/**
 * SpiderFoot integration: the manifest is valid and honest, the mapping table maps, and the parser
 * reads both shapes of `/scaneventresults` without dropping anything silently (12_SPIDERFOOT.md).
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry, BUILTIN_SOURCES } from '../src/registry.ts';
import type { ArtifactRef, ParseContext, RawRunResult } from '../src/pipeline.ts';
import { classifyEvent, isArtifactOnly } from '../spiderfoot/mapping.ts';
import {
  DEFAULT_SPIDERFOOT_BASE_URL,
  manifest,
  spiderFootBaseUrl,
  spiderFootManifest,
  spiderFootScanUrl,
} from '../spiderfoot/manifest.ts';
import { parser } from '../spiderfoot/parser.ts';

const ref: ArtifactRef = {
  bucket: 'b',
  key: 'runs/r1/events',
  bytes: 0,
  sha256: '',
  contentType: 'application/json',
  truncated: false,
};

function runResult(): RawRunResult {
  return {
    runId: 'r1',
    status: 'succeeded',
    exitCode: 0,
    startedAt: '2026-08-23T00:00:00.000Z',
    finishedAt: '2026-08-23T00:00:10.000Z',
    durationMs: 10_000,
    artifacts: [ref],
    stats: { bytesOut: 0, egressRequests: 1, egressDenied: 0, peakMemMiB: 0 },
  };
}

function context(payload: unknown, input: unknown = {}): ParseContext {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    manifest,
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

describe('spiderfoot manifest', () => {
  it('declares the maturity, risk and fallback the spec makes mandatory', () => {
    expect(manifest.maturity).toBe('beta');
    expect(manifest.risk.label).toBe('high');
    expect(manifest.risk.upstreamMaintenance).toBe('low');
    expect(manifest.risk.fallback).toMatch(/tier 3/i);
  });

  it('reaches exactly one host — the configured instance — and refuses private ranges', () => {
    const built = spiderFootManifest('https://sf.example.test:5001');
    expect(built.execution.kind).toBe('http');
    if (built.execution.kind !== 'http') throw new Error('unreachable');
    expect(built.execution.network.allow).toEqual(['sf.example.test:5001']);
    expect(built.execution.network.denyPrivateRanges).toBe(true);
    expect(built.execution.requests[0]?.query.id).toBe('{{input.scanId}}');
  });

  it('falls back to a dead host when the deployment configured nothing usable', () => {
    expect(spiderFootBaseUrl({})).toBe(DEFAULT_SPIDERFOOT_BASE_URL);
    expect(spiderFootBaseUrl({ SPIDERFOOT_BASE_URL: 'not a url' })).toBe(
      DEFAULT_SPIDERFOOT_BASE_URL,
    );
    expect(spiderFootBaseUrl({ SPIDERFOOT_BASE_URL: 'https://sf.example.test/' })).toBe(
      'https://sf.example.test',
    );
  });

  it('registers in the builtin registry without any core change', () => {
    const registry = buildRegistry(BUILTIN_SOURCES);
    expect(registry.rejected).toEqual([]);
    expect(registry.entries.has('spiderfoot')).toBe(true);
  });
});

describe('open in spiderfoot', () => {
  it('links to the scan page on the configured instance', () => {
    expect(spiderFootScanUrl('AbC123xy', 'https://sf.example.test')).toBe(
      'https://sf.example.test/scaninfo?id=AbC123xy',
    );
  });

  it('offers no link for an unconfigured instance or an implausible scan id', () => {
    expect(spiderFootScanUrl('AbC123xy', DEFAULT_SPIDERFOOT_BASE_URL)).toBeUndefined();
    expect(spiderFootScanUrl('../etc/passwd', 'https://sf.example.test')).toBeUndefined();
  });
});

describe('spiderfoot mapping table', () => {
  it.each([
    ['DOMAIN_NAME', 'domain', 'domain'],
    ['INTERNET_NAME', 'domain', 'domain'],
    ['IP_ADDRESS', 'ip', 'ip'],
    ['EMAILADDR', 'email', 'email'],
    ['USERNAME', 'username', 'username'],
    ['LINKED_URL_EXTERNAL', 'url', 'url'],
    ['PUBLIC_CODE_REPO', 'repo', 'repo'],
    ['SOCIAL_MEDIA', 'url', 'url'],
  ])('maps %s to a %s record', (eventType, recordType, kind) => {
    const mapped = classifyEvent(eventType);
    expect(mapped.recordType).toBe(recordType);
    expect(mapped.kind).toBe(kind);
  });

  it('keeps an unknown event type as an observation instead of dropping it', () => {
    expect(classifyEvent('SOME_FUTURE_EVENT').recordType).toBe('observation');
  });

  it('leaves raw page bodies in the artifacts', () => {
    expect(isArtifactOnly('RAW_RIR_DATA')).toBe(true);
    expect(isArtifactOnly('SEARCH_ENGINE_WEB_CONTENT')).toBe(true);
    expect(isArtifactOnly('DOMAIN_NAME')).toBe(false);
  });
});

describe('spiderfoot parser', () => {
  it('reads the row shape and keeps module, event type and source on every record', async () => {
    const doc = await parser.parse(
      runResult(),
      context([
        ['2026-08-23 00:00:01', 'example.test', 'seed', 'sfp_dnsresolve', 'DOMAIN_NAME'],
        ['2026-08-23 00:00:02', '203.0.113.7', 'example.test', 'sfp_dnsresolve', 'IP_ADDRESS'],
        ['2026-08-23 00:00:03', '<html/>', 'example.test', 'sfp_spider', 'RAW_DATA'],
      ]),
    );
    expect(doc.records.map((record) => record.type)).toEqual(['domain', 'ip']);
    expect(doc.records[0]?.data.module).toBe('sfp_dnsresolve');
    expect(doc.records[0]?.data.eventType).toBe('DOMAIN_NAME');
    expect(doc.records[1]?.data.sourceValue).toBe('example.test');
    expect(doc.counters.artifactOnly).toBe(1);
  });

  it('reads the object shape too, and counts rows it cannot read', async () => {
    const doc = await parser.parse(
      runResult(),
      context({
        data: [
          { data: 'ops@example.test', type: 'EMAILADDR', module: 'sfp_email' },
          { nothing: 'useful' },
        ],
      }),
    );
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0]?.type).toBe('email');
    expect(doc.counters.skipped).toBe(1);
    expect(doc.nonFatalIssues[0]?.level).toBe('info');
  });

  it('drops unclassified findings only when the analyst asked for that', async () => {
    const events = [['t', 'mystery', 'seed', 'sfp_x', 'SOME_FUTURE_EVENT']];
    const kept = await parser.parse(runResult(), context(events));
    const dropped = await parser.parse(runResult(), context(events, { includeUnmapped: false }));
    expect(kept.records).toHaveLength(1);
    expect(dropped.records).toHaveLength(0);
  });

  it('fails loudly when the instance answered with something that is not a result set', async () => {
    await expect(parser.parse(runResult(), context({ error: 'nope' }))).rejects.toThrow(
      /PARSE_UNSUPPORTED_SHAPE|shape/i,
    );
  });
});
