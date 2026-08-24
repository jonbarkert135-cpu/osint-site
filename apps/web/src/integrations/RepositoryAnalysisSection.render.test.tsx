/**
 * The container's behaviour around a run: it asks for an analysis, polls only while one is in
 * flight, stops when a newer head arrives, and never leaves a spinner running forever (U5).
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RepositoryAnalysis } from '@nexus/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useQuery = vi.fn<(...args: never[]) => unknown>();
const useMutation = vi.fn<(...args: never[]) => unknown>();
vi.mock('../lib/trpc.tsx', () => ({
  trpc: {
    repositories: {
      latestAnalysis: { useQuery: (...a: never[]) => useQuery(...a) },
      analyze: { useMutation: (...a: never[]) => useMutation(...a) },
    },
  },
}));

const { ANALYSIS_POLL_INTERVAL_MS, ANALYSIS_POLL_TIMEOUT_MS, RepositoryAnalysisSection } =
  await import('./RepositoryAnalysisSection.tsx');

const url = 'https://github.com/smicallef/spiderfoot';

const analysis: RepositoryAnalysis = {
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
};

const mutate = vi.fn();
const refetch = vi.fn();
let handlers: { onSuccess?: () => void; onError?: (e: { message: string }) => void } = {};

function setQuery(data: unknown, error: unknown = null) {
  useQuery.mockImplementation((_input: unknown, options: { refetchInterval: number | false }) => {
    lastOptions = options;
    return { data, error, refetch };
  });
}

let lastOptions: { refetchInterval: number | false } = { refetchInterval: false };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mutate.mockClear();
  refetch.mockClear();
  handlers = {};
  useMutation.mockImplementation((opts: typeof handlers) => {
    handlers = opts;
    return { mutate };
  });
  setQuery(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RepositoryAnalysisSection', () => {
  it('renders nothing for a URL that is not a repository', () => {
    const { container } = render(
      <RepositoryAnalysisSection repositoryUrl="https://github.com/x" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not poll while idle and starts an analysis on click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RepositoryAnalysisSection repositoryUrl={url} />);

    expect(lastOptions.refetchInterval).toBe(false);
    await user.click(screen.getByTestId('analysis-run'));
    expect(mutate).toHaveBeenCalledWith({
      repoKey: 'github.com/smicallef/spiderfoot',
      force: false,
    });
  });

  it('polls while the run is in flight and stops on a newer head', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(<RepositoryAnalysisSection repositoryUrl={url} />);

    await user.click(screen.getByTestId('analysis-run'));
    act(() => {
      handlers.onSuccess?.();
    });
    await waitFor(() => {
      expect(lastOptions.refetchInterval).toBe(ANALYSIS_POLL_INTERVAL_MS);
    });

    setQuery({ analysis, proposal: null });
    view.rerender(<RepositoryAnalysisSection repositoryUrl={url} />);
    await waitFor(() => {
      expect(lastOptions.refetchInterval).toBe(false);
    });
    expect(screen.getByTestId('analysis-run')).toHaveTextContent('Re-analyze');
  });

  it('gives up with an explanation when nothing comes back in time', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RepositoryAnalysisSection repositoryUrl={url} />);

    await user.click(screen.getByTestId('analysis-run'));
    act(() => {
      handlers.onSuccess?.();
    });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_POLL_TIMEOUT_MS + 1_000);
    });

    await waitFor(() => {
      expect(screen.getByText(/did not come back in time/i)).toBeInTheDocument();
    });
    expect(lastOptions.refetchInterval).toBe(false);
  });

  it('surfaces a refused request and retries the read', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RepositoryAnalysisSection repositoryUrl={url} />);

    await user.click(screen.getByTestId('analysis-run'));
    act(() => {
      handlers.onError?.({ message: 'This repository cannot be analyzed.' });
    });

    await waitFor(() => {
      expect(screen.getByText('This repository cannot be analyzed.')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('analysis-retry'));
    expect(refetch).toHaveBeenCalled();
  });

  it('forces a re-analysis when an older result is already on screen', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setQuery({ analysis, proposal: null });
    render(<RepositoryAnalysisSection repositoryUrl={url} />);

    await user.click(screen.getByTestId('analysis-run'));
    expect(mutate).toHaveBeenCalledWith({
      repoKey: 'github.com/smicallef/spiderfoot',
      force: true,
    });
  });
});
