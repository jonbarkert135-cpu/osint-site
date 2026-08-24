/**
 * Reference engine: `doh-resolver` (capability `dns-discovery`, provider `dns-google`).
 *
 * It exists for two reasons: it is the worked example third-party authors copy, and it is the
 * engine the conformance harness is proven against. It does no I/O of its own — every request goes
 * through the host `fetch`, so the same code runs in the Runner sandbox unchanged (L4.4).
 */

import type { EntityKind } from '../../types.ts';
import { INPUT_REF, type EngineOutput, type RawChunk, type TransformEngine } from '../types.ts';

const RECORD_TYPES = ['A', 'AAAA', 'MX', 'NS'] as const;
type RecordType = (typeof RECORD_TYPES)[number];

const ENDPOINT = 'https://dns.google/resolve';

/** RFC 1035 host name, punycode form; the engine does not resolve unicode itself. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface DohAnswer {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly TTL?: unknown;
  readonly data?: unknown;
}

interface DohPayload {
  readonly recordType: RecordType;
  readonly answers: readonly DohAnswer[];
}

const isPayload = (value: unknown): value is DohPayload =>
  typeof value === 'object' &&
  value !== null &&
  RECORD_TYPES.includes((value as DohPayload).recordType) &&
  Array.isArray((value as DohPayload).answers);

const KIND_OF: Record<RecordType, EntityKind> = {
  A: 'ip',
  AAAA: 'ip',
  MX: 'dns_record',
  NS: 'dns_record',
};

/** MX answers arrive as `10 mail.example.com.`; the host name is what matters. */
const cleanData = (recordType: RecordType, data: string): string => {
  const value = recordType === 'MX' ? (data.split(/\s+/).at(-1) ?? data) : data;
  return value.endsWith('.') && value.length > 1 ? value.slice(0, -1) : value;
};

export const createDohResolver = (): TransformEngine => ({
  metadata: () => ({
    engine: 'doh-resolver',
    version: '1.0.0',
    capability: 'dns-discovery',
    provider: 'dns-google',
    permissions: ['network'],
    inputs: ['domain', 'hostname'],
    outputs: ['ip', 'dns_record'],
  }),

  validateInput: (input) => {
    if (input.kind !== 'domain' && input.kind !== 'hostname') {
      return { ok: false, reason: `doh-resolver needs a domain or hostname, got ${input.kind}` };
    }
    const value = input.value.trim().toLowerCase().replace(/\.$/, '');
    if (!DOMAIN.test(value))
      return { ok: false, reason: `not a resolvable host name: ${input.value}` };
    return { ok: true, normalizedValue: value };
  },

  execute: async function* (input, ctx) {
    for (const recordType of RECORD_TYPES) {
      if (ctx.signal.aborted) return;
      const url = `${ENDPOINT}?name=${encodeURIComponent(input.value)}&type=${recordType}`;
      const response = await ctx.fetch(url);
      if (response.status !== 200) {
        ctx.log('warn', 'DoH query failed', { recordType, status: response.status });
        // A single record type failing is not a failed run: yield nothing and keep going, but say
        // the result may be incomplete so the router may still try a fallback engine.
        yield {
          at: new Date().toISOString(),
          url,
          payload: { recordType, answers: [] },
          exhaustive: false,
        };
        continue;
      }
      const body = response.body as { readonly Answer?: readonly DohAnswer[] } | null;
      yield {
        at: new Date().toISOString(),
        url,
        payload: { recordType, answers: body?.Answer ?? [] } satisfies DohPayload,
      };
    }
  },

  normalize: (chunks: readonly RawChunk[]): EngineOutput => {
    const entities = new Map<
      string,
      {
        key: string;
        kind: EntityKind;
        value: string;
        confidence: number;
        props: Record<string, unknown>;
      }
    >();
    const evidence: { entity: string; observedAt: string; excerpt: string; chunk: number }[] = [];

    chunks.forEach((chunk, index) => {
      if (!isPayload(chunk.payload)) return;
      const { recordType, answers } = chunk.payload;
      for (const answer of answers) {
        if (typeof answer.data !== 'string' || answer.data.length === 0) continue;
        const value = cleanData(recordType, answer.data);
        const key = `${recordType}:${value}`;
        if (!entities.has(key)) {
          entities.set(key, {
            key,
            kind: KIND_OF[recordType],
            value,
            confidence: 0.95, // authoritative DNS answer, single source
            props: { recordType, ...(typeof answer.TTL === 'number' ? { ttl: answer.TTL } : {}) },
          });
        }
        evidence.push({
          entity: key,
          observedAt: chunk.at,
          excerpt: `${recordType} ${answer.data}`,
          chunk: index,
        });
      }
    });

    return {
      entities: [...entities.values()],
      relationships: [...entities.keys()].map((key) => ({
        from: key,
        to: INPUT_REF,
        kind: 'derived_from',
        confidence: 0.95,
      })),
      evidence,
    };
  },

  healthCheck: async (ctx) => {
    const startedAt = Date.now();
    try {
      const response = await ctx.fetch(`${ENDPOINT}?name=dns.google&type=A`);
      return {
        ok: response.status === 200,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...(response.status === 200 ? {} : { detail: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
