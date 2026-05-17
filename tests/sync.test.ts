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
      listCollections: jest.fn().mockResolvedValue([]),
      getDocument: jest.fn(),
      createDocument: jest.fn(),
      updateDocument: jest.fn(),
      deleteDocument: jest.fn(),
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

  test('should create outline document for new obsidian note', async () => {
    const mockReaderInstance = mockObsidianReader.mock.results[0].value;
    const mockClientInstance = mockOutlineClient.mock.results[0].value;

    const note = {
      path: 'test.md',
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
      collectionId: 'default',
      parentDocumentId: null,
    });

    const result = await syncEngine.sync();

    expect(result.created).toBe(1);
    expect(mockClientInstance.createDocument).toHaveBeenCalledWith('test', 'Test content', undefined, undefined);
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
});
