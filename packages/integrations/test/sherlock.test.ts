/**
 * Sherlock: the sandbox contract of the manifest, the three JSON shapes of §4.2, and the bias rule
 * that an unrecognised answer is never a hit (13_SHERLOCK.md).
 */

import { describe, expect, it } from 'vitest';

import type { ArtifactRef, ParseContext, RawRunResult } from '../src/pipeline.ts';
import { sherlockImageDigest, sherlockManifest, SHERLOCK_IMAGE } from '../sherlock/manifest.ts';
import { detectShape, parser, readStatus, safeProfileUrl } from '../sherlock/parser.ts';
import { sherlockSources } from '../sherlock/source.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

const ref: ArtifactRef = {
  bucket: 'b',
  key: 'runs/r1/results',
  bytes: 0,
  sha256: '',
  contentType: 'application/json',
  truncated: false,
};

function runResult(status: RawRunResult['status'] = 'succeeded'): RawRunResult {
  return {
    runId: 'r1',
    status,
    exitCode: 0,
    startedAt: '2026-08-23T00:00:00.000Z',
    finishedAt: '2026-08-23T00:02:00.000Z',
    durationMs: 120_000,
    artifacts: [ref],
    stats: { bytesOut: 0, egressRequests: 400, egressDenied: 0, peakMemMiB: 0 },
  };
}

function context(payload: unknown, input: unknown = { username: 'ravwn' }): ParseContext {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    manifest: sherlockManifest(DIGEST),
    runId: 'r1',
    input,
    readArtifact: () =>
      Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      }),
    logger: { log: () => undefined },
  };
}

describe('sherlock manifest', () => {
  it('runs pinned, unprivileged and read-only, with private ranges denied', () => {
    const manifest = sherlockManifest(DIGEST);
    expect(manifest.execution.kind).toBe('container');
    if (manifest.execution.kind !== 'container') throw new Error('unreachable');
    expect(manifest.execution.image).toBe(SHERLOCK_IMAGE);
    expect(manifest.execution.digest).toBe(DIGEST);
    expect(manifest.execution.readOnlyRootFs).toBe(true);
    expect(manifest.execution.runtimeClass).toBe('gvisor');
    expect(manifest.execution.network.mode).toBe('broad');
    expect(manifest.execution.network.denyPrivateRanges).toBe(true);
    expect(manifest.permissions).toContain('net:broad');
    expect(manifest.execution.command).toContain('--json');
  });

  it('takes the username from a selected username node, so it runs from a node card', () => {
    const username = sherlockManifest(DIGEST).inputs.find((field) => field.name === 'username');
    expect(username?.from).toEqual({ source: 'selection', kinds: ['username'] });
    expect(username?.required).toBe(true);
  });

  it('is absent from the registry until the deployment pins a digest', () => {
    expect(sherlockImageDigest({})).toBeUndefined();
    expect(sherlockImageDigest({ SHERLOCK_IMAGE_DIGEST: 'latest' })).toBeUndefined();
    expect(sherlockImageDigest({ SHERLOCK_IMAGE_DIGEST: DIGEST })).toBe(DIGEST);
    // No digest in this test environment, so the source list is empty rather than floating.
    expect(sherlockSources).toHaveLength(0);
  });
});

describe('sherlock status reading', () => {
  it.each([
    [{ status: 'Claimed' }, 'claimed'],
    [{ exists: true }, 'claimed'],
    [{ status: 'not_found' }, 'available'],
    [{ status: 'WAF' }, 'error'],
    [{ status: 'something new' }, 'unknown'],
    [{}, 'unknown'],
  ])('reads %o as %s', (record, expected) => {
    expect(readStatus(record)).toBe(expected);
  });
});

describe('sherlock url safety', () => {
  it('keeps public http(s) profile links and drops everything else', () => {
    expect(safeProfileUrl('https://example.test/u/ravwn')).toBe('https://example.test/u/ravwn');
    expect(safeProfileUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeProfileUrl('http://127.0.0.1/admin')).toBeUndefined();
    expect(safeProfileUrl('http://169.254.169.254/latest/meta-data')).toBeUndefined();
    expect(safeProfileUrl('http://intranet.local/x')).toBeUndefined();
  });
});

describe('sherlock shape detection', () => {
  it('detects all three documented layouts', () => {
    expect(detectShape([{ site: 'X', status: 'claimed' }]).shape).toBe('array-of-records');
    expect(detectShape({ GitHub: { status: 'claimed', url: 'https://e.test' } }).shape).toBe(
      'map-of-sites',
    );
    expect(
      detectShape({ ravwn: { GitHub: { status: 'claimed', url: 'https://e.test' } } }).shape,
    ).toBe('map-of-usernames');
    expect(detectShape('nope').shape).toBe('unknown');
  });
});

describe('sherlock parser', () => {
  it('imports claimed profiles only, and counts the rest', async () => {
    const doc = await parser.parse(
      runResult(),
      context({
        GitHub: { status: 'claimed', url_user: 'https://github.test/ravwn', http_status: 200 },
        Reddit: { status: 'available', url_user: 'https://reddit.test/u/ravwn' },
        Weird: { status: 'brand new status', url_user: 'https://weird.test/ravwn' },
        Blocked: { status: 'waf' },
      }),
    );
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0]?.data.site).toBe('GitHub');
    expect(doc.records[0]?.data.username).toBe('ravwn');
    expect(doc.counters.claimed).toBe(1);
    expect(doc.counters.available).toBe(1);
    expect(doc.counters.unknown).toBe(1);
    expect(doc.counters.error).toBe(1);
  });

  it('refuses a claimed result whose link points somewhere private', async () => {
    const doc = await parser.parse(
      runResult(),
      context({ Evil: { status: 'claimed', url_user: 'http://169.254.169.254/' } }),
    );
    expect(doc.records).toHaveLength(0);
    expect(doc.counters.withoutUrl).toBe(1);
    expect(doc.nonFatalIssues.some((issue) => issue.level === 'warn')).toBe(true);
  });

  it('says so when the run was cut short instead of pretending it was complete', async () => {
    const doc = await parser.parse(
      runResult('partial'),
      context({ GitHub: { status: 'claimed', url_user: 'https://github.test/ravwn' } }),
    );
    expect(doc.records).toHaveLength(1);
    expect(doc.nonFatalIssues.some((issue) => /stopped early/.test(issue.message))).toBe(true);
  });

  it('fails loudly on a document it cannot recognise', async () => {
    await expect(parser.parse(runResult(), context('nonsense'))).rejects.toThrow(
      /PARSE_UNSUPPORTED_SHAPE|shape/i,
    );
  });
});
