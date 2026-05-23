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

  async moveNote(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const oldFull = path.join(this.vaultPath, oldRelativePath);
    const newFull = path.join(this.vaultPath, newRelativePath);
    await fs.ensureDir(path.dirname(newFull));
    await fs.move(oldFull, newFull, { overwrite: true });
    logger.info(`Moved note: ${oldRelativePath} → ${newRelativePath}`);
    await this.pruneEmptyFolders(oldRelativePath);
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

  // ── Binary IO (attachments) ───────────────────────────────────────────────

  async readBinary(relativePath: string): Promise<Buffer> {
    const fullPath = path.join(this.vaultPath, relativePath);
    return fs.readFile(fullPath); // no encoding → Buffer
  }

  async writeBinary(relativePath: string, data: Buffer): Promise<void> {
    const fullPath = path.join(this.vaultPath, relativePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, data);
    logger.info(`Wrote attachment: ${relativePath} (${data.byteLength} bytes)`);
  }

  /**
   * Find a vault file by its embed target (Obsidian-style resolution, approximated):
   * try the path verbatim, then relative to the embedding note's folder, then a
   * vault-wide search by exact filename (shortest path wins). Returns the
   * vault-relative path or undefined.
   */
  async resolveAttachment(target: string, sourcePath: string): Promise<string | undefined> {
    const candidates: string[] = [target];
    const srcDir = path.posix.dirname(sourcePath);
    if (srcDir && srcDir !== '.') candidates.push(path.posix.join(srcDir, target));
    for (const rel of candidates) {
      if (await this.noteExists(rel)) return rel.replace(/\\/g, '/');
    }
    // Vault-wide fallback: match by filename, prefer the shortest path.
    const wanted = target.split('/').pop()!;
    const found: string[] = [];
    await this.walkFiles(this.vaultPath, wanted, found);
    if (found.length === 0) return undefined;
    found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    return found[0];
  }

  private async walkFiles(dir: string, wantedName: string, out: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(this.vaultPath, full).replace(/\\/g, '/');
      if (this.shouldIgnore(rel)) continue;
      if (entry.isDirectory()) {
        await this.walkFiles(full, wantedName, out);
      } else if (entry.isFile() && entry.name === wantedName) {
        out.push(rel);
      }
    }
  }

  /** All vault-relative file paths (any type), respecting ignore patterns. */
  async listAllFiles(): Promise<string[]> {
    const out: string[] = [];
    await this.walkAll(this.vaultPath, out);
    return out;
  }

  private async walkAll(dir: string, out: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(this.vaultPath, full).replace(/\\/g, '/');
      if (this.shouldIgnore(rel)) continue;
      if (entry.isDirectory()) await this.walkAll(full, out);
      else if (entry.isFile()) out.push(rel);
    }
  }
}
