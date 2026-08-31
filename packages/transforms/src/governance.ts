/**
 * Integration governance: no legacy build-up (Part 2 §58) and safe defaults (§61).
 *
 * §58 is a rule against a specific failure: a tool aggregator slowly turning into a graveyard of
 * half-working forks nobody owns. So every integration must be able to answer seven questions —
 * **owner, adapter, compatibility, version, tests, health check, deprecation policy** — and the ones
 * that cannot are listed as debt rather than quietly kept.
 *
 * Four of the seven are derivable from what the repo already knows (adapter, compatibility, version,
 * and the licence facts behind them); three are statements a human has to make (owner, tests that
 * actually ran, deprecation policy). Those come in as an `IntegrationRecord` — the host's ledger —
 * and an engine with no record is **not** assumed to be fine.
 *
 * §61 is the consequence: a newly installed integration is `disabled` until compatibility, security,
 * licence and a *fresh* health check have all passed. Enabling is a decision with evidence behind it,
 * not the default state of anything that managed to get itself registered.
 */

import { engineDocument, type EngineDocument } from './document.ts';
import type { TransformRegistry } from './registry.ts';
import type { Verdict } from './review.ts';
import type { EngineId } from './types.ts';

export const INTEGRATION_REQUIREMENTS = [
  'owner',
  'adapter',
  'compatibility',
  'version',
  'tests',
  'health-check',
  'deprecation-policy',
] as const;
export type IntegrationRequirement = (typeof INTEGRATION_REQUIREMENTS)[number];

/** The test kinds every engine owes (Part 2 §62). `conformanceCoverage()` proves most of them. */
export const ENGINE_TEST_KINDS = [
  'unit',
  'integration',
  'adapter',
  'health',
  'timeout',
  'failure',
  'normalization',
  'duplicates',
] as const;
export type EngineTestKind = (typeof ENGINE_TEST_KINDS)[number];

/** What the host knows about an integration beyond its manifests. */
export interface IntegrationRecord {
  /** Who answers for this integration — a team or a person, not "the community". */
  readonly owner?: string;
  /** What happens when upstream dies: the policy text, or a link to it. */
  readonly deprecationPolicy?: string;
  /** Test kinds actually exercised in CI (see `conformanceCoverage`). */
  readonly tests?: readonly EngineTestKind[];
  /** ISO timestamp of the last successful health check. */
  readonly healthCheckedAt?: string;
  /** Verdicts from the §59/§60 review, when one was run. */
  readonly review?: { readonly licence: Verdict; readonly security: Verdict };
}

export interface IntegrationStatus {
  readonly engine: EngineId;
  readonly owner: string;
  /** §61: usable only when every activation gate passed. */
  readonly state: 'enabled' | 'disabled';
  /** §58 requirements with no answer. */
  readonly missing: readonly IntegrationRequirement[];
  /** §62 test kinds with no evidence. */
  readonly missingTests: readonly EngineTestKind[];
  /** Why it is still disabled; empty exactly when `state` is `enabled`. */
  readonly blocking: readonly string[];
}

export interface GovernanceOptions {
  /** A health check older than this is not evidence of anything. */
  readonly healthMaxAgeDays?: number;
  readonly now?: Date;
}

const DEFAULT_HEALTH_MAX_AGE_DAYS = 30;

const healthFresh = (record: IntegrationRecord, options: GovernanceOptions): boolean => {
  if (!record.healthCheckedAt) return false;
  const at = Date.parse(record.healthCheckedAt);
  if (Number.isNaN(at)) return false;
  const now = (options.now ?? new Date()).getTime();
  const maxAge = (options.healthMaxAgeDays ?? DEFAULT_HEALTH_MAX_AGE_DAYS) * 86_400_000;
  return now - at <= maxAge;
};

/** One integration against §58 and §61. Derives what it can, demands the rest. */
export const integrationGovernance = (
  document: EngineDocument,
  record: IntegrationRecord = {},
  options: GovernanceOptions = {},
): IntegrationStatus => {
  const missing: IntegrationRequirement[] = [];
  const blocking: string[] = [];

  if (!record.owner) missing.push('owner');
  if (document.execution.adapter !== 'implemented') missing.push('adapter');
  if (!document.execution.hostCompatible) missing.push('compatibility');
  if (!document.version) missing.push('version');

  const tests = new Set(record.tests ?? []);
  const missingTests = ENGINE_TEST_KINDS.filter((kind) => !tests.has(kind));
  if (missingTests.length > 0) missing.push('tests');

  const fresh = healthFresh(record, options);
  if (!fresh) missing.push('health-check');
  if (!record.deprecationPolicy) missing.push('deprecation-policy');

  // §61 activation gates, in the order the install pipeline runs them.
  if (document.execution.adapter !== 'implemented' || !document.execution.hostCompatible) {
    blocking.push(`compatibility: ${document.runtime}/${document.deployment} is not runnable here`);
  }
  if (record.review?.security !== 'pass') {
    blocking.push(`security: review verdict is ${record.review?.security ?? 'missing'}`);
  }
  if (record.review?.licence !== 'pass') {
    blocking.push(`licence: review verdict is ${record.review?.licence ?? 'missing'}`);
  }
  if (!fresh) {
    blocking.push(
      record.healthCheckedAt
        ? `health check: last passed ${record.healthCheckedAt}, older than the allowed window`
        : 'health check: never run',
    );
  }

  return {
    engine: document.name,
    owner: record.owner ?? 'unowned',
    state: blocking.length === 0 ? 'enabled' : 'disabled',
    missing,
    missingTests,
    blocking,
  };
};

export interface GovernanceReport {
  readonly integrations: readonly IntegrationStatus[];
  readonly enabled: readonly EngineId[];
  readonly disabled: readonly EngineId[];
  /** Integrations missing at least one §58 requirement — the legacy-debt list. */
  readonly debt: readonly IntegrationStatus[];
  readonly unowned: readonly EngineId[];
}

/** The whole registry against §58/§61, ready to print in CI or in `/system → Integrations`. */
export const governanceReport = (
  registry: TransformRegistry,
  records: Readonly<Record<EngineId, IntegrationRecord>> = {},
  options: GovernanceOptions = {},
): GovernanceReport => {
  const integrations = registry.engines
    .map((engine) =>
      integrationGovernance(engineDocument(registry, engine), records[engine.id], options),
    )
    .sort((a, b) => a.engine.localeCompare(b.engine));

  return {
    integrations,
    enabled: integrations.filter((entry) => entry.state === 'enabled').map((entry) => entry.engine),
    disabled: integrations
      .filter((entry) => entry.state === 'disabled')
      .map((entry) => entry.engine),
    debt: integrations.filter((entry) => entry.missing.length > 0),
    unowned: integrations.filter((entry) => entry.owner === 'unowned').map((entry) => entry.engine),
  };
};

/**
 * The engines a host may dispatch (§61). Everything else stays registered and visible — the catalogue
 * still lists it, with the reason — but no adapter is handed to the executor for it.
 */
export const enabledEngines = (report: GovernanceReport): ReadonlySet<EngineId> =>
  new Set(report.enabled);
