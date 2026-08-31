/**
 * §45/§46: the pipeline is drawn, edited, saved and re-run for a new input — without touching the
 * board until the analyst accepts the proposal.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { WorkflowPanel } from './WorkflowPanel.tsx';

describe('WorkflowPanel', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<WorkflowPanel open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws the template pipeline as nodes and arrows', () => {
    render(<WorkflowPanel open onClose={vi.fn()} />);
    const canvas = screen.getByTestId('workflow-canvas');
    expect(screen.getByTestId('workflow-node-input')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-summary')).toHaveTextContent('ai-summary');
    // One arrow per dependency in the template.
    expect(canvas.querySelectorAll('line').length).toBeGreaterThan(4);
  });

  it('adds a step after the selected node and keeps the workflow valid', async () => {
    const user = userEvent.setup();
    render(<WorkflowPanel open onClose={vi.fn()} />);

    await user.click(screen.getByTestId('workflow-node-normalize'));
    await user.selectOptions(screen.getByTestId('workflow-add-step'), 'username-to-profiles');

    expect(screen.getByTestId('workflow-node-step-9')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-issues')).not.toBeInTheDocument();
  });

  it('refuses to save an edit that breaks the pipeline, and says why', async () => {
    const user = userEvent.setup();
    render(<WorkflowPanel open onClose={vi.fn()} />);

    // Removing the input node leaves a pipeline with nothing to start from.
    await user.click(screen.getByTestId('workflow-node-input'));
    await user.click(screen.getByTestId('workflow-remove'));
    await user.click(screen.getByTestId('workflow-save'));

    expect(screen.getByTestId('workflow-issues')).toHaveTextContent('input node');
    expect(screen.queryByTestId('workflow-status')).not.toBeInTheDocument();
  });

  it('saves a workflow so it can be picked again', async () => {
    const user = userEvent.setup();
    render(<WorkflowPanel open onClose={vi.fn()} />);

    await user.clear(screen.getByTestId('workflow-name'));
    await user.type(screen.getByTestId('workflow-name'), 'Nightly handle sweep');
    await user.click(screen.getByTestId('workflow-save'));

    expect(screen.getByTestId('workflow-status')).toHaveTextContent('Nightly handle sweep');
    expect(screen.getByTestId('workflow-picker')).toHaveTextContent('Nightly handle sweep');
    expect(globalThis.localStorage.getItem('raven.workflows.v1')).toContain('Nightly handle sweep');
  });

  it('refuses an input of the wrong kind instead of running the pipeline on it', async () => {
    const user = userEvent.setup();
    const hostFetch = vi.fn(() => Promise.resolve({ status: 200, body: [] }));
    render(<WorkflowPanel open onClose={vi.fn()} hostFetch={hostFetch} />);

    await user.type(screen.getByTestId('workflow-input'), 'example.com');
    await user.click(screen.getByTestId('workflow-run'));

    expect(screen.getByTestId('workflow-issues')).toHaveTextContent('expects a username');
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('re-runs the saved pipeline for a new username and proposes what it found', async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    const hostFetch = vi.fn(() => Promise.resolve({ status: 200, body: [] }));

    render(<WorkflowPanel open onClose={vi.fn()} doc={doc} boardId="b1" hostFetch={hostFetch} />);
    await user.type(screen.getByTestId('workflow-input'), 'octocat');
    await user.click(screen.getByTestId('workflow-run'));

    expect(await screen.findByTestId('workflow-run-steps')).toBeInTheDocument();
    expect(doc.getMap('nodes').size).toBe(0);
  });
});
