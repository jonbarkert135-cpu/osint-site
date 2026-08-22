/**
 * Unit tests for the integration surface's components (P9 §11).
 *
 * They assert the parts of §6/§7 that are contract rather than styling: the picker never hides an
 * affordance, consent gates the run, the run panel prints the canonical error copy verbatim,
 * proposals carry provenance and never default-select a conflict, and every empty state explains
 * itself instead of saying "nothing here".
 */

import { payloadFor } from '@nexus/integrations/errors';
import type { ImportProposal } from '@nexus/integrations';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApplyToast } from './ApplyToast.tsx';
import { ConsentDialog, dataLeavingCopy } from './ConsentDialog.tsx';
import { IntegrationPicker, accepts } from './IntegrationPicker.tsx';
import { ProposalReview, defaultSelection, itemLabel } from './ProposalReview.tsx';
import { RunHistory, previousRunOf } from './RunHistory.tsx';
import { RunPanel, phaseLabel } from './RunPanel.tsx';
import type { IntegrationSummary, RunRow } from './types.ts';

const tool: IntegrationSummary = {
  id: 'tool-a',
  name: 'URL expander',
  description: 'Follows redirects on a short link.',
  executionKind: 'builtin',
  acceptsKinds: ['url'],
  inputs: [{ name: 'url', fromSelection: true, required: true }],
  consent: { required: true, scopeText: 'I am authorized to look this target up.' },
  risk: { label: 'low', reasons: ['Contacts the URL you provide.'] },
};

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  integrationId: 'tool-a',
  boardId: 'board-1',
  actorUserId: 'user-1',
  status: 'succeeded',
  durationMs: 120,
  proposalId: 'prop-1',
  createdAt: '2025-01-01T00:00:00.000Z',
  ...over,
});

describe('IntegrationPicker', () => {
  it('lists the tools that accept the selection', async () => {
    const onPick = vi.fn();
    render(<IntegrationPicker integrations={[tool]} selectionKinds={['url']} onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: /URL expander/ }));
    expect(onPick).toHaveBeenCalledWith(tool);
  });

  it('shows a disabled row rather than hiding the menu when nothing accepts the selection', () => {
    render(
      <IntegrationPicker integrations={[tool]} selectionKinds={['person']} onPick={vi.fn()} />,
    );
    expect(screen.getByTestId('picker-none-accepts')).toBeDisabled();
  });

  it('explains the empty state instead of rendering nothing', () => {
    render(<IntegrationPicker integrations={[]} selectionKinds={[]} onPick={vi.fn()} />);
    expect(screen.getByTestId('picker-empty')).toHaveTextContent(/always available/);
  });

  it('accepts anything when a manifest sources no field from the selection', () => {
    expect(accepts({ ...tool, acceptsKinds: [] }, [])).toBe(true);
  });

  it('offers "see all tools" when the caller supplies the route', async () => {
    const onSeeAll = vi.fn();
    render(
      <IntegrationPicker
        integrations={[tool]}
        selectionKinds={['url']}
        onPick={vi.fn()}
        onSeeAll={onSeeAll}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'See all tools' }));
    expect(onSeeAll).toHaveBeenCalled();
  });
});

describe('ConsentDialog', () => {
  const open = (extra: Partial<Parameters<typeof ConsentDialog>[0]> = {}) =>
    render(
      <ConsentDialog
        open
        integration={tool}
        targets={[{ kind: 'url', value: 'https://t.co/x' }]}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        {...extra}
      />,
    );

  it('keeps Run disabled until the authorization box is ticked', async () => {
    const onConfirm = vi.fn();
    open({ onConfirm });
    const button = screen.getByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith(tool);
  });

  it('names the target, the risk reasons and the manifest wording verbatim', () => {
    open();
    expect(screen.getByTestId('consent-targets')).toHaveTextContent('https://t.co/x');
    expect(screen.getByTestId('consent-risks')).toHaveTextContent('Contacts the URL you provide.');
    expect(screen.getByText(tool.consent.scopeText)).toBeInTheDocument();
  });

  it('says nothing leaves the device for a builtin, and the truth otherwise', () => {
    expect(dataLeavingCopy(tool)).toMatch(/Nothing leaves/);
    expect(dataLeavingCopy({ ...tool, executionKind: 'container' })).toMatch(/third-party/);
  });

  it('reopens with the expiry notice and renders nothing without an integration', () => {
    open({ notice: 'Your authorization expired.' });
    expect(screen.getByTestId('consent-notice')).toBeInTheDocument();
    const { container } = render(
      <ConsentDialog open integration={null} targets={[]} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('cancels through the footer button', async () => {
    const onCancel = vi.fn();
    open({ onCancel });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('RunPanel', () => {
  const base = {
    integrationName: 'URL expander',
    runId: 'run-1',
    elapsedMs: 4000,
    log: [],
  };

  it('shows the phase, never a percentage, while the run is active', () => {
    render(<RunPanel {...base} state="running" onCancel={vi.fn()} />);
    expect(screen.getByTestId('run-phase')).toHaveTextContent('running…');
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('4s');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('labels the phase from the last log line once there is one', () => {
    expect(
      phaseLabel('running', [{ seq: 1, at: 'now', level: 'info', phase: 'parsing', message: 'x' }]),
    ).toBe('parsing…');
    expect(phaseLabel('succeeded', [])).toBe('succeeded');
  });

  it('prints the canonical error copy verbatim', () => {
    render(<RunPanel {...base} state="failed" errorCode="TIMEOUT" onRetry={vi.fn()} />);
    const copy = payloadFor('TIMEOUT', { runId: 'run-1' });
    expect(screen.getByText(copy.what)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(copy.action.slice(0, 20)))).toBeInTheDocument();
  });

  it('links back into the tool when the run has a page there, and never otherwise', () => {
    const { rerender } = render(
      <RunPanel
        {...base}
        state="succeeded"
        externalUrl="https://sf.example.test/scaninfo?id=abcd"
      />,
    );
    const link = screen.getByTestId('run-external-link');
    expect(link).toHaveAttribute('href', 'https://sf.example.test/scaninfo?id=abcd');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    rerender(<RunPanel {...base} state="succeeded" />);
    expect(screen.queryByTestId('run-external-link')).not.toBeInTheDocument();
  });

  it('treats a run with no results as an explained empty state, not an error', () => {
    render(<RunPanel {...base} state="succeeded" itemsFound={0} />);
    expect(screen.getByText('No results found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review results' })).not.toBeInTheDocument();
  });

  it('banners the partial and cancelled states and offers review on success', async () => {
    const onReview = vi.fn();
    const { rerender } = render(<RunPanel {...base} state="partial" onReview={onReview} />);
    expect(screen.getByText('Run ended early')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review results' }));
    expect(onReview).toHaveBeenCalled();
    rerender(<RunPanel {...base} state="cancelled" />);
    expect(screen.getByText('Run cancelled')).toBeInTheDocument();
  });

  it('renders the log lines it was given', () => {
    render(
      <RunPanel
        {...base}
        state="running"
        log={[{ seq: 1, at: 'now', level: 'info', phase: 'starting', message: 'pulling' }]}
      />,
    );
    expect(screen.getByTestId('run-log')).toHaveTextContent('pulling');
  });
});

const provenance = {
  source: 'x',
  tool: 'tool-a',
  toolVersion: '1.0.0',
  runId: 'run-1',
  observedAt: '2025-01-01T00:00:00.000Z',
  importedAt: '2025-01-01T00:00:00.000Z',
  confidence: 0.9,
  actorUserId: 'user-1',
};

const proposal = (items: ImportProposal['items']): ImportProposal => ({
  id: 'prop-1',
  runId: 'run-1',
  integrationId: 'tool-a',
  boardId: 'board-1',
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: { newNodes: 1, newEdges: 0, enriched: 0, conflicts: 0, skippedDuplicates: 0 },
  items,
  issues: [],
  expiresAt: '2035-01-01T00:00:00.000Z',
});

const nodeItem = {
  id: 'item-1',
  kind: 'new_node' as const,
  selectedByDefault: true,
  confidence: 0.9,
  explain: 'Seen in the redirect chain.',
  node: {
    tempId: 't1',
    kind: 'url' as const,
    nodeType: 'url',
    tags: [],
    title: 'https://example.com',
    props: {},
    identityKey: 'url:example.com',
    provenance,
  },
};

const conflictItem = {
  id: 'item-2',
  kind: 'conflict' as const,
  selectedByDefault: false,
  confidence: 0.5,
  explain: 'Two sources disagree.',
  targetNodeId: 'node-1',
  field: 'url',
  currentValue: 'a',
  incomingValue: 'b',
  incomingProvenance: provenance,
  resolution: 'keep' as const,
};

describe('ProposalReview', () => {
  it('groups by kind, chips provenance and counts the selection', async () => {
    const onApply = vi.fn();
    render(
      <ProposalReview
        proposal={proposal([nodeItem, conflictItem])}
        integrationName="URL expander"
        onApply={onApply}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId('section-new_node')).toBeInTheDocument();
    expect(screen.getAllByTestId('provenance-chip')[0]).toHaveTextContent(/run run-1 · high/);
    expect(screen.getByTestId('proposal-footer')).toHaveTextContent('Applying 1 of 2 items');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(['item-1']);
  });

  it('never selects a conflict by default', () => {
    expect(defaultSelection(proposal([nodeItem, conflictItem]))).toEqual(['item-1']);
  });

  it('selects all and none', async () => {
    render(
      <ProposalReview
        proposal={proposal([nodeItem, conflictItem])}
        integrationName="URL expander"
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByTestId('proposal-footer')).toHaveTextContent('Applying 2 of 2');
    await userEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('explains an empty result set rather than showing an empty list', async () => {
    const onDiscard = vi.fn();
    render(
      <ProposalReview
        proposal={proposal([])}
        integrationName="URL expander"
        onApply={vi.fn()}
        onDiscard={onDiscard}
      />,
    );
    expect(screen.getByTestId('proposal-empty')).toHaveTextContent(/already matches/);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it('labels every item kind', () => {
    expect(itemLabel(nodeItem)).toBe('https://example.com');
    expect(itemLabel(conflictItem)).toContain('url:');
    expect(
      itemLabel({
        id: 'i3',
        kind: 'enrich',
        selectedByDefault: true,
        confidence: 0.9,
        explain: '',
        targetNodeId: 'n1',
        fieldPatches: [{ path: 'url', op: 'set', value: 'https://x' }],
        provenance,
      }),
    ).toContain('url: → https://x');
    expect(
      itemLabel({
        id: 'i4',
        kind: 'new_edge',
        selectedByDefault: true,
        confidence: 0.9,
        explain: '',
        edge: {
          tempId: 'e1',
          fromRef: { kind: 'existing' as const, nodeId: 'a' },
          toRef: { kind: 'temp' as const, tempId: 'b' },
          edgeType: 'redirects_to',
          props: {},
          provenance,
        },
      }),
    ).toBe('a —[redirects_to]→ b');
  });
});

describe('RunHistory', () => {
  it('lists newest first with a log, re-run and diff action per row', async () => {
    const onRerun = vi.fn();
    const onDiff = vi.fn();
    render(
      <RunHistory
        runs={[run(), run({ id: 'run-0', createdAt: '2024-12-31T00:00:00.000Z' })]}
        integrations={[tool]}
        onViewLog={vi.fn()}
        onRerun={onRerun}
        onDiff={onDiff}
      />,
    );
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Re-run' })[0]!);
    expect(onRerun).toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Diff with previous' })[0]!);
    expect(onDiff).toHaveBeenCalled();
  });

  it('disables the diff on the first run of a tool', () => {
    render(
      <RunHistory
        runs={[run()]}
        integrations={[tool]}
        onViewLog={vi.fn()}
        onRerun={vi.fn()}
        onDiff={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Diff with previous' })).toBeDisabled();
    expect(previousRunOf([run()], run())).toBeUndefined();
  });

  it('filters by status and by integration', async () => {
    render(
      <RunHistory
        runs={[run(), run({ id: 'run-2', status: 'failed' })]}
        integrations={[tool]}
        onViewLog={vi.fn()}
        onRerun={vi.fn()}
        onDiff={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');
    expect(screen.getAllByTestId('run-row')).toHaveLength(1);
    await userEvent.selectOptions(screen.getByLabelText('Integration'), 'tool-a');
    expect(screen.getAllByTestId('run-row')).toHaveLength(1);
  });

  it('says what to do when a board has no runs yet', () => {
    const onViewLog = vi.fn();
    render(
      <RunHistory
        runs={[]}
        integrations={[tool]}
        onViewLog={onViewLog}
        onRerun={vi.fn()}
        onDiff={vi.fn()}
      />,
    );
    expect(screen.getByTestId('history-empty')).toHaveTextContent(/Run integration/);
    expect(onViewLog).not.toHaveBeenCalled();
  });
});

describe('ApplyToast', () => {
  it('reports the import and offers undo', async () => {
    const onUndo = vi.fn();
    render(
      <ApplyToast
        result={{ nodes: 2, edges: 1, integrationName: 'URL expander' }}
        onUndo={onUndo}
        onViewRun={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('apply-toast')).toHaveTextContent(
      'Imported 2 nodes and 1 edges from URL expander',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalled();
  });

  it('dismisses itself after the undo window, and renders nothing without a result', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { container } = render(
      <ApplyToast
        result={{ nodes: 1, edges: 0, integrationName: 'URL expander' }}
        onUndo={vi.fn()}
        onViewRun={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).toHaveBeenCalled();
    vi.useRealTimers();
    expect(container).not.toBeEmptyDOMElement();
    const empty = render(
      <ApplyToast result={null} onUndo={vi.fn()} onViewRun={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('links back to the run that produced the import', async () => {
    const onViewRun = vi.fn();
    render(
      <ApplyToast
        result={{ nodes: 1, edges: 0, integrationName: 'URL expander' }}
        onUndo={vi.fn()}
        onViewRun={onViewRun}
        onDismiss={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'View run' }));
    expect(onViewRun).toHaveBeenCalled();
  });
});
