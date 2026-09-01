/** Safe defaults (§61): a new engine stays off until compatibility, security, licence and health pass. */

import { describe, expect, it } from 'vitest';

import { manifest as expandUrl } from '../builtin/manifest.ts';
import { parseManifest, type IntegrationManifest } from '../src/manifest.ts';
import { evaluateSafeDefaults, type SafeDefaultCheck } from '../src/safeDefaults.ts';

const manifestWith = (over: Record<string, unknown>): IntegrationManifest =>
  parseManifest({
    ...(JSON.parse(JSON.stringify(expandUrl)) as Record<string, unknown>),
    ...over,
  });

const checks = (m: IntegrationManifest): readonly SafeDefaultCheck[] =>
  evaluateSafeDefaults(m).blockers.map((b) => b.check);

describe('evaluateSafeDefaults', () => {
  it('enables a stable, permissively licensed, allowlisted integration', () => {
    const verdict = evaluateSafeDefaults(manifestWith({}));
    expect(verdict.blockers).toEqual([]);
    expect(verdict.enabledByDefault).toBe(true);
    expect(verdict.license.spdx).toBe('Apache-2.0');
  });

  it('holds back experimental and deprecated adapters', () => {
    expect(checks(manifestWith({ maturity: 'experimental' }))).toContain('compatibility');
    expect(checks(manifestWith({ maturity: 'deprecated' }))).toContain('compatibility');
    expect(evaluateSafeDefaults(manifestWith({ maturity: 'beta' })).enabledByDefault).toBe(true);
  });

  it('holds back broad network access and file writes', () => {
    const broad = manifestWith({
      permissions: ['net:broad', 'graph:read', 'graph:propose'],
    });
    expect(checks(broad)).toContain('security');
    expect(broad.permissions).toContain('net:broad');

    const writes = manifestWith({
      permissions: ['files:write', 'graph:read'],
    });
    expect(checks(writes)).toContain('security');
  });

  it('holds back an integration that declares it needs no consent', () => {
    const noConsent = manifestWith({
      consent: { ...expandUrl.consent, required: false },
    });
    expect(checks(noConsent)).toContain('security');
  });

  it('holds back anything whose licence is not unconditionally commercial', () => {
    expect(checks(manifestWith({ license: 'AGPL-3.0' }))).toContain('license');
    expect(checks(manifestWith({ license: 'made-up terms' }))).toContain('license');
    const verdict = evaluateSafeDefaults(manifestWith({ license: 'made-up terms' }));
    expect(verdict.license.category).toBe('unknown');
    expect(verdict.blockers.find((b) => b.check === 'license')?.message).toContain('made-up terms');
  });

  it('holds back unmaintained or unknown upstreams', () => {
    expect(
      checks(manifestWith({ risk: { ...expandUrl.risk, upstreamMaintenance: 'unmaintained' } })),
    ).toContain('health');
    expect(
      checks(manifestWith({ risk: { ...expandUrl.risk, upstreamMaintenance: 'unknown' } })),
    ).toContain('health');
    expect(
      checks(manifestWith({ risk: { ...expandUrl.risk, upstreamMaintenance: 'low' } })),
    ).toEqual([]);
  });

  it('requires a declared fallback for high-risk integrations', () => {
    const highRisk = manifestWith({
      risk: {
        label: 'high',
        reasons: expandUrl.risk.reasons,
        upstreamMaintenance: expandUrl.risk.upstreamMaintenance,
      },
    });
    expect(checks(highRisk)).toContain('health');

    const withFallback = manifestWith({
      risk: { ...expandUrl.risk, label: 'high', fallback: 'manual mode' },
    });
    expect(checks(withFallback)).toEqual([]);
  });

  it('reports every blocker at once instead of one per round-trip', () => {
    const bad = manifestWith({
      maturity: 'experimental',
      license: 'SSPL-1.0',
      risk: { ...expandUrl.risk, upstreamMaintenance: 'unmaintained' },
    });
    expect(checks(bad)).toEqual(
      expect.arrayContaining(['compatibility', 'license', 'health'] as SafeDefaultCheck[]),
    );
    expect(evaluateSafeDefaults(bad).enabledByDefault).toBe(false);
  });
});
