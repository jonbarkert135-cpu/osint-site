/**
 * Per-type schemas, validation and export round-trips (P4 §5.2, §11). The validators exist so the
 * card can say what is wrong in the analyst's terms; each message is asserted, because "invalid
 * input" would be worse than saying nothing.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeNode, type BoardNode } from '../src/entities/node.ts';
import { clean, hostOf, isPrivateHost, keywords, urlIssues } from '../src/nodes/define.ts';
import { builtinNodeTypes } from '../src/nodes/builtins.ts';
import { fileType } from '../src/nodes/types/file.ts';
import { imageType } from '../src/nodes/types/image.ts';
import { personType } from '../src/nodes/types/person.ts';
import { richTextSizeIssue, textType } from '../src/nodes/types/text.ts';
import { unknownType } from '../src/nodes/types/unknown.ts';
import { websiteType } from '../src/nodes/types/website.ts';
import type { NodeTypeDefinition, TypedNode } from '../src/nodes/types.ts';

const T0 = '2026-01-01T00:00:00.000Z';

function nodeWith<TData>(def: NodeTypeDefinition<TData>, data: Partial<TData>): TypedNode<TData> {
  const parsed = def.schema.parse({ ...(def.defaults.data as object), ...data });
  const base: BoardNode = makeNode(
    { id: 'n_1', type: def.type, x: 0, y: 0, data: parsed as Record<string, unknown> },
    T0,
  );
  return base as TypedNode<TData>;
}

describe('define helpers', () => {
  it('hostOf returns the host or an empty string', () => {
    expect(hostOf('https://example.com/a')).toBe('example.com');
    expect(hostOf('not a url')).toBe('');
  });

  it('clean collapses whitespace and clamps', () => {
    expect(clean('  a\n b  ')).toBe('a b');
    expect(clean(null)).toBe('');
    expect(clean('abcdef', 3)).toBe('abc');
  });

  it('keywords drops empties and collapses case-insensitive duplicates', () => {
    expect(keywords('OSINT', 'osint', '', null, 'infra')).toEqual(['OSINT', 'infra']);
  });

  it('isPrivateHost covers loopback, RFC1918, link-local and IPv6', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '169.254.1.1',
      '::1',
      'fd00::1',
      'db.internal',
    ]) {
      expect(isPrivateHost(host)).toBe(true);
    }
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('urlIssues names the specific problem', () => {
    expect(urlIssues('', 'The URL')).toEqual([]);
    expect(urlIssues('nope', 'The URL')[0]?.code).toBe('URL_MALFORMED');
    expect(urlIssues('ftp://example.com', 'The URL')[0]?.code).toBe('URL_SCHEME');
    expect(urlIssues('https://user:pw@example.com', 'The URL')[0]?.message).toContain(
      'credentials',
    );
    expect(urlIssues('http://192.168.0.4/admin', 'The URL')[0]?.code).toBe('URL_PRIVATE_RANGE');
    expect(urlIssues('https://example.com', 'The URL')).toEqual([]);
  });
});

describe('website', () => {
  it('warns, but does not block, on a private-range URL', () => {
    const issues = websiteType.validate?.(nodeWith(websiteType, { url: 'http://10.0.0.5' })) ?? [];
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('enrichment is skipped');
  });

  it('errors on a malformed URL', () => {
    const issues = websiteType.validate?.(nodeWith(websiteType, { url: 'example dot com' })) ?? [];
    expect(issues[0]?.severity).toBe('error');
  });

  it('uses the host as its identity key and exports a markdown link', () => {
    const node = nodeWith(websiteType, { url: 'https://Example.com/Path', description: 'Desc' });
    expect(websiteType.identityKeys(node)).toEqual(['website:https://example.com/path']);
    expect(websiteType.io.toMarkdown(node)).toContain('(https://Example.com/Path)');
    expect(websiteType.searchFields(node).body).toContain('Desc');
    expect(websiteType.identityKeys(nodeWith(websiteType, { url: '' }))).toEqual([]);
  });
});

describe('text', () => {
  it('warns only when the denormalised preview text approaches its cap', () => {
    expect(textType.validate?.(nodeWith(textType, { plain: 'a'.repeat(1000) }))).toEqual([]);
    const warned = textType.validate?.(nodeWith(textType, { plain: 'a'.repeat(19_000) })) ?? [];
    expect(warned[0]?.severity).toBe('warning');
    expect(warned[0]?.message).toContain('20000');
  });

  it('richTextSizeIssue warns at 150 KB and blocks at 200 KB', () => {
    expect(richTextSizeIssue(1000)).toBeNull();
    expect(richTextSizeIssue(160_000)?.level).toBe('warn');
    const blocked = richTextSizeIssue(210_000);
    expect(blocked?.level).toBe('block');
    expect(blocked?.message).toContain('210 KB');
  });

  it('fences code content in markdown', () => {
    const node = nodeWith(textType, { plain: 'print(1)', format: 'code', codeLanguage: 'python' });
    expect(textType.io.toMarkdown(node)).toBe('```python\nprint(1)\n```');
  });
});

describe('image', () => {
  it('rejects a decompression bomb with its dimensions', () => {
    const issues =
      imageType.validate?.(nodeWith(imageType, { naturalWidth: 20_000, naturalHeight: 20_000 })) ??
      [];
    expect(issues[0]?.code).toBe('IMAGE_TOO_LARGE');
    expect(issues[0]?.message).toContain('20000');
  });

  it('accepts a normal photo and surfaces the GPS keyword', () => {
    const node = nodeWith(imageType, {
      naturalWidth: 4000,
      naturalHeight: 3000,
      exif: { hasGps: true, lat: 1, lon: 2, takenAt: null, camera: 'Pixel' },
    });
    expect(imageType.validate?.(node)).toEqual([]);
    expect(imageType.searchFields(node).keywords).toContain('gps');
  });
});

describe('file', () => {
  it('states the size and the limit when a file is too large', () => {
    const issues = fileType.validate?.(nodeWith(fileType, { size: 142_000_000 })) ?? [];
    expect(issues[0]?.message).toBe(
      'This file is 142 MB, the limit is 100 MB. Compress it or link to it instead.',
    );
  });

  it('prefers the content hash as the identity key', () => {
    const node = nodeWith(fileType, { sha256: 'abc', fileId: 'f_1' });
    expect(fileType.identityKeys(node)).toEqual(['sha256:abc', 'file:f_1']);
    expect(fileType.identityKeys(nodeWith(fileType, {}))).toEqual([]);
  });
});

describe('person', () => {
  it('normalises handles into identity keys', () => {
    const node = nodeWith(personType, { usernames: ['@Ada', ' '], emails: ['Ada@Example.com'] });
    expect(personType.identityKeys(node)).toEqual(['email:ada@example.com', 'username:ada']);
  });

  it('warns on a malformed email without discarding it', () => {
    const node = nodeWith(personType, { emails: ['not-an-email'] });
    const issues = personType.validate?.(node) ?? [];
    expect(issues[0]?.severity).toBe('warning');
    expect(node.data.emails).toEqual(['not-an-email']);
  });
});

describe('unknown', () => {
  it('preserves the payload and still yields search text', () => {
    const node = nodeWith(unknownType, { widget: { name: 'x', values: [1, 'two'] } } as never);
    expect(unknownType.io.toExport(node)).toEqual({ widget: { name: 'x', values: [1, 'two'] } });
    expect(unknownType.searchFields(node).body).toContain('two');
    expect(unknownType.io.fromExport('not an object')).toEqual({});
  });
});

describe('payload round-trip (property)', () => {
  it('survives export → import for every type', () => {
    const registry = builtinNodeTypes();
    fc.assert(
      fc.property(
        fc.constantFrom(...registry.ids()),
        fc.dictionary(
          fc.string({ maxLength: 8 }).map((k) => `x_${k}`),
          fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
          {
            maxKeys: 4,
          },
        ),
        (type, extra) => {
          const def = registry.get(type);
          const data = def.schema.parse({ ...(def.defaults.data as object), ...extra });
          const node = makeNode(
            { id: 'n_x', type, x: 0, y: 0, data: data as Record<string, unknown> },
            T0,
          );
          const exported = def.io.toExport(node as TypedNode<never>);
          expect(def.schema.parse(def.io.fromExport(exported))).toEqual(data);
        },
      ),
      { numRuns: 60 },
    );
  });
});
