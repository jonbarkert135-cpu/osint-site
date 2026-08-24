import { describe, expect, it } from 'vitest';

import { createCatalogRegistry } from '../src/catalog/index.ts';
import { runConformance } from '../src/sdk/conformance.ts';
import { createCtLogSearch } from '../src/sdk/engines/ct-log-search.ts';
import { createRdapLookup } from '../src/sdk/engines/rdap-lookup.ts';
import { BUILTIN_ENGINES } from '../src/sdk/engines/index.ts';
import { createTestHost } from '../src/sdk/testkit.ts';

const registry = createCatalogRegistry();

const CRTSH = 'https://crt.sh/?q=%25.example.com&output=json';
const CRT_NET = {
  [CRTSH]: {
    status: 200,
    body: [
      {
        id: 1,
        name_value: 'www.example.com\n*.example.com',
        issuer_name: "C=US, O=Let's Encrypt",
        not_before: '2026-01-01T00:00:00',
      },
      {
        id: 2,
        name_value: 'mail.example.com',
        issuer_name: 'C=US, O=DigiCert',
        not_before: '2026-02-01T00:00:00',
      },
      { id: 3, name_value: 'example.com', issuer_name: 'C=US, O=DigiCert' },
    ],
  },
} as const;

const RDAP_URL = 'https://rdap.org/domain/example.com';
const RDAP_NET = {
  [RDAP_URL]: {
    status: 200,
    body: {
      handle: '2336799_DOMAIN_COM-VRSN',
      ldhName: 'EXAMPLE.COM',
      status: ['client delete prohibited'],
      events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }],
      entities: [
        {
          handle: '376',
          roles: ['registrar'],
          vcardArray: [
            'vcard',
            [
              ['version', {}, 'text', '4.0'],
              ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority'],
            ],
          ],
        },
        {
          roles: ['registrant'],
          vcardArray: [
            'vcard',
            [
              ['fn', {}, 'text', 'REDACTED FOR PRIVACY'],
              ['org', {}, 'text', 'Internet Assigned Numbers Authority'],
            ],
          ],
        },
      ],
    },
  },
} as const;

describe('ct-log-search', () => {
  it('passes the conformance harness against its shipped manifest', async () => {
    const report = await runConformance(createCtLogSearch(), {
      manifest: registry.engine('ct-log-search')!,
      fixtures: [
        {
          name: 'example.com',
          input: { kind: 'domain', value: 'example.com', entityId: 'n1' },
          net: CRT_NET,
          expect: { minEntities: 2, kinds: ['hostname'] },
        },
      ],
      invalidInputs: [
        { kind: 'domain', value: 'not a domain' },
        { kind: 'ip', value: '8.8.8.8' },
      ],
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
  });

  it('unwraps wildcards, drops the input itself and never claims to be exhaustive', async () => {
    const outcome = await createTestHost({ net: CRT_NET }).run(createCtLogSearch(), {
      kind: 'domain',
      value: 'Example.com.',
      entityId: 'n1',
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.entities.map((entity) => entity.value).sort()).toEqual([
      'mail.example.com',
      'www.example.com',
    ]);
    expect(outcome.exhaustive).toBe(false);
  });

  it('reports an unavailable service as an incomplete answer, not as a failure', async () => {
    const outcome = await createTestHost({ net: { [CRTSH]: { status: 503, body: null } } }).run(
      createCtLogSearch(),
      { kind: 'domain', value: 'example.com' },
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.entities).toEqual([]);
    expect(outcome.exhaustive).toBe(false);
  });
});

describe('rdap-lookup', () => {
  it('passes the conformance harness against its shipped manifest', async () => {
    const report = await runConformance(createRdapLookup(), {
      manifest: registry.engine('rdap-lookup')!,
      fixtures: [
        {
          name: 'example.com',
          input: { kind: 'domain', value: 'example.com', entityId: 'n1' },
          net: RDAP_NET,
          expect: { minEntities: 3, kinds: ['fact', 'organization'] },
        },
      ],
      invalidInputs: [
        { kind: 'domain', value: 'nope' },
        { kind: 'username', value: 'alice' },
      ],
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
  });

  it('keeps registry facts and drops redaction placeholders instead of reporting them as names', async () => {
    const outcome = await createTestHost({ net: RDAP_NET }).run(createRdapLookup(), {
      kind: 'domain',
      value: 'example.com',
      entityId: 'n1',
    });

    const values = outcome.entities.map((entity) => `${entity.kind}:${entity.value}`);
    expect(values).toContain('fact:registration: 1995-08-14T04:00:00Z');
    expect(values).toContain('fact:status: client delete prohibited');
    expect(values.some((value) => value.startsWith('organization:'))).toBe(true);
    expect(values.some((value) => /REDACTED/iu.test(value))).toBe(false);
  });

  it('treats "no such record" as an answer, not as an error', async () => {
    const outcome = await createTestHost({
      net: { 'https://rdap.org/domain/nothing-here.com': { status: 404, body: null } },
    }).run(createRdapLookup(), { kind: 'domain', value: 'nothing-here.com' });

    expect(outcome.status).toBe('completed');
    expect(outcome.entities).toEqual([]);
    expect(outcome.exhaustive).toBe(true);
  });
});

describe('rdap-lookup on networks', () => {
  const IP_URL = 'https://rdap.org/ip/8.8.8.8';
  const AS_URL = 'https://rdap.org/autnum/15169';
  const NET = {
    [IP_URL]: {
      status: 200,
      body: {
        handle: 'NET-8-8-8-0-1',
        name: 'GOGL',
        startAddress: '8.8.8.0',
        endAddress: '8.8.8.255',
        entities: [
          {
            roles: ['registrant'],
            vcardArray: [
              'vcard',
              [
                ['fn', {}, 'text', 'Google LLC'],
                ['adr', {}, 'text', ['', '', '1600 Amphitheatre Parkway', 'Mountain View']],
              ],
            ],
          },
        ],
      },
    },
    [AS_URL]: { status: 200, body: { handle: 'AS15169', name: 'GOOGLE' } },
  } as const;

  it('reads an IP allocation into an asn entity with its address range', async () => {
    const outcome = await createTestHost({ net: NET }).run(createRdapLookup(), {
      kind: 'ip',
      value: '8.8.8.8',
    });

    const allocation = outcome.entities.find((entity) => entity.kind === 'asn');
    expect(allocation?.value).toBe('NET-8-8-8-0-1');
    expect(allocation?.props).toMatchObject({ startAddress: '8.8.8.0', endAddress: '8.8.8.255' });
    // A person with a name that is really an organisation is still reported as what it is.
    expect(
      outcome.entities.some((entity) => entity.kind === 'person' && entity.value === 'Google LLC'),
    ).toBe(true);
  });

  it('accepts an AS number with or without the AS prefix', async () => {
    const engine = createRdapLookup();
    expect(engine.validateInput({ kind: 'asn', value: 'AS15169' })).toEqual({
      ok: true,
      normalizedValue: '15169',
    });
    expect(engine.validateInput({ kind: 'asn', value: 'nope' }).ok).toBe(false);
    expect(engine.validateInput({ kind: 'ip', value: '999.1.1.1' }).ok).toBe(false);

    const outcome = await createTestHost({ net: NET }).run(engine, {
      kind: 'asn',
      value: 'AS15169',
    });
    expect(outcome.entities.map((entity) => entity.value)).toEqual(['AS15169']);
  });

  it('treats a registry error as an incomplete answer so the chain may try another engine', async () => {
    const outcome = await createTestHost({
      net: { 'https://rdap.org/domain/example.com': { status: 500, body: null } },
    }).run(createRdapLookup(), { kind: 'domain', value: 'example.com' });

    expect(outcome.status).toBe('completed');
    expect(outcome.entities).toEqual([]);
    expect(outcome.exhaustive).toBe(false);
  });
});

describe('BUILTIN_ENGINES', () => {
  it('only lists engines the catalogue knows, and agrees with their manifests', () => {
    for (const [id, factory] of Object.entries(BUILTIN_ENGINES)) {
      const manifest = registry.engine(id);
      expect(manifest, id).toBeDefined();
      const metadata = factory().metadata();
      expect(metadata.engine).toBe(manifest!.id);
      expect(metadata.version).toBe(manifest!.version);
      expect(metadata.capability).toBe(manifest!.capability);
      expect(metadata.provider).toBe(manifest!.provider);
    }
  });
});
