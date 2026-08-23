/**
 * 13_SHERLOCK.md §6.5. The test that carries the weight is the third one: a check that failed the
 * second time is `becameUnknown`, never `disappeared`, because a failed check says nothing about
 * whether the account still exists.
 */

import { describe, expect, it } from 'vitest';

import { describeDiff, diffSherlockRuns, siteResults } from '../sherlock/diff.ts';

const run = (
  sites: Record<string, { status: string; url?: string }>,
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(sites).map(([site, value]) => [
      site,
      {
        status: value.status,
        url_user: value.url ?? `https://${site.toLowerCase()}.test/jsmith`,
        http_status: 200,
      },
    ]),
  );

const snapshot = (
  runId: string,
  at: string,
  payload: unknown,
  imageDigest?: string,
): { runId: string; at: string; payload: unknown; imageDigest?: string } => ({
  runId,
  at,
  payload,
  ...(imageDigest === undefined ? {} : { imageDigest }),
});

describe('sherlock re-run diff', () => {
  it('reads every site, hit or miss, so a first check is not mistaken for an appearance', () => {
    const rows = siteResults(
      run({ GitHub: { status: 'claimed' }, Reddit: { status: 'available' } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.site === 'Reddit')?.status).toBe('available');
    expect(rows.find((row) => row.site === 'GitHub')?.url).toBe('https://github.test/jsmith');
  });

  it('reports a new hit as appeared and an old hit that is now free as disappeared', () => {
    const diff = diffSherlockRuns(
      'jsmith',
      snapshot(
        'run-1',
        '2026-03-02T00:00:00.000Z',
        run({ GitHub: { status: 'claimed' }, X: { status: 'available' } }),
      ),
      snapshot(
        'run-2',
        '2026-08-17T00:00:00.000Z',
        run({ GitHub: { status: 'available' }, X: { status: 'claimed' } }),
      ),
    );

    expect(diff.appeared.map((row) => row.site)).toEqual(['X']);
    expect(diff.disappeared.map((row) => row.site)).toEqual(['GitHub']);
    expect(diff.becameUnknown).toEqual([]);
    expect(diff.unchanged).toBe(0);
  });

  it('never turns a failed check into a disappearance', () => {
    const diff = diffSherlockRuns(
      'jsmith',
      snapshot('run-1', '2026-03-02T00:00:00.000Z', run({ GitHub: { status: 'claimed' } })),
      snapshot('run-2', '2026-08-17T00:00:00.000Z', run({ GitHub: { status: 'error' } })),
    );

    expect(diff.disappeared).toEqual([]);
    expect(diff.becameUnknown.map((row) => row.site)).toEqual(['GitHub']);
    expect(describeDiff(diff)).toContain('could not be checked');
  });

  it('counts a site whose answer did not change as unchanged', () => {
    const payload = run({ GitHub: { status: 'claimed' }, Reddit: { status: 'available' } });
    const diff = diffSherlockRuns(
      'jsmith',
      snapshot('run-1', '2026-03-02T00:00:00.000Z', payload),
      snapshot('run-2', '2026-08-17T00:00:00.000Z', payload),
    );

    expect(diff.unchanged).toBe(2);
    expect(describeDiff(diff)).toContain('No change for jsmith');
  });

  it('separates the tool losing a site from an account disappearing', () => {
    const diff = diffSherlockRuns(
      'jsmith',
      snapshot(
        'run-1',
        '2026-03-02T00:00:00.000Z',
        run({ GitHub: { status: 'claimed' }, Old: { status: 'claimed' } }),
      ),
      snapshot(
        'run-2',
        '2026-08-17T00:00:00.000Z',
        run({ GitHub: { status: 'claimed' }, Fresh: { status: 'available' } }),
      ),
    );

    expect(diff.siteListDelta).toEqual({ added: ['Fresh'], removed: ['Old'] });
    expect(diff.disappeared).toEqual([]);
    expect(describeDiff(diff)).toContain('no longer checked by this version');
  });

  it('flags a digest change, because it can explain the differences by itself', () => {
    const diff = diffSherlockRuns(
      'jsmith',
      snapshot(
        'run-1',
        '2026-03-02T00:00:00.000Z',
        run({ GitHub: { status: 'claimed' } }),
        `sha256:${'a'.repeat(64)}`,
      ),
      snapshot(
        'run-2',
        '2026-08-17T00:00:00.000Z',
        run({ GitHub: { status: 'claimed' } }),
        `sha256:${'b'.repeat(64)}`,
      ),
    );

    expect(diff.digestChanged).toBe(true);
    expect(describeDiff(diff)).toContain('image changed');
  });

  it('reports an unreadable payload as no sites rather than throwing', () => {
    expect(siteResults('nonsense')).toEqual([]);
  });
});
