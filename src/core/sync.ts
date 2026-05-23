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
  outlineUpdatedAt: Record<string, string>; // outlineId → last-synced updatedAt (ISO); drives change detection
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
    outlineUpdatedAt: {},
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

      const updatedCollections = await this.ensureCollectionsForFolders(obsidianNotes, collections, outlineDocuments);
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
    outlineDocuments: OutlineDocument[],
  ): Promise<OutlineCollection[]> {
    const existingNames = new Set(collections.map(c => c.name));
    const collById = new Map(collections.map(c => [c.id, c]));
    const docCollById = new Map(outlineDocuments.map(d => [d.id, d.collectionId]));
    const allVaultPaths = new Set(notes.map(n => n.path));
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

      const folderNotes = notes.filter(n => n.path.startsWith(folder + '/'));

      // Obsidian-side collection rename: every note in this folder maps to docs in ONE existing
      // collection whose own folder is gone from the vault (all its files moved here). Rename the
      // Outline collection (preserves id/sharing) instead of creating a new one + leaving a ghost.
      const renamedFrom = this.detectRenamedCollection(folder, folderNotes, vaultFolders, docCollById, collById, allVaultPaths);
      if (renamedFrom) {
        this.logger.info(`Collection renamed in Obsidian: "${renamedFrom.name}" → "${folder}"`);
        try {
          const upd = await this.outlineClient.updateCollection(renamedFrom.id, folder);
          renamedFrom.name = upd.name; // reflect new name so later passes use it
          existingNames.add(folder);
          continue;
        } catch (e) {
          this.logger.warn(`Collection rename failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Only create a collection for a folder that holds genuinely NEW (unmapped) notes.
      // If every note here is already known, this is a stale folder name — e.g. the Outline
      // collection was renamed (docs still live under the new name) or deleted. Creating a
      // collection would spawn a ghost; the re-path / deletion passes handle these instead.
      if (folderNotes.length > 0 && folderNotes.every(n =>
        this.syncState.pathToOutlineId[n.path] !== undefined
      )) continue;

      this.logger.info(`Creating collection for new folder: ${folder}`);
      const newCollection = await this.outlineClient.createCollection(folder);
      updated.push(newCollection);
      existingNames.add(folder);
    }

    return updated;
  }

  /**
   * Detect an Obsidian-side collection rename: `folder` is a new top-level folder name, every note
   * in it resolves (via state or last-synced fileHashes) to docs in a SINGLE existing collection C,
   * and C's own name is no longer a vault folder (all its files moved into `folder`). Returns C.
   */
  private detectRenamedCollection(
    folder: string,
    folderNotes: ObsidianNote[],
    vaultFolders: Set<string>,
    docCollById: Map<string, string>,
    collById: Map<string, OutlineCollection>,
    allVaultPaths: Set<string>,
  ): OutlineCollection | undefined {
    if (folderNotes.length === 0) return undefined;

    const collsInvolved = new Set<string>();
    for (const note of folderNotes) {
      // The vault must have MOVED this note here: it can't already be mapped at its current path
      // (that would mean only Outline's collection name changed — an Outline-side rename, which
      // the Outline→Obsidian pass handles; renaming the collection back here would fight it).
      if (this.syncState.pathToOutlineId[note.path]) return undefined;
      const h = this.hashContent(note.content);
      let docId: string | undefined;
      for (const [oldPath, oh] of Object.entries(this.syncState.fileHashes)) {
        if (oh === h && oldPath !== note.path && !allVaultPaths.has(oldPath)) {
          docId = this.syncState.pathToOutlineId[oldPath];
          break;
        }
      }
      const cid = docId ? docCollById.get(docId) : undefined;
      if (!cid) return undefined; // a genuinely new note here → not a pure rename
      collsInvolved.add(cid);
    }
    if (collsInvolved.size !== 1) return undefined;
    const col = collById.get([...collsInvolved][0]);
    if (!col || col.name === folder) return undefined;
    // Only a rename if the old collection's folder is gone from the vault (everything moved out).
    if (vaultFolders.has(col.name)) return undefined;
    return col;
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
      // Per-doc change detection: compare against the updatedAt we last synced for this doc.
      // Robust against the sync's own writes and Outline-side content normalisation (idempotent).
      const lastSeen = this.syncState.outlineUpdatedAt[doc.id];
      const changedSinceLastSync = !lastSeen || doc.updatedAt !== lastSeen;

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
        // text:'' marks this as a stub; the Obsidian→Outline pass detects this
        // and falls back to fileHashes for change detection instead of content diff.
        const stub: OutlineDocument = { ...doc, text: '' };
        fullOutlineDocs.push(stub);
        docById.set(doc.id, stub);
        outlineDocByKey.set(`${doc.collectionId}::${doc.title}`, stub);
      }
    }

    const obsidianMap = new Map(obsidianNotes.map(n => [n.path, n]));
    const outlineIdSet = new Set(outlineDocuments.map(d => d.id));

    // Source of truth for the post-sync outlineUpdatedAt state. Seed with the values we just
    // observed; overwrite with the API-response updatedAt at each write site so the next sync
    // sees the doc as unchanged (idempotent — survives Outline-side content normalisation).
    const freshUpdatedAt = new Map<string, string>();
    for (const [id, d] of docById) freshUpdatedAt.set(id, d.updatedAt);

    // Snapshot keys before any state mutations so rename detection can release them first
    const knownPaths = Object.keys(this.syncState.pathToOutlineId);
    const knownIds = Object.keys(this.syncState.outlineIdMap);

    // Ensure virtual parent docs exist for pure-folder hierarchies before main loop
    await this.ensureParentDocsForFolders(obsidianNotes, collectionIdByName, outlineDocByKey, outlineIdSet, freshUpdatedAt, docById);

    // ── Obsidian → Outline ──────────────────────────────────────────────────
    // Sort by path depth so parent flat-files are processed before their children
    const sortedNotes = [...obsidianNotes].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length
    );

    for (const note of sortedNotes) {
      const knownOutlineId = this.syncState.pathToOutlineId[note.path];
      const outlineDoc = knownOutlineId ? docById.get(knownOutlineId) : undefined;
      // Tracks the content the local file ends up with this run; when Outline wins a
      // conflict we overwrite the file, so fileHashes must reflect that — not note.content.
      let localContent = note.content;

      if (!outlineDoc) {
        // Doc was known but is no longer in Outline (e.g. collection deleted) → skip,
        // the Outline→Obsidian deletion pass will remove the local file.
        if (knownOutlineId && !outlineIdSet.has(knownOutlineId)) continue;

        const noteHash = this.hashContent(note.content);
        // Rename detection: a path we knew last sync is gone, and a new note has the same
        // content. Primary signal is our own last-synced fileHashes (works even when the
        // Outline doc is an unchanged stub); fall back to a freshly-fetched doc's text hash.
        let renamedFromId: string | undefined;
        let renamedFromPath: string | undefined;
        for (const [oldPath, h] of Object.entries(this.syncState.fileHashes)) {
          if (h === noteHash && oldPath !== note.path && !obsidianMap.has(oldPath)) {
            const id = this.syncState.pathToOutlineId[oldPath];
            if (id && outlineIdSet.has(id)) { renamedFromId = id; renamedFromPath = oldPath; break; }
          }
        }
        if (!renamedFromId) {
          const byText = hashToOutlineId.get(noteHash);
          const byTextPath = byText ? this.syncState.outlineIdMap[byText] : undefined;
          if (byText && byTextPath && byTextPath !== note.path && !obsidianMap.has(byTextPath)) {
            renamedFromId = byText; renamedFromPath = byTextPath;
          }
        }

        if (renamedFromId && renamedFromPath && renamedFromPath !== note.path) {
          this.logger.info(`Rename detected: "${renamedFromPath}" → "${note.path}"`);
          const renamed = await this.outlineClient.updateDocument(renamedFromId, note.content, note.title);
          this.syncState.outlineIdMap[renamedFromId] = note.path;
          this.syncState.pathToOutlineId[note.path] = renamedFromId;
          delete this.syncState.pathToOutlineId[renamedFromPath];
          delete this.syncState.fileHashes[renamedFromPath];
          freshUpdatedAt.set(renamedFromId, renamed.updatedAt);
          docById.set(renamed.id, renamed);
          result.renamed++;
          // If the new path also lands in a different collection/parent (file moved between
          // folders, not just renamed in place), move the Outline doc to match (Gap 2).
          const { collectionId: tgtColl, parentDocumentId: tgtParent } =
            this.extractCollectionAndParentFromPath(note.path, collectionIdByName);
          const pathImpliesParent = note.path.split('/').filter(p => p).length > 2;
          const parentResolved = !pathImpliesParent || tgtParent !== undefined;
          if (tgtColl && parentResolved &&
              (tgtColl !== renamed.collectionId || tgtParent !== (renamed.parentDocumentId ?? undefined))) {
            this.logger.info(`Moving renamed doc to new location for "${note.path}"`);
            const moved = await this.outlineClient.moveDocument(renamedFromId, tgtColl, tgtParent);
            if (moved) { freshUpdatedAt.set(renamedFromId, moved.updatedAt); docById.set(moved.id, moved); }
          }
        } else {
          const { collectionId, parentDocumentId } = this.extractCollectionAndParentFromPath(
            note.path, collectionIdByName
          );
          if (!collectionId) {
            this.logger.warn(`No collection for "${note.path}" — skipping`);
            continue;
          }

          // Adopt existing doc instead of duplicating (index file = same doc as flat).
          // Also adopt when the mapped path no longer exists in Obsidian — both sides
          // renamed independently and content changed so hash detection missed it.
          const adoptKey = `${collectionId}::${note.title}`;
          const existing = outlineDocByKey.get(adoptKey);
          const existingMappedPath = existing ? this.syncState.outlineIdMap[existing.id] : undefined;
          const canAdopt = existing && (!existingMappedPath || !obsidianMap.has(existingMappedPath));
          if (canAdopt && existing) {
            this.logger.info(`Adopting existing Outline doc for "${note.path}"`);
            if (existingMappedPath) {
              delete this.syncState.pathToOutlineId[existingMappedPath];
              delete this.syncState.fileHashes[existingMappedPath];
            }
            this.syncState.outlineIdMap[existing.id] = note.path;
            this.syncState.pathToOutlineId[note.path] = existing.id;
            // Reconcile content: both sides may have diverged before the re-link.
            // Without this the two stay permanently out of sync on body content.
            if (existing.text !== '' && this.hashContent(note.content) !== this.hashContent(existing.text)) {
              const resolvedNote = this.resolveConflict(note, existing);
              if (resolvedNote === note) {
                const upd = await this.outlineClient.updateDocument(existing.id, note.content, note.title);
                freshUpdatedAt.set(existing.id, upd.updatedAt);
                docById.set(upd.id, upd);
              } else {
                await this.obsidianReader.writeNote(note.path, resolvedNote.content);
                localContent = resolvedNote.content;
              }
              result.updated++;
            }
          } else {
            const created = await this.outlineClient.createDocument(
              note.title, note.content, collectionId, parentDocumentId
            );
            this.syncState.outlineIdMap[created.id] = note.path;
            this.syncState.pathToOutlineId[note.path] = created.id;
            freshUpdatedAt.set(created.id, created.updatedAt);
            docById.set(created.id, created);
            result.created++;
          }
        }
      } else {
        const noteHash = this.hashContent(note.content);
        let contentUpdated = false;

        if (outlineDoc.text !== '') {
          const outlineHash = this.hashContent(outlineDoc.text);
          const titleChanged = note.title !== outlineDoc.title;
          // Outline-only rename: title changed, local content matches its last-synced hash
          // (= user didn't touch the local file). Skip conflict resolution; the Outline→Obsidian
          // re-path below will move the file to the new name. Prevents pushing old title back.
          const localUnchanged = this.syncState.fileHashes[note.path] === noteHash;
          const outlineOnlyRename = titleChanged && noteHash === outlineHash && localUnchanged;

          if (!outlineOnlyRename && (noteHash !== outlineHash || titleChanged)) {
            const resolvedNote = this.resolveConflict(note, outlineDoc);
            if (resolvedNote === note) {
              const upd = await this.outlineClient.updateDocument(outlineDoc.id, note.content, note.title);
              freshUpdatedAt.set(outlineDoc.id, upd.updatedAt);
              docById.set(upd.id, upd);
            } else {
              await this.obsidianReader.writeNote(note.path, resolvedNote.content);
              localContent = resolvedNote.content;
            }
            result.updated++;
            contentUpdated = true;
          }
        } else {
          // Stub: Outline unchanged since last sync — push Obsidian changes if any
          const lastKnownHash = this.syncState.fileHashes[note.path];
          if (lastKnownHash && noteHash !== lastKnownHash) {
            const upd = await this.outlineClient.updateDocument(outlineDoc.id, note.content, note.title);
            freshUpdatedAt.set(outlineDoc.id, upd.updatedAt);
            docById.set(upd.id, upd);
            result.updated++;
            contentUpdated = true;
          }
        }

        // Move document if parent has changed (e.g. flat docs from first sync).
        // NOTE: only the PARENT is compared here, never the collection. A mapped note keeps the
        // same path, so a collection mismatch means Outline moved the doc — that must be PULLED
        // (handled in the Outline→Obsidian re-path), not pushed back here. Obsidian-side moves
        // change the path and go through rename detection (which does its own move, Gap 2).
        // Only move when the target is unambiguous: if the path implies a parent (deep path)
        // but it isn't resolvable yet, skip rather than relocate to root.
        const { collectionId: expectedCollection, parentDocumentId: expectedParent } =
          this.extractCollectionAndParentFromPath(note.path, collectionIdByName);
        const currentParent = outlineDoc.parentDocumentId ?? undefined;
        const pathImpliesParent = note.path.split('/').filter(p => p).length > 2;
        const parentResolved = !pathImpliesParent || expectedParent !== undefined;
        if (expectedCollection && expectedCollection === outlineDoc.collectionId &&
            parentResolved && expectedParent !== currentParent) {
          this.logger.info(`Moving "${note.path}" to correct parent in Outline`);
          const moved = await this.outlineClient.moveDocument(outlineDoc.id, expectedCollection, expectedParent);
          if (moved) { freshUpdatedAt.set(outlineDoc.id, moved.updatedAt); docById.set(moved.id, moved); }
          if (!contentUpdated) result.updated++;
        }
      }

      this.syncState.fileHashes[note.path] = this.hashContent(localContent);
    }

    // ── Outline → Obsidian (create/update) ─────────────────────────────────

    for (const rawDoc of fullOutlineDocs) {
      // Use the freshest version of the doc: our own Obsidian→Outline writes earlier this run
      // may have changed its title/parent, which must be reflected when computing the path.
      const outlineDoc = docById.get(rawDoc.id) ?? rawDoc;
      const notePath = this.buildObsidianPath(outlineDoc, collectionNameById, docById);
      const mappedPath = this.syncState.outlineIdMap[outlineDoc.id];

      // Known doc: content updates handled in Obsidian→Outline pass; deletions in deletion pass.
      // But if the doc moved collection/parent/title in Outline, its computed path now differs
      // from where the local file lives — relocate it.
      //  - sameName (folder move only): always safe.
      //  - title change (different filename): only safe when the local file is unchanged since
      //    last sync (otherwise it's a real conflict, leave it to conflict resolution).
      if (mappedPath) {
        const localNote = obsidianMap.get(mappedPath);
        const hasFile = localNote !== undefined;
        const sameName = mappedPath.split('/').pop() === notePath.split('/').pop();
        const localUnchanged = hasFile &&
          this.syncState.fileHashes[mappedPath] === this.hashContent(localNote.content);
        // Safe to re-path when: no real file (virtual parent), pure folder move (sameName),
        // or real file unchanged locally (so a title rename doesn't lose user edits).
        const canRepath = mappedPath !== notePath
          && (!hasFile || sameName || localUnchanged)
          && !this.syncState.pathToOutlineId[notePath];
        if (canRepath) {
          try {
            if (await this.obsidianReader.noteExists(mappedPath)) {
              await this.obsidianReader.moveNote(mappedPath, notePath);
            }
            this.syncState.outlineIdMap[outlineDoc.id] = notePath;
            delete this.syncState.pathToOutlineId[mappedPath];
            this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
            if (this.syncState.fileHashes[mappedPath] !== undefined) {
              this.syncState.fileHashes[notePath] = this.syncState.fileHashes[mappedPath];
              delete this.syncState.fileHashes[mappedPath];
            }
            this.logger.info(`Outline moved doc — relocating "${mappedPath}" → "${notePath}"`);
            result.renamed++;
          } catch (e) {
            this.logger.warn(`Re-path failed for "${mappedPath}" → "${notePath}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        continue;
      }

      const existingIds = pathToOutlineIds.get(notePath) || [];
      if (existingIds.length > 0) {
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
      } else if (!await this.obsidianReader.noteExists(notePath)) {
        await this.obsidianReader.writeNote(notePath, outlineDoc.text);
        this.syncState.outlineIdMap[outlineDoc.id] = notePath;
        this.syncState.pathToOutlineId[notePath] = outlineDoc.id;
        this.syncState.fileHashes[notePath] = this.hashContent(outlineDoc.text);
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
    // Outline returns 403 when you delete a parent that still has children — deepest first avoids that.
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

    // Rebuild per-doc updatedAt from the freshest values. Entries for deleted docs drop out
    // automatically because they're no longer in outlineIdMap. This is what makes the next
    // sync a no-op for everything we just reconciled.
    const rebuiltUpdatedAt: Record<string, string> = {};
    for (const id of Object.keys(this.syncState.outlineIdMap)) {
      const ts = freshUpdatedAt.get(id);
      if (ts) rebuiltUpdatedAt[id] = ts;
    }
    this.syncState.outlineUpdatedAt = rebuiltUpdatedAt;

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
      parts.unshift(this.sanitizeTitleForPath(parent.title));
      parentId = parent.parentDocumentId;
    }

    const collectionName = collectionNameById.get(doc.collectionId) ?? 'Unsorted';
    parts.unshift(collectionName);
    parts.push(`${this.sanitizeTitleForPath(doc.title)}.md`);

    return parts.join('/');
  }

  // Replace characters that are invalid in file paths (notably '/', which would otherwise
  // create unintended subfolders and break the path↔doc round-trip).
  private sanitizeTitleForPath(title: string): string {
    return title.replace(/[/\\:*?"<>|]/g, '-').trim() || 'Untitled';
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
    freshUpdatedAt: Map<string, string>,
    docById: Map<string, OutlineDocument>,
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
        freshUpdatedAt.set(existing.id, existing.updatedAt);
      } else if (!existing) {
        this.logger.info(`Creating virtual parent doc for folder: "${folderPath}"`);
        const created = await this.outlineClient.createDocument(
          folderTitle, '', collectionId, parentDocumentId
        );
        this.syncState.outlineIdMap[created.id] = flatFilePath;
        this.syncState.pathToOutlineId[flatFilePath] = created.id;
        freshUpdatedAt.set(created.id, created.updatedAt);
        docById.set(created.id, created);
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
          // Backwards-compat: older state files lack pathToOutlineId, rebuild from outlineIdMap.
          pathToOutlineId: raw.pathToOutlineId ??
            Object.fromEntries(Object.entries(raw.outlineIdMap ?? {}).map(([id, p]) => [p, id])),
          // Backwards-compat: older state files lack outlineUpdatedAt → empty triggers one full resync.
          outlineUpdatedAt: raw.outlineUpdatedAt ?? {},
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
