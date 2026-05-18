import * as fs from 'fs-extra';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { Logger } from '../utils/logger';

const logger = new Logger('ObsidianReader');

export interface ObsidianNote {
  path: string;
  title: string;
  content: string;
  lastModified: number;
}

export class ObsidianReader {
  private vaultPath: string;
  private ignorePaths: string[];

  constructor(vaultPath: string, ignorePaths: string[] = []) {
    this.vaultPath = vaultPath;
    this.ignorePaths = ignorePaths;
    logger.debug(`ObsidianReader initialized for ${vaultPath}`);
  }

  private shouldIgnore(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    for (const pattern of this.ignorePaths) {
      if (minimatch(normalized, pattern) || minimatch(normalized, `**/${pattern}`)) {
        return true;
      }
    }
    return false;
  }

  async readVault(): Promise<ObsidianNote[]> {
    if (!(await fs.pathExists(this.vaultPath))) {
      throw new Error(`Vault path does not exist: ${this.vaultPath}`);
    }

    const notes: ObsidianNote[] = [];
    await this.walkDirectory(this.vaultPath, notes);
    logger.info(`Read ${notes.length} notes from vault`);
    return notes;
  }

  private async walkDirectory(dir: string, notes: ObsidianNote[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.vaultPath, fullPath);

      if (this.shouldIgnore(relativePath)) {
        logger.debug(`Ignoring: ${relativePath}`);
        continue;
      }

      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, notes);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const note = await this.readNote(relativePath);
        notes.push(note);
      }
    }
  }

  async readNote(relativePath: string): Promise<ObsidianNote> {
    const fullPath = path.join(this.vaultPath, relativePath);

    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`Note file does not exist: ${fullPath}`);
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    const stats = await fs.stat(fullPath);
    const title = path.basename(relativePath, '.md');

    const note: ObsidianNote = {
      path: relativePath.replace(/\\/g, '/'),
      title,
      content,
      lastModified: stats.mtime.getTime(),
    };

    return note;
  }

  async writeNote(relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, relativePath);
    const dir = path.dirname(fullPath);

    await fs.ensureDir(dir);
    await fs.writeFile(fullPath, content, 'utf-8');

    const stats = await fs.stat(fullPath);
    logger.info(`Wrote note: ${relativePath} (${stats.size} bytes)`);
  }

  async deleteNote(relativePath: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, relativePath);

    if (await fs.pathExists(fullPath)) {
      await fs.remove(fullPath);
      logger.info(`Deleted note: ${relativePath}`);
      await this.pruneEmptyFolders(relativePath);
    }
  }

  private async pruneEmptyFolders(relativePath: string): Promise<void> {
    const parts = relativePath.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const folderPath = path.join(this.vaultPath, ...parts.slice(0, i));
      const contents = await fs.readdir(folderPath).catch(() => null);
      if (contents && contents.length === 0) {
        await fs.rmdir(folderPath);
        logger.info(`Removed empty folder: ${parts.slice(0, i).join('/')}`);
      } else {
        break;
      }
    }
  }

  async noteExists(relativePath: string): Promise<boolean> {
    const fullPath = path.join(this.vaultPath, relativePath);
    return fs.pathExists(fullPath);
  }
}
