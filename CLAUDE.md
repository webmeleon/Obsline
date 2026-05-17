# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Obsline v0.2.0** — Bi-directional sync between Obsidian and a self-hosted Outline instance.

Two distinct deliverables in one repo:
1. **CLI tool** (`src/`) — Node.js + Commander.js, runs on any machine
2. **Obsidian plugin** (`plugin/`) — esbuild-bundled TypeScript, uses Obsidian's plugin API

**Key design constraints:**
- Local `.md` files are the source of truth for RAG/ML pipelines
- No deletion propagation from Outline → Obsidian (only Obsidian deletes propagate to Outline)
- All Outline API endpoints use **POST** (not GET)
- Documents must be created with `publish: true` or they land in Drafts

## Common Commands

```bash
# CLI tool
npm install
npm test                        # Run all 43 tests (Jest)
npm test -- tests/sync.test.ts  # Run one test file
npm run dev sync                # Test sync against real Outline
npm run dev sync --daemon       # Polling daemon mode
npm run type-check              # TypeScript check without emit

# Obsidian plugin
cd plugin && npm install
npm run build                   # Production bundle → plugin/main.js
npm run dev                     # Watch mode (esbuild --watch)

# Deploy plugin to vault (macOS)
VAULT=~/Documents/Obsidian/Marvin
cp plugin/main.js plugin/manifest.json plugin/styles.css \
   "$VAULT/.obsidian/plugins/obsline/"
```

## Architecture

### CLI tool (`src/`)

| File | Role |
|------|------|
| `src/version.ts` | Single source of version string (`VERSION = '0.2.0'`) |
| `src/index.ts` | Commander.js CLI — commands: `sync`, `config`, `status` |
| `src/core/obsidian.ts` | Vault reader/writer using `fs-extra`; uses `minimatch` (v9 named import) |
| `src/core/outline.ts` | Outline REST client using `axios`; all calls are POST |
| `src/core/sync.ts` | Bi-directional sync engine; manages `SyncState` |
| `src/utils/config.ts` | Config at `~/.obsline/config.json`; `getConfigDir()` is dynamic (reads `process.env.HOME` at call time) |
| `src/utils/logger.ts` | Simple timestamped logger |

### Obsidian plugin (`plugin/src/`)

| File | Role |
|------|------|
| `main.ts` | Plugin lifecycle, status bar, ribbon icon, commands, sync scheduler |
| `settings.ts` | `PluginSettingTab` — full settings UI including connection test and sync status |
| `sync-engine.ts` | Sync logic using `app.vault` API instead of `fs`; `requestUrl` instead of axios |
| `outline-client.ts` | Outline REST client using Obsidian's `requestUrl` |
| `types.ts` | Shared interfaces: `ObslineSettings`, `SyncState`, `OutlineDocument`, etc. |

### Sync state

Both the CLI and plugin maintain a `SyncState` with:
- `outlineIdMap`: `outlineId → obsidianPath`
- `pathToOutlineId`: `obsidianPath → outlineId` (reverse, for O(1) rename detection)
- `fileHashes`: `obsidianPath → md5(content)` (change detection)
- `firstSyncDone`: controls initial-sync-direction logic

CLI stores state at `~/.obsline/sync-state.json`. Plugin uses `this.loadData()`/`this.saveData()`.

### Rename detection

When an Obsidian file has no known Outline mapping, its content hash is checked against `hashToOutlineId` (built from all loaded Outline documents). A match with a different path = rename → `updateDocument` with new title, update both maps.

### Collection ↔ Folder mapping

- Top-level Obsidian folders → Outline Collections
- `ensureCollections()` auto-creates missing Collections before sync
- `buildPath()` walks `parentDocumentId` chain to reconstruct nested paths

## Key Decisions

- `getConfigDir()` / `getConfigFile()` read `process.env.HOME` dynamically so test overrides work
- Plugin uses Obsidian's `requestUrl` (not axios) to work in Electron's renderer process
- esbuild externals include all Node.js builtins so `crypto` works at runtime in Obsidian
- On-change sync debounces 30 seconds to avoid mid-edit noise
- `publish: true` is required on create/update — otherwise documents go to Drafts

## Testing

```bash
npm test                 # All suites
npm test -- --watch      # Watch mode
```

Tests mock `../src/core/obsidian` and `../src/core/outline` via `jest.mock()`. Tests that manipulate `syncState` before calling `sync()` must redirect `HOME` to a temp dir so `loadSyncState()` doesn't overwrite the injected state:

```typescript
const originalHome = process.env.HOME;
process.env.HOME = tempVault; // no sync-state.json here
try { /* test */ } finally { process.env.HOME = originalHome; }
```

## Config

`~/.obsline/config.json`:
```json
{
  "obsidianVault": "/Users/marvin/Documents/Obsidian/Marvin",
  "outlineUrl": "https://notes.hydrahub.de",
  "outlineApiToken": "ol_api_...",
  "syncInterval": 300,
  "conflictResolution": "last-write-wins",
  "ignorePaths": [".obsidian", ".trash", ".DS_Store", "*.tmp"]
}
```
