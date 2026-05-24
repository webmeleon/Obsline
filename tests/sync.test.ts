import { SyncEngine } from '../src/core/sync';
import { ObslineConfig } from '../src/utils/config';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

jest.mock('../src/core/obsidian');
jest.mock('../src/core/outline');

import { ObsidianReader } from '../src/core/obsidian';
import { OutlineClient, OutlineDocument, OutlineCollection } from '../src/core/outline';

const mockObsidianReader = ObsidianReader as jest.MockedClass<typeof ObsidianReader>;
const mockOutlineClient = OutlineClient as jest.MockedClass<typeof OutlineClient>;

// ── Idempotency test helpers ──────────────────────────────────────────────
// Store-backed mocks so a second sync() sees the realistic post-sync state of
// both sides. Mutations bump a monotonic updatedAt, mimicking Outline.

function makeOutlineStore(seedNormalize = false) {
  const store = new Map<string, OutlineDocument>();
  const collections = new Map<string, OutlineCollection>();
  const attachments = new Map<string, { id: string; data: Buffer; contentType: string }>();
  let clock = 1000;
  let seq = 0;
  let attSeq = 0;
  const nextTs = () => new Date(clock++ * 1000).toISOString();
  // Optional: simulate Outline normalising body content on write (trailing newline).
  const norm = (t: string) => (seedNormalize && t ? `${t}\n` : t);

  const client = {
    downloadAttachment: jest.fn(async (id: string) => {
      const a = attachments.get(id);
      if (!a) throw new Error(`no attachment ${id}`);
      return { data: a.data, contentType: a.contentType };
    }),
    createAttachment: jest.fn(async (name: string, contentType: string, _size: number, _documentId?: string) => {
      const id = `att-${++attSeq}`;
      attachments.set(id, { id, data: Buffer.alloc(0), contentType });
      return {
        uploadUrl: `https://s3.example.com/upload/${id}`,
        form: { key: id },
        attachment: { id, url: `/api/attachments.redirect?id=${id}`, name, contentType },
      };
    }),
    uploadAttachment: jest.fn(async (uploadUrl: string, _form: any, data: Buffer, contentType: string, _fileName: string) => {
      const id = uploadUrl.split('/').pop()!;
      const rec = attachments.get(id)!;
      rec.data = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      rec.contentType = contentType;
    }),
    deleteAttachment: jest.fn(async (id: string) => { attachments.delete(id); }),
    listDocuments: jest.fn(async () => [...store.values()].map(d => ({ ...d, text: '' }))),
    listCollections: jest.fn(async () => [...collections.values()]),
    getDocument: jest.fn(async (id: string) => ({ ...store.get(id)! })),
    createDocument: jest.fn(async (title: string, text: string, collectionId?: string, parentDocumentId?: string) => {
      const id = `doc-${++seq}`;
      const doc: OutlineDocument = {
        id, title, text: norm(text), updatedAt: nextTs(),
        collectionId: collectionId ?? '', parentDocumentId: parentDocumentId ?? null, published: true,
      };
      store.set(id, doc);
      return { ...doc };
    }),
    updateDocument: jest.fn(async (id: string, text: string, title?: string) => {
      const doc = store.get(id)!;
      doc.text = norm(text);
      if (title) doc.title = title;
      doc.updatedAt = nextTs();
      return { ...doc };
    }),
    moveDocument: jest.fn(async (id: string, collectionId: string, parentDocumentId?: string) => {
      const doc = store.get(id)!;
      doc.collectionId = collectionId;
      doc.parentDocumentId = parentDocumentId ?? null;
      doc.updatedAt = nextTs();
      return { ...doc };
    }),
    deleteDocument: jest.fn(async (id: string) => { store.delete(id); }),
    createCollection: jest.fn(async (name: string) => {
      const c: OutlineCollection = { id: `col-${name}`, name, description: null };
      collections.set(c.id, c);
      return c;
    }),
    updateCollection: jest.fn(async (id: string, name: string) => {
      const c = collections.get(id)!;
      c.name = name;
      return { ...c };
    }),
    deleteCollection: jest.fn(async (id: string) => { collections.delete(id); }),
    testConnection: jest.fn(async () => true),
  };
  return { store, collections, attachments, client };
}

function makeVaultStore() {
  const files = new Map<string, string>();
  const binaries = new Map<string, Buffer>();
  const reader = {
    readVault: jest.fn(async () => [...files.entries()].map(([p, content]) => ({
      path: p,
      title: p.split('/').pop()!.replace(/\.md$/, ''),
      content,
      lastModified: Date.now(),
    }))),
    readNote: jest.fn(),
    writeNote: jest.fn(async (p: string, content: string) => { files.set(p, content); }),
    // Existence covers notes AND attachment binaries (used by attachment allocation/dedup).
    noteExists: jest.fn(async (p: string) => files.has(p) || binaries.has(p)),
    deleteNote: jest.fn(async (p: string) => { files.delete(p); }),
    moveNote: jest.fn(async (oldP: string, newP: string) => {
      if (files.has(oldP)) { files.set(newP, files.get(oldP)!); files.delete(oldP); }
    }),
    readBinary: jest.fn(async (p: string) => binaries.get(p)!),
    writeBinary: jest.fn(async (p: string, data: Buffer) => { binaries.set(p, data); }),
    listAllFiles: jest.fn(async () => [...files.keys(), ...binaries.keys()]),
    resolveAttachment: jest.fn(async (target: string, sourcePath: string) => {
      // Mirror the engine's heuristic enough for tests: verbatim, then by basename.
      if (binaries.has(target)) return target;
      const name = target.split('/').pop()!;
      const hit = [...binaries.keys()].find(p => p.split('/').pop() === name);
      return hit;
    }),
  };
  return { files, binaries, reader };
}

function clearWriteMocks(client: ReturnType<typeof makeOutlineStore>['client'], reader: ReturnType<typeof makeVaultStore>['reader']) {
  client.createDocument.mockClear();
  client.updateDocument.mockClear();
  client.moveDocument.mockClear();
  client.deleteDocument.mockClear();
  client.createCollection.mockClear();
  client.updateCollection.mockClear();
  client.deleteCollection.mockClear();
  client.getDocument.mockClear();
  client.downloadAttachment.mockClear();
  client.createAttachment.mockClear();
  client.uploadAttachment.mockClear();
  client.deleteAttachment.mockClear();
  reader.writeNote.mockClear();
  reader.deleteNote.mockClear();
  reader.writeBinary.mockClear();
}

function expectNoWrites(client: ReturnType<typeof makeOutlineStore>['client'], reader: ReturnType<typeof makeVaultStore>['reader']) {
  expect(client.createDocument).not.toHaveBeenCalled();
  expect(client.updateDocument).not.toHaveBeenCalled();
  expect(client.moveDocument).not.toHaveBeenCalled();
  expect(client.deleteDocument).not.toHaveBeenCalled();
  expect(client.createCollection).not.toHaveBeenCalled();
  expect(client.updateCollection).not.toHaveBeenCalled();
  expect(client.deleteCollection).not.toHaveBeenCalled();
  expect(client.downloadAttachment).not.toHaveBeenCalled();
  expect(client.createAttachment).not.toHaveBeenCalled();
  expect(client.uploadAttachment).not.toHaveBeenCalled();
  expect(client.deleteAttachment).not.toHaveBeenCalled();
  expect(reader.writeNote).not.toHaveBeenCalled();
  expect(reader.deleteNote).not.toHaveBeenCalled();
  expect(reader.writeBinary).not.toHaveBeenCalled();
}

describe('SyncEngine', () => {
  let syncEngine: SyncEngine;
  let config: ObslineConfig;
  let tempVault: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsline-sync-test-'));
    // Isolate state I/O: sync() persists to $HOME/.obsline — never touch the real one.
    realHome = process.env.HOME;
    process.env.HOME = tempVault;

    config = {
      obsidianVault: tempVault,
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'test-token',
      syncInterval: 300,
      conflictResolution: 'last-write-wins',
      ignorePaths: [],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    mockObsidianReader.mockClear();
    mockOutlineClient.mockClear();

    const mockReaderInstance = {
      readVault: jest.fn().mockResolvedValue([]),
      readNote: jest.fn(),
      writeNote: jest.fn(),
      noteExists: jest.fn(),
      deleteNote: jest.fn(),
      listAllFiles: jest.fn().mockResolvedValue([]),
      readBinary: jest.fn(),
      writeBinary: jest.fn(),
    };

    const mockClientInstance = {
      listDocuments: jest.fn().mockResolvedValue([]),
      listCollections: jest.fn().mockResolvedValue([{ id: 'col-1', name: 'ToDo', description: null }]),
      getDocument: jest.fn(),
      createDocument: jest.fn(),
      updateDocument: jest.fn(),
      deleteDocument: jest.fn(),
      createCollection: jest.fn(),
      downloadAttachment: jest.fn(),
      createAttachment: jest.fn(),
      uploadAttachment: jest.fn(),
      testConnection: jest.fn().mockResolvedValue(true),
    };

    mockObsidianReader.mockImplementation(() => mockReaderInstance as any);
    mockOutlineClient.mockImplementation(() => mockClientInstance as any);

    syncEngine = new SyncEngine(config);
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await fs.remove(tempVault);
  });

  test('should initialize with config', () => {
    expect(syncEngine.getLastSyncTime()).toBe(0);
    expect(syncEngine.getSyncState().fileHashes).toEqual({});
  });

  test('should sync empty vault and outline', async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tempVault;
    try {
      const result = await syncEngine.sync();
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test('should create outline document for new obsidian note in a folder', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    const note = {
      path: 'ToDo/test.md',
      title: 'test',
      content: 'Test content',
      lastModified: Date.now(),
    };

    mockReaderInstance.readVault.mockResolvedValue([note]);
    mockClientInstance.createDocument.mockResolvedValue({
      id: 'doc-1',
      title: 'test',
      text: 'Test content',
      updatedAt: new Date().toISOString(),
      collectionId: 'col-1',
      parentDocumentId: null,
      published: true,
    });

    const result = await syncEngine.sync();

    expect(result.created).toBe(1);
    expect(mockClientInstance.createDocument).toHaveBeenCalledWith('test', 'Test content', 'col-1', undefined);
  });

  test('should sync root-level notes to Inbox collection', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    mockClientInstance.listCollections.mockResolvedValue([]);
    mockClientInstance.createCollection.mockResolvedValue({ id: 'col-inbox', name: 'Inbox', description: null });
    mockClientInstance.createDocument.mockResolvedValue({
      id: 'doc-inbox-1',
      title: 'test',
      text: 'Test content',
      updatedAt: new Date().toISOString(),
      collectionId: 'col-inbox',
      parentDocumentId: null,
      published: true,
    });

    mockReaderInstance.readVault.mockResolvedValue([{
      path: 'test.md',
      title: 'test',
      content: 'Test content',
      lastModified: Date.now(),
    }]);

    const result = await syncEngine.sync();

    expect(mockClientInstance.createCollection).toHaveBeenCalledWith('Inbox');
    expect(result.created).toBe(1);
    expect(mockClientInstance.createDocument).toHaveBeenCalledWith('test', 'Test content', 'col-inbox', undefined);
  });

  test('should handle sync errors gracefully', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    mockReaderInstance.readVault.mockRejectedValue(new Error('Vault read failed'));

    await expect(syncEngine.sync()).rejects.toThrow('Vault read failed');
  });

  test('should use last-write-wins conflict resolution by default', async () => {
    expect(config.conflictResolution).toBe('last-write-wins');
  });

  test('should support obsidian-wins conflict resolution', async () => {
    const obsidianWinsConfig = { ...config, conflictResolution: 'obsidian-wins' as const };
    const obsidianWinsSyncEngine = new SyncEngine(obsidianWinsConfig);
    expect(obsidianWinsSyncEngine).toBeDefined();
  });

  test('should support outline-wins conflict resolution', async () => {
    const outlineWinsConfig = { ...config, conflictResolution: 'outline-wins' as const };
    const outlineWinsSyncEngine = new SyncEngine(outlineWinsConfig);
    expect(outlineWinsSyncEngine).toBeDefined();
  });

  test('should create document in correct collection for folder-based note', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    const note = {
      path: 'ToDo/My Task.md',
      title: 'My Task',
      content: 'Task content',
      lastModified: Date.now(),
    };

    mockReaderInstance.readVault.mockResolvedValue([note]);
    mockClientInstance.createDocument.mockResolvedValue({
      id: 'doc-2',
      title: 'My Task',
      text: 'Task content',
      updatedAt: new Date().toISOString(),
      collectionId: 'col-1',
      parentDocumentId: null,
      published: true,
    });

    const result = await syncEngine.sync();

    expect(result.created).toBe(1);
    expect(mockClientInstance.createDocument).toHaveBeenCalledWith(
      'My Task', 'Task content', 'col-1', undefined
    );
  });

  test('should create new collection for unknown folder', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    const note = {
      path: 'NewFolder/Note.md',
      title: 'Note',
      content: 'Content',
      lastModified: Date.now(),
    };

    mockReaderInstance.readVault.mockResolvedValue([note]);
    mockClientInstance.listCollections.mockResolvedValue([]);
    mockClientInstance.createCollection.mockResolvedValue({
      id: 'col-new',
      name: 'NewFolder',
      description: null,
    });
    mockClientInstance.createDocument.mockResolvedValue({
      id: 'doc-3',
      title: 'Note',
      text: 'Content',
      updatedAt: new Date().toISOString(),
      collectionId: 'col-new',
      parentDocumentId: null,
      published: true,
    });

    const result = await syncEngine.sync();

    expect(mockClientInstance.createCollection).toHaveBeenCalledWith('NewFolder');
    expect(result.created).toBe(1);
  });

  test('should detect renames via content hash', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    // Redirect HOME so loadSyncState finds no file and won't overwrite test state
    const originalHome = process.env.HOME;
    process.env.HOME = tempVault;

    try {
      const content = 'Same content';
      const now = Date.now();
      const isoNow = new Date(now).toISOString();

      const existingDoc = {
        id: 'doc-rename',
        title: 'Old Title',
        text: content,
        updatedAt: isoNow,
        collectionId: 'col-1',
        parentDocumentId: null,
        published: true,
      };

      mockClientInstance.listDocuments.mockResolvedValue([existingDoc]);
      mockClientInstance.getDocument.mockResolvedValue(existingDoc);
      mockClientInstance.updateDocument.mockResolvedValue({ ...existingDoc, title: 'New Title' });

      // Inject pre-existing state: old path was tracked in Outline
      const engine = syncEngine as any;
      engine.syncState.outlineIdMap['doc-rename'] = 'ToDo/Old Title.md';
      engine.syncState.pathToOutlineId['ToDo/Old Title.md'] = 'doc-rename';

      const renamedNote = {
        path: 'ToDo/New Title.md',
        title: 'New Title',
        content,
        lastModified: now,
      };

      mockReaderInstance.readVault.mockResolvedValue([renamedNote]);
      mockReaderInstance.noteExists.mockResolvedValue(false);

      const result = await syncEngine.sync();

      expect(result.renamed).toBe(1);
      expect(mockClientInstance.updateDocument).toHaveBeenCalledWith('doc-rename', content, 'New Title');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test('should set parentDocumentId for nested Obsidian notes (coexistence pattern)', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    const originalHome = process.env.HOME;
    process.env.HOME = tempVault;

    try {
      // With coexistence: parent is flat (ToDo/Website.md), child in subfolder (ToDo/Website/Design.md)
      const parentNote = {
        path: 'ToDo/Website.md',
        title: 'Website',
        content: 'Website overview',
        lastModified: Date.now(),
      };
      const childNote = {
        path: 'ToDo/Website/Design.md',
        title: 'Design',
        content: 'Design content',
        lastModified: Date.now(),
      };

      // Depth sort ensures parent (depth 2) is processed before child (depth 3)
      mockReaderInstance.readVault.mockResolvedValue([childNote, parentNote]);

      const parentDocId = 'doc-website';
      mockClientInstance.createDocument
        .mockResolvedValueOnce({
          id: parentDocId,
          title: 'Website',
          text: 'Website overview',
          updatedAt: new Date().toISOString(),
          collectionId: 'col-1',
          parentDocumentId: null,
          published: true,
        })
        .mockResolvedValueOnce({
          id: 'doc-design',
          title: 'Design',
          text: 'Design content',
          updatedAt: new Date().toISOString(),
          collectionId: 'col-1',
          parentDocumentId: parentDocId,
          published: true,
        });

      const result = await syncEngine.sync();

      expect(result.created).toBe(2);
      // Parent (flat file) must be created first, without parentDocumentId
      expect(mockClientInstance.createDocument).toHaveBeenNthCalledWith(
        1, 'Website', 'Website overview', 'col-1', undefined,
      );
      // Child must reference parent via state lookup of ToDo/Website.md
      expect(mockClientInstance.createDocument).toHaveBeenNthCalledWith(
        2, 'Design', 'Design content', 'col-1', parentDocId,
      );
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test('should use coexistence pattern for Outline docs: parent flat, children in subfolder', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    const originalHome = process.env.HOME;
    process.env.HOME = tempVault;

    try {
      mockReaderInstance.readVault.mockResolvedValue([]);
      mockReaderInstance.noteExists.mockResolvedValue(false);
      mockReaderInstance.writeNote.mockResolvedValue(undefined);

      const parentDoc = {
        id: 'doc-parent',
        title: 'Website',
        text: 'Parent content',
        updatedAt: new Date().toISOString(),
        collectionId: 'col-1',
        parentDocumentId: null,
        published: true,
      };
      const childDoc = {
        id: 'doc-child',
        title: 'Design',
        text: 'Child content',
        updatedAt: new Date().toISOString(),
        collectionId: 'col-1',
        parentDocumentId: 'doc-parent',
        published: true,
      };

      mockClientInstance.listDocuments.mockResolvedValue([parentDoc, childDoc]);
      mockClientInstance.getDocument
        .mockResolvedValueOnce(parentDoc)
        .mockResolvedValueOnce(childDoc);

      const result = await syncEngine.sync();

      expect(result.created).toBe(2);
      // Parent stays flat — no index-file duplication
      expect(mockReaderInstance.writeNote).toHaveBeenCalledWith(
        'ToDo/Website.md', 'Parent content',
      );
      // Child goes into subfolder named after parent
      expect(mockReaderInstance.writeNote).toHaveBeenCalledWith(
        'ToDo/Website/Design.md', 'Child content',
      );
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe('SyncEngine idempotency', () => {
  let tempVault: string;
  let originalHome: string | undefined;
  let config: ObslineConfig;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsline-idem-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempVault; // no sync-state.json here; state round-trips via this dir
    config = {
      obsidianVault: tempVault,
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'test-token',
      syncInterval: 300,
      conflictResolution: 'last-write-wins',
      ignorePaths: [],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };
    mockObsidianReader.mockClear();
    mockOutlineClient.mockClear();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.remove(tempVault);
  });

  function wire(store: ReturnType<typeof makeOutlineStore>, vault: ReturnType<typeof makeVaultStore>) {
    mockObsidianReader.mockImplementation(() => vault.reader as any);
    mockOutlineClient.mockImplementation(() => store.client as any);
    return new SyncEngine(config);
  }

  test('Obsidian→Outline create, then second sync is a no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/test.md', 'Test content');
    const engine = wire(store, vault);

    const r1 = await engine.sync();
    expect(r1.created).toBe(1);

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();

    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Outline→Obsidian pull, then second sync is a no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    store.collections.set('col-ToDo', { id: 'col-ToDo', name: 'ToDo', description: null });
    store.store.set('docP', {
      id: 'docP', title: 'Pulled', text: 'pcontent',
      updatedAt: new Date(900 * 1000).toISOString(),
      collectionId: 'col-ToDo', parentDocumentId: null, published: true,
    });
    const engine = wire(store, vault);

    const r1 = await engine.sync();
    expect(r1.created).toBe(1);
    expect(vault.files.get('ToDo/Pulled.md')).toBe('pcontent');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();

    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('nested coexistence structure is stable on re-sync', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/Website.md', 'Website overview');
    vault.files.set('ToDo/Website/Design.md', 'Design content');
    const engine = wire(store, vault);

    const r1 = await engine.sync();
    expect(r1.created).toBe(2);

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();

    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Outline-side content normalisation does not cause re-push', async () => {
    // createDocument/updateDocument store text + "\n"; without per-doc updatedAt tracking
    // the next sync would re-fetch and re-push forever. With tracking it stays a stub.
    const store = makeOutlineStore(true);
    const vault = makeVaultStore();
    vault.files.set('ToDo/norm.md', 'hello');
    const engine = wire(store, vault);

    await engine.sync();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();

    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
    // The unchanged doc must not even be re-fetched.
    expect(store.client.getDocument).not.toHaveBeenCalled();
  });

  test('both sides renamed with diverging content: reconciles once, no notebook deletion, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/Old.md', 'v1');
    const engine = wire(store, vault);

    // Sync 1: create "Old"
    await engine.sync();
    const docId = [...store.store.keys()][0];
    expect(store.store.get(docId)!.title).toBe('Old');

    // Independent rename on BOTH sides + content change on the Obsidian side
    store.store.get(docId)!.title = 'New';
    store.store.get(docId)!.updatedAt = new Date(5000 * 1000).toISOString();
    vault.files.delete('ToDo/Old.md');
    vault.files.set('ToDo/New.md', 'v2');

    // Sync 2: reconcile — exactly one update, nothing deleted, doc survives
    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2.deleted).toBe(0);
    expect(r2.updated).toBe(1);
    expect(store.store.has(docId)).toBe(true);          // original doc not deleted
    expect(store.store.size).toBe(1);                    // no duplicate created
    expect(store.client.deleteDocument).not.toHaveBeenCalled();
    expect(store.client.deleteCollection).not.toHaveBeenCalled();

    // Sync 3: fully settled — no-op
    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('hash-based rename, then second sync is a no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/Alpha.md', 'same body');
    const engine = wire(store, vault);

    await engine.sync();
    const docId = [...store.store.keys()][0];

    // Rename only in Obsidian, content unchanged → hash rename detection
    vault.files.delete('ToDo/Alpha.md');
    vault.files.set('ToDo/Beta.md', 'same body');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2.renamed).toBe(1);
    expect(store.store.get(docId)!.title).toBe('Beta');

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('doc moved to another collection in Outline → local file relocated, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ColA/Note.md', 'body');
    const engine = wire(store, vault);

    await engine.sync(); // creates ColA + doc
    const docId = [...store.store.keys()][0];

    // Move the doc into a different collection in Outline
    store.collections.set('col-ColB', { id: 'col-ColB', name: 'ColB', description: null });
    store.store.get(docId)!.collectionId = 'col-ColB';
    store.store.get(docId)!.updatedAt = new Date(9000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2.renamed).toBe(1);
    expect(vault.files.has('ColB/Note.md')).toBe(true);   // relocated
    expect(vault.files.has('ColA/Note.md')).toBe(false);  // old gone
    expect(store.store.size).toBe(1);                      // no duplicate
    expect(store.client.deleteDocument).not.toHaveBeenCalled(); // not deleted from Outline

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('collection renamed in Outline → no ghost collection, local folder relocated, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ColA/Note.md', 'body');
    const engine = wire(store, vault);

    await engine.sync(); // creates collection ColA + doc
    const docId = [...store.store.keys()][0];
    const collId = store.store.get(docId)!.collectionId;
    expect(store.collections.size).toBe(1);

    // Rename the collection in Outline (same id, new name)
    store.collections.get(collId)!.name = 'ColRenamed';
    store.store.get(docId)!.updatedAt = new Date(9000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(store.client.createCollection).not.toHaveBeenCalled(); // no ghost collection
    expect(store.collections.size).toBe(1);                       // still exactly one
    expect(vault.files.has('ColRenamed/Note.md')).toBe(true);     // file relocated
    expect(vault.files.has('ColA/Note.md')).toBe(false);          // old gone
    expect(store.store.size).toBe(1);                             // no duplicate doc

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Obsidian-side parent-note rename → children follow under new parent, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Projects/Website.md', 'parent');
    vault.files.set('Projects/Website/Design.md', 'child');
    const engine = wire(store, vault);

    await engine.sync();
    const parentId = [...store.store.entries()].find(([, d]) => d.title === 'Website')![0];
    const childId = [...store.store.entries()].find(([, d]) => d.title === 'Design')![0];
    expect(store.store.get(childId)!.parentDocumentId).toBe(parentId);

    // Rename the parent note in Obsidian
    vault.files.delete('Projects/Website.md');
    vault.files.set('Projects/Site.md', 'parent');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(store.store.get(parentId)!.title).toBe('Site');          // parent renamed in Outline
    expect(vault.files.has('Projects/Site/Design.md')).toBe(true);  // child relocated to follow
    expect(vault.files.has('Projects/Website/Design.md')).toBe(false);
    expect(store.store.get(childId)!.parentDocumentId).toBe(parentId); // still same parent doc

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Obsidian-side folder rename → Outline collection renamed (not recreated), then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Foo/A.md', 'aaa');
    vault.files.set('Foo/B.md', 'bbb');
    const engine = wire(store, vault);

    await engine.sync();
    const fooId = [...store.collections.values()].find(c => c.name === 'Foo')!.id;

    // Rename the folder in Obsidian: all files move Foo/ → Bar/
    vault.files.delete('Foo/A.md');
    vault.files.delete('Foo/B.md');
    vault.files.set('Bar/A.md', 'aaa');
    vault.files.set('Bar/B.md', 'bbb');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(store.client.updateCollection).toHaveBeenCalledWith(fooId, 'Bar'); // renamed in place
    expect(store.client.createCollection).not.toHaveBeenCalled();              // no ghost collection
    expect(store.collections.size).toBe(1);                                    // still one collection
    expect(store.collections.get(fooId)!.name).toBe('Bar');                    // same id, new name
    expect(store.store.size).toBe(2);                                          // no duplicate docs

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Obsidian-side file move to another collection → Outline doc moved, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ColA/Note.md', 'body');
    vault.files.set('ColB/Keep.md', 'keep'); // ensures ColB collection exists
    const engine = wire(store, vault);

    await engine.sync();
    const noteId = [...store.store.entries()].find(([, d]) => d.title === 'Note')![0];
    expect(store.store.get(noteId)!.collectionId).toBe('col-ColA');

    // Move the file from ColA to ColB in the vault
    vault.files.delete('ColA/Note.md');
    vault.files.set('ColB/Note.md', 'body');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(store.client.moveDocument).toHaveBeenCalled();
    expect(store.store.get(noteId)!.collectionId).toBe('col-ColB'); // doc relocated in Outline
    expect(store.store.size).toBe(2);                                // no duplicate

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Outline-side title rename (local unchanged) → file renamed locally, no push-back', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/Note.md', 'body');
    const engine = wire(store, vault);

    await engine.sync();
    const docId = [...store.store.keys()][0];

    // Rename only the title in Outline (collection unchanged, content unchanged)
    store.store.get(docId)!.title = 'NoteRenamed';
    store.store.get(docId)!.updatedAt = new Date(9000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(vault.files.has('ToDo/NoteRenamed.md')).toBe(true);
    expect(vault.files.has('ToDo/Note.md')).toBe(false);
    expect(r2.renamed).toBe(1);
    expect(store.client.updateDocument).not.toHaveBeenCalled(); // no push-back of old title
    expect(store.store.get(docId)!.title).toBe('NoteRenamed');   // Outline title preserved

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Outline-side title + collection change combined → relocated to new path', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ColA/Note.md', 'body');
    const engine = wire(store, vault);

    await engine.sync();
    const docId = [...store.store.keys()][0];

    // Combined: title rename AND collection move in Outline
    store.collections.set('col-ColB', { id: 'col-ColB', name: 'ColB', description: null });
    store.store.get(docId)!.title = 'NoteRenamed';
    store.store.get(docId)!.collectionId = 'col-ColB';
    store.store.get(docId)!.updatedAt = new Date(9000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(vault.files.has('ColB/NoteRenamed.md')).toBe(true);  // new folder AND new name
    expect(vault.files.has('ColA/Note.md')).toBe(false);         // old gone
    expect(r2.renamed).toBe(1);
    expect(store.client.updateDocument).not.toHaveBeenCalled();
    expect(store.client.createCollection).not.toHaveBeenCalled(); // no ghost ColA

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('title diff + LOCAL file also changed → real conflict, NOT silent re-path', async () => {
    // Regression: the Outline-only-rename bypass must NOT trigger when the local file was
    // also edited. That would silently overwrite or drop the user's local change.
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/Note.md', 'original body');
    const engine = wire(store, vault);

    await engine.sync();
    const docId = [...store.store.keys()][0];

    // Outline renames title; local file ALSO edited
    store.store.get(docId)!.title = 'NoteRenamed';
    store.store.get(docId)!.updatedAt = new Date(9000 * 1000).toISOString();
    vault.files.set('ToDo/Note.md', 'local edit'); // user modified locally

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    // Conflict resolution must run (some write happened, either direction).
    expect(r2.updated + r2.renamed).toBeGreaterThanOrEqual(1);
    // The Outline-only-rename bypass MUST have been skipped — bypass would have moved
    // the file WITHOUT consulting conflict resolution and lost the local edit silently.
    const localEditStillThere = vault.files.has('ToDo/Note.md') && vault.files.get('ToDo/Note.md') === 'local edit';
    const pushedToOutline = (store.client.updateDocument as any).mock.calls.length > 0;
    const pulledOutlineWin = vault.files.has('ToDo/NoteRenamed.md') && vault.files.get('ToDo/NoteRenamed.md') === store.store.get(docId)!.text;
    // Either obsidian wins (push) OR outline wins (write outline body somewhere) — but a
    // decision was made, not silently overridden.
    expect(localEditStillThere || pushedToOutline || pulledOutlineWin).toBe(true);
  });

  test('Outline wins a conflict (pull) — settles to no-op, no stale re-push', async () => {
    // Regression: after Outline wins and the local file is overwritten, fileHashes must
    // reflect the pulled content — otherwise the next sync sees a phantom local change
    // and pushes the old content back (non-idempotent).
    config.conflictResolution = 'outline-wins';
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ToDo/Doc.md', 'local v1');
    const engine = wire(store, vault);

    await engine.sync();
    const docId = [...store.store.keys()][0];

    // Outline-side edit (newer); outline-wins forces the pull regardless of timestamps
    store.store.get(docId)!.text = 'remote v2';
    store.store.get(docId)!.updatedAt = new Date(9000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2.updated).toBe(1);
    expect(vault.files.get('ToDo/Doc.md')).toBe('remote v2'); // local overwritten by Outline

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  // ── Coverage matrix (Phase 3): deep nesting + all op combinations ────────────

  test('deep 3-level nesting: created with correct parent chain, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Col/A.md', 'a');
    vault.files.set('Col/A/B.md', 'b');
    vault.files.set('Col/A/B/C.md', 'c');
    const engine = wire(store, vault);

    await engine.sync();
    const a = [...store.store.values()].find(d => d.title === 'A')!;
    const b = [...store.store.values()].find(d => d.title === 'B')!;
    const c = [...store.store.values()].find(d => d.title === 'C')!;
    expect(b.parentDocumentId).toBe(a.id);
    expect(c.parentDocumentId).toBe(b.id);

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Outline-side re-parent (same collection) → local file relocated under new parent', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Col/P1.md', 'p1');
    vault.files.set('Col/P2.md', 'p2');
    vault.files.set('Col/P1/Child.md', 'c');
    const engine = wire(store, vault);

    await engine.sync();
    const p2 = [...store.store.values()].find(d => d.title === 'P2')!;
    const child = [...store.store.values()].find(d => d.title === 'Child')!;

    // Re-parent Child under P2 in Outline
    store.store.get(child.id)!.parentDocumentId = p2.id;
    store.store.get(child.id)!.updatedAt = new Date(9000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    await engine.sync();
    expect(vault.files.has('Col/P2/Child.md')).toBe(true);
    expect(vault.files.has('Col/P1/Child.md')).toBe(false);

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Obsidian delete file → Outline doc deleted, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Col/A.md', 'a');
    vault.files.set('Col/B.md', 'b'); // sibling keeps the collection non-empty
    const engine = wire(store, vault);

    await engine.sync();
    const aId = [...store.store.entries()].find(([, d]) => d.title === 'A')![0];

    vault.files.delete('Col/A.md');
    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(store.client.deleteDocument).toHaveBeenCalledWith(aId);
    expect([...store.store.values()].some(d => d.title === 'A')).toBe(false);

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('Outline delete doc → local file deleted, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Col/A.md', 'a');
    vault.files.set('Col/B.md', 'b');
    const engine = wire(store, vault);

    await engine.sync();
    const aId = [...store.store.entries()].find(([, d]) => d.title === 'A')![0];

    store.store.delete(aId); // deleted in Outline
    clearWriteMocks(store.client, vault.reader);
    await engine.sync();
    expect(vault.files.has('Col/A.md')).toBe(false);
    expect(vault.files.has('Col/B.md')).toBe(true);

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('content update Obsidian→Outline, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('Col/A.md', 'v1');
    const engine = wire(store, vault);

    await engine.sync();
    const aId = [...store.store.keys()][0];

    vault.files.set('Col/A.md', 'v2 edited');
    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2.updated).toBe(1);
    expect(store.store.get(aId)!.text).toBe('v2 edited');

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('combined sync: create + move + delete in one run, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.files.set('ColA/Keep.md', 'keep');
    vault.files.set('ColA/Move.md', 'move');
    vault.files.set('ColA/Del.md', 'del');
    vault.files.set('ColB/Anchor.md', 'anchor'); // ensures ColB exists
    const engine = wire(store, vault);

    await engine.sync();
    const delId = [...store.store.entries()].find(([, d]) => d.title === 'Del')![0];
    const moveId = [...store.store.entries()].find(([, d]) => d.title === 'Move')![0];

    // Three different ops at once:
    vault.files.set('ColA/New.md', 'new');          // create
    vault.files.delete('ColA/Move.md');             // move ColA/Move.md → ColB/Move.md
    vault.files.set('ColB/Move.md', 'move');
    vault.files.delete('ColA/Del.md');              // delete

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect([...store.store.values()].some(d => d.title === 'New')).toBe(true);     // created
    expect(store.store.get(moveId)!.collectionId).toBe('col-ColB');               // moved
    expect(store.store.has(delId)).toBe(false);                                   // deleted

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  // ── Attachments (Phase A: Outline→Obsidian download) ─────────────────────────

  function seedDocWithAttachment(
    store: ReturnType<typeof makeOutlineStore>,
    opts: { id?: string; text: string; attId?: string; data?: string; ct?: string } = { text: '' },
  ) {
    store.collections.set('col-ToDo', { id: 'col-ToDo', name: 'ToDo', description: null });
    if (opts.attId) {
      store.attachments.set(opts.attId, {
        id: opts.attId, data: Buffer.from(opts.data ?? 'BINARY'), contentType: opts.ct ?? 'image/png',
      });
    }
    store.store.set(opts.id ?? 'docA', {
      id: opts.id ?? 'docA', title: 'WithImage', text: opts.text,
      updatedAt: new Date(900 * 1000).toISOString(),
      collectionId: 'col-ToDo', parentDocumentId: null, published: true,
    });
  }

  test('Outline→Obsidian: attachment pulled into folder, embed rewritten, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    seedDocWithAttachment(store, {
      text: 'See ![pic](/api/attachments.redirect?id=att-1) here',
      attId: 'att-1', data: 'PNGDATA', ct: 'image/png',
    });
    const engine = wire(store, vault);

    const r1 = await engine.sync();
    expect(r1.created).toBe(1);
    // Binary downloaded into the attachments/ folder
    const binPath = [...vault.binaries.keys()][0];
    expect(binPath).toMatch(/^attachments\//);
    expect(binPath.endsWith('.png')).toBe(true);
    expect(vault.binaries.get(binPath)!.toString()).toBe('PNGDATA');
    // Note body rewritten to a local embed — no redirect URL leaks into the vault
    const body = vault.files.get('ToDo/WithImage.md')!;
    expect(body).not.toContain('attachments.redirect');
    expect(body).toContain('![pic](attachments/');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
    expect(store.client.downloadAttachment).not.toHaveBeenCalled(); // no re-download
  });

  test('dot-prefixed attachment folder is sanitised (Obsidian hides dot-folders)', async () => {
    config.attachmentFolder = '.attachments'; // would be invisible to Obsidian
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    seedDocWithAttachment(store, {
      text: '![pic](/api/attachments.redirect?id=att-7)',
      attId: 'att-7', data: 'D', ct: 'image/png',
    });
    const engine = wire(store, vault);

    await engine.sync();
    const binPath = [...vault.binaries.keys()][0];
    expect(binPath.startsWith('attachments/')).toBe(true);   // dot stripped
    expect(binPath.startsWith('.attachments/')).toBe(false);
    expect(vault.files.get('ToDo/WithImage.md')).not.toContain('.attachments/');
  });

  test('attachment doc: Outline bumps updatedAt but content identical → canonical no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    seedDocWithAttachment(store, {
      text: 'pre ![cap](/api/attachments.redirect?id=att-9) post',
      attId: 'att-9', data: 'XYZ', ct: 'image/png',
    });
    const engine = wire(store, vault);
    await engine.sync();

    // Outline touches the doc (new updatedAt) without changing content → forces a re-fetch,
    // but the canonical form is identical, so nothing should be pushed/pulled/downloaded.
    store.store.get('docA')!.updatedAt = new Date(5000 * 1000).toISOString();

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('note embeds and external image URLs are NOT downloaded as attachments', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    seedDocWithAttachment(store, {
      text: 'wiki ![[Some Note]] ext ![x](https://example.com/y.png) end',
    });
    const engine = wire(store, vault);

    const r1 = await engine.sync();
    expect(r1.created).toBe(1);
    expect(store.client.downloadAttachment).not.toHaveBeenCalled();
    expect(vault.binaries.size).toBe(0);
    // Body passes through untouched (no attachment rewriting)
    expect(vault.files.get('ToDo/WithImage.md')).toBe('wiki ![[Some Note]] ext ![x](https://example.com/y.png) end');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('multiple attachments in one doc are each pulled once', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    seedDocWithAttachment(store, {
      text: '![a](/api/attachments.redirect?id=att-a) and ![b](/api/attachments.redirect?id=att-b)',
      attId: 'att-a', data: 'AAA', ct: 'image/png',
    });
    store.attachments.set('att-b', { id: 'att-b', data: Buffer.from('BBB'), contentType: 'application/pdf' });
    const engine = wire(store, vault);

    await engine.sync();
    expect(vault.binaries.size).toBe(2);
    expect([...vault.binaries.keys()].some(p => p.endsWith('.pdf'))).toBe(true);
    const body = vault.files.get('ToDo/WithImage.md')!;
    expect(body).not.toContain('attachments.redirect');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('syncAttachments=false leaves redirect URLs untouched (feature toggle)', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    seedDocWithAttachment(store, {
      text: 'x ![p](/api/attachments.redirect?id=att-1) y',
      attId: 'att-1', data: 'D', ct: 'image/png',
    });
    config.syncAttachments = false;
    const engine = wire(store, vault);

    await engine.sync();
    expect(store.client.downloadAttachment).not.toHaveBeenCalled();
    expect(vault.binaries.size).toBe(0);
    expect(vault.files.get('ToDo/WithImage.md')).toContain('attachments.redirect');
  });

  // ── Attachments (Phase B: Obsidian→Outline upload) ───────────────────────────

  test('Obsidian→Outline: local attachment uploaded, embed rewritten, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.binaries.set('attachments/pic.png', Buffer.from('IMG-BYTES'));
    vault.files.set('ToDo/Note.md', 'before ![[attachments/pic.png]] after');
    const engine = wire(store, vault);

    const r1 = await engine.sync();
    expect(r1.created).toBe(1);
    expect(store.client.createAttachment).toHaveBeenCalledTimes(1);
    expect(store.client.uploadAttachment).toHaveBeenCalledTimes(1);
    const doc = [...store.store.values()][0];
    expect(doc.text).toContain('/api/attachments.redirect?id=');
    expect(doc.text).not.toContain('![['); // wikilink rewritten to a redirect URL

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('markdown embed (relative path) is uploaded too', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.binaries.set('attachments/doc.pdf', Buffer.from('%PDF-1.4'));
    vault.files.set('ToDo/Note.md', '![the pdf](attachments/doc.pdf)');
    const engine = wire(store, vault);

    await engine.sync();
    expect(store.client.uploadAttachment).toHaveBeenCalledTimes(1);
    const doc = [...store.store.values()][0];
    expect(doc.text).toContain('/api/attachments.redirect?id=');

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(r2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('attachment binary changed (same embed text) → re-uploaded once, then no-op', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.binaries.set('attachments/pic.png', Buffer.from('V1'));
    vault.files.set('ToDo/Note.md', '![[attachments/pic.png]]');
    const engine = wire(store, vault);

    await engine.sync();
    expect(store.client.uploadAttachment).toHaveBeenCalledTimes(1);

    // Replace the image content (same path/name, new bytes); note text unchanged.
    vault.binaries.set('attachments/pic.png', Buffer.from('V2-different-bytes'));

    clearWriteMocks(store.client, vault.reader);
    const r2 = await engine.sync();
    expect(store.client.uploadAttachment).toHaveBeenCalledTimes(1); // exactly one re-upload
    expect(r2.updated).toBe(1);

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('round-trip: pushed attachment pulls into a second device, then no-op', async () => {
    const store = makeOutlineStore();
    const vaultA = makeVaultStore();
    vaultA.binaries.set('attachments/pic.png', Buffer.from('ROUNDTRIP'));
    vaultA.files.set('ToDo/Note.md', '![[attachments/pic.png]]');
    const engineA = wire(store, vaultA);
    await engineA.sync(); // uploads to Outline

    // Second device: fresh state (separate HOME) + fresh vault, same Outline instance.
    const home2 = await fs.mkdtemp(path.join(os.tmpdir(), 'obsline-idem-dev2-'));
    process.env.HOME = home2;
    try {
      const vaultB = makeVaultStore();
      const engineB = wire(store, vaultB);
      const rB = await engineB.sync();
      expect(rB.created).toBe(1);
      // The attachment was downloaded into B and the body uses a local embed.
      expect([...vaultB.binaries.keys()].some(p => p.startsWith('attachments/'))).toBe(true);
      const body = vaultB.files.get('ToDo/Note.md')!;
      expect(body).toContain('attachments/');
      expect(body).not.toContain('attachments.redirect');

      clearWriteMocks(store.client, vaultB.reader);
      const rB2 = await engineB.sync();
      expect(rB2).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
      expectNoWrites(store.client, vaultB.reader);
    } finally {
      process.env.HOME = tempVault;
      await fs.remove(home2);
    }
  });

  test('syncAttachments=false does not upload local embeds (pushed raw, unchanged behaviour)', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.binaries.set('attachments/pic.png', Buffer.from('X'));
    vault.files.set('ToDo/Note.md', '![[attachments/pic.png]]');
    config.syncAttachments = false;
    const engine = wire(store, vault);

    await engine.sync();
    expect(store.client.createAttachment).not.toHaveBeenCalled();
    expect(store.client.uploadAttachment).not.toHaveBeenCalled();
    const doc = [...store.store.values()][0];
    expect(doc.text).toBe('![[attachments/pic.png]]'); // pushed raw, as before the feature
  });

  test('orphan cleanup (opt-in): local attachment removed → Outline attachment deleted', async () => {
    config.syncAttachments = true;
    config.cleanupOrphanAttachments = true;
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.binaries.set('attachments/pic.png', Buffer.from('IMG'));
    vault.files.set('ToDo/Note.md', '![[attachments/pic.png]]');
    const engine = wire(store, vault);
    await engine.sync();
    const attId = [...store.attachments.keys()][0];
    expect(store.attachments.has(attId)).toBe(true);

    // User removes the note and its attachment file from the vault.
    vault.files.delete('ToDo/Note.md');
    vault.binaries.delete('attachments/pic.png');

    clearWriteMocks(store.client, vault.reader);
    await engine.sync();
    expect(store.client.deleteAttachment).toHaveBeenCalledWith(attId);
    expect(store.attachments.has(attId)).toBe(false);

    clearWriteMocks(store.client, vault.reader);
    const r3 = await engine.sync();
    expect(r3).toMatchObject({ created: 0, updated: 0, deleted: 0, renamed: 0 });
    expectNoWrites(store.client, vault.reader);
  });

  test('orphan cleanup stays off by default: removed attachment is NOT deleted from Outline', async () => {
    const store = makeOutlineStore();
    const vault = makeVaultStore();
    vault.binaries.set('attachments/pic.png', Buffer.from('IMG'));
    vault.files.set('ToDo/Note.md', '![[attachments/pic.png]]');
    const engine = wire(store, vault);
    await engine.sync();
    const attId = [...store.attachments.keys()][0];

    vault.files.delete('ToDo/Note.md');
    vault.binaries.delete('attachments/pic.png');

    clearWriteMocks(store.client, vault.reader);
    await engine.sync();
    expect(store.client.deleteAttachment).not.toHaveBeenCalled(); // default off
    expect(store.attachments.has(attId)).toBe(true);              // attachment preserved
  });
});
