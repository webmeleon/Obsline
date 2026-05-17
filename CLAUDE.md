# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Obsline** — A bi-directional synchronization connector between Obsidian and Outline.

**Goal:** Keep local Markdown files in Obsidian in sync with Outline, enabling:
- Local MD files on desktop (Mac, Windows, Linux) for RAG/ML use cases
- Outline as a secondary interface (especially via web on mobile)
- Seamless note taking across devices

**Key Constraint:** Local MD files are the source of truth for RAG/LLM applications.

## Tech Stack

- **Runtime:** Node.js 18+ with TypeScript
- **Package Manager:** npm or yarn
- **CLI Framework:** Commander.js (for CLI commands)
- **Daemon/Service:** node-daemon or native OS services
- **Testing:** Jest or Vitest
- **File Handling:** fs-extra (cross-platform file ops)
- **APIs:** 
  - Obsidian Vault API (local file system)
  - Outline API (REST)

## Project Structure

```
obsline/
├── src/
│   ├── cli/                 # CLI entry points
│   │   └── commands/        # Individual CLI commands (sync, status, config, etc.)
│   ├── core/                # Core sync logic
│   │   ├── obsidian.ts      # Obsidian vault reader
│   │   ├── outline.ts       # Outline API client
│   │   └── sync.ts          # Bi-directional sync engine
│   ├── daemon/              # Background service (optional)
│   │   └── service.ts       # Daemon lifecycle management
│   ├── utils/               # Shared utilities
│   │   ├── logger.ts
│   │   └── config.ts        # Config file management (~/.obsline/config.json)
│   └── index.ts
├── tests/                   # Jest/Vitest test files
│   ├── sync.test.ts
│   ├── obsidian.test.ts
│   └── outline.test.ts
├── package.json
├── tsconfig.json
├── jest.config.js (or vitest.config.ts)
└── README.md
```

## Common Commands

```bash
# Setup
npm install

# Development
npm run dev                  # Run CLI in dev mode
npm run build               # Compile TypeScript to JS
npm run watch               # Watch and recompile on changes

# Testing
npm test                    # Run all tests
npm test -- sync.test.ts   # Run specific test file
npm test -- --watch        # Watch mode for tests

# Linting & Formatting
npm run lint                # Run ESLint
npm run format              # Format with Prettier
npm run type-check          # Run TypeScript type checker

# Production
npm run build
npm start                   # Run compiled CLI
npm run daemon:start        # Start background service
npm run daemon:stop         # Stop background service
```

## Architecture

### Core Components

1. **Obsidian Module** (`src/core/obsidian.ts`)
   - Reads local vault (file system)
   - Tracks file metadata (modified time, size)
   - Handles nested folder structures

2. **Outline Module** (`src/core/outline.ts`)
   - REST API client for Outline
   - Authentication handling
   - Document CRUD operations

3. **Sync Engine** (`src/core/sync.ts`)
   - Conflict resolution (last-write-wins or manual)
   - Bidirectional change detection
   - Metadata tracking (sync state file: `~/.obsline/sync-state.json`)

4. **CLI** (`src/cli/`)
   - Commands: `sync`, `status`, `config`, `auth`
   - User-facing interface

5. **Daemon** (optional, `src/daemon/`)
   - Polls for changes periodically
   - Runs on schedule (e.g., every 5 minutes)

### Sync Strategy

- **Change Detection:** Compare file timestamps + content hash (MD5/SHA1)
- **Conflict Resolution:** Log conflicts, user decision or last-write-wins
- **Sync State:** Stored locally in `~/.obsline/sync-state.json`
  - Tracks: last-synced version, file hashes, timestamps
- **Bi-directional:** Changes in Obsidian AND Outline are detected and merged

## Configuration

Config file: `~/.obsline/config.json`

```json
{
  "obsidianVault": "/Users/user/Vaults/MyVault",
  "outlineUrl": "https://outline.example.com",
  "outlineApiToken": "...",
  "syncInterval": 300,
  "conflictResolution": "last-write-wins",
  "ignorePaths": [".obsidian", ".trash", "*.tmp"]
}
```

## Key Decisions

- **Local files as source of truth:** Obsidian is primary, Outline is secondary. Deletes in Outline don't delete local files.
- **No deletion propagation:** Only Obsidian deletes trigger Outline deletion (safer for RAG).
- **Config in home directory:** `~/.obsline/` for user-agnostic setup across devices.
- **Cross-platform:** Use `path` module and `fs-extra` for file ops, avoid shell-specific code.

## Testing Strategy

- **Unit Tests:** Sync logic, conflict detection, file handling
- **Integration Tests:** Mock Outline API, test real file I/O
- **No E2E tests initially:** Too risky with real Outline/Obsidian instances

## Future Enhancements

- Obsidian plugin for native integration
- Encryption for Outline API tokens
- Advanced conflict resolution (3-way merge)
- Web UI for configuration
- Docker image for headless sync
