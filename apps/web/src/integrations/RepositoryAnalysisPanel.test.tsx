/**
 * The Repository Analysis surface prints measured facts, marks the proposal as a draft and, on
 * failure, offers Retry / Open Repository / Analyze Manually instead of a generic error.
 */

import type { RepositoryAnalysis } from '@nexus/domain';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  RepositoryAnalysisPanel,
  complexityOf,
  interfaceLabels,
} from './RepositoryAnalysisPanel.tsx';

const analysis = (over: Partial<RepositoryAnalysis> = {}): RepositoryAnalysis => ({
  repoKey: 'github.com/smicallef/spiderfoot',
  headSha: 'abc123',
  inputsDigest: 'digest',
  analyzerVersion: '1.0.0',
  producedAt: '2026-08-22T20:00:00.000Z',
  completeness: 1,
  skippedSteps: [],
  treeComplete: true,
  languages: [{ name: 'Python', bytes: 100, pct: 100, source: 'api' }],
  primaryLanguage: 'Python',
  layout: {
    kind: 'single-package',
    packages: [],
    docsDirs: [],
    testDirs: ['test'],
    ciProviders: ['github-actions'],
  },
  entryPoints: [
    {
      type: 'cli',
      name: 'sf.py',
      path: 'sf.py',
      runCommand: 'python sf.py',
      rule: 'root script',
      confidence: 'high',
    },
  ],
  build: { systems: ['pip'], commands: [], runtimeVersions: {} },
  dependencies: [
    {
      ecosystem: 'pypi',
      path: 'requirements.txt',
      packageName: null,
      direct: 12,
      dev: 0,
      truncated: 0,
      top: [],
      parseErrors: [],
    },
  ],
  surface: {
    cli: [{ command: 'sf.py', flags: ['-s'], source: 'readme' }],
    http: { spec: null, framework: 'flask', routesKnown: false, routes: [] },
    grpc: [],
    library: false,
    mcp: false,
  },
  container: {
    dockerfile: 'Dockerfile',
    compose: [],
    baseImages: ['python:3.11'],
    exposedPorts: [5001],
    publishedImageHints: [],
    rootUser: false,
  },
  health: {
    license: { spdxId: 'MIT', method: 'api', permissive: true },
    maintenanceScore: 80,
    maintenanceBand: 'healthy',
    signals: [],
    archived: false,
    contributorsCount: 40,
  },
  narrative: {
    summary: null,
    architecture: 'A modular scanner driven by plugin modules.',
    integrationNotes: null,
    model: 'test',
    generatedAt: '2026-08-22T20:00:00.000Z',
  },
  ...over,
});

const noop = () => {};

describe('RepositoryAnalysisPanel', () => {
  it('prints the measured facts of the analysis', () => {
    render(
      <RepositoryAnalysisPanel
        repoKey="github.com/smicallef/spiderfoot"
        repositoryUrl="https://github.com/smicallef/spiderfoot"
        analysis={analysis()}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );

    const facts = screen.getByTestId('analysis-facts');
    expect(facts).toHaveTextContent('Python');
    expect(facts).toHaveTextContent('single-package');
    expect(facts).toHaveTextContent('sf.py (cli)');
    expect(facts).toHaveTextContent('CLI (1), flask');
    expect(facts).toHaveTextContent('low');
    expect(facts).toHaveTextContent('12');
    expect(screen.getByTestId('analysis-narrative')).toHaveTextContent('plugin modules');
  });

  it('labels the proposal as a draft and shows its blockers', () => {
    render(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={analysis()}
        proposal={{
          executionMode: 'container',
          confidence: 0.62,
          blockers: ['license'],
          adapter: 'container adapter',
          nodeKinds: ['domain', 'email'],
          rationale: 'Containerised CLI with a JSON output flag.',
        }}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );

    const proposal = screen.getByTestId('analysis-proposal');
    expect(proposal).toHaveTextContent('needs review');
    expect(proposal).toHaveTextContent('container adapter');
    expect(proposal).toHaveTextContent('domain, email');
    expect(proposal).toHaveTextContent('62%');
    expect(proposal).toHaveTextContent('license');
  });

  it('offers retry, open repository and manual analysis when the run failed', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onAnalyzeManually = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={null}
        error={{ title: 'Analysis failed', detail: 'GitHub rate limit reached.' }}
        onRetry={onRetry}
        onAnalyzeManually={onAnalyzeManually}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('rate limit');
    await user.click(screen.getByTestId('analysis-retry'));
    await user.click(screen.getByTestId('analysis-manual'));
    await user.click(screen.getAllByTestId('analysis-open-repository')[1] as HTMLElement);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAnalyzeManually).toHaveBeenCalledTimes(1);
    expect(open.mock.lastCall?.[0]).toBe('https://example.com/r');
    open.mockRestore();
  });

  it('offers one analyze control, and disables it while a run is in flight', async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    const { rerender } = render(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={null}
        onAnalyze={onAnalyze}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );

    const button = screen.getByTestId('analysis-run');
    expect(button).toHaveTextContent('Analyze Repository');
    await user.click(button);
    expect(onAnalyze).toHaveBeenCalledTimes(1);

    rerender(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={null}
        analyzing
        onAnalyze={onAnalyze}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );
    expect(screen.getByTestId('analysis-run')).toBeDisabled();
    expect(screen.getByTestId('analysis-running')).toHaveTextContent('Analyzing this repository');
    // The empty-state paragraph would contradict the running notice, so it steps aside.
    expect(screen.queryByTestId('analysis-empty')).toBeNull();
  });

  it('offers a re-analysis once an analysis exists, and hides the control from a viewer', () => {
    const { rerender } = render(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={analysis()}
        onAnalyze={noop}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );
    expect(screen.getByTestId('analysis-run')).toHaveTextContent('Re-analyze');

    rerender(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={analysis()}
        onAnalyze={null}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );
    expect(screen.queryByTestId('analysis-run')).toBeNull();
  });

  it('explains the empty state instead of rendering an empty panel', () => {
    render(
      <RepositoryAnalysisPanel
        repoKey="r"
        repositoryUrl="https://example.com/r"
        analysis={null}
        onRetry={noop}
        onAnalyzeManually={noop}
      />,
    );
    expect(screen.getByTestId('analysis-empty')).toHaveTextContent('has not been analyzed yet');
  });

  it('rates integration complexity from the measured facts', () => {
    expect(complexityOf(analysis())).toBe('low');
    expect(
      complexityOf(
        analysis({
          entryPoints: [],
          container: {
            dockerfile: null,
            compose: [],
            baseImages: [],
            exposedPorts: [],
            publishedImageHints: [],
            rootUser: null,
          },
          health: { ...analysis().health, maintenanceBand: 'unmaintained' },
        }),
      ),
    ).toBe('high');
    expect(
      interfaceLabels(analysis({ surface: { ...analysis().surface, library: true } })),
    ).toContain('Library');
  });
});
