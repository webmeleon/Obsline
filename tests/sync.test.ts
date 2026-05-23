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
  let clock = 1000;
  let seq = 0;
  const nextTs = () => new Date(clock++ * 1000).toISOString();
  // Optional: simulate Outline normalising body content on write (trailing newline).
  const norm = (t: string) => (seedNormalize && t ? `${t}\n` : t);

  const client = {
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
  return { store, collections, client };
}

function makeVaultStore() {
  const files = new Map<string, string>();
  const reader = {
    readVault: jest.fn(async () => [...files.entries()].map(([p, content]) => ({
      path: p,
      title: p.split('/').pop()!.replace(/\.md$/, ''),
      content,
      lastModified: Date.now(),
    }))),
    readNote: jest.fn(),
    writeNote: jest.fn(async (p: string, content: string) => { files.set(p, content); }),
    noteExists: jest.fn(async (p: string) => files.has(p)),
    deleteNote: jest.fn(async (p: string) => { files.delete(p); }),
    moveNote: jest.fn(async (oldP: string, newP: string) => {
      if (files.has(oldP)) { files.set(newP, files.get(oldP)!); files.delete(oldP); }
    }),
  };
  return { files, reader };
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
  reader.writeNote.mockClear();
  reader.deleteNote.mockClear();
}

function expectNoWrites(client: ReturnType<typeof makeOutlineStore>['client'], reader: ReturnType<typeof makeVaultStore>['reader']) {
  expect(client.createDocument).not.toHaveBeenCalled();
  expect(client.updateDocument).not.toHaveBeenCalled();
  expect(client.moveDocument).not.toHaveBeenCalled();
  expect(client.deleteDocument).not.toHaveBeenCalled();
  expect(client.createCollection).not.toHaveBeenCalled();
  expect(client.updateCollection).not.toHaveBeenCalled();
  expect(client.deleteCollection).not.toHaveBeenCalled();
  expect(reader.writeNote).not.toHaveBeenCalled();
  expect(reader.deleteNote).not.toHaveBeenCalled();
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
    };

    mockObsidianReader.mockClear();
    mockOutlineClient.mockClear();

    const mockReaderInstance = {
      readVault: jest.fn().mockResolvedValue([]),
      readNote: jest.fn(),
      writeNote: jest.fn(),
      noteExists: jest.fn(),
      deleteNote: jest.fn(),
    };

    const mockClientInstance = {
      listDocuments: jest.fn().mockResolvedValue([]),
      listCollections: jest.fn().mockResolvedValue([{ id: 'col-1', name: 'ToDo', description: null }]),
      getDocument: jest.fn(),
      createDocument: jest.fn(),
      updateDocument: jest.fn(),
      deleteDocument: jest.fn(),
      createCollection: jest.fn(),
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
});
