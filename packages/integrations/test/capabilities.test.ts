/**
 * 13_SHERLOCK.md §3.6: the pinned digest is asked what it is before it is trusted. A missing
 * required flag is fatal; an old or unreadable version is only a warning, because the parsers are
 * shape-driven.
 */

import { describe, expect, it } from 'vitest';

import { checkCapabilities, parseImageCapabilities } from '../src/capabilities.ts';

const HELP = `usage: sherlock [-h] [--version] [--verbose] USERNAMES [USERNAMES ...]

options:
  -h, --help            show this help message and exit
  --version             Display version information
  --json FILE, -j FILE  Load data from a JSON file or URL
  --timeout SECONDS     Time in seconds to wait for a response
  --nsfw                Include checking of NSFW sites
`;

const spec = {
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  requiredFlags: ['--json'],
  minVersion: '0.16.0',
};

const probe = (version: string, help = HELP) =>
  parseImageCapabilities({
    imageDigest: `sha256:${'a'.repeat(64)}`,
    versionOutput: version,
    helpOutput: help,
    probedAt: '2026-08-23T10:00:00.000Z',
  });

describe('image capability probe', () => {
  it('reads the version line and every flag --help advertises', () => {
    const caps = probe('\nSherlock v0.16.0\n');
    expect(caps.versionString).toBe('Sherlock v0.16.0');
    expect(caps.semver).toBe('0.16.0');
    expect(caps.flags).toContain('--json');
    expect(caps.flags).toContain('-j');
    expect(caps.flags).toContain('--timeout');
    expect(caps.flags).toContain('-h');
  });

  it('accepts the verified version with no warning', () => {
    expect(checkCapabilities(probe('Sherlock v0.16.0'), spec)).toEqual({
      ok: true,
      missingFlags: [],
      warning: null,
    });
  });

  it('rejects an image whose help does not advertise the required flag', () => {
    const verdict = checkCapabilities(
      probe('Sherlock v0.14.0', 'usage: sherlock\n  --site NAME\n'),
      {
        ...spec,
      },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.missingFlags).toEqual(['--json']);
  });

  it('warns — but does not fail — on an image older than the verified version', () => {
    const verdict = checkCapabilities(probe('Sherlock v0.14.3'), spec);
    expect(verdict.ok).toBe(true);
    expect(verdict.warning).toContain('v0.16.0');
  });

  it('treats an unreadable version as usable, since parsing is shape-driven', () => {
    const caps = probe('   \n');
    expect(caps.versionString).toBeNull();
    expect(caps.semver).toBeNull();
    expect(checkCapabilities(caps, spec)).toMatchObject({ ok: true, warning: null });
  });

  it('does not warn for a newer image', () => {
    expect(checkCapabilities(probe('Sherlock v0.17.1'), spec).warning).toBeNull();
  });
});
