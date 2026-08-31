import { describe, expect, it } from 'vitest';

import {
  licenceReview,
  reviewProject,
  securityReview,
  type LicencePolicy,
  type ProjectDeclaration,
} from '../src/review.ts';

const POLICY: LicencePolicy = {
  allowed: new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause']),
  allowedOutOfProcess: new Set(['GPL-3.0']),
  commercial: true,
};

const CLEAN: ProjectDeclaration = {
  id: 'subfinder',
  version: '2.6.6',
  licence: 'MIT',
  dependencies: [{ name: 'goflags', licence: 'MIT' }],
  advisories: [],
  executionModel: 'subprocess',
  permissions: ['network', 'subprocess'],
  networkEgress: ['crt.sh'],
  redistribution: 'permitted',
};

describe('licenceReview (§60)', () => {
  it('refuses a project that states no licence', () => {
    const report = licenceReview({ id: 'x', version: '1.0.0', dependencies: [] }, POLICY);

    expect(report.verdict).toBe('refuse');
    expect(report.findings[0]?.id).toBe('licence-missing');
    expect(report.summary).toContain('being public on GitHub grants no rights');
  });

  it('passes an allowed licence with an audited dependency tree', () => {
    expect(licenceReview(CLEAN, POLICY).verdict).toBe('pass');
  });

  it('flags a copyleft licence that is only accepted out of process', () => {
    const report = licenceReview({ ...CLEAN, licence: 'GPL-3.0' }, POLICY);

    expect(report.verdict).toBe('review');
    expect(report.findings.map((finding) => finding.id)).toContain('licence-out-of-process-only');
  });

  it('refuses unlisted copyleft and source-available licences', () => {
    expect(licenceReview({ ...CLEAN, licence: 'AGPL-3.0' }, POLICY).verdict).toBe('refuse');
    const busl = licenceReview({ ...CLEAN, licence: 'BUSL-1.1' }, POLICY);
    expect(busl.verdict).toBe('refuse');
    expect(busl.findings.map((finding) => finding.id)).toContain('commercial-incompatible');
    expect(licenceReview({ ...CLEAN, licence: 'WTF-1.0' }, POLICY).verdict).toBe('refuse');
  });

  it('carries attribution and redistribution obligations into the verdict', () => {
    const report = licenceReview(
      { ...CLEAN, attributionRequired: true, redistribution: 'restricted' },
      { ...POLICY, redistributes: true },
    );

    expect(report.verdict).toBe('refuse');
    expect(report.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(['attribution-required', 'redistribution-restricted']),
    );
  });

  it('warns when redistribution terms were never checked', () => {
    const report = licenceReview(
      { ...CLEAN, redistribution: 'unknown' },
      { ...POLICY, redistributes: true },
    );

    expect(report.verdict).toBe('review');
  });

  it('checks dependency licences, not just the top-level one', () => {
    const unknownDep = licenceReview(
      { ...CLEAN, dependencies: [{ name: 'vendored-thing', licence: 'unknown' }] },
      POLICY,
    );
    expect(unknownDep.verdict).toBe('refuse');

    const copyleftDep = licenceReview(
      { ...CLEAN, dependencies: [{ name: 'lib', licence: 'AGPL-3.0' }] },
      POLICY,
    );
    expect(copyleftDep.verdict).toBe('refuse');

    const oddDep = licenceReview(
      { ...CLEAN, dependencies: [{ name: 'lib', licence: 'Zlib' }] },
      POLICY,
    );
    expect(oddDep.verdict).toBe('review');

    expect(licenceReview({ ...CLEAN, dependencies: [] }, POLICY).verdict).toBe('review');
  });
});

describe('securityReview (§59)', () => {
  const granted = new Set(['network', 'subprocess'] as const);

  it('passes a profiled subprocess engine with granted permissions', () => {
    const report = securityReview(CLEAN, granted);

    expect(report.verdict).toBe('review'); // subprocess is never waved through silently
    expect(report.findings.map((finding) => finding.id)).toContain('subprocess');
  });

  it('refuses an integration nobody profiled', () => {
    const report = securityReview(
      { id: 'x', version: '1.0.0', permissions: [], advisories: [] },
      granted,
    );

    expect(report.verdict).toBe('refuse');
    expect(report.findings[0]?.id).toBe('execution-model-unknown');
  });

  it('refuses a project that runs third-party code outside a container', () => {
    const report = securityReview({ ...CLEAN, runsUntrustedCode: true }, granted);

    expect(report.verdict).toBe('refuse');
    expect(report.findings.map((finding) => finding.id)).toContain('runs-untrusted-code');
  });

  it('accepts third-party code execution only inside a container, with a warning', () => {
    const report = securityReview(
      { ...CLEAN, runsUntrustedCode: true, executionModel: 'container', permissions: ['network'] },
      granted,
    );

    expect(report.verdict).toBe('review');
  });

  it('refuses an in-process engine that spawns processes', () => {
    const report = securityReview({ ...CLEAN, executionModel: 'in-process' }, granted);

    expect(report.findings.map((finding) => finding.id)).toContain('in-process-subprocess');
    expect(report.verdict).toBe('refuse');
  });

  it('refuses ungranted permissions, stray filesystem writes and undeclared reach', () => {
    expect(securityReview({ ...CLEAN, permissions: ['credentials'] }, granted).verdict).toBe(
      'refuse',
    );
    expect(
      securityReview({ ...CLEAN, filesystemWrites: ['/etc/hosts'] }, granted).findings.map(
        (f) => f.id,
      ),
    ).toContain('filesystem-writes-outside-workdir');
    expect(
      securityReview({ ...CLEAN, filesystemWrites: ['./cache'] }, granted).findings.map(
        (f) => f.id,
      ),
    ).toContain('undeclared-filesystem');
    expect(
      securityReview(
        { ...CLEAN, permissions: ['subprocess'], networkEgress: ['evil.example'] },
        granted,
      ).findings.map((f) => f.id),
    ).toContain('undeclared-network');
    expect(
      securityReview({ ...CLEAN, secrets: ['SHODAN_API_KEY'] }, granted).findings.map((f) => f.id),
    ).toContain('undeclared-secrets');
  });

  it('notices extra egress hosts beyond the provider endpoint', () => {
    const report = securityReview(
      { ...CLEAN, networkEgress: ['crt.sh', 'telemetry.example'] },
      granted,
    );

    expect(report.findings.map((finding) => finding.id)).toContain('multiple-egress-hosts');
  });

  it('blocks on an unfixed high advisory and warns on a fixed one', () => {
    const unfixed = securityReview(
      { ...CLEAN, advisories: [{ id: 'GHSA-1', severity: 'critical' }] },
      granted,
    );
    expect(unfixed.verdict).toBe('refuse');

    const fixed = securityReview(
      { ...CLEAN, advisories: [{ id: 'GHSA-2', severity: 'high', fixedIn: '2.7.0' }] },
      granted,
    );
    expect(fixed.verdict).toBe('review');
  });

  it('says so when no vulnerability scan was supplied', () => {
    const { advisories: _ignored, ...withoutScan } = CLEAN;
    const report = securityReview(withoutScan, granted);

    expect(report.findings.map((finding) => finding.id)).toContain('advisories-unchecked');
  });
});

describe('reviewProject', () => {
  it('returns the worse of the two verdicts', () => {
    const combined = reviewProject(
      { ...CLEAN, licence: 'AGPL-3.0' },
      POLICY,
      new Set(['network', 'subprocess']),
    );

    expect(combined.licence.verdict).toBe('refuse');
    expect(combined.security.verdict).toBe('review');
    expect(combined.verdict).toBe('refuse');
  });

  it('reports pass only when both halves pass', () => {
    const combined = reviewProject(
      { ...CLEAN, executionModel: 'remote-api', permissions: ['network'] },
      POLICY,
      new Set(['network']),
    );

    expect(combined.verdict).toBe('pass');
  });
});
