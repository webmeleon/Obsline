# Obsline v0.5.6

Bi-directional sync between [Obsidian](https://obsidian.md) and a self-hosted [Outline](https://www.getoutline.com/) instance.

## Features

- **Obsidian Plugin** — native integration with sync-on-change or interval-based sync
- **CLI Tool** — optional command-line interface for scripting and headless use
- **Nested documents** — Outline sub-notes map to subfolders in Obsidian (coexistence pattern)
- **Collection → Folder mapping** — Outline collections appear as top-level folders in Obsidian
- **Inbox collection** — root-level vault notes sync to a configurable Inbox collection
- **Rename detection** — content-hash based rename tracking (no duplicates)
- **Auto-collection creation** — new Obsidian folders automatically create Outline collections
- **Conflict resolution** — last-write-wins, Obsidian-wins, or Outline-wins
- **Initial sync direction** — choose which side is authoritative on the very first sync
- **Auto-update** — plugin checks for new releases on load and offers one-click in-place update
- **Danger zone** — reset local sync state or wipe all Outline data for a clean first sync
- **Cross-platform** — Windows, Mac, Linux, iOS, Android (Obsidian mobile app)

---

## Obsidian Plugin (recommended)

### Installation

**Option A — Download release (no build required)**

1. Download `obsline-v0.5.6.zip` from the [latest release](https://github.com/webmeleon/Obsline/releases/latest)
2. Unzip and run the install script:

   ```bash
   # macOS / Linux
   ./install.sh /path/to/your/obsidian/vault
   ```

   ```powershell
   # Windows (PowerShell)
   .\install.ps1 -Vault "C:\path\to\your\obsidian\vault"
   ```

   Or copy `main.js`, `manifest.json`, `styles.css` manually into:
   `<vault>/.obsidian/plugins/obsline/`

3. Restart Obsidian and enable **Obsline – Outline Sync** under Settings → Community plugins

**Option B — Build from source**

```bash
cd plugin
npm install
npm run build
./install.sh /path/to/your/obsidian/vault
```

### Configuration

Open **Settings → Obsline – Outline Sync** and fill in:

| Setting | Description |
|---------|-------------|
| Outline server URL | Base URL, e.g. `https://notes.example.com` |
| API key | See instructions below |
| Sync trigger | On change (30 s debounce) or every 1–30 min |
| Conflict resolution | Last-write-wins / Obsidian-wins / Outline-wins |
| Inbox collection | Collection for root-level vault notes (default: `Inbox`) |
| First-sync direction | Which side wins on the very first sync |
| Ignored paths | Folders/files to exclude (e.g. `Templates, Attachments`) |

#### How to create an Outline API key

1. Open Outline → **Settings** → **API Tokens**
2. Click **New token**, give it a name like `Obsidian Sync`
3. Copy the token (starts with `ol_api_…`) and paste it into Obsline settings

### Sync behaviour

- **On change** — vault events (create/modify/delete/rename) trigger a sync after a 30-second debounce
- **Interval** — syncs every N minutes regardless of changes
- **Manual** — ribbon icon or command palette: *Obsline: Sync now*

After the first sync the direction is always bidirectional.

### Folder structure

Outline's document hierarchy maps to Obsidian using a coexistence pattern:

```
Outline:                    Obsidian:
Projects                    Projects/
  Website          →          Website.md        ← parent content
    Design         →          Website/
    Mockups        →            Design.md
                                Mockups.md
```

Parent notes stay flat. Children appear in a same-named subfolder.

### Auto-update

When a new release is available, Obsline shows a notification on startup with an **Update now** button. Clicking it downloads and extracts the release ZIP directly into the plugin folder. Restart Obsidian afterwards to activate the new version.

### Danger zone

Found in Settings → Obsline → **Danger zone**:

- **Reset sync state** — clears local tracking only (Outline data untouched). Use this when setting up a new machine and you want Obsidian to pull existing Outline content.
- **Delete everything in Outline** — deletes ALL collections and documents from Outline, then resets local state. Use before a clean first sync from Obsidian. Both actions require a double-click confirmation.

---

## CLI Tool

The CLI is for environments where Obsidian isn't running — a server, a headless machine, a cron job, or a RAG/ML pipeline that needs files kept in sync without a desktop app. If you have Obsidian open most of the time, use the plugin instead.

```bash
git clone https://github.com/webmeleon/Obsline.git
cd Obsline
npm install

# Configure (creates ~/.obsline/config.json)
npm run dev config

# One-off sync
npm run dev sync

# Polling daemon — syncs every N seconds (default: 300)
npm run dev sync --daemon

# Show sync status
npm run dev status
```

### Config file: `~/.obsline/config.json`

```json
{
  "obsidianVault": "/Users/you/Documents/Obsidian/MyVault",
  "outlineUrl": "https://notes.example.com",
  "outlineApiToken": "ol_api_...",
  "syncInterval": 300,
  "conflictResolution": "last-write-wins",
  "ignorePaths": [".obsidian", ".trash", ".DS_Store", "Templates"]
}
```

---

## Development

```bash
# CLI tool
npm install
npm test                 # Run all tests
npm run dev sync         # Test against real Outline

# Obsidian plugin
cd plugin
npm install
npm run dev              # Watch mode
npm run build            # Production build
npm run release          # Build + create releases/obsline-vX.Y.Z.zip
```

### Architecture

```
obsline/
├── src/               # CLI tool (Node.js + Commander.js)
│   ├── core/
│   │   ├── obsidian.ts    # Vault reader (fs-extra)
│   │   ├── outline.ts     # Outline REST client (axios)
│   │   └── sync.ts        # Bi-directional sync engine
│   ├── utils/
│   │   ├── config.ts      # ~/.obsline/config.json
│   │   └── logger.ts
│   ├── index.ts           # CLI entry point
│   └── version.ts         # Shared version constant
├── plugin/            # Obsidian plugin (esbuild bundle)
│   ├── src/
│   │   ├── main.ts          # Plugin lifecycle + auto-update
│   │   ├── settings.ts      # Settings UI + danger zone
│   │   ├── sync-engine.ts   # Sync engine (Obsidian Vault API)
│   │   ├── outline-client.ts # Outline REST client (requestUrl)
│   │   └── types.ts         # Shared types
│   ├── install.sh           # Mac/Linux installer
│   └── install.ps1          # Windows installer
├── scripts/
│   └── package-plugin.mjs  # Creates release ZIP
└── tests/             # Jest tests
```

## License

MIT — Copyright (c) 2026 Marvin Schill
