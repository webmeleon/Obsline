# Obsline

A bi-directional synchronization connector between Obsidian and Outline.

## Features

- **Bi-directional sync:** Keep notes in sync between Obsidian and Outline
- **Local file preservation:** Original Markdown files stored locally for RAG/ML use
- **Cross-platform:** Runs on Mac, Windows, and Linux
- **CLI-based:** Simple command-line interface
- **Optional daemon:** Background service for periodic syncing

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run sync
npm run dev sync

# Run tests
npm test
```

## Project Structure

See [CLAUDE.md](./CLAUDE.md) for detailed architecture and development guidance.

## Configuration

Configuration is stored in `~/.obsline/config.json`. See CLAUDE.md for details.

## Development

```bash
npm run dev       # Run CLI in development
npm test          # Run tests
npm run lint      # Lint code
npm run format    # Format code
npm run type-check # Type checking
```

## License

MIT
