import { App, TFile } from 'obsidian';
import { createHash } from 'crypto';
import { OutlineClient } from './outline-client';
import {
  ObslineSettings,
  OutlineCollection,
  OutlineDocument,
  SyncResult,
  SyncState,
} from './types';

interface VaultNote {
  file: TFile;
  path: string;
  title: string;
  content: string;
  lastModified: number;
}

export class SyncEngine {
  private app: App;
  private settings: ObslineSettings;
  private client: OutlineClient;

  constructor(app: App, settings: ObslineSettings) {
    this.app = app;
    this.settings = settings;
    this.client = new OutlineClient(settings.outlineUrl, settings.outlineApiToken);
  }

  updateSettings(settings: ObslineSettings) {
    this.settings = settings;
    this.client = new OutlineClient(settings.outlineUrl, settings.outlineApiToken);
  }

  async testConnection(): Promise<boolean> {
    return this.client.testConnection();
  }

  async deleteOutlineDoc(id: string): Promise<void> {
    await this.client.deleteDocument(id);
  }

  async deleteAllOutline(): Promise<{ deleted: number; failed: number }> {
    const collections = await this.client.listCollections();
    let deleted = 0;
    let failed = 0;
    for (const col of collections) {
      try {
        await this.client.deleteCollection(col.id);
        deleted++;
      } catch {
        failed++;
      }
    }
    return { deleted, failed };
  }

  async sync(onProgress?: (msg: string) => void): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, deleted: 0, renamed: 0, conflicts: [], errors: [] };
    const state = this.settings.syncState;
    const lastSyncTime = state.lastSyncTime;

    onProgress?.('Reading vault…');
    const vaultNotes = await this.readVault();

    onProgress?.('Fetching Outline data…');
    const [collections, outlineDocsList] = await Promise.all([
      this.client.listCollections(),
      this.client.listDocuments(),
    ]);

    // Only fetch full content for docs that changed since last sync or are unknown
    onProgress?.('Loading changed documents…');
    const fullDocs: OutlineDocument[] = [];
    const docById = new Map<string, OutlineDocument>();
    const hashToOutlineId = new Map<string, string>();

    for (const doc of outlineDocsList) {
      const isKnown = state.outlineIdMap[doc.id] !== undefined;
      const changedSinceLastSync = new Date(doc.updatedAt).getTime() > lastSyncTime;

      if (!isKnown || changedSinceLastSync) {
        try {
          const full = await this.client.getDocument(doc.id);
          fullDocs.push(full);
          docById.set(full.id, full);
          if (full.text) hashToOutlineId.set(this.hash(full.text), full.id);
        } catch (e) {
          result.errors.push(`Failed to load doc ${doc.id}: ${String(e)}`);
        }
      } else {
        const stub: OutlineDocument = { ...doc, text: '' };
        fullDocs.push(stub);
        docById.set(doc.id, stub);
      }
    }

    // Build early — needed by ensureCollections to avoid recreating deleted collections
    const outlineIdSet = new Set(outlineDocsList.map(d => d.id));

    // Ensure collections exist for all vault folders + inbox for root-level notes
    const updatedCollections = await this.ensureCollections(vaultNotes, collections, outlineIdSet, onProgress);
    const collectionNameById = new Map(updatedCollections.map(c => [c.id, c.name]));
    const collectionIdByName = new Map(updatedCollections.map(c => [c.name, c.id]));

    // (collectionId::title) → doc — adopt existing instead of duplicating
    const outlineDocByKey = new Map<string, OutlineDocument>();
    for (const doc of fullDocs) {
      outlineDocByKey.set(`${doc.collectionId}::${doc.title}`, doc);
    }

    const obsidianMap = new Map(vaultNotes.map(n => [n.path, n]));
    const pathToOutlineIds = new Map<string, string[]>();
    for (const [oid, opath] of Object.entries(state.outlineIdMap)) {
      if (!pathToOutlineIds.has(opath)) pathToOutlineIds.set(opath, []);
      pathToOutlineIds.get(opath)!.push(oid);
    }

    // Snapshot before any state mutations so rename detection can release paths first
    const knownPaths = Object.keys(state.pathToOutlineId);
    const knownIds = Object.keys(state.outlineIdMap);

    const firstSync = !state.firstSyncDone;
    const dir = this.settings.initialSyncDirection;

    // ── Obsidian → Outline ──────────────────────────────────────────────────

    if (!firstSync || dir === 'obsidian-to-outline' || dir === 'bidirectional') {
      // Ensure virtual parent docs exist for pure-folder hierarchies before main loop
      await this.ensureParentDocsForFolders(vaultNotes, collectionIdByName, outlineDocByKey, state, outlineIdSet);

      // Sort by depth so parent flat-files are processed before their children
      const sortedNotes = [...vaultNotes].sort(
        (a, b) => a.path.split('/').length - b.path.split('/').length,
      );

      for (const note of sortedNotes) {
        const knownId = state.pathToOutlineId[note.path];
        const outlineDoc = knownId ? docById.get(knownId) : undefined;

        if (!outlineDoc) {
          // Doc was known but is no longer in Outline (e.g. collection deleted) → skip,
          // the Outline→Obsidian deletion pass will remove the local file.
          if (knownId && !outlineIdSet.has(knownId)) continue;

          const noteHash = this.hash(note.content);
          const renamedFromId = hashToOutlineId.get(noteHash);
          const renamedFromPath = renamedFromId ? state.outlineIdMap[renamedFromId] : undefined;

          if (renamedFromId && renamedFromPath && renamedFromPath !== note.path) {
            onProgress?.(`Rename: "${renamedFromPath}" → "${note.path}"`);
            try {
              await this.client.updateDocument(renamedFromId, note.content, note.title);
              state.outlineIdMap[renamedFromId] = note.path;
              state.pathToOutlineId[note.path] = renamedFromId;
              delete state.pathToOutlineId[renamedFromPath];
              result.renamed++;
            } catch (e) {
              result.errors.push(`Rename failed: ${String(e)}`);
            }
          } else {
            const { collectionId, parentDocumentId } = this.collectionFromPath(note.path, collectionIdByName, state);
            if (!collectionId) {
              result.errors.push(`No collection for "${note.path}" — skipping`);
              continue;
            }
            const adoptKey = `${collectionId}::${note.title}`;
            const existing = outlineDocByKey.get(adoptKey);
            if (existing && !state.outlineIdMap[existing.id]) {
              onProgress?.(`Adopting existing Outline doc: ${note.path}`);
              state.outlineIdMap[existing.id] = note.path;
              state.pathToOutlineId[note.path] = existing.id;
            } else {
              onProgress?.(`Creating in Outline: ${note.path}`);
              try {
                const created = await this.client.createDocument(note.title, note.content, collectionId, parentDocumentId);
                state.outlineIdMap[created.id] = note.path;
                state.pathToOutlineId[note.path] = created.id;
                result.created++;
              } catch (e) {
                result.errors.push(`Create failed for ${note.path}: ${String(e)}`);
              }
            }
          }
        } else {
          const noteHash = this.hash(note.content);
          let contentUpdated = false;

          if (outlineDoc.text !== '') {
            const docHash = this.hash(outlineDoc.text);
            const titleChanged = note.title !== outlineDoc.title;

            if (noteHash !== docHash || titleChanged) {
              const winner = this.resolveConflict(note, outlineDoc);
              onProgress?.(`Updating: ${note.path}`);
              try {
                if (winner === 'obsidian') {
                  await this.client.updateDocument(outlineDoc.id, note.content, note.title);
                } else {
                  await this.writeNote(note.path, outlineDoc.text);
                }
                result.updated++;
                contentUpdated = true;
              } catch (e) {
                result.errors.push(`Update failed for ${note.path}: ${String(e)}`);
              }
            }
          } else {
            // Stub: Outline unchanged — push Obsidian changes if any
            const lastKnownHash = state.fileHashes[note.path];
            if (lastKnownHash && noteHash !== lastKnownHash) {
              try {
                await this.client.updateDocument(outlineDoc.id, note.content, note.title);
                result.updated++;
                contentUpdated = true;
              } catch (e) {
                result.errors.push(`Update failed for ${note.path}: ${String(e)}`);
              }
            }
          }

          // Move document if parent has changed (fixes flat docs from first sync)
          const { collectionId: expectedCollection, parentDocumentId: expectedParent } =
            this.collectionFromPath(note.path, collectionIdByName, state);
          const currentParent = outlineDoc.parentDocumentId ?? undefined;
          if (expectedCollection && expectedParent !== currentParent) {
            onProgress?.(`Moving to correct parent: ${note.path}`);
            try {
              await this.client.moveDocument(outlineDoc.id, expectedCollection, expectedParent);
              if (!contentUpdated) result.updated++;
            } catch (e) {
              result.errors.push(`Move failed for ${note.path}: ${String(e)}`);
            }
          }
        }

        state.fileHashes[note.path] = this.hash(note.content);
      }
    }

    // ── Outline → Obsidian ──────────────────────────────────────────────────

    if (!firstSync || dir === 'outline-to-obsidian' || dir === 'bidirectional') {
      for (const doc of fullDocs) {
        const notePath = this.buildPath(doc, collectionNameById, docById);
        const mappedPath = state.outlineIdMap[doc.id];

        // Known doc: updates handled in Obsidian→Outline pass; deletions in deletion pass.
        if (mappedPath) continue;

        const existingIds = pathToOutlineIds.get(notePath) || [];

        if (existingIds.length > 0) {
          state.outlineIdMap[doc.id] = notePath;
          state.pathToOutlineId[notePath] = doc.id;
        } else if (!this.noteExists(notePath)) {
          onProgress?.(`Pulling from Outline: ${notePath}`);
          try {
            await this.writeNote(notePath, doc.text);
            state.outlineIdMap[doc.id] = notePath;
            state.pathToOutlineId[notePath] = doc.id;
            pathToOutlineIds.set(notePath, [doc.id]);
            result.created++;
          } catch (e) {
            result.errors.push(`Write failed for ${notePath}: ${String(e)}`);
          }
        } else {
          state.outlineIdMap[doc.id] = notePath;
          state.pathToOutlineId[notePath] = doc.id;
          pathToOutlineIds.set(notePath, [doc.id]);
        }
      }
    }

    // ── Deletions: Obsidian → Outline ──────────────────────────────────────
    // Uses snapshot keys; rename detection above may have cleared a path from state,
    // so we re-check state[obsPath] before acting.
    // Sort deepest paths first so children are deleted before parents (Outline 403s on parent with children).
    const pathsToDelete = knownPaths
      .filter(obsPath => {
        const outlineId = state.pathToOutlineId[obsPath];
        if (!outlineId || obsidianMap.has(obsPath)) return false;
        // Skip virtual parent docs whose folder still has children in vault
        const folderPrefix = obsPath.replace(/\.md$/, '/');
        return ![...obsidianMap.keys()].some(p => p.startsWith(folderPrefix));
      })
      .sort((a, b) => b.split('/').length - a.split('/').length); // deepest first

    // Capture IDs before the loop clears state — needed for collection cleanup below
    const deletedIds = new Set<string>(
      pathsToDelete
        .map(p => state.pathToOutlineId[p])
        .filter((id): id is string => !!id),
    );

    for (const obsPath of pathsToDelete) {
      const outlineId = state.pathToOutlineId[obsPath];
      if (!outlineId) continue; // may have been cleared by an earlier iteration
      onProgress?.(`Obsidian deleted "${obsPath}" — removing from Outline`);
      try {
        await this.client.deleteDocument(outlineId);
      } catch (e) {
        result.errors.push(`Delete Outline doc failed for "${obsPath}": ${String(e)}`);
        continue; // don't wipe state if delete failed
      }
      delete state.outlineIdMap[outlineId];
      delete state.pathToOutlineId[obsPath];
      delete state.fileHashes[obsPath];
      result.deleted++;
    }

    // ── Empty collection cleanup ────────────────────────────────────────────
    // After document deletions, remove Outline collections that are now empty.
    if (deletedIds.size > 0) {
      const emptyCollections = updatedCollections.filter(col => {
        if (col.name === this.settings.inboxCollection) return false;
        // Only act on collections we actually deleted docs from in this pass
        const hadDeletions = outlineDocsList.some(d => d.collectionId === col.id && deletedIds.has(d.id));
        if (!hadDeletions) return false;
        // Collection is now empty if every one of its docs was deleted
        return outlineDocsList.every(d => d.collectionId !== col.id || deletedIds.has(d.id));
      });
      for (const col of emptyCollections) {
        onProgress?.(`Removing empty collection: ${col.name}`);
        try {
          await this.client.deleteCollection(col.id);
          result.deleted++;
        } catch (e) {
          result.errors.push(`Delete empty collection "${col.name}" failed: ${String(e)}`);
        }
      }
    }

    // ── Deletions: Outline → Obsidian ──────────────────────────────────────
    for (const outlineId of knownIds) {
      const obsPath = state.outlineIdMap[outlineId];
      if (!obsPath || outlineIdSet.has(outlineId)) continue;

      // Skip virtual parent paths — they have no real Obsidian file to delete
      const folderPrefix = obsPath.replace(/\.md$/, '/');
      if ([...obsidianMap.keys()].some(p => p.startsWith(folderPrefix))) {
        delete state.outlineIdMap[outlineId];
        delete state.pathToOutlineId[obsPath];
        continue;
      }

      onProgress?.(`Outline deleted doc — removing Obsidian file "${obsPath}"`);
      try {
        const file = this.app.vault.getAbstractFileByPath(obsPath);
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
          await this.pruneEmptyFolders(obsPath);
        }
      } catch (e) {
        result.errors.push(`Delete Obsidian file failed for "${obsPath}": ${String(e)}`);
        continue; // don't wipe state if delete failed
      }
      delete state.outlineIdMap[outlineId];
      delete state.pathToOutlineId[obsPath];
      delete state.fileHashes[obsPath];
      result.deleted++;
    }

    state.lastSyncTime = Date.now();
    state.firstSyncDone = true;

    return result;
  }

  private async ensureParentDocsForFolders(
    notes: VaultNote[],
    collectionIdByName: Map<string, string>,
    outlineDocByKey: Map<string, OutlineDocument>,
    state: SyncState,
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
      (a, b) => a.split('/').length - b.split('/').length,
    );

    for (const folderPath of sorted) {
      const flatFilePath = `${folderPath}.md`;
      if (notePaths.has(flatFilePath)) continue;
      if (state.pathToOutlineId[flatFilePath]) continue;

      // Don't recreate a virtual parent if all notes in this folder already have valid
      // Outline IDs — parent was deleted from Outline but children were only orphaned.
      const folderNotes = notes.filter(n => n.path.startsWith(folderPath + '/'));
      if (folderNotes.length > 0 && folderNotes.every(n => {
        const id = state.pathToOutlineId[n.path];
        return id !== undefined && outlineIdSet.has(id);
      })) continue;

      const { collectionId, parentDocumentId } = this.collectionFromPath(
        flatFilePath, collectionIdByName, state,
      );
      if (!collectionId) continue;

      const folderTitle = folderPath.split('/').pop()!;
      const adoptKey = `${collectionId}::${folderTitle}`;
      const existing = outlineDocByKey.get(adoptKey);

      if (existing && !state.outlineIdMap[existing.id]) {
        state.outlineIdMap[existing.id] = flatFilePath;
        state.pathToOutlineId[flatFilePath] = existing.id;
      } else if (!existing) {
        try {
          const created = await this.client.createDocument(
            folderTitle, '', collectionId, parentDocumentId,
          );
          state.outlineIdMap[created.id] = flatFilePath;
          state.pathToOutlineId[flatFilePath] = created.id;
        } catch (e) {
          // non-fatal: children will land flat but won't break the sync
        }
      }
    }
  }

  private async ensureCollections(
    notes: VaultNote[],
    collections: OutlineCollection[],
    outlineIdSet: Set<string>,
    onProgress?: (msg: string) => void,
  ): Promise<OutlineCollection[]> {
    const existingNames = new Set(collections.map(c => c.name));
    const folders = new Set<string>();
    const hasRootLevelNotes = notes.some(n => !n.path.includes('/'));

    for (const note of notes) {
      const parts = note.path.split('/');
      if (parts.length > 1) folders.add(parts[0]);
    }

    if (hasRootLevelNotes) {
      folders.add(this.settings.inboxCollection);
    }

    const state = this.settings.syncState;
    const updated = [...collections];
    for (const folder of folders) {
      if (existingNames.has(folder)) continue;

      // Don't recreate a collection whose vault files all map to now-deleted Outline docs.
      // The deletion pass will remove those Obsidian files on this same sync run.
      const folderNotes = notes.filter(n => n.path.startsWith(folder + '/'));
      if (folderNotes.length > 0 && folderNotes.every(n => {
        const id = state.pathToOutlineId[n.path];
        return id !== undefined && !outlineIdSet.has(id);
      })) continue;

      onProgress?.(`Creating Outline collection: ${folder}`);
      try {
        const col = await this.client.createCollection(folder);
        updated.push(col);
        existingNames.add(folder);
      } catch (e) {
        // non-fatal
      }
    }
    return updated;
  }

  private async readVault(): Promise<VaultNote[]> {
    const files = this.app.vault.getMarkdownFiles();
    const notes: VaultNote[] = [];

    for (const file of files) {
      if (this.isIgnored(file.path)) continue;
      const content = await this.app.vault.read(file);
      notes.push({
        file,
        path: file.path,
        title: file.basename,
        content,
        lastModified: file.stat.mtime,
      });
    }

    return notes;
  }

  private isIgnored(filePath: string): boolean {
    return this.settings.ignorePaths.some(
      ignore => filePath === ignore || filePath.startsWith(ignore + '/'),
    );
  }

  private noteExists(notePath: string): boolean {
    return this.app.vault.getAbstractFileByPath(notePath) instanceof TFile;
  }

  private async writeNote(notePath: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.ensureFolder(notePath);
      await this.app.vault.create(notePath, content);
    }
  }

  private async ensureFolder(notePath: string): Promise<void> {
    const parts = notePath.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const folderPath = parts.slice(0, i).join('/');
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }
    }
  }

  /**
   * Build the Obsidian file path for an Outline document.
   * Coexistence pattern: parent notes stay flat, children go into a same-named subfolder.
   * e.g. "Website" (parent) → Collection/Website.md
   *      "Design" (child of Website) → Collection/Website/Design.md
   */
  private buildPath(
    doc: OutlineDocument,
    collectionNameById: Map<string, string>,
    docById: Map<string, OutlineDocument>,
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
  private collectionFromPath(
    notePath: string,
    collectionIdByName: Map<string, string>,
    state: SyncState,
  ): { collectionId?: string; parentDocumentId?: string } {
    const parts = notePath.split('/').filter(Boolean);

    if (parts.length < 2) {
      return { collectionId: collectionIdByName.get(this.settings.inboxCollection) };
    }

    const collectionId = collectionIdByName.get(parts[0]);
    if (!collectionId) return {};

    if (parts.length === 2) {
      return { collectionId };
    }

    // Deep path: Collection/Folder/Note.md
    // Parent is the flat file one level above: Collection/Folder.md
    const parentFolderName = parts[parts.length - 2];
    const parentPath = [...parts.slice(0, -2), `${parentFolderName}.md`].join('/');
    const parentDocId = state.pathToOutlineId[parentPath];

    return { collectionId, parentDocumentId: parentDocId };
  }

  private resolveConflict(note: VaultNote, doc: OutlineDocument): 'obsidian' | 'outline' {
    if (this.settings.conflictResolution === 'obsidian-wins') return 'obsidian';
    if (this.settings.conflictResolution === 'outline-wins') return 'outline';
    const outlineTime = new Date(doc.updatedAt).getTime();
    return note.lastModified > outlineTime ? 'obsidian' : 'outline';
  }

  private async pruneEmptyFolders(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const folderPath = parts.slice(0, i).join('/');
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (folder && 'children' in folder && (folder as any).children.length === 0) {
        await this.app.vault.delete(folder as any);
      } else {
        break;
      }
    }
  }

  private hash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }
}
