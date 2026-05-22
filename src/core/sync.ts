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

      const outlineIdSet = new Set(outlineDocuments.map(d => d.id));
      const updatedCollections = await this.ensureCollectionsForFolders(obsidianNotes, collections, outlineIdSet);
      const result = await this.syncBidirectional(obsidianNotes, outlineDocuments, updatedCollections);

      this.syncState.lastSyncTime = startTime;
      await this.saveSyncState();

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
    collections: OutlineCollection[],
    outlineIdSet: Set<string>,
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
      if (existingNames.has(folder)) continue;

      // Don't recreate a collection whose vault files all map to now-deleted Outline docs.
      const folderNotes = notes.filter(n => n.path.startsWith(folder + '/'));
      if (folderNotes.length > 0 && folderNotes.every(n => {
        const id = this.syncState.pathToOutlineId[n.path];
        return id !== undefined && !outlineIdSet.has(id);
      })) continue;

      this.logger.info(`Creating collection for new folder: ${folder}`);
      const newCollection = await this.outlineClient.createCollection(folder);
      updated.push(newCollection);
      existingNames.add(folder);
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

    // Ensure virtual parent docs exist for pure-folder hierarchies before main loop
    await this.ensureParentDocsForFolders(obsidianNotes, collectionIdByName, outlineDocByKey, outlineIdSet);

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
      } else {
        const noteHash = this.hashContent(note.content);
        let contentUpdated = false;

        if (outlineDoc.text !== '') {
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
            contentUpdated = true;
          }
        } else {
          // Stub: Outline unchanged since last sync — push Obsidian changes if any
          const lastKnownHash = this.syncState.fileHashes[note.path];
          if (lastKnownHash && noteHash !== lastKnownHash) {
            await this.outlineClient.updateDocument(outlineDoc.id, note.content, note.title);
            result.updated++;
            contentUpdated = true;
          }
        }

        // Move document if parent has changed (e.g. flat docs from first sync)
        const { collectionId: expectedCollection, parentDocumentId: expectedParent } =
          this.extractCollectionAndParentFromPath(note.path, collectionIdByName);
        const currentParent = outlineDoc.parentDocumentId ?? undefined;
        if (expectedCollection && expectedParent !== currentParent) {
          this.logger.info(`Moving "${note.path}" to correct parent in Outline`);
          await this.outlineClient.moveDocument(outlineDoc.id, expectedCollection, expectedParent);
          if (!contentUpdated) result.updated++;
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
    // Sort deepest paths first so children are deleted before parents (Outline 403s on parent with children).
    const pathsToDelete = knownPaths
      .filter(obsPath => {
        const outlineId = this.syncState.pathToOutlineId[obsPath];
        if (!outlineId || obsidianMap.has(obsPath)) return false;
        const folderPrefix = obsPath.replace(/\.md$/, '/');
        return ![...obsidianMap.keys()].some(p => p.startsWith(folderPrefix));
      })
      .sort((a, b) => b.split('/').length - a.split('/').length); // deepest first

    // Capture IDs before the loop clears state — needed for collection cleanup below
    const deletedIds = new Set<string>(
      pathsToDelete
        .map(p => this.syncState.pathToOutlineId[p])
        .filter((id): id is string => !!id),
    );

    for (const obsPath of pathsToDelete) {
      const outlineId = this.syncState.pathToOutlineId[obsPath];
      if (!outlineId) continue;
      this.logger.info(`Obsidian deleted "${obsPath}" — deleting Outline doc ${outlineId}`);
      try {
        await this.outlineClient.deleteDocument(outlineId);
      } catch (e) {
        this.logger.warn(`Delete Outline doc failed: ${e instanceof Error ? e.message : String(e)}`);
        continue; // don't wipe state if delete failed
      }
      delete this.syncState.outlineIdMap[outlineId];
      delete this.syncState.pathToOutlineId[obsPath];
      delete this.syncState.fileHashes[obsPath];
      result.deleted++;
    }

    // ── Empty collection cleanup ────────────────────────────────────────────
    // After document deletions, remove Outline collections that are now empty.
    if (deletedIds.size > 0) {
      const emptyCollections = collections.filter(col => {
        const hadDeletions = outlineDocuments.some(d => d.collectionId === col.id && deletedIds.has(d.id));
        if (!hadDeletions) return false;
        return outlineDocuments.every(d => d.collectionId !== col.id || deletedIds.has(d.id));
      });
      for (const col of emptyCollections) {
        this.logger.info(`Removing empty collection: ${col.name}`);
        try {
          await this.outlineClient.deleteCollection(col.id);
          result.deleted++;
        } catch (e) {
          this.logger.warn(`Delete empty collection "${col.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // ── Deletions: Outline → Obsidian ──────────────────────────────────────
    for (const outlineId of knownIds) {
      const obsPath = this.syncState.outlineIdMap[outlineId];
      if (!obsPath || outlineIdSet.has(outlineId)) continue;

      // Skip virtual parent paths — they have no real Obsidian file to delete.
      // Only applies when the path is NOT a real vault file (coexistence pattern:
      // a real note like Website.md can also be a parent of Website/).
      const folderPrefix = obsPath.replace(/\.md$/, '/');
      if (!obsidianMap.has(obsPath) && [...obsidianMap.keys()].some(p => p.startsWith(folderPrefix))) {
        delete this.syncState.outlineIdMap[outlineId];
        delete this.syncState.pathToOutlineId[obsPath];
        continue;
      }

      this.logger.info(`Outline deleted doc ${outlineId} — deleting Obsidian file "${obsPath}"`);
      try {
        await this.obsidianReader.deleteNote(obsPath);
      } catch (e) {
        this.logger.warn(`Delete Obsidian file failed: ${e instanceof Error ? e.message : String(e)}`);
        continue; // don't wipe state if delete failed
      }
      delete this.syncState.outlineIdMap[outlineId];
      delete this.syncState.pathToOutlineId[obsPath];
      delete this.syncState.fileHashes[obsPath];
      result.deleted++;
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

  /**
   * For every pure-folder path in the vault (a folder with no matching flat .md file),
   * create a virtual parent document in Outline so nested notes can be placed under it.
   * Processes shallowest folders first so multi-level nesting chains correctly.
   */
  private async ensureParentDocsForFolders(
    notes: ObsidianNote[],
    collectionIdByName: Map<string, string>,
    outlineDocByKey: Map<string, OutlineDocument>,
    outlineIdSet: Set<string>,
  ): Promise<void> {
    const notePaths = new Set(notes.map(n => n.path));
    const folderPaths = new Set<string>();

    for (const note of notes) {
      const parts = note.path.split('/');
      for (let i = 2; i < parts.length; i++) {
        folderPaths.add(parts.slice(0, i).join('/'));
      }
    }

    const sorted = [...folderPaths].sort(
      (a, b) => a.split('/').length - b.split('/').length
    );

    for (const folderPath of sorted) {
      const flatFilePath = `${folderPath}.md`;
      if (notePaths.has(flatFilePath)) continue;
      if (this.syncState.pathToOutlineId[flatFilePath]) continue;

      // Don't recreate a virtual parent if all notes in this folder already have valid
      // Outline IDs — parent was deleted from Outline but children were only orphaned.
      const folderNotes = notes.filter(n => n.path.startsWith(folderPath + '/'));
      if (folderNotes.length > 0 && folderNotes.every(n => {
        const id = this.syncState.pathToOutlineId[n.path];
        return id !== undefined && outlineIdSet.has(id);
      })) continue;

      const { collectionId, parentDocumentId } = this.extractCollectionAndParentFromPath(
        flatFilePath, collectionIdByName
      );
      if (!collectionId) continue;

      const folderTitle = folderPath.split('/').pop()!;
      const adoptKey = `${collectionId}::${folderTitle}`;
      const existing = outlineDocByKey.get(adoptKey);

      if (existing && !this.syncState.outlineIdMap[existing.id]) {
        this.logger.info(`Adopting existing Outline doc as virtual parent for "${folderPath}"`);
        this.syncState.outlineIdMap[existing.id] = flatFilePath;
        this.syncState.pathToOutlineId[flatFilePath] = existing.id;
      } else if (!existing) {
        this.logger.info(`Creating virtual parent doc for folder: "${folderPath}"`);
        const created = await this.outlineClient.createDocument(
          folderTitle, '', collectionId, parentDocumentId
        );
        this.syncState.outlineIdMap[created.id] = flatFilePath;
        this.syncState.pathToOutlineId[flatFilePath] = created.id;
      }
    }
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
