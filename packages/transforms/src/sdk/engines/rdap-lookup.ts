/**
 * Engine `rdap-lookup` (capability `registration-lookup`, provider `rdap`).
 *
 * RDAP replaced WHOIS for gTLDs: a documented protocol, structured JSON, no key, no scraping
 * (§9 `public-api`). Registries redact most contact data by policy — this engine reports what the
 * registry actually published and never reconstructs a name from a redaction placeholder.
 */

import type { EntityKind } from '../../types.ts';
import { INPUT_REF, type EngineOutput, type RawChunk, type TransformEngine } from '../types.ts';

const ENDPOINT = 'https://rdap.org';

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u;
const IPV6 = /^[0-9a-f:]{2,45}$/u;
const ASN = /^(?:as)?\d{1,10}$/u;

/** Registries publish redaction placeholders; they are not names. */
const REDACTED = /redacted|not disclosed|privacy|data protected|withheld|statutory masking/iu;

interface RdapEntity {
  readonly roles?: unknown;
  readonly vcardArray?: unknown;
  readonly handle?: unknown;
}

interface RdapResponse {
  readonly handle?: unknown;
  readonly ldhName?: unknown;
  readonly name?: unknown;
  readonly startAddress?: unknown;
  readonly endAddress?: unknown;
  readonly status?: unknown;
  readonly events?: unknown;
  readonly entities?: unknown;
}

interface Payload {
  readonly record: RdapResponse;
}

const isPayload = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && typeof (value as Payload).record === 'object';

/** `["vcard", [["fn", {}, "text", "Example Inc"], ...]]` → `{ fn: 'Example Inc' }`. */
const vcard = (value: unknown): Readonly<Record<string, string>> => {
  if (!Array.isArray(value) || !Array.isArray(value[1])) return {};
  const fields: Record<string, string> = {};
  for (const entry of value[1] as readonly unknown[]) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [name, , , item] = entry as readonly unknown[];
    if (typeof name !== 'string') continue;
    const text =
      typeof item === 'string'
        ? item
        : Array.isArray(item)
          ? item
              .filter((part) => typeof part === 'string')
              .join(' ')
              .trim()
          : '';
    if (text !== '' && fields[name] === undefined) fields[name] = text;
  }
  return fields;
};

const rolesOf = (entity: RdapEntity): readonly string[] =>
  Array.isArray(entity.roles)
    ? entity.roles.filter((role): role is string => typeof role === 'string')
    : [];

export const createRdapLookup = (): TransformEngine => ({
  metadata: () => ({
    engine: 'rdap-lookup',
    version: '1.0.0',
    capability: 'registration-lookup',
    provider: 'rdap',
    permissions: ['network'],
    inputs: ['domain', 'ip', 'asn'],
    outputs: ['organization', 'person', 'fact', 'asn'],
  }),

  validateInput: (input) => {
    const value = input.value.trim().toLowerCase().replace(/\.$/u, '');
    if (input.kind === 'domain') {
      return DOMAIN.test(value)
        ? { ok: true, normalizedValue: value }
        : { ok: false, reason: `not a domain: ${input.value}` };
    }
    if (input.kind === 'ip') {
      return IPV4.test(value) || IPV6.test(value)
        ? { ok: true, normalizedValue: value }
        : { ok: false, reason: `not an IP address: ${input.value}` };
    }
    if (input.kind === 'asn') {
      return ASN.test(value)
        ? { ok: true, normalizedValue: value.replace(/^as/u, '') }
        : { ok: false, reason: `not an AS number: ${input.value}` };
    }
    return { ok: false, reason: `rdap-lookup needs a domain, IP or ASN, got ${input.kind}` };
  },

  execute: async function* (input, ctx) {
    if (ctx.signal.aborted) return;
    const path = input.kind === 'domain' ? 'domain' : input.kind === 'ip' ? 'ip' : 'autnum';
    const url = `${ENDPOINT}/${path}/${encodeURIComponent(input.value)}`;
    const response = await ctx.fetch(url);
    if (response.status === 404) {
      // A registry that says "no record" has answered: that is an exhaustive negative.
      ctx.log('info', 'no RDAP record', { input: input.value });
      return;
    }
    if (response.status !== 200) {
      ctx.log('warn', 'RDAP lookup failed', { status: response.status });
      yield { at: new Date().toISOString(), url, payload: { record: {} }, exhaustive: false };
      return;
    }
    yield {
      at: new Date().toISOString(),
      url,
      payload: { record: (response.body ?? {}) as RdapResponse } satisfies Payload,
    };
  },

  normalize: (chunks: readonly RawChunk[], input): EngineOutput => {
    const entities: {
      key: string;
      kind: EntityKind;
      value: string;
      label?: string;
      confidence: number;
      props: Record<string, unknown>;
    }[] = [];
    const relationships: { from: string; to: string; kind: string; confidence: number }[] = [];
    const evidence: { entity: string; observedAt: string; excerpt: string; chunk: number }[] = [];
    const seen = new Set<string>();

    const add = (
      key: string,
      kind: EntityKind,
      value: string,
      confidence: number,
      props: Record<string, unknown>,
      excerpt: string,
      observedAt: string,
      chunk: number,
      relation: string,
    ): void => {
      if (value.trim() === '' || seen.has(key)) return;
      seen.add(key);
      entities.push({ key, kind, value, confidence, props });
      relationships.push({ from: key, to: INPUT_REF, kind: relation, confidence });
      evidence.push({ entity: key, observedAt, excerpt, chunk });
    };

    chunks.forEach((chunk, index) => {
      if (!isPayload(chunk.payload)) return;
      const record = chunk.payload.record;

      if (Array.isArray(record.events)) {
        for (const event of record.events as readonly {
          readonly eventAction?: unknown;
          readonly eventDate?: unknown;
        }[]) {
          if (typeof event.eventAction !== 'string' || typeof event.eventDate !== 'string')
            continue;
          add(
            `event:${event.eventAction}`,
            'fact',
            `${event.eventAction}: ${event.eventDate}`,
            0.95,
            { kind: 'registration-event', action: event.eventAction, date: event.eventDate },
            `RDAP event ${event.eventAction} ${event.eventDate}`,
            event.eventDate,
            index,
            'described_by',
          );
        }
      }

      if (Array.isArray(record.status) && record.status.length > 0) {
        const status = record.status.filter((item): item is string => typeof item === 'string');
        if (status.length > 0) {
          add(
            'status',
            'fact',
            `status: ${status.join(', ')}`,
            0.95,
            { kind: 'registration-status', status },
            `RDAP status ${status.join(', ')}`,
            chunk.at,
            index,
            'described_by',
          );
        }
      }

      if (input.kind !== 'domain' && typeof record.handle === 'string' && record.handle !== '') {
        const label = typeof record.name === 'string' ? record.name : record.handle;
        add(
          `net:${record.handle}`,
          'asn',
          record.handle,
          0.95,
          {
            kind: 'network-allocation',
            ...(typeof record.startAddress === 'string'
              ? { startAddress: record.startAddress }
              : {}),
            ...(typeof record.endAddress === 'string' ? { endAddress: record.endAddress } : {}),
            label,
          },
          `RDAP allocation ${record.handle}`,
          chunk.at,
          index,
          'allocated_in',
        );
      }

      const rdapEntities = Array.isArray(record.entities)
        ? (record.entities as readonly RdapEntity[])
        : [];
      for (const entity of rdapEntities) {
        const fields = vcard(entity.vcardArray);
        const roles = rolesOf(entity);
        const role = roles[0] ?? 'contact';
        const organisation =
          fields['org'] ?? (roles.includes('registrar') ? fields['fn'] : undefined);
        const person = roles.includes('registrar') ? undefined : fields['fn'];

        if (organisation !== undefined && !REDACTED.test(organisation)) {
          add(
            `org:${role}:${organisation.toLowerCase()}`,
            'organization',
            organisation,
            0.9,
            { role, ...(typeof entity.handle === 'string' ? { handle: entity.handle } : {}) },
            `RDAP ${role}: ${organisation}`,
            chunk.at,
            index,
            role === 'registrar' ? 'registered_by' : 'related_to',
          );
        }
        if (person !== undefined && person !== organisation && !REDACTED.test(person)) {
          add(
            `person:${role}:${person.toLowerCase()}`,
            'person',
            person,
            // A published contact name is a claim by the registrant, not a verified identity.
            0.7,
            { role },
            `RDAP ${role} contact: ${person}`,
            chunk.at,
            index,
            'related_to',
          );
        }
      }
    });

    return { entities, relationships, evidence };
  },
});
