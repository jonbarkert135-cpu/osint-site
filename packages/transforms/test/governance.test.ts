import { describe, expect, it } from 'vitest';

import { engineDocument } from '../src/document.ts';
import {
  ENGINE_TEST_KINDS,
  enabledEngines,
  governanceReport,
  integrationGovernance,
  type IntegrationRecord,
} from '../src/governance.ts';
import {
  buildRegistry,
  makeEngine,
  makeProvider,
  makeTransform,
  MANUAL_ENGINE,
  MANUAL_PROVIDER,
} from './fixtures.ts';

const NOW = new Date('2026-08-31T00:00:00Z');

const registry = buildRegistry({
  transforms: [
    makeTransform({
      id: 'domain-to-ip',
      capability: 'dns',
      engines: ['engine-a', 'engine-exotic'],
    }),
  ],
  engines: [
    makeEngine({ id: 'engine-a', capability: 'dns', provider: 'provider-a' }),
    makeEngine({
      id: 'engine-exotic',
      capability: 'dns',
      provider: 'provider-a',
      runtime: {
        runtime: 'rust',
        deployment: 'unsupported',
        requirements: { memoryMb: 512, cpu: 2, persistent: false },
        hostCompatible: false,
        fallback: { strategy: 'remote-execution', target: 'worker' },
      },
    }),
    MANUAL_ENGINE,
  ],
  providers: [makeProvider({ id: 'provider-a' }), MANUAL_PROVIDER],
});

const documentOf = (id: string) => engineDocument(registry, registry.engine(id)!);

const COMPLETE: IntegrationRecord = {
  owner: 'raven-core',
  deprecationPolicy: 'docs/ecosystem/DEPRECATION.md',
  tests: [...ENGINE_TEST_KINDS],
  healthCheckedAt: '2026-08-20T10:00:00Z',
  review: { licence: 'pass', security: 'pass' },
};

describe('integrationGovernance (§58, §61)', () => {
  it('disables an engine with no ledger entry and lists every missing requirement', () => {
    const status = integrationGovernance(documentOf('engine-a'), {}, { now: NOW });

    expect(status.state).toBe('disabled');
    expect(status.owner).toBe('unowned');
    expect(status.missing).toEqual(['owner', 'tests', 'health-check', 'deprecation-policy']);
    expect(status.missingTests).toEqual([...ENGINE_TEST_KINDS]);
    expect(status.blocking).toEqual([
      'security: review verdict is missing',
      'licence: review verdict is missing',
      'health check: never run',
    ]);
  });

  it('enables an engine only once compatibility, security, licence and health all passed', () => {
    const status = integrationGovernance(documentOf('engine-a'), COMPLETE, { now: NOW });

    expect(status.state).toBe('enabled');
    expect(status.missing).toEqual([]);
    expect(status.blocking).toEqual([]);
  });

  it('keeps an engine disabled when its health check went stale', () => {
    const status = integrationGovernance(
      documentOf('engine-a'),
      { ...COMPLETE, healthCheckedAt: '2026-01-01T00:00:00Z' },
      { now: NOW },
    );

    expect(status.state).toBe('disabled');
    expect(status.blocking[0]).toContain('older than the allowed window');
    expect(status.missing).toContain('health-check');
  });

  it('rejects an unparseable health timestamp instead of trusting it', () => {
    const status = integrationGovernance(
      documentOf('engine-a'),
      { ...COMPLETE, healthCheckedAt: 'yesterday' },
      { now: NOW },
    );

    expect(status.state).toBe('disabled');
  });

  it('reports the missing §62 test kinds one by one', () => {
    const status = integrationGovernance(
      documentOf('engine-a'),
      { ...COMPLETE, tests: ['unit', 'integration'] },
      { now: NOW },
    );

    expect(status.missingTests).toEqual([
      'adapter',
      'health',
      'timeout',
      'failure',
      'normalization',
      'duplicates',
    ]);
    expect(status.missing).toContain('tests');
  });

  it('blocks an engine this host cannot run, however complete its ledger is', () => {
    const status = integrationGovernance(documentOf('engine-exotic'), COMPLETE, { now: NOW });

    expect(status.state).toBe('disabled');
    expect(status.missing).toContain('compatibility');
    expect(status.blocking[0]).toContain('is not runnable here');
  });

  it('honours a custom health window', () => {
    const status = integrationGovernance(
      documentOf('engine-a'),
      { ...COMPLETE, healthCheckedAt: '2026-08-30T00:00:00Z' },
      { now: NOW, healthMaxAgeDays: 1 },
    );

    expect(status.state).toBe('enabled');
  });
});

describe('governanceReport (§58)', () => {
  it('separates enabled engines from debt and names the unowned ones', () => {
    const report = governanceReport(registry, { 'engine-a': COMPLETE }, { now: NOW });

    expect(report.enabled).toEqual(['engine-a']);
    expect(report.disabled).toEqual(['engine-exotic', 'manual-entry']);
    expect(report.debt.map((entry) => entry.engine)).toEqual(['engine-exotic', 'manual-entry']);
    expect(report.unowned).toEqual(['engine-exotic', 'manual-entry']);
    expect([...enabledEngines(report)]).toEqual(['engine-a']);
  });

  it('defaults to everything disabled when the ledger is empty (§61)', () => {
    const report = governanceReport(registry, {}, { now: NOW });

    expect(report.enabled).toEqual([]);
    expect(report.integrations).toHaveLength(3);
  });
});
