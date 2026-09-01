/**
 * The `sherlock` integration manifest (13_SHERLOCK.md §2, 10_INTEGRATIONS.md §4).
 *
 * Sherlock is a Python CLI, so it runs as a container in the runner sandbox — read-only rootfs,
 * gVisor, no capabilities, all traffic through the egress proxy. Its egress is `broad` by
 * necessity (§3.3): it contacts hundreds of third-party sites, and enumerating them would be a lie
 * dressed as an allowlist. Private ranges stay denied, which is the part that actually matters.
 *
 * The image is pinned by digest: `SHERLOCK_IMAGE_DIGEST` when a deployment pins its own build,
 * otherwise the repo's pin from `pinnedImages.ts` (§6.2, refreshed by `scripts/pin-images.mjs`
 * through the registry API — no Docker needed). A floating `:latest` is never used; if neither
 * source has a valid digest, `sherlockSources` is empty and the registry never sees Sherlock.
 */

import { parseManifest, type EntityMapping, type IntegrationManifest } from '../src/manifest.ts';
import { pinnedDigest } from '../src/pinnedImages.ts';

export const SHERLOCK_ID = 'sherlock';
export const SHERLOCK_IMAGE = 'sherlock/sherlock';
/** §1: v0.16.0, MIT, actively maintained. */
export const SHERLOCK_TOOL_VERSION = '0.16.0';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function sherlockImageDigest(
  env: Record<string, string | undefined> = {},
): string | undefined {
  const override = env.SHERLOCK_IMAGE_DIGEST;
  // A deployment's own pin wins; an invalid override is ignored rather than silently trusted.
  if (override !== undefined && DIGEST.test(override)) return override;
  return pinnedDigest(SHERLOCK_IMAGE);
}

/** Claimed profiles only; §5.4 forbids importing "available" as if it meant anything about a person. */
const entityMappings: readonly EntityMapping[] = [
  {
    id: 'profile',
    when: { recordType: 'profile' },
    entity: {
      kind: 'url',
      valueFrom: '/url',
      nodeType: 'link',
      titleFrom: '/site',
      fields: [
        { from: '/url', to: 'url', transform: 'url-normalize', required: true },
        { from: '/site', to: 'service', transform: 'trim', required: true },
        { from: '/username', to: 'username', transform: 'lower', required: false },
        { from: '/urlMain', to: 'serviceRoot', transform: 'url-normalize', required: false },
        { from: '/httpStatus', to: 'httpStatus', transform: 'none', required: false },
        { from: '/status', to: 'sherlockStatus', transform: 'none', required: false },
        { from: '/raw', to: 'sherlockRaw', transform: 'none', required: false },
      ],
      tags: ['sherlock', 'profile'],
      // §5.3: a claimed handle is an account with that name, never a person; never above 0.9.
      baseConfidence: 0.7,
    },
    relate: [{ to: 'anchor', edgeType: 'related_to', direction: 'out', label: 'has profile' }],
  },
];

export function sherlockManifest(imageDigest: string): IntegrationManifest {
  return parseManifest({
    manifestVersion: 1,
    id: SHERLOCK_ID,
    name: 'Sherlock',
    version: '1.0.0',
    toolVersion: SHERLOCK_TOOL_VERSION,
    publisher: { name: 'Raven core', url: 'https://raven.local', verified: true },
    icon: 'integrations/sherlock',
    repository: 'https://github.com/sherlock-project/sherlock',
    license: 'MIT',
    description:
      'Checks a username against several hundred sites and proposes the profiles that are claimed as nodes linked to the username. A claimed handle is an account using that name — never proof that a particular person owns it.',
    documentationUrl: 'https://github.com/sherlock-project/sherlock',
    capabilities: ['enumerate-usernames'],
    inputs: [
      {
        name: 'username',
        label: 'Username',
        type: 'string',
        required: true,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
        help: 'One username per run, so provenance, cancellation and quota stay one-to-one with it.',
        from: { source: 'selection', kinds: ['username'] },
      },
      {
        name: 'timeoutSec',
        label: 'Per-site timeout (seconds)',
        type: 'number',
        required: false,
        default: 15,
        min: 3,
        max: 60,
        advanced: true,
      },
      {
        name: 'nsfw',
        label: 'Include adult sites',
        type: 'boolean',
        required: false,
        default: false,
        help: 'Off by default. Turning it on checks adult platforms as well.',
      },
    ],
    outputs: [
      {
        name: 'results',
        kind: 'json',
        path: '/out/results.json',
        fromStdout: false,
        primary: true,
        maxBytes: 33_554_432,
      },
    ],
    permissions: ['net:broad', 'graph:read', 'graph:propose'],
    execution: {
      kind: 'container',
      image: SHERLOCK_IMAGE,
      digest: imageDigest,
      command: [
        '{{input.username}}',
        '--json',
        '/out/results.json',
        '--timeout',
        '{{input.timeoutSec}}',
        '--print-found',
        '--local',
      ],
      env: {},
      secretEnv: {},
      workdir: '/out',
      network: {
        // §3.3: ~400 third-party sites cannot be honestly enumerated; private ranges stay denied.
        mode: 'broad',
        allow: [],
        denyPrivateRanges: true,
        maxRequestsPerMinute: 600,
        maxConcurrentConnections: 16,
      },
      limits: {
        wallClockMs: 600_000,
        cpuMillicores: 1000,
        memoryMiB: 1024,
        pids: 256,
        tmpfsMiB: 256,
        maxOutputBytes: 33_554_432,
        maxArtifacts: 4,
      },
      runtimeClass: 'gvisor',
      user: '65532:65532',
      readOnlyRootFs: true,
      // §3.6: `--json` is the only result source we trust; an image without it is unusable.
      capabilityProbe: {
        versionArgs: ['--version'],
        helpArgs: ['--help'],
        requiredFlags: ['--json'],
        minVersion: SHERLOCK_TOOL_VERSION,
      },
    },
    parser: {
      module: '@nexus/integrations/sherlock/parser',
      export: 'parser',
      supportedOutputVersions: ['1.0'],
    },
    entityMappings,
    rateLimits: {
      perUserPerHour: 20,
      perOrgPerHour: 100,
      perTargetPerDay: 10,
      concurrentRunsPerOrg: 2,
      minIntervalMsSameInput: 300_000,
    },
    costHints: {
      typicalDurationMs: 120_000,
      typicalOutboundRequests: 400,
      typicalNewNodes: 15,
      billable: false,
    },
    maturity: 'stable',
    risk: {
      label: 'medium',
      reasons: [
        'Contacts several hundred third-party sites from this deployment, which is visible traffic.',
        'Site checks produce false positives; an unrecognised answer is never counted as a hit.',
        'A claimed handle identifies an account, not a person (13_SHERLOCK.md §5.4).',
      ],
      upstreamMaintenance: 'active',
      fallback:
        'If the image is not pinned or the run fails, Sherlock is unavailable with the exact reason; nothing is imported and existing nodes are untouched.',
    },
    consent: {
      required: true,
      scopeText:
        'I confirm I have a legitimate reason to look up this username. The run contacts several hundred public sites from this deployment and records which of them have an account with that name; it logs in nowhere and writes nothing.',
      allowedTargetScopes: ['public-index'],
    },
  });
}

/** Empty when the deployment did not pin a digest — no Sherlock is better than a floating tag. */
export const manifest: IntegrationManifest | undefined = ((): IntegrationManifest | undefined => {
  const digest = sherlockImageDigest(typeof process === 'undefined' ? {} : process.env);
  return digest === undefined ? undefined : sherlockManifest(digest);
})();
