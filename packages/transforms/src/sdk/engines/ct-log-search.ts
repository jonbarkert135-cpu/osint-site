/**
 * Engine `ct-log-search` (capability `subdomain-discovery`, provider `crtsh`).
 *
 * Certificate transparency is the highest-yield keyless source of host names for a domain: every
 * publicly trusted certificate is logged, so names appear whether or not they resolve. crt.sh is a
 * courtesy service (§9 `courtesy-service`), so this engine asks once, never paginates in a loop,
 * and marks its output non-exhaustive — the router may then try `subfinder` or `amass`.
 */

import type { EntityKind } from '../../types.ts';
import { INPUT_REF, type EngineOutput, type RawChunk, type TransformEngine } from '../types.ts';

const ENDPOINT = 'https://crt.sh';

/** RFC 1035 host name in punycode form. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

interface CrtShRow {
  readonly id?: unknown;
  readonly name_value?: unknown;
  readonly issuer_name?: unknown;
  readonly not_before?: unknown;
}

interface Payload {
  readonly rows: readonly CrtShRow[];
}

const isPayload = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && Array.isArray((value as Payload).rows);

/** A logged name may be a wildcard or carry a trailing dot; neither is a host. */
const hostsIn = (row: CrtShRow): readonly string[] => {
  if (typeof row.name_value !== 'string') return [];
  return row.name_value
    .split('\n')
    .map((name) => name.trim().toLowerCase().replace(/^\*\./u, '').replace(/\.$/u, ''))
    .filter((name) => DOMAIN.test(name));
};

const HOSTNAME: EntityKind = 'hostname';

export const createCtLogSearch = (): TransformEngine => ({
  metadata: () => ({
    engine: 'ct-log-search',
    version: '1.0.0',
    capability: 'subdomain-discovery',
    provider: 'crtsh',
    permissions: ['network'],
    inputs: ['domain'],
    outputs: ['hostname'],
  }),

  validateInput: (input) => {
    if (input.kind !== 'domain') {
      return { ok: false, reason: `ct-log-search needs a domain, got ${input.kind}` };
    }
    const value = input.value.trim().toLowerCase().replace(/\.$/u, '');
    if (!DOMAIN.test(value)) return { ok: false, reason: `not a domain: ${input.value}` };
    return { ok: true, normalizedValue: value };
  },

  execute: async function* (input, ctx) {
    if (ctx.signal.aborted) return;
    const url = `${ENDPOINT}/?q=${encodeURIComponent(`%.${input.value}`)}&output=json`;
    const response = await ctx.fetch(url);
    if (response.status !== 200) {
      ctx.log('warn', 'crt.sh query failed', { status: response.status });
      yield { at: new Date().toISOString(), url, payload: { rows: [] }, exhaustive: false };
      return;
    }
    const rows = Array.isArray(response.body) ? (response.body as readonly CrtShRow[]) : [];
    yield {
      at: new Date().toISOString(),
      url,
      payload: { rows } satisfies Payload,
      // CT shows what was certified, never what exists: another source may still know more.
      exhaustive: false,
    };
  },

  normalize: (chunks: readonly RawChunk[], input): EngineOutput => {
    const entities = new Map<string, { key: string; value: string; issuers: Set<string> }>();
    const evidence: { entity: string; observedAt: string; excerpt: string; chunk: number }[] = [];

    chunks.forEach((chunk, index) => {
      if (!isPayload(chunk.payload)) return;
      for (const row of chunk.payload.rows) {
        const issuer = typeof row.issuer_name === 'string' ? row.issuer_name : 'unknown issuer';
        for (const host of hostsIn(row)) {
          if (host === input.value) continue; // the input is not its own discovery
          const key = `host:${host}`;
          const existing = entities.get(key) ?? { key, value: host, issuers: new Set<string>() };
          if (existing.issuers.has(issuer)) continue;
          existing.issuers.add(issuer);
          entities.set(key, existing);
          evidence.push({
            entity: key,
            observedAt: typeof row.not_before === 'string' ? row.not_before : chunk.at,
            excerpt: `certificate for ${host} issued by ${issuer}`,
            chunk: index,
          });
        }
      }
    });

    return {
      entities: [...entities.values()].map((entity) => ({
        key: entity.key,
        kind: HOSTNAME,
        value: entity.value,
        // A certified name is evidence the name existed, not that it resolves today.
        confidence: 0.8,
        props: { source: 'certificate-transparency', certificates: entity.issuers.size },
      })),
      relationships: [...entities.keys()].map((key) => ({
        from: key,
        to: INPUT_REF,
        kind: 'subdomain_of',
        confidence: 0.9,
      })),
      evidence,
    };
  },

  healthCheck: async (ctx) => {
    const startedAt = Date.now();
    const response = await ctx.fetch(
      `${ENDPOINT}/?q=${encodeURIComponent('%.example.com')}&output=json`,
    );
    return {
      ok: response.status === 200,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      ...(response.status === 200 ? {} : { detail: `HTTP ${response.status}` }),
    };
  },
});
