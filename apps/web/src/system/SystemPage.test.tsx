/** System Health and Engine Registry (Part 2 §27, §28, §30). */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '@nexus/transforms';

import SystemPage from './SystemPage.tsx';
import { recordRuns, resetRuntime, runtimeSnapshot } from './runtimeStore.ts';

const run = (engine: string, status: RunRecord['status'], id: string): RunRecord =>
  ({
    id,
    transform: 'demo',
    transformVersion: '1.0.0',
    input: { kind: 'domain', value: 'example.com' },
    engine,
    engineVersion: '1.0.0',
    provider: 'local-runtime',
    mode: 'zero-credential',
    startedAt: 0,
    finishedAt: 120,
    status,
    results: [],
    errors: [],
  }) satisfies RunRecord;

const firstEngineId = (): string => {
  const table = screen.getByTestId('system-health');
  const row = within(table).getAllByRole('row')[1];
  return row?.getAttribute('data-testid')?.replace(/^health-/, '') ?? '';
};

describe('SystemPage', () => {
  beforeEach(() => {
    resetRuntime();
  });

  it('lists every installed engine with an honest unknown status', () => {
    render(<SystemPage />);
    const table = screen.getByTestId('system-health');
    // header + one row per engine
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    expect(within(table).getAllByText('Not run yet').length).toBeGreaterThan(0);
    expect(screen.getByTestId('system-budget')).toHaveTextContent('run slots');
  });

  it('turns a completed run into an Online row with a response time', () => {
    render(<SystemPage />);
    const engine = firstEngineId();
    act(() => recordRuns([run(engine, 'completed', 'r1')]));

    const row = screen.getByTestId(`health-${engine}`);
    expect(row).toHaveTextContent('Online');
    expect(row).toHaveTextContent('120 ms');
  });

  it('shows failures without hiding the healthy services (§29)', () => {
    render(<SystemPage />);
    const engine = firstEngineId();
    act(() => recordRuns([run(engine, 'failed', 'r2'), run(engine, 'completed', 'r3')]));

    const row = screen.getByTestId(`health-${engine}`);
    expect(row).toHaveTextContent('Degraded');
    expect(row).toHaveTextContent('1 / 2');
    expect(screen.getAllByText('Not run yet').length).toBeGreaterThan(0);
  });

  it('records a retry request from the row menu (§30)', async () => {
    const user = userEvent.setup();
    render(<SystemPage />);
    const engine = firstEngineId();
    act(() => recordRuns([run(engine, 'failed', 'r4')]));

    await user.click(screen.getByLabelText(`${engine} actions`));
    await user.click(await screen.findByText('Retry failed only'));

    expect(screen.getByTestId('system-action-note')).toHaveTextContent('retry-failed');
    expect(runtimeSnapshot().retries[0]?.engine).toBe(engine);
  });

  it('disables an engine from the same menu', async () => {
    const user = userEvent.setup();
    render(<SystemPage />);
    const engine = firstEngineId();

    await user.click(screen.getByLabelText(`${engine} actions`));
    await user.click(await screen.findByText('Disable'));

    expect(screen.getByTestId(`health-${engine}`)).toHaveTextContent('Disabled');
  });

  it('switches to the engine registry and shows the passport of each engine (§28)', async () => {
    const user = userEvent.setup();
    render(<SystemPage />);
    await user.click(screen.getByRole('tab', { name: 'Engines' }));

    const list = screen.getByTestId('system-engines');
    const cards = within(list).getAllByRole('listitem');
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[0];
    expect(card).toBeDefined();
    expect(card).toHaveTextContent('Category');
    expect(card).toHaveTextContent('Inputs');
    expect(card).toHaveTextContent('Outputs');
    expect(card).toHaveTextContent('Permissions');
    expect(card).toHaveTextContent('Resources');
    expect(card).toHaveTextContent('Compatibility');
    expect(card).toHaveTextContent(/v\d+\.\d+\.\d+/);
  });

  it('renders the compatibility matrix split into the four deployment classes (§34)', async () => {
    const user = userEvent.setup();
    render(<SystemPage />);
    await user.click(screen.getByRole('tab', { name: 'Runtime' }));

    const panel = screen.getByTestId('system-compat');
    expect(panel).toBeInTheDocument();
    for (const kind of ['native', 'containerized', 'external', 'unsupported']) {
      expect(screen.getByTestId(`compat-${kind}`)).toBeInTheDocument();
    }
  });

  it('shows sherlock as a containerized python engine with its footprint', async () => {
    const user = userEvent.setup();
    render(<SystemPage />);
    await user.click(screen.getByRole('tab', { name: 'Runtime' }));

    const row = screen.getByTestId('compat-row-sherlock');
    expect(row).toHaveTextContent('python');
    expect(row).toHaveTextContent('512 MB');
  });

  it('says None for a deployment class with no engines rather than hiding it (§35)', async () => {
    const user = userEvent.setup();
    render(<SystemPage />);
    await user.click(screen.getByRole('tab', { name: 'Runtime' }));

    // No engine in the shipped catalogue is external or unsupported today; the class still shows,
    // so the reader can see the answer is "none" rather than "not measured".
    expect(screen.getByTestId('compat-unsupported')).toHaveTextContent('None.');
  });
});
