import {
  parseEmbeds,
  classifyTarget,
  parseOutlineAttachmentId,
  fileExtension,
  canonicalizeBody,
  replaceEmbeds,
  type EmbedTarget,
} from '../src/core/embeds';

describe('embeds: parseEmbeds', () => {
  test('parses a simple wikilink embed', () => {
    const [e] = parseEmbeds('text ![[img.png]] more');
    expect(e).toMatchObject({ kind: 'wikilink', target: 'img.png', alias: '' });
    expect(e.raw).toBe('![[img.png]]');
  });

  test('wikilink with folder and size option', () => {
    const [e] = parseEmbeds('![[sub/folder/pic.jpg|200]]');
    expect(e).toMatchObject({ kind: 'wikilink', target: 'sub/folder/pic.jpg', alias: '200' });
  });

  test('markdown embed with alt text and relative path', () => {
    const [e] = parseEmbeds('![my alt](path/to/img.png)');
    expect(e).toMatchObject({ kind: 'markdown', target: 'path/to/img.png', alias: 'my alt' });
  });

  test('markdown embed with %20-encoded spaces is decoded', () => {
    const [e] = parseEmbeds('![](attachments/a%20b%20c.png)');
    expect(e.target).toBe('attachments/a b c.png');
  });

  test('markdown embed with <>-wrapped path', () => {
    const [e] = parseEmbeds('![](<a b/c d.png>)');
    expect(e.target).toBe('a b/c d.png');
  });

  test('markdown embed with a title is handled', () => {
    const [e] = parseEmbeds('![alt](img.png "a title")');
    expect(e.target).toBe('img.png');
  });

  test('Outline redirect URL embed', () => {
    const [e] = parseEmbeds('![cap](/api/attachments.redirect?id=abc-123)');
    expect(e.target).toBe('/api/attachments.redirect?id=abc-123');
  });

  test('multiple mixed embeds in document order', () => {
    const body = '![[a.png]] x ![b](/api/attachments.redirect?id=z) y ![[c.pdf]]';
    const got = parseEmbeds(body).map(e => e.target);
    expect(got).toEqual(['a.png', '/api/attachments.redirect?id=z', 'c.pdf']);
  });

  test('no embeds → empty', () => {
    expect(parseEmbeds('just text, no [[note]] link')).toEqual([]);
  });
});

describe('embeds: classifyTarget', () => {
  const t = (s: string): EmbedTarget => classifyTarget(s);

  test('outline redirect URL (relative + absolute)', () => {
    expect(t('/api/attachments.redirect?id=uuid-1')).toEqual({ type: 'outline', id: 'uuid-1' });
    expect(t('https://notes.example.com/api/attachments.redirect?id=uuid-2'))
      .toEqual({ type: 'outline', id: 'uuid-2' });
  });

  test('local file with image extension', () => {
    expect(t('attachments/pic.png')).toEqual({ type: 'local', path: 'attachments/pic.png' });
    expect(t('doc.pdf')).toEqual({ type: 'local', path: 'doc.pdf' });
  });

  test('note embed (.md or extensionless) is ignored', () => {
    expect(t('Some Note')).toEqual({ type: 'ignore' });
    expect(t('Some Note.md')).toEqual({ type: 'ignore' });
  });

  test('external non-Outline URL is ignored', () => {
    expect(t('https://example.com/remote.png')).toEqual({ type: 'ignore' });
  });
});

describe('embeds: helpers', () => {
  test('parseOutlineAttachmentId tolerates extra query params', () => {
    expect(parseOutlineAttachmentId('/api/attachments.redirect?foo=1&id=xyz')).toBe('xyz');
    expect(parseOutlineAttachmentId('/api/attachments.redirect?id=xyz&w=10')).toBe('xyz');
    expect(parseOutlineAttachmentId('attachments/pic.png')).toBeUndefined();
  });

  test('fileExtension strips query and lowercases', () => {
    expect(fileExtension('a/b/IMG.PNG')).toBe('png');
    expect(fileExtension('pic.png?width=10')).toBe('png');
    expect(fileExtension('noext')).toBe('');
  });
});

describe('embeds: canonicalizeBody (idempotency core)', () => {
  // Map both representations of the same attachment to the same id.
  const resolve = (_m: any, target: EmbedTarget): string | undefined => {
    if (target.type === 'outline') return target.id;
    if (target.type === 'local') {
      // pretend attachments/pic.png is uploaded as attachment "A1"
      return target.path === 'attachments/pic.png' ? 'A1' : `local:${target.path}`;
    }
    return undefined;
  };

  test('Obsidian and Outline forms of the same attachment canonicalize equal', () => {
    const obsidian = 'intro ![[attachments/pic.png|300]] outro';
    const outline = 'intro ![pic](/api/attachments.redirect?id=A1) outro';
    expect(canonicalizeBody(obsidian, resolve)).toBe(canonicalizeBody(outline, resolve));
  });

  test('alt-text / size differences do not change the canonical form', () => {
    const a = '![one](/api/attachments.redirect?id=A1)';
    const b = '![two](/api/attachments.redirect?id=A1)';
    expect(canonicalizeBody(a, resolve)).toBe(canonicalizeBody(b, resolve));
  });

  test('note embeds and external URLs are left untouched', () => {
    const body = '![[Some Note]] and ![x](https://example.com/y.png)';
    expect(canonicalizeBody(body, resolve)).toBe(body);
  });

  test('unmapped local attachment gets a stable local: key (differs from id)', () => {
    const body = '![[attachments/new.png]]';
    expect(canonicalizeBody(body, resolve)).toBe('⟦att:local:attachments/new.png⟧');
  });
});

describe('embeds: replaceEmbeds', () => {
  test('rebuilds body preserving non-embed text', () => {
    const out = replaceEmbeds('a ![[x.png]] b ![[y.pdf]] c', () => 'Z');
    expect(out).toBe('a Z b Z c');
  });
});
