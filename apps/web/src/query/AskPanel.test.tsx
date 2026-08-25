/**
 * The panel is the surface P17 was missing: one string in, a visible plan out, nothing executed.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import * as Y from 'yjs';

import { AskPanel } from './AskPanel.tsx';

describe('AskPanel', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<AskPanel open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('types the input and plans what would run for it', async () => {
    const user = userEvent.setup();
    render(<AskPanel open onClose={vi.fn()} />);

    await user.type(screen.getByTestId('ask-input'), 'example.com');

    const kinds = screen.getByTestId('ask-kinds');
    expect(kinds).toHaveTextContent('domain');
    expect(screen.getByRole('button', { name: 'domain' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ask-plan').querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('lets the analyst override the detected type', async () => {
    const user = userEvent.setup();
    render(<AskPanel open onClose={vi.fn()} />);

    await user.type(screen.getByTestId('ask-input'), 'raven.io');
    await user.click(screen.getByRole('button', { name: 'company' }));

    expect(screen.getByRole('button', { name: 'company' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('closes on request', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AskPanel open onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('runs the plan on request and proposes what it found instead of writing it', async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    const hostFetch = vi.fn(() => Promise.resolve({ status: 200, body: [] }));

    render(<AskPanel open onClose={vi.fn()} doc={doc} boardId="b1" hostFetch={hostFetch} />);
    await user.type(screen.getByTestId('ask-input'), 'example.com');
    await user.click(screen.getByTestId('ask-run'));

    // The run is over: steps are reported, and the board was not touched by the run itself (U7).
    expect(await screen.findByTestId('ask-run-steps')).toBeInTheDocument();
    expect(doc.getMap('nodes').size).toBe(0);
  });

  it('keeps the raw provider result one click away from every finding (Part 2 §18, §19)', async () => {
    const user = userEvent.setup();
    const hostFetch = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('type=A')
          ? {
              status: 200,
              body: {
                Answer: [{ name: 'example.com.', type: 1, TTL: 60, data: '93.184.216.34' }],
              },
            }
          : { status: 200, body: {} },
      ),
    );

    render(<AskPanel open onClose={vi.fn()} hostFetch={hostFetch} />);
    await user.type(screen.getByTestId('ask-input'), 'example.com');
    await user.click(screen.getByTestId('ask-run'));

    const dashboard = await screen.findByTestId('ask-dashboard');
    expect(dashboard).toHaveTextContent('93.184.216.34');
    expect(screen.getByTestId('ask-counters')).toHaveTextContent('Entities');
    expect(screen.getAllByRole('link', { name: 'Open source' })[0]).toHaveAttribute(
      'href',
      expect.stringContaining('dns.google'),
    );
    await user.click(screen.getAllByRole('button', { name: 'Expand' })[0] as HTMLElement);
    await user.click(screen.getByText('View raw result'));
    expect(dashboard).toHaveTextContent('93.184.216.34');
  });

  it('builds the graph from the results the analyst kept (Part 2 §22, §23)', async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    const hostFetch = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('type=A')
          ? {
              status: 200,
              body: {
                Answer: [{ name: 'example.com.', type: 1, TTL: 60, data: '93.184.216.34' }],
              },
            }
          : { status: 200, body: {} },
      ),
    );

    render(<AskPanel open onClose={vi.fn()} doc={doc} boardId="b1" hostFetch={hostFetch} />);
    await user.type(screen.getByTestId('ask-input'), 'example.com');
    await user.click(screen.getByTestId('ask-run'));

    await screen.findByTestId('ask-dashboard');
    // Dismissed results stay out of the graph: the card is the filter, the button is the commit.
    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0] as HTMLElement);
    expect(doc.getMap('nodes').size).toBe(0);

    await user.click(screen.getByTestId('ask-build-graph'));
    expect(await screen.findByTestId('ask-applied')).toBeInTheDocument();
  });
});
