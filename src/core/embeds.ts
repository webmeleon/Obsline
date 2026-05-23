/**
 * Embed parsing & transformation — the heart of idempotent attachment sync.
 *
 * The two sides hold the SAME document in DIFFERENT embed syntax:
 *   Obsidian:  ![[img.png]]  ·  ![[folder/img.png|200]]  ·  ![alt](img.png)  ·  ![alt](a/b%20c.png)
 *   Outline:   ![alt](/api/attachments.redirect?id=UUID)  ·  ![alt](https://host/api/attachments.redirect?id=UUID)
 *
 * Comparing raw bodies would mark every synced doc as "changed" forever. So all
 * content diffs run over a CANONICAL form where every attachment embed collapses to
 * a stable `⟦att:ID⟧` token keyed on attachment identity (id or, pre-upload, path).
 *
 * This module is PURE (no IO, no Node/Obsidian deps) so the CLI and the plugin can
 * share identical logic — the plugin mirrors it in `plugin/src/embeds.ts`.
 */

export interface EmbedMatch {
  raw: string;                       // full matched text incl. delimiters
  start: number;                     // index into the body
  end: number;
  kind: 'wikilink' | 'markdown';
  target: string;                    // decoded link target (path or URL), no <> / %xx
  alias: string;                     // markdown alt-text, or wikilink post-`|` text; '' if none
}

export type EmbedTarget =
  | { type: 'outline'; id: string }  // an Outline attachment redirect URL
  | { type: 'local'; path: string }  // a vault-local file with a non-md extension
  | { type: 'ignore' };              // note embed, extensionless, or external URL — leave alone

const WIKILINK_EMBED = /!\[\[([^\]]+)\]\]/g;
// Markdown image: ![alt](url) — url may be <wrapped>, %-encoded, or followed by a "title".
const MARKDOWN_EMBED = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Decode %xx, strip <> wrappers and a leading ./ — yields the bare target string. */
export function normalizeTarget(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  try { t = decodeURIComponent(t); } catch { /* leave malformed encodings as-is */ }
  if (t.startsWith('./')) t = t.slice(2);
  return t;
}

/** Extract the attachment UUID from an Outline redirect URL, else undefined. */
export function parseOutlineAttachmentId(target: string): string | undefined {
  const m = target.match(/attachments\.redirect\?(?:[^#\s]*&)?id=([^&#\s]+)/);
  return m ? m[1] : undefined;
}

/** Lower-cased file extension of a path/URL (query & hash stripped); '' if none. */
export function fileExtension(target: string): string {
  const base = target.split(/[?#]/)[0];
  const name = base.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isExternalUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('//');
}

/**
 * Classify an embed target. Order matters: an Outline redirect URL is an attachment
 * even though it has no file extension, so it's checked first.
 */
export function classifyTarget(target: string): EmbedTarget {
  const id = parseOutlineAttachmentId(target);
  if (id) return { type: 'outline', id };
  if (isExternalUrl(target)) return { type: 'ignore' };  // external non-Outline URL
  const ext = fileExtension(target);
  if (ext === '' || ext === 'md') return { type: 'ignore' };  // note embed / extensionless
  return { type: 'local', path: target };
}

/** Find every embed (wikilink + markdown) in the body, in document order. */
export function parseEmbeds(body: string): EmbedMatch[] {
  const matches: EmbedMatch[] = [];

  for (const m of body.matchAll(WIKILINK_EMBED)) {
    const inner = m[1];
    const bar = inner.indexOf('|');
    const targetRaw = bar >= 0 ? inner.slice(0, bar) : inner;
    const alias = bar >= 0 ? inner.slice(bar + 1) : '';
    matches.push({
      raw: m[0], start: m.index!, end: m.index! + m[0].length,
      kind: 'wikilink', target: normalizeTarget(targetRaw), alias,
    });
  }

  for (const m of body.matchAll(MARKDOWN_EMBED)) {
    matches.push({
      raw: m[0], start: m.index!, end: m.index! + m[0].length,
      kind: 'markdown', target: normalizeTarget(m[2]), alias: m[1],
    });
  }

  // Document order; drop any overlap (a wikilink can't overlap a markdown embed, but be safe).
  matches.sort((a, b) => a.start - b.start);
  const out: EmbedMatch[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.start >= cursor) { out.push(m); cursor = m.end; }
  }
  return out;
}

/** Rebuild a body, replacing each embed with the string returned by `fn` (raw to keep it). */
export function replaceEmbeds(body: string, fn: (m: EmbedMatch) => string): string {
  const embeds = parseEmbeds(body);
  if (embeds.length === 0) return body;
  let out = '';
  let last = 0;
  for (const e of embeds) {
    out += body.slice(last, e.start) + fn(e);
    last = e.end;
  }
  return out + body.slice(last);
}

/** Async variant of {@link replaceEmbeds} — for transforms that download/upload. */
export async function replaceEmbedsAsync(
  body: string,
  fn: (m: EmbedMatch) => Promise<string>,
): Promise<string> {
  const embeds = parseEmbeds(body);
  if (embeds.length === 0) return body;
  let out = '';
  let last = 0;
  for (const e of embeds) {
    out += body.slice(last, e.start) + (await fn(e));
    last = e.end;
  }
  return out + body.slice(last);
}

/**
 * Collapse every attachment embed to a stable `⟦att:KEY⟧` token so two representations
 * of the same document hash equal. `resolveId` maps an embed to its attachment identity:
 *   - Outline embeds use their URL id directly.
 *   - Local embeds are resolved via the caller (path → mapped attachment id). When the
 *     local file isn't uploaded yet, the caller returns a `local:<vaultPath>` key so the
 *     doc still reads as "changed" vs. Outline until the upload happens, then converges.
 * Note/external embeds are left untouched. Alt-text and wikilink size (`|200`) are
 * intentionally dropped from the canonical form — they don't round-trip between the two
 * systems, so ignoring them is what keeps re-sync a no-op.
 */
export function canonicalizeBody(
  body: string,
  resolveId: (m: EmbedMatch, t: EmbedTarget) => string | undefined,
): string {
  return replaceEmbeds(body, (m) => {
    const t = classifyTarget(m.target);
    if (t.type === 'ignore') return m.raw;
    const key = resolveId(m, t);
    return key !== undefined ? `⟦att:${key}⟧` : m.raw;
  });
}
