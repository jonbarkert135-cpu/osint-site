import { describe, expect, it } from 'vitest';

import { assessDeprecation, deprecationReport } from '../src/deprecation.ts';
import {
  buildRegistry,
  makeEngine,
  makeProvider,
  makeTransform,
  MANUAL_ENGINE,
  MANUAL_PROVIDER,
} from './fixtures.ts';

const NOW = new Date('2026-08-31T00:00:00Z');

/** Old engine + a maintained alternative for the same capability. */
const registry = buildRegistry({
  transforms: [
    makeTransform({ id: 'domain-to-ip', capability: 'dns', engines: ['engine-old', 'engine-new'] }),
  ],
  engines: [
    makeEngine({
      id: 'engine-old',
      capability: 'dns',
      provider: 'provider-keyed',
      status: 'beta',
      runtime: {
        runtime: 'cli',
        deployment: 'native',
        requirements: { memoryMb: 256, cpu: 1, persistent: false },
        hostCompatible: true,
      },
    }),
    makeEngine({
      id: 'engine-new',
      capability: 'dns',
      provider: 'provider-free',
      runtime: {
        runtime: 'http',
        deployment: 'native',
        requirements: { memoryMb: 64, cpu: 1, persistent: false },
        hostCompatible: true,
      },
    }),
    MANUAL_ENGINE,
  ],
  providers: [
    makeProvider({ id: 'provider-keyed', credentials: 'required' }),
    makeProvider({ id: 'provider-free' }),
    MANUAL_PROVIDER,
  ],
});

const engine = (id: string) => {
  const found = registry.engine(id);
  expect(found).toBeDefined();
  return found!;
};

describe('assessDeprecation (§57)', () => {
  it('says unverified rather than active when no signals were collected', () => {
    const assessment = assessDeprecation(registry, engine('engine-new'), {}, NOW);

    expect(assessment.verdict).toBe('unverified');
    expect(assessment.evidence).toEqual([
      'no upstream signals have been collected for this engine',
    ]);
    expect(assessment.warning).toBe('');
  });

  it('treats an archived upstream as deprecated and names a replacement with reasons', () => {
    const assessment = assessDeprecation(
      registry,
      engine('engine-old'),
      { archived: true, lastReleaseAt: '2022-01-01' },
      NOW,
    );

    expect(assessment.verdict).toBe('deprecated');
    expect(assessment.evidence[0]).toBe('the upstream repository is archived');
    expect(assessment.replacement?.engine).toBe('engine-new');
    expect(assessment.replacement?.reasons).toContain('Active maintenance');
    expect(assessment.replacement?.reasons).toContain('Better API');
    expect(assessment.warning).toContain('Engine engine-old appears to be deprecated.');
    expect(assessment.warning).toContain('Replacement candidate:\nengine-new');
    expect(assessment.warning).toContain('Reason:');
  });

  it('deprecates an engine that has not shipped in three years', () => {
    const assessment = assessDeprecation(
      registry,
      engine('engine-old'),
      { lastReleaseAt: '2022-06-01' },
      NOW,
    );

    expect(assessment.verdict).toBe('deprecated');
    expect(assessment.evidence[0]).toContain('no release for');
  });

  it('suspects, rather than condemns, an engine with soft signals only', () => {
    const assessment = assessDeprecation(
      registry,
      engine('engine-old'),
      { lastReleaseAt: '2024-06-01', failureRate: 0.7, openAdvisories: 2, latestVersion: '2.0.0' },
      NOW,
    );

    expect(assessment.verdict).toBe('suspected');
    expect(assessment.evidence).toHaveLength(4);
    expect(assessment.evidence.some((line) => line.includes('70% of observed runs failed'))).toBe(
      true,
    );
  });

  it('offers no replacement when nothing in the registry is demonstrably better', () => {
    const assessment = assessDeprecation(registry, engine('engine-new'), { archived: true }, NOW);

    expect(assessment.verdict).toBe('deprecated');
    expect(assessment.replacement).toBeUndefined();
    expect(assessment.warning).toContain('none in this registry');
  });

  it('ignores an unparseable release date instead of guessing', () => {
    const assessment = assessDeprecation(
      registry,
      engine('engine-new'),
      { lastReleaseAt: 'soon' },
      NOW,
    );

    expect(assessment.verdict).toBe('active');
    expect(assessment.evidence).toEqual([]);
  });

  it('reports a deprecated manifest even with no signals at all', () => {
    const deprecated = makeEngine({
      id: 'engine-dead',
      capability: 'dns',
      provider: 'provider-free',
      status: 'deprecated',
    });

    const assessment = assessDeprecation(registry, deprecated, {}, NOW);

    expect(assessment.verdict).toBe('deprecated');
    expect(assessment.evidence).toContain('the manifest declares status "deprecated"');
  });
});

describe('deprecationReport (§57)', () => {
  it('lists every engine, worst verdict first', () => {
    const report = deprecationReport(registry, { 'engine-old': { archived: true } }, NOW);

    expect(report.map((entry) => [entry.engine, entry.verdict])).toEqual([
      ['engine-old', 'deprecated'],
      ['engine-new', 'unverified'],
      ['manual-entry', 'unverified'],
    ]);
  });
});
