/**
 * Finds duplicate Outline documents (same title + collectionId) and deletes
 * the newer ones, keeping the oldest version (which the CLI already tracks).
 *
 * Run: npx ts-node scripts/fix-duplicates.ts
 */

import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';

const CONFIG_FILE = path.join(process.env.HOME || '~', '.obsline', 'config.json');

async function main() {
  const config = await fs.readJSON(CONFIG_FILE);
  const { outlineUrl, outlineApiToken } = config;

  const client = axios.create({
    baseURL: `${outlineUrl.replace(/\/$/, '')}/api`,
    headers: {
      Authorization: `Bearer ${outlineApiToken}`,
      'Content-Type': 'application/json',
    },
  });

  // Load CLI sync state to know which IDs we want to KEEP
  const stateFile = path.join(process.env.HOME || '~', '.obsline', 'sync-state.json');
  const state = await fs.readJSON(stateFile);
  const keepIds = new Set<string>(Object.keys(state.outlineIdMap));
  console.log(`CLI tracks ${keepIds.size} documents:`, [...keepIds]);

  // Fetch all documents
  const res = await client.post<{ data: Array<{ id: string; title: string; collectionId: string; createdAt: string; updatedAt: string }> }>(
    '/documents.list', {}
  );
  const docs = res.data.data;
  console.log(`\nOutline has ${docs.length} total documents`);

  // Group by collectionId + title
  const groups = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.collectionId}::${doc.title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(doc);
  }

  const duplicateGroups = [...groups.values()].filter(g => g.length > 1);
  if (duplicateGroups.length === 0) {
    console.log('\nNo duplicates found — nothing to do.');
    return;
  }

  console.log(`\nFound ${duplicateGroups.length} duplicate group(s):\n`);

  const toDelete: string[] = [];

  for (const group of duplicateGroups) {
    // Sort: keep IDs that CLI tracks first, then oldest by createdAt
    group.sort((a, b) => {
      const aKeep = keepIds.has(a.id) ? 0 : 1;
      const bKeep = keepIds.has(b.id) ? 0 : 1;
      if (aKeep !== bKeep) return aKeep - bKeep;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const [keep, ...dupes] = group;
    console.log(`  "${keep.title}"`);
    console.log(`    KEEP:   ${keep.id} (created ${keep.createdAt})`);
    for (const d of dupes) {
      console.log(`    DELETE: ${d.id} (created ${d.createdAt})`);
      toDelete.push(d.id);
    }
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} duplicate(s)…`);
  for (const id of toDelete) {
    await client.post('/documents.delete', { id });
    console.log(`  Deleted ${id}`);
  }

  console.log('\nDone! Run "npm run dev sync" once more to stabilise state.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
