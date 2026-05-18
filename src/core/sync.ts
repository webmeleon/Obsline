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
  // outlineId -> obsidianPath
  outlineIdMap: Record<string, string>;
  // obsidianPath -> outlineId (for rename detection)
  pathToOutlineId: Record<string, string>;
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

      // Create missing collections for new Obsidian folders
      const updatedCollections = await this.ensureCollectionsForFolders(
        obsidianNotes,
        collections
      );

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

  // Creates Outline collections for any new top-level folders in Obsidian
  private async ensureCollectionsForFolders(
    notes: ObsidianNote[],
    collections: OutlineCollection[]
  ): Promise<OutlineCollection[]> {
    const existingNames = new Set(collections.map(c => c.name));
    const vaultFolders = new Set<string>();

    for (const note of notes) {
      const parts = note.path.split('/');
      if (parts.length > 1) {
        vaultFolders.add(parts[0]);
      }
    }

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

    // Build reverse path → outlineIds map (for duplicate prevention)
    const pathToOutlineIds = new Map<string, string[]>();
    for (const [outlineId, obsidianPath] of Object.entries(this.syncState.outlineIdMap)) {
      if (!pathToOutlineIds.has(obsidianPath)) pathToOutlineIds.set(obsidianPath, []);
      pathToOutlineIds.get(obsidianPath)!.push(outlineId);
    }

    // Load full document content
    const fullOutlineDocs: OutlineDocument[] = [];
    const docById = new Map<string, OutlineDocument>();
    const hashToOutlineId = new Map<string, string>();
    // (collectionId + title) → doc — adopt existing docs instead of creating duplicates
    const outlineDocByKey = new Map<string, OutlineDocument>();

    for (const doc of outlineDocuments) {
      try {
        const fullDoc = await this.outlineClient.getDocument(doc.id);
        fullOutlineDocs.push(fullDoc);
        docById.set(fullDoc.id, fullDoc);
        if (fullDoc.text) {
          hashToOutlineId.set(this.hashContent(fullDoc.text), fullDoc.id);
        }
        outlineDocByKey.set(`${fullDoc.collectionId}::${fullDoc.title}`, fullDoc);
      } catch (error) {
        this.logger.warn(`Failed to load document ${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ── Obsidian → Outline ──────────────────────────────────────────────────

    const obsidianMap = new Map(obsidianNotes.map(n => [n.path, n]));

    for (const note of obsidianNotes) {
      const knownOutlineId = this.syncState.pathToOutlineId[note.path];
      const outlineDoc = knownOutlineId ? docById.get(knownOutlineId) : undefined;

      if (!outlineDoc) {
        // Check if this is a rename: same content hash already exists in Outline
        const noteHash = this.hashContent(note.content);
        const renamedFromId = hashToOutlineId.get(noteHash);
        const renamedFromPath = renamedFromId ? this.syncState.outlineIdMap[renamedFromId] : undefined;

        if (renamedFromId && renamedFromPath && renamedFromPath !== note.path) {
          // Rename detected: update title in Outline, update mappings
          this.logger.info(`Rename detected: "${renamedFromPath}" → "${note.path}"`);
          await this.outlineClient.updateDocument(renamedFromId, note.content, note.title);
          delete this.syncState.outlineIdMap[renamedFromId];
          this.syncState.outlineIdMap[renamedFromId] = note.path;
          this.syncState.pathToOutlineId[note.path] = renamedFromId;
          delete this.syncState.pathToOutlineId[renamedFromPath];
          result.renamed++;
        } else {
          const { collectionId, parentDocumentId } = this.extractCollectionAndParentFromPath(
            note.path, collectionIdByName
          );
          // Root-level files have no collection — Outline requires one, skip them
          if (!collectionId) {
            this.logger.warn(`Skipping "${note.path}" — move it into a subfolder to sync with Outline`);
            continue;
          }
          // Adopt existing Outline doc (same collection + title) instead of creating a duplicate
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
        // Known document — check for content or title changes
        const noteHash = this.hashContent(note.content);
        const outlineHash = this.hashContent(outlineDoc.text);
        const titleChanged = note.title !== outlineDoc.title;

        if (noteHash !== outlineHash || titleChanged) {
          const resolvedNote = this.resolveConflict(note, outlineDoc);
          if (resolvedNote === note) {
            await this.outlineClient.updateDocument(outlineDoc.id, note.content, note.title);
            result.updated++;
          } else {
            await this.obsidianReader.writeNote(note.path, resolvedNote.content);
            result.updated++;
          }
        }
      }

      this.syncState.fileHashes[note.path] = this.hashContent(note.content);
    }

    // ── Outline → Obsidian ──────────────────────────────────────────────────

    for (const outlineDoc of fullOutlineDocs) {
      const mappedPath = this.syncState.outlineIdMap[outlineDoc.id];

      if (mappedPath && obsidianMap.has(mappedPath)) continue; // already in sync

      const notePath = this.buildObsidianPath(outlineDoc, collectionNameById, docById);
      const existingIds = pathToOutlineIds.get(notePath) || [];

      if (existingIds.length > 0) {
        // Path already mapped — just update state entry
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
      } else if (!await this.obsidianReader.noteExists(notePath)) {
        await this.obsidianReader.writeNote(notePath, outlineDoc.text);
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
        pathToOutlineIds.set(notePath, [outlineDoc.id]);
        result.created++;
      } else {
        // File exists on disk but wasn't in state — adopt it
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
        pathToOutlineIds.set(notePath, [outlineDoc.id]);
      }
    }

    return result;
  }

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

  private extractCollectionAndParentFromPath(
    notePath: string,
    collectionIdByName: Map<string, string>
  ): { collectionId?: string; parentDocumentId?: string } {
    const parts = notePath.split('/').filter(p => p);
    if (parts.length < 2) {
      // Root-level file — no collection
      return {};
    }

    const collectionId = collectionIdByName.get(parts[0]);
    if (!collectionId) {
      this.logger.warn(`No collection found for folder "${parts[0]}" in path ${notePath}`);
    }

    return { collectionId };
  }

  private resolveConflict(note: ObsidianNote, outlineDoc: OutlineDocument): ObsidianNote {
    if (this.config.conflictResolution === 'obsidian-wins') return note;
    if (this.config.conflictResolution === 'outline-wins') {
      return { ...note, content: outlineDoc.text, lastModified: new Date(outlineDoc.updatedAt).getTime() };
    }
    // last-write-wins
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
          // Rebuild pathToOutlineId from outlineIdMap if missing (migration)
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
