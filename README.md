# Obsline v0.2.0

Bi-directional sync between [Obsidian](https://obsidian.md) and a self-hosted [Outline](https://www.getoutline.com/) instance.

## Features

- **Obsidian Plugin** — native integration with sync-on-change or interval-based sync
- **CLI Tool** — optional command-line interface for scripting and headless use
- **Collection → Folder mapping** — Outline collections appear as top-level folders in Obsidian
- **Rename detection** — content-hash based rename tracking (no duplicates)
- **Auto-collection creation** — new Obsidian folders automatically create Outline collections
- **Conflict resolution** — last-write-wins, Obsidian-wins, or Outline-wins
- **Initial sync direction** — choose which side is authoritative on the very first sync
- **Cross-platform** — Windows, Mac, Linux

---

## Obsidian Plugin (recommended)

### Installation

1. **Build the plugin**

   ```bash
   cd plugin
   npm install
   npm run build
   ```

2. **Copy to your vault**

   ```bash
   # macOS/Linux
   VAULT=~/Documents/Obsidian/MyVault
   mkdir -p "$VAULT/.obsidian/plugins/obsline"
   cp plugin/main.js plugin/manifest.json plugin/styles.css "$VAULT/.obsidian/plugins/obsline/"
   ```

   On Windows (PowerShell):
   ```powershell
   $VAULT = "$env:USERPROFILE\Documents\Obsidian\MyVault"
   New-Item -ItemType Directory -Force "$VAULT\.obsidian\plugins\obsline"
   Copy-Item plugin\main.js, plugin\manifest.json, plugin\styles.css "$VAULT\.obsidian\plugins\obsline\"
   ```

3. **Enable in Obsidian**

   Settings → Community plugins → enable **Obsline – Outline Sync**

### Configuration

Open **Settings → Obsline – Outline Sync** and fill in:

| Setting | Description |
|---------|-------------|
| Outline server URL | Base URL, e.g. `https://notes.example.com` |
| API key | See instructions below |
| Sync trigger | On change (30 s debounce) or every 1–30 min |
| Conflict resolution | Last-write-wins / Obsidian-wins / Outline-wins |
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

---

## CLI Tool

```bash
# Install dependencies
npm install

# Configure (edit ~/.obsline/config.json)
npm run dev config

# Run a one-off sync
npm run dev sync

# Run as daemon (polls every 5 min by default)
npm run dev sync --daemon

# Show status
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
npm test           # Run all tests (43 tests)
npm run dev sync   # Test sync against real Outline

# Obsidian plugin
cd plugin
npm install
npm run dev        # Watch mode — rebuilds on change
npm run build      # Production build
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
│   └── src/
│       ├── main.ts          # Plugin lifecycle
│       ├── settings.ts      # Settings UI tab
│       ├── sync-engine.ts   # Sync engine (Obsidian Vault API)
│       ├── outline-client.ts # Outline REST client (requestUrl)
│       └── types.ts         # Shared types
└── tests/             # Jest tests
```

## License

MIT
