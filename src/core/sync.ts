import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ObsidianReader, ObsidianNote } from './obsidian';
import { OutlineClient, OutlineDocument } from './outline';
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

      const [obsidianNotes, outlineDocuments] = await Promise.all([
        this.obsidianReader.readVault(),
        this.outlineClient.listDocuments(),
      ]);

      const result = await this.syncBidirectional(obsidianNotes, outlineDocuments);

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
    outlineDocuments: OutlineDocument[]
  ): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, deleted: 0, conflicts: [] };

    const obsidianMap = new Map(obsidianNotes.map(n => [n.path, n]));

    // Load full content for all Outline documents
    const fullOutlineDocs: OutlineDocument[] = [];
    for (const doc of outlineDocuments) {
      try {
        const fullDoc = await this.outlineClient.getDocument(doc.id);
        fullOutlineDocs.push(fullDoc);
      } catch (error) {
        this.logger.warn(`Failed to load document ${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const outlineMap = new Map(fullOutlineDocs.map(d => [this.syncState.outlineIdMap[d.id], d]));

    // Sync Obsidian notes to Outline
    for (const note of obsidianNotes) {
      const outlineDoc = outlineMap.get(note.path);

      if (!outlineDoc) {
        const created = await this.outlineClient.createDocument(note.title, note.content);
        this.syncState.outlineIdMap[created.id] = note.path;
        result.created++;
      } else {
        const noteHash = this.hashContent(note.content);
        const outlineHash = this.hashContent(outlineDoc.text);

        if (noteHash !== outlineHash) {
          const resolvedNote = this.resolveConflict(note, outlineDoc);
          if (resolvedNote === note) {
            await this.outlineClient.updateDocument(outlineDoc.id, note.content);
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
        const notePath = this.createNotePathFromOutlineTitle(outlineDoc.title);
        if (!await this.obsidianReader.noteExists(notePath)) {
          await this.obsidianReader.writeNote(notePath, outlineDoc.text);
          this.syncState.outlineIdMap[outlineDoc.id] = notePath;
          result.created++;
        }
      }
    }

    return result;
  }

  private createNotePathFromOutlineTitle(title: string): string {
    return `${title.replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, '-').toLowerCase()}.md`;
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
