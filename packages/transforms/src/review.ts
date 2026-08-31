/**
 * Security and licence review of a third-party project before it is integrated (Part 2 §59, §60).
 *
 * Two questions, asked before any code of theirs runs here:
 *   - **§59 security** — what does this thing execute, where does it write, what does it reach, what
 *     secrets does it want, and does it run code we did not write? A project that runs third-party
 *     code (a plugin host, a script runner, a "modules" directory) is held to a stricter bar.
 *   - **§60 legal** — under what licence, compatible with commercial use, with what attribution and
 *     what redistribution limits, and what do its *dependencies* say? "It is on GitHub" is not a
 *     licence: an unstated licence is a refusal, never a permission.
 *
 * Both are pure functions over a declaration the caller assembled (from a package manifest, an SBOM,
 * an OSV query, a licence scan). Nothing is fetched here, and nothing is assumed: a field the caller
 * could not fill is `unknown`, and `unknown` never resolves in the candidate's favour.
 */

import type { Permission } from './types.ts';

export type Verdict = 'pass' | 'review' | 'refuse';
export type Severity = 'blocker' | 'warning' | 'note';

export interface ReviewFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly message: string;
}

/** How the project's code is executed here. Determines the blast radius of a bug in it. */
export const EXECUTION_MODELS = [
  'in-process',
  'subprocess',
  'container',
  'remote-api',
  'unknown',
] as const;
export type ExecutionModel = (typeof EXECUTION_MODELS)[number];

export interface DependencyFact {
  readonly name: string;
  /** SPDX id as stated by the dependency itself; `unknown` when nothing states one. */
  readonly licence: string;
}

export interface AdvisoryFact {
  readonly id: string;
  readonly severity: 'low' | 'moderate' | 'high' | 'critical';
  /** Version that fixes it, when upstream published one. */
  readonly fixedIn?: string;
}

/** Everything the reviewer is allowed to know. Anything absent is treated as unverified. */
export interface ProjectDeclaration {
  readonly id: string;
  readonly version: string;
  /** SPDX id from the project's own LICENSE file; omit when the project states none. */
  readonly licence?: string;
  readonly dependencies?: readonly DependencyFact[];
  readonly advisories?: readonly AdvisoryFact[];
  readonly executionModel?: ExecutionModel;
  /** True when the project executes code supplied by users or third parties (plugins, scripts). */
  readonly runsUntrustedCode?: boolean;
  /** Permissions the integration will need here. */
  readonly permissions?: readonly Permission[];
  /** Filesystem paths it writes outside its own workdir. */
  readonly filesystemWrites?: readonly string[];
  /** Hosts it contacts, beyond the provider endpoint. */
  readonly networkEgress?: readonly string[];
  /** Names of secrets it reads (env vars, key files). */
  readonly secrets?: readonly string[];
  readonly attributionRequired?: boolean;
  readonly redistribution?: 'permitted' | 'restricted' | 'unknown';
}

export interface LicencePolicy {
  /** SPDX ids the workspace accepts outright. */
  readonly allowed: ReadonlySet<string>;
  /** SPDX ids accepted only for out-of-process use (typically GPL/AGPL). */
  readonly allowedOutOfProcess?: ReadonlySet<string>;
  /** True when the integration ships inside a product that is sold or redistributed. */
  readonly commercial: boolean;
  /** True when the build redistributes the dependency's code rather than calling a service. */
  readonly redistributes?: boolean;
}

export interface ReviewReport {
  readonly project: string;
  readonly verdict: Verdict;
  readonly findings: readonly ReviewFinding[];
  /** Text for the install dialog and the PR body. */
  readonly summary: string;
}

const worst = (findings: readonly ReviewFinding[]): Verdict =>
  findings.some((finding) => finding.severity === 'blocker')
    ? 'refuse'
    : findings.some((finding) => finding.severity === 'warning')
      ? 'review'
      : 'pass';

const report = (
  project: string,
  findings: readonly ReviewFinding[],
  kind: string,
): ReviewReport => {
  const verdict = worst(findings);
  const headline =
    verdict === 'pass'
      ? `${kind} review passed`
      : verdict === 'review'
        ? `${kind} review needs a human decision`
        : `${kind} review refused the integration`;
  return {
    project,
    verdict,
    findings,
    summary: [
      `${project}: ${headline}`,
      ...findings.map((finding) => `- [${finding.severity}] ${finding.message}`),
    ].join('\n'),
  };
};

/** Copyleft families that dictate *how* an engine may be run, not merely credited. */
const STRONG_COPYLEFT = /^(A?GPL-[23]\.0)/i;
const SOURCE_AVAILABLE = /^(BUSL|SSPL|Elastic-2\.0|Commons-Clause|.*-NC)/i;

/** §60 — licence, commercial compatibility, attribution, redistribution, dependency licences. */
export const licenceReview = (project: ProjectDeclaration, policy: LicencePolicy): ReviewReport => {
  const findings: ReviewFinding[] = [];
  const licence = project.licence;

  if (!licence) {
    findings.push({
      id: 'licence-missing',
      severity: 'blocker',
      // The rule this repo keeps repeating: a public repository is not a grant of any rights.
      message: 'the project states no licence; being public on GitHub grants no rights',
    });
  } else if (policy.allowed.has(licence)) {
    findings.push({ id: 'licence-allowed', severity: 'note', message: `licence ${licence}` });
  } else if (policy.allowedOutOfProcess?.has(licence) === true) {
    findings.push({
      id: 'licence-out-of-process-only',
      severity: 'warning',
      message: `${licence} is accepted only out-of-process: run it as a separate process or service`,
    });
  } else if (STRONG_COPYLEFT.test(licence)) {
    findings.push({
      id: 'licence-copyleft',
      severity: 'blocker',
      message: `${licence} is copyleft and not in the allow list; linking it into the product is not permitted`,
    });
  } else if (SOURCE_AVAILABLE.test(licence)) {
    findings.push({
      id: 'licence-source-available',
      severity: 'blocker',
      message: `${licence} is source-available, not open source; commercial use needs a written grant`,
    });
  } else {
    findings.push({
      id: 'licence-not-allowed',
      severity: 'blocker',
      message: `licence "${licence}" is not in the workspace allow list`,
    });
  }

  if (policy.commercial && licence !== undefined && SOURCE_AVAILABLE.test(licence)) {
    findings.push({
      id: 'commercial-incompatible',
      severity: 'blocker',
      message: `${licence} restricts commercial use`,
    });
  }
  if (project.attributionRequired === true) {
    findings.push({
      id: 'attribution-required',
      severity: 'warning',
      message: 'attribution is required: the notice must ship in the product, not only in a PR',
    });
  }
  if (policy.redistributes === true && project.redistribution !== 'permitted') {
    findings.push({
      id: 'redistribution-restricted',
      severity: project.redistribution === 'restricted' ? 'blocker' : 'warning',
      message:
        project.redistribution === 'restricted'
          ? 'redistribution is restricted and this build redistributes the code'
          : 'redistribution terms are unverified and this build redistributes the code',
    });
  }

  const deps = project.dependencies ?? [];
  if (deps.length === 0) {
    findings.push({
      id: 'dependency-licences-unverified',
      severity: 'warning',
      message: 'no dependency licences were supplied; the tree is unverified',
    });
  }
  for (const dep of deps) {
    if (dep.licence === 'unknown' || dep.licence === '') {
      findings.push({
        id: `dependency-licence-unknown:${dep.name}`,
        severity: 'blocker',
        message: `dependency ${dep.name} states no licence`,
      });
    } else if (
      !policy.allowed.has(dep.licence) &&
      policy.allowedOutOfProcess?.has(dep.licence) !== true
    ) {
      findings.push({
        id: `dependency-licence-not-allowed:${dep.name}`,
        severity:
          STRONG_COPYLEFT.test(dep.licence) || SOURCE_AVAILABLE.test(dep.licence)
            ? 'blocker'
            : 'warning',
        message: `dependency ${dep.name} is ${dep.licence}, which the policy does not allow`,
      });
    }
  }

  return report(`${project.id}@${project.version}`, findings, 'Licence');
};

/** §59 — execution model, subprocesses, filesystem, network, secrets, permissions, advisories. */
export const securityReview = (
  project: ProjectDeclaration,
  granted: ReadonlySet<Permission> = new Set(),
): ReviewReport => {
  const findings: ReviewFinding[] = [];
  const model = project.executionModel ?? 'unknown';
  const permissions = project.permissions ?? [];

  if (model === 'unknown') {
    findings.push({
      id: 'execution-model-unknown',
      severity: 'blocker',
      message:
        'the execution model is unverified; an integration nobody profiled cannot be trusted',
    });
  } else {
    findings.push({ id: 'execution-model', severity: 'note', message: `runs ${model}` });
  }

  if (project.runsUntrustedCode === true) {
    findings.push({
      id: 'runs-untrusted-code',
      severity: model === 'container' ? 'warning' : 'blocker',
      message:
        model === 'container'
          ? 'executes third-party code; only acceptable inside the container sandbox with pinned limits'
          : `executes third-party code ${model === 'remote-api' ? 'off-box' : 'in this trust zone'}: needs container isolation first`,
    });
  }

  if (model === 'in-process' && permissions.includes('subprocess')) {
    findings.push({
      id: 'in-process-subprocess',
      severity: 'blocker',
      message: 'spawns processes from inside our process; it must go through the execution layer',
    });
  } else if (permissions.includes('subprocess')) {
    findings.push({
      id: 'subprocess',
      severity: 'warning',
      message: 'spawns subprocesses: argument construction and binary provenance must be reviewed',
    });
  }

  const ungranted = permissions.filter((permission) => !granted.has(permission));
  if (ungranted.length > 0) {
    findings.push({
      id: 'permissions-not-granted',
      severity: 'blocker',
      message: `asks for permissions the workspace has not granted: ${ungranted.join(', ')}`,
    });
  }

  const writes = project.filesystemWrites ?? [];
  const outside = writes.filter((path) => !path.startsWith('./') && !path.startsWith('workdir'));
  if (outside.length > 0) {
    findings.push({
      id: 'filesystem-writes-outside-workdir',
      severity: 'blocker',
      message: `writes outside its workdir: ${outside.join(', ')}`,
    });
  } else if (writes.length > 0 && !permissions.includes('filesystem')) {
    findings.push({
      id: 'undeclared-filesystem',
      severity: 'blocker',
      message: 'writes to disk without declaring the filesystem permission',
    });
  }

  const egress = project.networkEgress ?? [];
  if (egress.length > 0 && !permissions.includes('network')) {
    findings.push({
      id: 'undeclared-network',
      severity: 'blocker',
      message: `contacts ${egress.join(', ')} without declaring the network permission`,
    });
  } else if (egress.length > 1) {
    findings.push({
      id: 'multiple-egress-hosts',
      severity: 'warning',
      message: `contacts more than the provider endpoint: ${egress.join(', ')}`,
    });
  }

  const secrets = project.secrets ?? [];
  if (secrets.length > 0 && !permissions.includes('credentials')) {
    findings.push({
      id: 'undeclared-secrets',
      severity: 'blocker',
      message: `reads secrets without declaring the credentials permission: ${secrets.join(', ')}`,
    });
  }

  const advisories = project.advisories ?? [];
  for (const advisory of advisories) {
    const blocking = advisory.severity === 'critical' || advisory.severity === 'high';
    findings.push({
      id: `advisory:${advisory.id}`,
      severity: blocking && advisory.fixedIn === undefined ? 'blocker' : 'warning',
      message: `${advisory.id} (${advisory.severity})${advisory.fixedIn ? `, fixed in ${advisory.fixedIn}` : ', no fix published'}`,
    });
  }
  if (project.advisories === undefined) {
    findings.push({
      id: 'advisories-unchecked',
      severity: 'warning',
      message: 'no vulnerability scan was supplied for this version',
    });
  }

  return report(`${project.id}@${project.version}`, findings, 'Security');
};

/** Both reviews as one verdict — the shape the install pipeline (§40) and the PR template want. */
export const reviewProject = (
  project: ProjectDeclaration,
  policy: LicencePolicy,
  granted?: ReadonlySet<Permission>,
): {
  readonly licence: ReviewReport;
  readonly security: ReviewReport;
  readonly verdict: Verdict;
} => {
  const licence = licenceReview(project, policy);
  const security = securityReview(project, granted);
  const rank: Record<Verdict, number> = { refuse: 0, review: 1, pass: 2 };
  const verdict =
    rank[licence.verdict] <= rank[security.verdict] ? licence.verdict : security.verdict;
  return { licence, security, verdict };
};
