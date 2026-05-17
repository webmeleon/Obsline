#!/usr/bin/env node

import { program } from 'commander';
import * as fs from 'fs-extra';
import * as path from 'path';
import { SyncEngine } from './core/sync';
import { Logger } from './utils/logger';
import { loadConfig, saveConfig, validateConfig, getConfigFile, getConfigDir } from './utils/config';
import { VERSION } from './version';

const logger = new Logger('obsline');

program
  .name('obsline')
  .description('Bi-directional sync between Obsidian and Outline')
  .version(VERSION);

program
  .command('config')
  .description('Configure Obsline')
  .action(async () => {
    const config = await loadConfig();
    const errors = await validateConfig(config);

    if (errors.length > 0) {
      logger.error('Configuration is invalid:');
      errors.forEach(e => logger.error(`  - ${e}`));
      process.exit(1);
    }

    logger.info('Current configuration:');
    logger.info(`  Obsidian Vault: ${config.obsidianVault}`);
    logger.info(`  Outline URL: ${config.outlineUrl}`);
    logger.info(`  Sync Interval: ${config.syncInterval}s`);
    logger.info(`  Conflict Resolution: ${config.conflictResolution}`);
    logger.info(`  Config File: ${getConfigFile()}`);
  });

program
  .command('sync')
  .description('Run synchronization')
  .option('-d, --daemon', 'Run as daemon (polling mode)')
  .option('-i, --interval <seconds>', 'Polling interval in seconds')
  .action(async (options) => {
    const config = await loadConfig();
    const errors = await validateConfig(config);

    if (errors.length > 0) {
      logger.error('Configuration is invalid. Run "obsline config" to check.');
      errors.forEach(e => logger.error(`  - ${e}`));
      process.exit(1);
    }

    const engine = new SyncEngine(config);

    if (options.daemon) {
      const interval = (options.interval ? parseInt(options.interval) : config.syncInterval) * 1000;
      logger.info(`Running in daemon mode (polling every ${interval / 1000}s)...`);
      logger.info('Press Ctrl+C to stop');

      const runSync = async () => {
        try {
          const result = await engine.sync();
          const timestamp = new Date().toISOString();
          logger.info(`[${timestamp}] Sync completed: +${result.created} ${result.updated}~ ${result.deleted}-`);
        } catch (error) {
          logger.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      await runSync();
      setInterval(runSync, interval);
    } else {
      try {
        const result = await engine.sync();
        logger.info(`\nSync Results:`);
        logger.info(`  Created:  ${result.created}`);
        logger.info(`  Updated:  ${result.updated}`);
        logger.info(`  Deleted:  ${result.deleted}`);
        if (result.conflicts.length > 0) {
          logger.warn(`  Conflicts: ${result.conflicts.join(', ')}`);
        }
      } catch (error) {
        logger.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }
  });

program
  .command('status')
  .description('Show sync status')
  .action(async () => {
    const config = await loadConfig();
    const stateFile = path.join(getConfigDir(), 'sync-state.json');
    const engine = new SyncEngine(config);

    logger.info('Obsline Status:');
    logger.info(`  Vault: ${config.obsidianVault}`);
    logger.info(`  Outline: ${config.outlineUrl}`);

    if (await fs.pathExists(stateFile)) {
      const state = await fs.readJSON(stateFile);
      const lastSync = new Date(state.lastSyncTime).toISOString();
      const fileCount = Object.keys(state.fileHashes).length;
      logger.info(`  Last Sync: ${lastSync}`);
      logger.info(`  Tracked Files: ${fileCount}`);
    } else {
      logger.info('  Last Sync: Never');
      logger.info('  Tracked Files: 0');
    }
  });

program.parse(process.argv);
