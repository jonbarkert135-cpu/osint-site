/**
 * The `spiderfoot` integration manifest (12_SPIDERFOOT.md, 10_INTEGRATIONS.md §4).
 *
 * SpiderFoot is a self-hosted tool: there is no vendor host to hard-code, so the instance URL is
 * deployment configuration (`SPIDERFOOT_BASE_URL`) and the manifest is built from it. The runner's
 * existing http executor performs the read — no third-party code ever runs outside the sandbox
 * (N5), and exactly one host is reachable, declared here rather than in a global allowlist.
 *
 * Raven reads the results of a scan the analyst started on their own instance
 * (`/scaneventresults`); launching and polling a scan from Raven is a separate, larger piece of
 * work and is deliberately not pretended to exist here.
 *
 * §1 of the spec is honoured literally: `maturity: 'beta'`, `risk.label: 'high'`,
 * `risk.upstreamMaintenance: 'low'` and a `risk.fallback` naming the tiers — those three fields
 * drive the warning UI, so they are not optional for this integration.
 */

import {
  parseManifest,
  type EntityMapping,
  type IntegrationManifest,
  type NetworkPolicy,
} from '../src/manifest.ts';
import type { SpiderFootRecordType } from './mapping.ts';

export const SPIDERFOOT_ID = 'spiderfoot';

/** No sane default exists for a self-hosted tool; an unconfigured deployment gets a dead host. */
export const DEFAULT_SPIDERFOOT_BASE_URL = 'https://spiderfoot.invalid';

export function spiderFootBaseUrl(env: Record<string, string | undefined> = {}): string {
  const configured = env.SPIDERFOOT_BASE_URL;
  if (configured === undefined || configured.length === 0) return DEFAULT_SPIDERFOOT_BASE_URL;
  try {
    return new URL(configured).toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_SPIDERFOOT_BASE_URL;
  }
}

/** The scan page on the analyst's own instance — what "Open in SpiderFoot" opens. */
export function spiderFootScanUrl(scanId: string, baseUrl: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(scanId)) return undefined;
  if (baseUrl === DEFAULT_SPIDERFOOT_BASE_URL) return undefined;
  return `${baseUrl.replace(/\/$/, '')}/scaninfo?id=${encodeURIComponent(scanId)}`;
}

const mapping = (
  recordType: SpiderFootRecordType,
  kind: EntityMapping['entity']['kind'],
  nodeType: string,
  label: string,
  baseConfidence: number,
): EntityMapping => ({
  id: recordType,
  when: { recordType },
  entity: {
    kind,
    valueFrom: '/value',
    nodeType,
    titleFrom: '/value',
    fields: [
      { from: '/value', to: 'value', transform: 'trim', required: true },
      { from: '/module', to: 'sfModule', transform: 'none', required: false },
      { from: '/eventType', to: 'sfEventType', transform: 'none', required: false },
      { from: '/sourceValue', to: 'sfSource', transform: 'none', required: false },
      { from: '/observedAt', to: 'sfObservedAt', transform: 'none', required: false },
      { from: '/raw', to: 'sfRaw', transform: 'none', required: false },
    ],
    tags: ['spiderfoot', recordType],
    baseConfidence,
  },
  relate: [{ to: 'anchor', edgeType: 'related_to', direction: 'out', label }],
});

/** One row per record type of `mapping.ts`; the table there decides which row a record lands in. */
const entityMappings: readonly EntityMapping[] = [
  mapping('domain', 'domain', 'website', 'observed domain', 0.85),
  mapping('url', 'url', 'link', 'observed url', 0.7),
  mapping('email', 'email', 'person', 'observed email', 0.7),
  mapping('username', 'username', 'person', 'observed username', 0.6),
  mapping('ip', 'ip', 'unknown', 'observed ip', 0.85),
  mapping('repo', 'repo', 'repo', 'observed repository', 0.8),
  mapping('observation', 'note', 'note', 'observation', 0.3),
];

export function spiderFootManifest(baseUrl: string): IntegrationManifest {
  const host = ((): string => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return new URL(DEFAULT_SPIDERFOOT_BASE_URL).host;
    }
  })();

  const network: NetworkPolicy = {
    mode: 'allowlist',
    allow: [host],
    denyPrivateRanges: true,
    maxRequestsPerMinute: 60,
    maxConcurrentConnections: 4,
  };

  return parseManifest({
    manifestVersion: 1,
    id: SPIDERFOOT_ID,
    name: 'SpiderFoot',
    version: '1.0.0',
    toolVersion: '4.0',
    publisher: { name: 'Raven core', url: 'https://raven.local', verified: true },
    icon: 'integrations/spiderfoot',
    repository: 'https://github.com/smicallef/spiderfoot',
    license: 'MIT',
    description:
      'Imports the findings of a SpiderFoot scan from your own SpiderFoot instance and proposes the domains, hosts, addresses, emails, usernames, links and repositories it observed as nodes on the board, each with its module, event type and confidence.',
    documentationUrl: 'https://github.com/smicallef/spiderfoot',
    capabilities: ['scan-domain', 'enrich-entity', 'enumerate-usernames'],
    inputs: [
      {
        name: 'scanId',
        label: 'Scan ID',
        type: 'string',
        required: true,
        help: 'The id of a finished scan on your SpiderFoot instance (the id in its /scaninfo URL).',
        pattern: '^[A-Za-z0-9_-]{4,64}$',
        from: { source: 'form' },
      },
      {
        name: 'includeUnmapped',
        label: 'Import findings Raven cannot classify',
        type: 'boolean',
        required: false,
        default: true,
        help: 'Unknown SpiderFoot event types arrive as observations instead of being dropped.',
      },
    ],
    outputs: [
      { name: 'events', kind: 'json', fromStdout: false, primary: true, maxBytes: 33_554_432 },
    ],
    permissions: ['net:allowlist', 'graph:read', 'graph:propose'],
    execution: {
      kind: 'http',
      baseUrl,
      requests: [
        {
          name: 'events',
          method: 'GET',
          path: '/scaneventresults',
          query: { id: '{{input.scanId}}', eventType: 'ALL', filterfp: 'True' },
          headers: { accept: 'application/json' },
          collectAs: 'events',
        },
      ],
      network,
      limits: {
        wallClockMs: 120_000,
        cpuMillicores: 500,
        memoryMiB: 512,
        pids: 16,
        tmpfsMiB: 16,
        maxOutputBytes: 33_554_432,
        maxArtifacts: 1,
      },
    },
    parser: {
      module: '@nexus/integrations/spiderfoot/parser',
      export: 'parser',
      supportedOutputVersions: ['1.0'],
    },
    entityMappings,
    rateLimits: {
      perUserPerHour: 20,
      perOrgPerHour: 200,
      perTargetPerDay: 20,
      concurrentRunsPerOrg: 2,
      minIntervalMsSameInput: 60_000,
    },
    costHints: {
      typicalDurationMs: 5_000,
      typicalOutboundRequests: 1,
      typicalNewNodes: 60,
      billable: false,
    },
    maturity: 'beta',
    risk: {
      label: 'high',
      reasons: [
        'SpiderFoot v4.0 shows no recent upstream activity, so security fixes may not arrive (12_SPIDERFOOT.md §1).',
        'Its API shape is not a published contract; Raven reads it tolerantly and never trusts field order.',
        'Findings are observations by third-party modules, never facts: every node carries its module, event type and confidence.',
      ],
      upstreamMaintenance: 'low',
      fallback:
        'If the instance is unreachable: tier 1 — run the individual lookup natively; tier 2 — username enumeration falls back to Sherlock; tier 3 — the integration reports unavailable with the exact reason, never a silent no-op.',
    },
    consent: {
      required: true,
      scopeText:
        'I confirm I may look into this target. Raven reads the results of a scan I already ran on my own SpiderFoot instance; it sends one read-only request to that instance and starts no new scan.',
      allowedTargetScopes: ['public-index', 'owned-asset'],
    },
  });
}

export const manifest: IntegrationManifest = spiderFootManifest(
  spiderFootBaseUrl(typeof process === 'undefined' ? {} : process.env),
);
