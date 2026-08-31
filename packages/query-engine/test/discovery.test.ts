import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../src/catalog.ts';
import { discoverTools, isScanDue, type ToolCandidate } from '../src/discovery.ts';

const entry = (overrides: Partial<CatalogEntry> = {}): CatalogEntry => ({
  engine: 'sherlock',
  version: '1.0.0',
  provider: 'sherlock-project',
  capabilities: ['profile-discovery'],
  state: 'installed',
  detail: '',
  needsCredentials: false,
  action: 'open',
  ...overrides,
});

const candidate = (overrides: Partial<ToolCandidate> = {}): ToolCandidate => ({
  id: 'github:acme/finder',
  name: 'finder',
  version: '2.0.0',
  capability: 'profile-discovery',
  runtime: 'python',
  url: 'https://github.com/acme/finder',
  seenAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const ctx = (catalog: readonly CatalogEntry[], overrides = {}) => ({
  catalog,
  supportedRuntimes: new Set(['python', 'node']),
  ...overrides,
});

describe('discoverTools (Part 2 §56)', () => {
  it('says nothing when a working engine already covers the capability', () => {
    expect(discoverTools([candidate()], ctx([entry()]))).toEqual([]);
  });

  it('proposes an alternative to a deprecated engine, naming what it replaces', () => {
    const [finding] = discoverTools([candidate()], ctx([entry({ state: 'deprecated' })]));

    expect(finding?.kind).toBe('alternative');
    expect(finding?.replaces).toBe('sherlock');
    expect(finding?.headline).toContain('supported alternative to sherlock');
    expect(finding?.actions).toEqual(['review', 'install', 'ignore']);
  });

  it('treats an engine this host cannot run as stranded too', () => {
    const [finding] = discoverTools([candidate()], ctx([entry({ state: 'incompatible' })]));

    expect(finding?.kind).toBe('alternative');
  });

  it('reports a newer release of an installed engine as an update, never an older one', () => {
    const catalog = [entry({ version: '1.9.0' })];
    const newer = candidate({ name: 'sherlock', version: '1.10.0' });
    const older = candidate({ name: 'sherlock', version: '1.8.0' });

    expect(discoverTools([newer], ctx(catalog))[0]?.kind).toBe('update');
    expect(discoverTools([newer], ctx(catalog))[0]?.headline).toContain('1.10.0');
    expect(discoverTools([older], ctx(catalog))).toEqual([]);
    // Unparseable versions compare as zeros instead of throwing.
    expect(
      discoverTools([candidate({ name: 'sherlock', version: 'nightly' })], ctx(catalog)),
    ).toEqual([]);
  });

  it('reports a genuinely new capability as a new tool', () => {
    const [finding] = discoverTools([candidate({ capability: 'breach-search' })], ctx([entry()]));

    expect(finding?.kind).toBe('new-tool');
    expect(finding?.replaces).toBeUndefined();
    expect(finding?.headline).toContain('New tool for breach-search');
  });

  it('offers review and ignore, but not install, for an unsupported runtime', () => {
    const [finding] = discoverTools(
      [candidate({ capability: 'breach-search', runtime: 'browser-worker' })],
      ctx([entry()]),
    );

    expect(finding?.actions).toEqual(['review', 'ignore']);
  });

  it('never repeats what the user ignored', () => {
    const findings = discoverTools(
      [candidate({ capability: 'breach-search' })],
      ctx([entry()], { ignored: new Set(['github:acme/finder']) }),
    );

    expect(findings).toEqual([]);
  });

  it('sorts newest first', () => {
    const findings = discoverTools(
      [
        candidate({ id: 'a', capability: 'breach-search', seenAt: '2026-01-01T00:00:00.000Z' }),
        candidate({ id: 'b', capability: 'leak-search', seenAt: '2026-06-01T00:00:00.000Z' }),
      ],
      ctx([entry()]),
    );

    expect(findings.map((finding) => finding.candidate.id)).toEqual(['b', 'a']);
  });
});

describe('isScanDue', () => {
  it('is due when nothing ever scanned, and once the interval has passed', () => {
    expect(isScanDue(undefined, 0)).toBe(true);
    expect(isScanDue(0, 1_000)).toBe(false);
    expect(isScanDue(0, 8 * 24 * 60 * 60 * 1_000)).toBe(true);
  });
});
