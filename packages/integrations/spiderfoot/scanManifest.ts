/**
 * The `spiderfoot-scan` manifest: the *launching* half of 12_SPIDERFOOT.md §4.
 *
 * `spiderfoot` reads a scan the analyst already ran; this one starts the scan itself. It is a
 * second manifest rather than a mode of the first because the two differ only in what the analyst
 * types (a scan id versus a target) and in the execution kind — and a second manifest costs one
 * line in `BUILTIN_SOURCES` (R2), while a mode would fork every stage behind it.
 *
 * Execution is `builtin`: creating a scan and following it needs a loop (create → poll with
 * backoff → cancel), which the declarative http executor cannot express. The loop itself lives in
 * `client.ts`; the runner module is the thin binding to an SSRF-guarded fetch.
 */

import { parseManifest, type IntegrationManifest } from '../src/manifest.ts';
import { entityMappings, spiderFootBaseUrl, DEFAULT_SPIDERFOOT_BASE_URL } from './manifest.ts';

export const SPIDERFOOT_SCAN_ID = 'spiderfoot-scan';

/** The runner registry key; the module of the same name performs the run. */
export const SPIDERFOOT_SCAN_MODULE = 'spiderfoot-scan';

/** §4.5: a scan can run for a long time, so the wall clock is the scan budget, not a page load. */
export const SCAN_WALL_CLOCK_MS = 1_800_000;

export function spiderFootScanManifest(): IntegrationManifest {
  return parseManifest({
    manifestVersion: 1,
    id: SPIDERFOOT_SCAN_ID,
    name: 'SpiderFoot scan',
    version: '1.0.0',
    toolVersion: '4.0',
    publisher: { name: 'Raven core', url: 'https://raven.local', verified: true },
    icon: 'integrations/spiderfoot',
    repository: 'https://github.com/smicallef/spiderfoot',
    license: 'MIT',
    description:
      'Starts a scan on your own SpiderFoot instance for the selected target, follows it while it runs, and proposes what it observed as nodes on the board. Stopping the run also stops the scan on the instance.',
    documentationUrl: 'https://github.com/smicallef/spiderfoot',
    capabilities: ['scan-domain', 'enrich-entity', 'enumerate-usernames'],
    inputs: [
      {
        name: 'target',
        label: 'Target',
        type: 'string',
        required: true,
        help: 'The domain, host, address, email or username SpiderFoot should scan.',
        from: { source: 'selection', kinds: ['domain', 'url', 'email', 'username', 'ip'] },
      },
      {
        name: 'useCase',
        label: 'Scan profile',
        type: 'enum',
        required: false,
        default: 'passive',
        enumValues: [
          { value: 'passive', label: 'Passive — never touches the target' },
          { value: 'footprint', label: 'Footprint — what the target exposes' },
          { value: 'investigate', label: 'Investigate — footprint plus reputation checks' },
          { value: 'all', label: 'All modules — slowest and loudest' },
        ],
        help: 'SpiderFoot’s own use-case profiles; passive is the safe default.',
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
      kind: 'builtin',
      module: SPIDERFOOT_SCAN_MODULE,
      limits: {
        wallClockMs: SCAN_WALL_CLOCK_MS,
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
      perUserPerHour: 10,
      perOrgPerHour: 50,
      perTargetPerDay: 10,
      concurrentRunsPerOrg: 2,
      minIntervalMsSameInput: 300_000,
    },
    costHints: {
      typicalDurationMs: 600_000,
      typicalOutboundRequests: 200,
      typicalNewNodes: 60,
      billable: false,
    },
    maturity: 'beta',
    risk: {
      label: 'high',
      reasons: [
        'This starts a real scan: depending on the profile, SpiderFoot may contact the target itself, which is visible to it.',
        'SpiderFoot v4.0 shows no recent upstream activity, so security fixes may not arrive (12_SPIDERFOOT.md §1).',
        'Findings are observations by third-party modules, never facts: every node carries its module, event type and confidence.',
      ],
      upstreamMaintenance: 'low',
      fallback:
        'If the instance is unreachable or refuses the scan: tier 1 — run the individual lookup natively; tier 2 — username enumeration falls back to Sherlock; tier 3 — the run reports the exact reason, never a silent no-op.',
    },
    consent: {
      required: true,
      scopeText:
        'I confirm I may look into this target. Raven starts a new scan on my own SpiderFoot instance; with a non-passive profile that instance will contact the target directly.',
      allowedTargetScopes: ['public-index', 'owned-asset'],
    },
  });
}

export const scanManifest: IntegrationManifest = spiderFootScanManifest();

/** The instance this deployment scans against; `undefined` when none is configured. */
export function configuredScanBaseUrl(
  env: Record<string, string | undefined> = {},
): string | undefined {
  const base = spiderFootBaseUrl(env);
  return base === DEFAULT_SPIDERFOOT_BASE_URL ? undefined : base;
}
