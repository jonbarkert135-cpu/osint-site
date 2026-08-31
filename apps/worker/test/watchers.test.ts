import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  definitionWatch,
  licenseWatch,
  livenessWatch,
  releaseWatch,
  runWatcher,
  vulnWatch,
} from '../src/watchers/checks.ts';
import { appendFindings, findingsFile } from '../src/watchers/store.ts';
import { WATCHED_ENGINES, type WatchedEngine } from '../src/watchers/watched.ts';

const engine: WatchedEngine = {
  id: 'sherlock',
  repo: 'sherlock-project/sherlock',
  pinnedVersion: 'v0.16.0',
  licence: 'MIT',
  verifiedOn: '2026-08-23',
};

const now = () => new Date('2026-08-31T00:00:00.000Z');
const github = (body: unknown) => ({ github: async () => body, now });

describe('release-watch (§7)', () => {
  it('is quiet while the pin is the latest release', async () => {
    const finding = await releaseWatch(engine, github({ tag_name: 'v0.16.0' }));
    expect(finding).toMatchObject({ status: 'ok', severity: 'info' });
  });

  it('raises a review finding when upstream moved ahead', async () => {
    const finding = await releaseWatch(engine, github({ tag_name: 'v0.17.0' }));
    expect(finding).toMatchObject({ status: 'drift', severity: 'review' });
    expect(finding.detail).toContain('v0.17.0');
  });

  it('records unverified rather than assuming nothing changed', async () => {
    expect(await releaseWatch(engine, github(undefined))).toMatchObject({ status: 'unverified' });
    const unpinned: WatchedEngine = {
      id: 'subfinder',
      repo: 'projectdiscovery/subfinder',
      licence: 'MIT',
      verifiedOn: '2026-08-24',
    };
    expect(await releaseWatch(unpinned, github({ tag_name: 'v1' }))).toMatchObject({
      status: 'unverified',
    });
  });
});

describe('liveness-watch (§7)', () => {
  it('proposes a demotion for an archived repository', async () => {
    const finding = await livenessWatch(engine, github({ archived: true }));
    expect(finding).toMatchObject({ status: 'drift', severity: 'review' });
    expect(finding.detail).toContain('archived');
  });

  it('proposes a demotion after a year without a push', async () => {
    const finding = await livenessWatch(engine, github({ pushed_at: '2025-01-01T00:00:00Z' }));
    expect(finding.status).toBe('drift');
  });

  it('stays quiet for a repository pushed last month', async () => {
    const finding = await livenessWatch(engine, github({ pushed_at: '2026-07-30T00:00:00Z' }));
    expect(finding.status).toBe('ok');
  });

  it('does not read a missing timestamp as recent activity', async () => {
    expect(await livenessWatch(engine, github({}))).toMatchObject({ status: 'unverified' });
  });
});

describe('license-watch (§7)', () => {
  it('blocks when the licence changed', async () => {
    const finding = await licenseWatch(engine, github({ license: { spdx_id: 'AGPL-3.0' } }));
    expect(finding).toMatchObject({ status: 'drift', severity: 'block' });
    expect(finding.detail).toContain('AGPL-3.0');
  });

  it('treats NOASSERTION as unverified, never as unchanged', async () => {
    const finding = await licenseWatch(engine, github({ license: { spdx_id: 'NOASSERTION' } }));
    expect(finding.status).toBe('unverified');
  });

  it('is quiet while the licence matches what was recorded', async () => {
    const finding = await licenseWatch(engine, github({ license: { spdx_id: 'MIT' } }));
    expect(finding.status).toBe('ok');
  });
});

describe('runWatcher', () => {
  it('checks every watched engine and never throws on a dead source', async () => {
    const findings = await runWatcher('license-watch', WATCHED_ENGINES, github(undefined));
    expect(findings).toHaveLength(WATCHED_ENGINES.length);
    expect(findings.every((finding) => finding.status === 'unverified')).toBe(true);
  });
});

describe('findings store', () => {
  it('appends dated JSONL records, ok findings included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raven-findings-'));
    const findings = await runWatcher('release-watch', [engine], github({ tag_name: 'v0.17.0' }));

    const file = await appendFindings(findings, { dir, at: now() });
    expect(file).toBe(findingsFile(now(), dir));

    const lines = (await readFile(file as string, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      watcher: 'release-watch',
      engine: 'sherlock',
      status: 'drift',
    });
  });

  it('writes nothing when there is nothing to record', async () => {
    expect(await appendFindings([], { dir: '/nonexistent' })).toBeUndefined();
  });
});

describe('vuln-watch (§7)', () => {
  const pinned: WatchedEngine = {
    ...engine,
    pkg: { ecosystem: 'PyPI', name: 'sherlock-project' },
  };
  const osv = (body: unknown) => ({ github: async () => undefined, json: async () => body, now });

  it('blocks on any advisory against a pinned engine', async () => {
    const finding = await vulnWatch(pinned, osv({ vulns: [{ id: 'GHSA-xxxx' }] }));
    expect(finding).toMatchObject({ status: 'drift', severity: 'block' });
    expect(finding.detail).toContain('GHSA-xxxx');
  });

  it('is quiet when OSV knows of none', async () => {
    expect(await vulnWatch(pinned, osv({ vulns: [] }))).toMatchObject({ status: 'ok' });
  });

  it('cannot check an engine with no package coordinates', async () => {
    expect(await vulnWatch(engine, osv({ vulns: [] }))).toMatchObject({ status: 'unverified' });
  });

  it('records an unreadable answer as unverified, not as clean', async () => {
    expect(await vulnWatch(pinned, osv(undefined))).toMatchObject({ status: 'unverified' });
  });
});

describe('definition-watch (§7)', () => {
  const withBaseline = (entries?: number): WatchedEngine => ({
    ...engine,
    definition: {
      url: 'https://example.com/data.json',
      ...(entries === undefined ? {} : { entries }),
    },
  });
  const defs = (body: unknown) => ({ github: async () => undefined, json: async () => body, now });
  const sites = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {}]));

  it('fires when the definitions moved beyond the threshold', async () => {
    const finding = await definitionWatch(withBaseline(100), defs(sites(80)));
    expect(finding).toMatchObject({ status: 'drift', severity: 'review' });
  });

  it('stays quiet inside the threshold', async () => {
    expect(await definitionWatch(withBaseline(100), defs(sites(95)))).toMatchObject({
      status: 'ok',
    });
  });

  it('reports the observed count when no baseline was ever recorded', async () => {
    const finding = await definitionWatch(withBaseline(), defs(sites(400)));
    expect(finding.status).toBe('unverified');
    expect(finding.detail).toContain('400');
  });
});
