import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from './logger';

const logger = new Logger('Config');

export type ConflictResolution = 'last-write-wins' | 'obsidian-wins' | 'outline-wins';

export interface ObslineConfig {
  obsidianVault: string;
  outlineUrl: string;
  outlineApiToken: string;
  syncInterval: number;
  conflictResolution: ConflictResolution;
  ignorePaths: string[];
}


const DEFAULT_CONFIG: ObslineConfig = {
  obsidianVault: '',
  outlineUrl: '',
  outlineApiToken: '',
  syncInterval: 300,
  conflictResolution: 'last-write-wins',
  ignorePaths: ['.obsidian', '.trash', '.DS_Store', '*.tmp'],
};

export async function loadConfig(): Promise<ObslineConfig> {
  const configFile = getConfigFile();
  try {
    if (await fs.pathExists(configFile)) {
      const raw = await fs.readFile(configFile, 'utf-8');
      const config = JSON.parse(raw) as ObslineConfig;
      logger.debug(`Config loaded from ${configFile}`);
      return { ...DEFAULT_CONFIG, ...config };
    }
  } catch (error) {
    logger.warn(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
  }

  logger.info('No config found, using defaults');
  return DEFAULT_CONFIG;
}

export async function saveConfig(config: ObslineConfig): Promise<void> {
  const configDir = getConfigDir();
  const configFile = getConfigFile();
  await fs.ensureDir(configDir);
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8');
  logger.info(`Config saved to ${configFile}`);
}

export async function validateConfig(config: ObslineConfig): Promise<string[]> {
  const errors: string[] = [];

  if (!config.obsidianVault) {
    errors.push('obsidianVault is required');
  } else if (!(await fs.pathExists(config.obsidianVault))) {
    errors.push(`obsidianVault does not exist: ${config.obsidianVault}`);
  }

  if (!config.outlineUrl) {
    errors.push('outlineUrl is required');
  }

  if (!config.outlineApiToken) {
    errors.push('outlineApiToken is required');
  }

  if (config.syncInterval < 10) {
    errors.push('syncInterval must be at least 10 seconds');
  }

  return errors;
}

export function getConfigDir(): string {
  return path.join(process.env.HOME || '~', '.obsline');
}

export function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}
