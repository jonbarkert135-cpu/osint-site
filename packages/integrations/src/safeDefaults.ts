/**
 * Safe defaults for newly registered integrations (§61).
 *
 * The spec's rule: a new engine is DISABLED until it has passed a compatibility, security, licence
 * and health check. Rather than a review checklist living in someone's head, the four checks are
 * evaluated from what the manifest already declares, and the verdict decides the *default*
 * enablement of a registry entry. An operator can still enable a blocked integration explicitly —
 * that is the human decision the gate is asking for — but nothing turns itself on quietly.
 */

import { classifyLicense, type LicenseFacts } from './license.ts';
import { CURRENT_MANIFEST_VERSION, type IntegrationManifest } from './manifest.ts';

export type SafeDefaultCheck = 'compatibility' | 'security' | 'license' | 'health';

export interface SafeDefaultBlocker {
  readonly check: SafeDefaultCheck;
  /** Shown verbatim in Admin → Integrations next to the disabled toggle (U5: honest reasons). */
  readonly message: string;
}

export interface SafeDefaultsVerdict {
  readonly enabledByDefault: boolean;
  readonly blockers: readonly SafeDefaultBlocker[];
  readonly license: LicenseFacts;
}

export function evaluateSafeDefaults(manifest: IntegrationManifest): SafeDefaultsVerdict {
  const blockers: SafeDefaultBlocker[] = [];
  const license = classifyLicense(manifest.license);

  // compatibility — the manifest speaks the version this build understands, and the adapter is not
  // still moving under us.
  if (manifest.manifestVersion !== CURRENT_MANIFEST_VERSION) {
    blockers.push({
      check: 'compatibility',
      message: `manifest version ${String(manifest.manifestVersion)} is not the current version ${String(CURRENT_MANIFEST_VERSION)}`,
    });
  }
  if (manifest.maturity === 'experimental') {
    blockers.push({
      check: 'compatibility',
      message: 'maturity is experimental — enable it deliberately, per workspace',
    });
  }
  if (manifest.maturity === 'deprecated') {
    blockers.push({
      check: 'compatibility',
      message: 'maturity is deprecated — it should be replaced, not switched on',
    });
  }

  // security — the two capabilities that cannot be reasoned about from the manifest alone.
  if (manifest.permissions.includes('net:broad')) {
    blockers.push({
      check: 'security',
      message: 'requests unrestricted outbound network access (net:broad)',
    });
  }
  if (manifest.permissions.includes('files:write')) {
    blockers.push({
      check: 'security',
      message: 'requests write access to files (files:write)',
    });
  }
  if (manifest.consent.required !== true) {
    blockers.push({
      check: 'security',
      message: 'declares that it needs no consent — that is a decision a human makes',
    });
  }

  // licence — §60. Unknown is never treated as permissive.
  if (license.commercialUse !== 'yes') {
    blockers.push({
      check: 'license',
      message: `licence ${license.spdx}: ${license.note}`,
    });
  }

  // health — is anyone still maintaining the upstream tool, and is there a way out if not.
  if (manifest.risk.upstreamMaintenance === 'unmaintained') {
    blockers.push({ check: 'health', message: 'upstream tool is unmaintained' });
  }
  if (manifest.risk.upstreamMaintenance === 'unknown') {
    blockers.push({
      check: 'health',
      message: 'upstream maintenance status is unknown — check it before enabling',
    });
  }
  if (manifest.risk.label === 'high' && manifest.risk.fallback === undefined) {
    blockers.push({
      check: 'health',
      message: 'high-risk integration with no declared fallback (§67)',
    });
  }

  return { enabledByDefault: blockers.length === 0, blockers, license };
}
