import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ObsidianReader, ObsidianNote } from './obsidian';
import { OutlineClient, OutlineDocument, OutlineCollection } from './outline';
import { ObslineConfig } from '../utils/config';
import { Logger } from '../utils/logger';

interface SyncState {
  lastSyncTime: number;
  fileHashes: Record<string, string>;
  outlineIdMap: Record<string, string>;   // outlineId → obsidianPath
  pathToOutlineId: Record<string, string>; // obsidianPath → outlineId
}

interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  renamed: number;
  conflicts: string[];
}

export class SyncEngine {
  private logger = new Logger('SyncEngine');
  private config: ObslineConfig;
  private obsidianReader: ObsidianReader;
  private outlineClient: OutlineClient;
  private syncState: SyncState = {
    lastSyncTime: 0,
    fileHashes: {},
    outlineIdMap: {},
    pathToOutlineId: {},
  };

  constructor(config: ObslineConfig) {
    this.config = config;
    this.obsidianReader = new ObsidianReader(config.obsidianVault, config.ignorePaths);
    this.outlineClient = new OutlineClient(config.outlineUrl, config.outlineApiToken);
  }

  async sync(): Promise<SyncResult> {
    this.logger.info('Starting bi-directional sync');
    const startTime = Date.now();

    try {
      await this.loadSyncState();

      const [obsidianNotes, outlineDocuments, collections] = await Promise.all([
        this.obsidianReader.readVault(),
        this.outlineClient.listDocuments(),
        this.outlineClient.listCollections(),
      ]);

      const updatedCollections = await this.ensureCollectionsForFolders(obsidianNotes, collections);
      const result = await this.syncBidirectional(obsidianNotes, outlineDocuments, updatedCollections);

      await this.saveSyncState();
      this.syncState.lastSyncTime = startTime;

      this.logger.info(
        `Sync completed: ${result.created} created, ${result.updated} updated, ` +
        `${result.renamed} renamed, ${result.deleted} deleted`
      );
      if (result.conflicts.length > 0) {
        this.logger.warn(`Conflicts: ${result.conflicts.join(', ')}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async ensureCollectionsForFolders(
    notes: ObsidianNote[],
    collections: OutlineCollection[]
  ): Promise<OutlineCollection[]> {
    const existingNames = new Set(collections.map(c => c.name));
    const vaultFolders = new Set<string>();
    const hasRootLevelNotes = notes.some(n => !n.path.includes('/'));

    for (const note of notes) {
      const parts = note.path.split('/');
      if (parts.length > 1) vaultFolders.add(parts[0]);
    }

    if (hasRootLevelNotes) vaultFolders.add('Inbox');

    const updated = [...collections];
    for (const folder of vaultFolders) {
      if (!existingNames.has(folder)) {
        this.logger.info(`Creating collection for new folder: ${folder}`);
        const newCollection = await this.outlineClient.createCollection(folder);
        updated.push(newCollection);
        existingNames.add(folder);
      }
    }

    return updated;
  }

  private async syncBidirectional(
    obsidianNotes: ObsidianNote[],
    outlineDocuments: OutlineDocument[],
    collections: OutlineCollection[]
  ): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, deleted: 0, renamed: 0, conflicts: [] };

    const collectionNameById = new Map(collections.map(c => [c.id, c.name]));
    const collectionIdByName = new Map(collections.map(c => [c.name, c.id]));

    const pathToOutlineIds = new Map<string, string[]>();
    for (const [outlineId, obsidianPath] of Object.entries(this.syncState.outlineIdMap)) {
      if (!pathToOutlineIds.has(obsidianPath)) pathToOutlineIds.set(obsidianPath, []);
      pathToOutlineIds.get(obsidianPath)!.push(outlineId);
    }

    // Only fetch full content for new or changed docs
    const fullOutlineDocs: OutlineDocument[] = [];
    const docById = new Map<string, OutlineDocument>();
    const hashToOutlineId = new Map<string, string>();
    const outlineDocByKey = new Map<string, OutlineDocument>(); // collectionId::title → doc

    for (const doc of outlineDocuments) {
      const isKnown = this.syncState.outlineIdMap[doc.id] !== undefined;
      const changedSinceLastSync = new Date(doc.updatedAt).getTime() > this.syncState.lastSyncTime;

      if (!isKnown || changedSinceLastSync) {
        try {
          const fullDoc = await this.outlineClient.getDocument(doc.id);
          fullOutlineDocs.push(fullDoc);
          docById.set(fullDoc.id, fullDoc);
          if (fullDoc.text) hashToOutlineId.set(this.hashContent(fullDoc.text), fullDoc.id);
          outlineDocByKey.set(`${fullDoc.collectionId}::${fullDoc.title}`, fullDoc);
        } catch (error) {
          this.logger.warn(`Failed to load document ${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        const stub: OutlineDocument = { ...doc, text: '' };
        fullOutlineDocs.push(stub);
        docById.set(doc.id, stub);
        outlineDocByKey.set(`${doc.collectionId}::${doc.title}`, stub);
      }
    }

    const obsidianMap = new Map(obsidianNotes.map(n => [n.path, n]));
    const outlineIdSet = new Set(outlineDocuments.map(d => d.id));

    // Snapshot keys before any state mutations so rename detection can release them first
    const knownPaths = Object.keys(this.syncState.pathToOutlineId);
    const knownIds = Object.keys(this.syncState.outlineIdMap);

    // ── Obsidian → Outline ──────────────────────────────────────────────────
    // Sort by path depth so parent flat-files are processed before their children
    const sortedNotes = [...obsidianNotes].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length
    );

    for (const note of sortedNotes) {
      const knownOutlineId = this.syncState.pathToOutlineId[note.path];
      const outlineDoc = knownOutlineId ? docById.get(knownOutlineId) : undefined;

      if (!outlineDoc) {
        // Doc was known but is no longer in Outline (e.g. collection deleted) → skip,
        // the Outline→Obsidian deletion pass will remove the local file.
        if (knownOutlineId && !outlineIdSet.has(knownOutlineId)) continue;

        const noteHash = this.hashContent(note.content);
        const renamedFromId = hashToOutlineId.get(noteHash);
        const renamedFromPath = renamedFromId ? this.syncState.outlineIdMap[renamedFromId] : undefined;

        if (renamedFromId && renamedFromPath && renamedFromPath !== note.path) {
          this.logger.info(`Rename detected: "${renamedFromPath}" → "${note.path}"`);
          await this.outlineClient.updateDocument(renamedFromId, note.content, note.title);
          this.syncState.outlineIdMap[renamedFromId] = note.path;
          this.syncState.pathToOutlineId[note.path] = renamedFromId;
          delete this.syncState.pathToOutlineId[renamedFromPath];
          result.renamed++;
        } else {
          const { collectionId, parentDocumentId } = this.extractCollectionAndParentFromPath(
            note.path, collectionIdByName
          );
          if (!collectionId) {
            this.logger.warn(`No collection for "${note.path}" — skipping`);
            continue;
          }

          // Adopt existing doc instead of duplicating (index file = same doc as flat)
          const adoptKey = `${collectionId}::${note.title}`;
          const existing = outlineDocByKey.get(adoptKey);
          if (existing && !this.syncState.outlineIdMap[existing.id]) {
            this.logger.info(`Adopting existing Outline doc for "${note.path}"`);
            this.syncState.outlineIdMap[existing.id] = note.path;
            this.syncState.pathToOutlineId[note.path] = existing.id;
          } else {
            const created = await this.outlineClient.createDocument(
              note.title, note.content, collectionId, parentDocumentId
            );
            this.syncState.outlineIdMap[created.id] = note.path;
            this.syncState.pathToOutlineId[note.path] = created.id;
            result.created++;
          }
        }
      } else if (outlineDoc.text !== '') {
        const noteHash = this.hashContent(note.content);
        const outlineHash = this.hashContent(outlineDoc.text);
        const titleChanged = note.title !== outlineDoc.title;

        if (noteHash !== outlineHash || titleChanged) {
          const resolvedNote = this.resolveConflict(note, outlineDoc);
          if (resolvedNote === note) {
            await this.outlineClient.updateDocument(outlineDoc.id, note.content, note.title);
          } else {
            await this.obsidianReader.writeNote(note.path, resolvedNote.content);
          }
          result.updated++;
        }
      }

      this.syncState.fileHashes[note.path] = this.hashContent(note.content);
    }

    // ── Outline → Obsidian (create/update) ─────────────────────────────────

    for (const outlineDoc of fullOutlineDocs) {
      const notePath = this.buildObsidianPath(outlineDoc, collectionNameById, docById);
      const mappedPath = this.syncState.outlineIdMap[outlineDoc.id];

      // Known doc: updates handled in Obsidian→Outline pass; deletions in deletion pass.
      if (mappedPath) continue;

      const existingIds = pathToOutlineIds.get(notePath) || [];
      if (existingIds.length > 0) {
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
      } else if (!await this.obsidianReader.noteExists(notePath)) {
        await this.obsidianReader.writeNote(notePath, outlineDoc.text);
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
        pathToOutlineIds.set(notePath, [outlineDoc.id]);
        result.created++;
      } else {
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
        pathToOutlineIds.set(notePath, [outlineDoc.id]);
      }
    }

    // ── Deletions: Obsidian → Outline ──────────────────────────────────────
    // Uses snapshot keys; rename detection above may have cleared a path from state,
    // so we re-check state[obsPath] before acting.
    for (const obsPath of knownPaths) {
      const outlineId = this.syncState.pathToOutlineId[obsPath];
      if (outlineId && !obsidianMap.has(obsPath)) {
        this.logger.info(`Obsidian deleted "${obsPath}" — deleting Outline doc ${outlineId}`);
        try {
          await this.outlineClient.deleteDocument(outlineId);
        } catch (e) {
          this.logger.warn(`Delete Outline doc failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        delete this.syncState.outlineIdMap[outlineId];
        delete this.syncState.pathToOutlineId[obsPath];
        delete this.syncState.fileHashes[obsPath];
        result.deleted++;
      }
    }

    // ── Deletions: Outline → Obsidian ──────────────────────────────────────
    for (const outlineId of knownIds) {
      const obsPath = this.syncState.outlineIdMap[outlineId];
      if (obsPath && !outlineIdSet.has(outlineId)) {
        this.logger.info(`Outline deleted doc ${outlineId} — deleting Obsidian file "${obsPath}"`);
        try {
          await this.obsidianReader.deleteNote(obsPath);
        } catch (e) {
          this.logger.warn(`Delete Obsidian file failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        delete this.syncState.outlineIdMap[outlineId];
        delete this.syncState.pathToOutlineId[obsPath];
        delete this.syncState.fileHashes[obsPath];
        result.deleted++;
      }
    }

    return result;
  }

  /**
   * Build the Obsidian file path for an Outline document.
   * Coexistence pattern: parent notes stay flat, children go into a same-named subfolder.
   * e.g. "Website" (parent) → Collection/Website.md
   *      "Design" (child of Website) → Collection/Website/Design.md
   */
  private buildObsidianPath(
    doc: OutlineDocument,
    collectionNameById: Map<string, string>,
    docById: Map<string, OutlineDocument>
  ): string {
    const parts: string[] = [];

    let parentId = doc.parentDocumentId;
    while (parentId) {
      const parent = docById.get(parentId);
      if (!parent) break;
      parts.unshift(parent.title);
      parentId = parent.parentDocumentId;
    }

    const collectionName = collectionNameById.get(doc.collectionId) ?? 'Unsorted';
    parts.unshift(collectionName);
    parts.push(`${doc.title}.md`);

    return parts.join('/');
  }

  /**
   * Resolve the Outline collection and parentDocumentId for an Obsidian path.
   * Coexistence pattern: the parent doc lives one level up as a flat file.
   *
   * Collection/Note.md              → { collectionId }
   * Collection/Folder/Note.md       → { collectionId, parentDocumentId: Folder doc ID }
   *   parent lookup: Collection/Folder.md in state
   * Note.md (root)                  → { collectionId: Inbox }
   */
  private extractCollectionAndParentFromPath(
    notePath: string,
    collectionIdByName: Map<string, string>
  ): { collectionId?: string; parentDocumentId?: string } {
    const parts = notePath.split('/').filter(p => p);

    if (parts.length < 2) {
      return { collectionId: collectionIdByName.get('Inbox') };
    }

    const collectionId = collectionIdByName.get(parts[0]);
    if (!collectionId) {
      this.logger.warn(`No collection found for folder "${parts[0]}" in path ${notePath}`);
      return {};
    }

    if (parts.length === 2) {
      return { collectionId };
    }

    // Deep path: Collection/Folder/Note.md
    // Parent is the flat file one level above: Collection/Folder.md
    const parentFolderName = parts[parts.length - 2];
    const parentPath = [...parts.slice(0, -2), `${parentFolderName}.md`].join('/');
    const parentDocId = this.syncState.pathToOutlineId[parentPath];
    if (!parentDocId) {
      this.logger.warn(`Parent doc for "${notePath}" not in state (${parentPath})`);
    }

    return { collectionId, parentDocumentId: parentDocId };
  }

  private resolveConflict(note: ObsidianNote, outlineDoc: OutlineDocument): ObsidianNote {
    if (this.config.conflictResolution === 'obsidian-wins') return note;
    if (this.config.conflictResolution === 'outline-wins') {
      return { ...note, content: outlineDoc.text, lastModified: new Date(outlineDoc.updatedAt).getTime() };
    }
    const outlineTime = new Date(outlineDoc.updatedAt).getTime();
    return note.lastModified > outlineTime
      ? note
      : { ...note, content: outlineDoc.text, lastModified: outlineTime };
  }

  private hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private async loadSyncState(): Promise<void> {
    const stateFile = path.join(process.env.HOME || '~', '.obsline', 'sync-state.json');
    try {
      if (await fs.pathExists(stateFile)) {
        const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
        this.syncState = {
          lastSyncTime: raw.lastSyncTime ?? 0,
          fileHashes: raw.fileHashes ?? {},
          outlineIdMap: raw.outlineIdMap ?? {},
          pathToOutlineId: raw.pathToOutlineId ??
            Object.fromEntries(Object.entries(raw.outlineIdMap ?? {}).map(([id, p]) => [p, id])),
        };
        this.logger.debug('Sync state loaded');
      }
    } catch (error) {
      this.logger.warn(`Failed to load sync state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveSyncState(): Promise<void> {
    const stateDir = path.join(process.env.HOME || '~', '.obsline');
    const stateFile = path.join(stateDir, 'sync-state.json');
    try {
      await fs.ensureDir(stateDir);
      await fs.writeFile(stateFile, JSON.stringify(this.syncState, null, 2), 'utf-8');
      this.logger.debug('Sync state saved');
    } catch (error) {
      this.logger.error(`Failed to save sync state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getLastSyncTime(): number {
    return this.syncState.lastSyncTime;
  }

  getSyncState(): SyncState {
    return { ...this.syncState };
  }
}
