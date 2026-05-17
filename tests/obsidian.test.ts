import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { ObsidianReader, ObsidianNote } from '../src/core/obsidian';

describe('ObsidianReader', () => {
  let tempVault: string;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsline-vault-'));
  });

  afterEach(async () => {
    await fs.remove(tempVault);
  });

  test('should read empty vault', async () => {
    const reader = new ObsidianReader(tempVault);
    const notes = await reader.readVault();

    expect(notes).toHaveLength(0);
  });

  test('should read single note', async () => {
    const noteContent = '# Test\nThis is a test note.';
    await fs.writeFile(path.join(tempVault, 'test.md'), noteContent);

    const reader = new ObsidianReader(tempVault);
    const notes = await reader.readVault();

    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('test');
    expect(notes[0].content).toBe(noteContent);
    expect(notes[0].path).toBe('test.md');
  });

  test('should read nested notes', async () => {
    const subdir = path.join(tempVault, 'subdir');
    await fs.ensureDir(subdir);
    await fs.writeFile(path.join(tempVault, 'note1.md'), 'Note 1');
    await fs.writeFile(path.join(subdir, 'note2.md'), 'Note 2');

    const reader = new ObsidianReader(tempVault);
    const notes = await reader.readVault();

    expect(notes).toHaveLength(2);
    expect(notes.map(n => n.path)).toContain('note1.md');
    expect(notes.map(n => n.path)).toContain('subdir/note2.md');
  });

  test('should ignore specified paths', async () => {
    await fs.ensureDir(path.join(tempVault, '.obsidian'));
    await fs.ensureDir(path.join(tempVault, '.trash'));
    await fs.writeFile(path.join(tempVault, 'note.md'), 'Note');
    await fs.writeFile(path.join(tempVault, '.obsidian', 'workspace.json'), '{}');
    await fs.writeFile(path.join(tempVault, '.trash', 'deleted.md'), 'Deleted');

    const reader = new ObsidianReader(tempVault, ['.obsidian', '.trash']);
    const notes = await reader.readVault();

    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('note');
  });

  test('should ignore .DS_Store and temp files', async () => {
    await fs.writeFile(path.join(tempVault, 'note.md'), 'Note');
    await fs.writeFile(path.join(tempVault, '.DS_Store'), 'mac junk');
    await fs.writeFile(path.join(tempVault, 'temp.tmp'), 'temp file');

    const reader = new ObsidianReader(tempVault, ['.DS_Store', '*.tmp']);
    const notes = await reader.readVault();

    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('note');
  });

  test('should write note', async () => {
    const reader = new ObsidianReader(tempVault);
    const content = '# New Note\nContent here.';

    await reader.writeNote('new.md', content);

    const written = await fs.readFile(path.join(tempVault, 'new.md'), 'utf-8');
    expect(written).toBe(content);
  });

  test('should write note in nested directory', async () => {
    const reader = new ObsidianReader(tempVault);
    const content = '# Nested Note';

    await reader.writeNote('folder/subfolder/note.md', content);

    const written = await fs.readFile(path.join(tempVault, 'folder', 'subfolder', 'note.md'), 'utf-8');
    expect(written).toBe(content);
  });

  test('should read specific note', async () => {
    const noteContent = '# Specific Note';
    await fs.writeFile(path.join(tempVault, 'specific.md'), noteContent);

    const reader = new ObsidianReader(tempVault);
    const note = await reader.readNote('specific.md');

    expect(note.title).toBe('specific');
    expect(note.content).toBe(noteContent);
    expect(note.path).toBe('specific.md');
    expect(note.lastModified).toBeGreaterThan(0);
  });

  test('should delete note', async () => {
    const notePath = path.join(tempVault, 'delete-me.md');
    await fs.writeFile(notePath, 'To delete');

    const reader = new ObsidianReader(tempVault);
    expect(await reader.noteExists('delete-me.md')).toBe(true);

    await reader.deleteNote('delete-me.md');
    expect(await reader.noteExists('delete-me.md')).toBe(false);
  });

  test('should check if note exists', async () => {
    await fs.writeFile(path.join(tempVault, 'exists.md'), 'Content');

    const reader = new ObsidianReader(tempVault);
    expect(await reader.noteExists('exists.md')).toBe(true);
    expect(await reader.noteExists('nonexistent.md')).toBe(false);
  });

  test('should throw on non-existent vault', async () => {
    const reader = new ObsidianReader('/nonexistent/vault');

    await expect(reader.readVault()).rejects.toThrow('does not exist');
  });

  test('should track lastModified timestamp', async () => {
    const noteFile = path.join(tempVault, 'timestamped.md');
    const beforeWrite = Date.now();
    await fs.writeFile(noteFile, 'Content');
    const afterWrite = Date.now() + 10;

    const reader = new ObsidianReader(tempVault);
    const notes = await reader.readVault();

    expect(notes[0].lastModified).toBeLessThanOrEqual(afterWrite);
    expect(notes[0].lastModified).toBeGreaterThanOrEqual(beforeWrite);
  });
});
