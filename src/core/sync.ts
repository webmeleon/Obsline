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
  outlineIdMap: Record<string, string>;
}

interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
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

      const result = await this.syncBidirectional(obsidianNotes, outlineDocuments, collections);

      await this.saveSyncState();
      this.syncState.lastSyncTime = startTime;

      this.logger.info(`Sync completed: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`);
      if (result.conflicts.length > 0) {
        this.logger.warn(`Conflicts detected: ${result.conflicts.join(', ')}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async syncBidirectional(
    obsidianNotes: ObsidianNote[],
    outlineDocuments: OutlineDocument[],
    collections: OutlineCollection[]
  ): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, deleted: 0, conflicts: [] };

    const obsidianMap = new Map(obsidianNotes.map(n => [n.path, n]));
    const collectionNameById = new Map(collections.map(c => [c.id, c.name]));
    const collectionIdByName = new Map(collections.map(c => [c.name, c.id]));

    // Build reverse mapping: obsidian path -> outline doc IDs (to avoid duplicates)
    const pathToOutlineIds = new Map<string, string[]>();
    for (const [outlineId, obsidianPath] of Object.entries(this.syncState.outlineIdMap)) {
      if (!pathToOutlineIds.has(obsidianPath)) {
        pathToOutlineIds.set(obsidianPath, []);
      }
      pathToOutlineIds.get(obsidianPath)!.push(outlineId);
    }

    // Load full content for all Outline documents
    const fullOutlineDocs: OutlineDocument[] = [];
    const docById = new Map<string, OutlineDocument>();
    for (const doc of outlineDocuments) {
      try {
        const fullDoc = await this.outlineClient.getDocument(doc.id);
        fullOutlineDocs.push(fullDoc);
        docById.set(fullDoc.id, fullDoc);
      } catch (error) {
        this.logger.warn(`Failed to load document ${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Sync Obsidian notes to Outline
    const firstCollectionId = collections.length > 0 ? collections[0].id : undefined;
    for (const note of obsidianNotes) {
      const outlineDoc = fullOutlineDocs.find(d => this.syncState.outlineIdMap[d.id] === note.path);

      if (!outlineDoc) {
        const { collectionId, parentDocumentId } = this.extractCollectionAndParentFromPath(note.path, collectionIdByName, firstCollectionId);
        const created = await this.outlineClient.createDocument(note.title, note.content, collectionId, parentDocumentId);
        this.syncState.outlineIdMap[created.id] = note.path;
        result.created++;
      } else {
        const noteHash = this.hashContent(note.content);
        const outlineHash = this.hashContent(outlineDoc.text);

        if (noteHash !== outlineHash) {
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

    // Sync Outline documents to Obsidian
    for (const outlineDoc of fullOutlineDocs) {
      const mappedPath = this.syncState.outlineIdMap[outlineDoc.id];

      if (!mappedPath || !obsidianMap.has(mappedPath)) {
        const notePath = this.buildObsidianPath(outlineDoc, collectionNameById, docById);

        // Check if this path already has a mapping (avoid duplicates)
        const existingOutlineIds = pathToOutlineIds.get(notePath) || [];
        if (existingOutlineIds.length > 0) {
          // Path already exists in sync state, use the first mapping
          this.syncState.outlineIdMap[outlineDoc.id] = notePath;
          this.logger.debug(`Mapped outline doc ${outlineDoc.id} to existing path ${notePath}`);
        } else if (!await this.obsidianReader.noteExists(notePath)) {
          // Path doesn't exist anywhere, create new file
          await this.obsidianReader.writeNote(notePath, outlineDoc.text);
          this.syncState.outlineIdMap[outlineDoc.id] = notePath;
          pathToOutlineIds.set(notePath, [outlineDoc.id]);
          result.created++;
        } else {
          // File exists but not in sync state, add mapping without recreating
          this.syncState.outlineIdMap[outlineDoc.id] = notePath;
          pathToOutlineIds.set(notePath, [...(pathToOutlineIds.get(notePath) || []), outlineDoc.id]);
          this.logger.debug(`Added mapping for existing file ${notePath}`);
        }
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

    // Walk parentDocumentId chain (for nested documents)
    let parentId = doc.parentDocumentId;
    while (parentId) {
      const parent = docById.get(parentId);
      if (!parent) break;
      parts.unshift(parent.title);
      parentId = parent.parentDocumentId;
    }

    // Collection = root folder
    const collectionName = collectionNameById.get(doc.collectionId) ?? 'Unsorted';
    parts.unshift(collectionName);
    parts.push(`${doc.title}.md`);

    return parts.join('/');
  }

  private extractCollectionAndParentFromPath(
    notePath: string,
    collectionIdByName: Map<string, string>,
    firstCollectionId?: string
  ): { collectionId?: string; parentDocumentId?: string } {
    const parts = notePath.split('/').filter(p => p);
    const collectionName = parts[0];
    let collectionId = collectionIdByName.get(collectionName);

    // If path doesn't match a known collection, only use firstCollectionId if path starts with a folder
    if (!collectionId && parts.length > 1) {
      // File is in a subfolder, use first collection
      collectionId = firstCollectionId;
    }

    if (!collectionId) {
      this.logger.warn(`No collection found for path ${notePath}, will be added to default Outline location`);
    }

    return { collectionId };
  }

  private resolveConflict(note: ObsidianNote, outlineDoc: OutlineDocument): ObsidianNote {
    if (this.config.conflictResolution === 'obsidian-wins') {
      return note;
    }
    if (this.config.conflictResolution === 'outline-wins') {
      return {
        ...note,
        content: outlineDoc.text,
        lastModified: new Date(outlineDoc.updatedAt).getTime(),
      };
    }
    const noteTime = note.lastModified;
    const outlineTime = new Date(outlineDoc.updatedAt).getTime();
    return noteTime > outlineTime ? note : { ...note, content: outlineDoc.text, lastModified: outlineTime };
  }

  private hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private async loadSyncState(): Promise<void> {
    const stateFile = path.join(process.env.HOME || '~', '.obsline', 'sync-state.json');
    try {
      if (await fs.pathExists(stateFile)) {
        const data = await fs.readFile(stateFile, 'utf-8');
        this.syncState = JSON.parse(data);
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
