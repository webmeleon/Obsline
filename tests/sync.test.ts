import { SyncEngine } from '../src/core/sync';
import { ObslineConfig } from '../src/utils/config';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

jest.mock('../src/core/obsidian');
jest.mock('../src/core/outline');

import { ObsidianReader } from '../src/core/obsidian';
import { OutlineClient } from '../src/core/outline';

const mockObsidianReader = ObsidianReader as jest.MockedClass<typeof ObsidianReader>;
const mockOutlineClient = OutlineClient as jest.MockedClass<typeof OutlineClient>;

describe('SyncEngine', () => {
  let syncEngine: SyncEngine;
  let config: ObslineConfig;
  let tempVault: string;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsline-sync-test-'));

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
    await fs.remove(tempVault);
  });

  test('should initialize with config', () => {
    expect(syncEngine.getLastSyncTime()).toBe(0);
    expect(syncEngine.getSyncState().fileHashes).toEqual({});
  });

  test('should sync empty vault and outline', async () => {
    const result = await syncEngine.sync();

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
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

  test('should skip root-level notes without a collection', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    mockReaderInstance.readVault.mockResolvedValue([{
      path: 'test.md',
      title: 'test',
      content: 'Test content',
      lastModified: Date.now(),
    }]);

    const result = await syncEngine.sync();

    expect(result.created).toBe(0);
    expect(mockClientInstance.createDocument).not.toHaveBeenCalled();
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
});
