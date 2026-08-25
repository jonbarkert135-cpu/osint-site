/** The console is the anti-black-box surface (§24): foldable, readable, and never a control. */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RunConsole } from './RunConsole.tsx';

const lines = [
  { seq: 1, level: 'info' as const, text: 'run domain.certificates via ct-log-search on domain a' },
  { seq: 2, level: 'good' as const, text: 'found host a.example.com · 0.80 · domain.certificates' },
];

describe('RunConsole', () => {
  it('stays folded until the handle is pulled up', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<RunConsole lines={lines} open={false} onToggle={onToggle} />);

    const handle = screen.getByTestId('ask-console-toggle');
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('log', { hidden: true })).not.toBeVisible();

    await user.click(handle);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows every line of the run when open', () => {
    render(<RunConsole lines={lines} open onToggle={vi.fn()} />);

    const log = screen.getByRole('log');
    expect(log).toBeVisible();
    expect(log).toHaveTextContent('run domain.certificates via ct-log-search on domain a');
    expect(log).toHaveTextContent('found host a.example.com');
  });

  it('says so when nothing has run yet', () => {
    render(<RunConsole lines={[]} open onToggle={vi.fn()} />);
    expect(screen.getByRole('log')).toHaveTextContent('Nothing has run yet.');
  });

  it('reports a live run on the handle', () => {
    render(<RunConsole lines={lines} open={false} onToggle={vi.fn()} running />);
    expect(screen.getByTestId('ask-console-toggle')).toHaveTextContent('running');
  });
});
