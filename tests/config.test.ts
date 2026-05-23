import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, validateConfig, ObslineConfig, getConfigFile } from '../src/utils/config';

describe('Config', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsline-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome) {
      process.env.HOME = originalHome;
    }
    await fs.remove(tempDir);
  });

  test('should load defaults when config does not exist', async () => {
    const configFile = getConfigFile();
    if (await fs.pathExists(configFile)) {
      await fs.remove(configFile);
    }
    const config = await loadConfig();

    expect(config.syncInterval).toBe(300);
    expect(config.conflictResolution).toBe('last-write-wins');
    expect(config.ignorePaths).toContain('.obsidian');
    expect(config.obsidianVault).toBe('');
  });

  test('should save and load config', async () => {
    const testConfig: ObslineConfig = {
      obsidianVault: '/test/vault',
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'test-token-123',
      syncInterval: 600,
      conflictResolution: 'obsidian-wins',
      ignorePaths: ['.obsidian', '.trash', 'temp'],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    await saveConfig(testConfig);
    const loaded = await loadConfig();

    expect(loaded.obsidianVault).toBe(testConfig.obsidianVault);
    expect(loaded.outlineUrl).toBe(testConfig.outlineUrl);
    expect(loaded.outlineApiToken).toBe(testConfig.outlineApiToken);
    expect(loaded.syncInterval).toBe(600);
    expect(loaded.conflictResolution).toBe('obsidian-wins');
  });

  test('should validate config correctly', async () => {
    const validConfig: ObslineConfig = {
      obsidianVault: tempDir,
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'token',
      syncInterval: 300,
      conflictResolution: 'last-write-wins',
      ignorePaths: [],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    const errors = await validateConfig(validConfig);
    expect(errors).toHaveLength(0);
  });

  test('should detect missing required fields', async () => {
    const invalidConfig: ObslineConfig = {
      obsidianVault: '',
      outlineUrl: '',
      outlineApiToken: '',
      syncInterval: 300,
      conflictResolution: 'last-write-wins',
      ignorePaths: [],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    const errors = await validateConfig(invalidConfig);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join()).toMatch(/obsidianVault|outlineUrl|outlineApiToken/);
  });

  test('should reject invalid vault path', async () => {
    const config: ObslineConfig = {
      obsidianVault: '/nonexistent/vault',
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'token',
      syncInterval: 300,
      conflictResolution: 'last-write-wins',
      ignorePaths: [],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    const errors = await validateConfig(config);
    expect(errors.some(e => e.includes('does not exist'))).toBe(true);
  });

  test('should reject invalid sync interval', async () => {
    const config: ObslineConfig = {
      obsidianVault: tempDir,
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'token',
      syncInterval: 5,
      conflictResolution: 'last-write-wins',
      ignorePaths: [],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    const errors = await validateConfig(config);
    expect(errors.some(e => e.includes('syncInterval'))).toBe(true);
  });

  test('should merge defaults with provided config', async () => {
    const testConfig: ObslineConfig = {
      obsidianVault: tempDir,
      outlineUrl: 'https://outline.example.com',
      outlineApiToken: 'token',
      syncInterval: 600,
      conflictResolution: 'outline-wins',
      ignorePaths: ['custom'],
      attachmentFolder: 'attachments',
      syncAttachments: true,
      cleanupOrphanAttachments: false,
    };

    await saveConfig(testConfig);
    const loaded = await loadConfig();

    expect(loaded.syncInterval).toBe(600);
    expect(loaded.conflictResolution).toBe('outline-wins');
    expect(loaded.ignorePaths).toContain('custom');
  });
});
