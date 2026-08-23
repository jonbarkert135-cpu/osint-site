/**
 * The panel is the surface P17 was missing: one string in, a visible plan out, nothing executed.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
});
