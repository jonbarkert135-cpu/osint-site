/** Activity tab (Part 2 §54) on screen. */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ActivityLog } from './ActivityLog.tsx';
import { clearActivity, logActivity } from './activityLog.ts';

describe('ActivityLog', () => {
  beforeEach(() => {
    clearActivity();
  });

  it('says nothing has happened when the session is empty', () => {
    render(<ActivityLog />);

    expect(screen.getByTestId('activity-empty')).toBeInTheDocument();
  });

  it('shows the history newest first and filters it by kind', async () => {
    const user = userEvent.setup();
    logActivity('query', 'Plan started · 2 step(s)');
    logActivity('error', 'dns failed · timeout');
    render(<ActivityLog />);

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('dns failed');

    await user.click(screen.getByRole('button', { name: 'query' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('listitem')).toHaveTextContent('Plan started');

    await user.click(screen.getByRole('button', { name: 'export' }));
    expect(screen.getByTestId('activity-empty')).toBeInTheDocument();
  });

  it('clears the log on demand', async () => {
    const user = userEvent.setup();
    logActivity('import', 'Added 1 node(s)');
    render(<ActivityLog />);

    await user.click(screen.getByTestId('activity-clear'));
    expect(screen.getByTestId('activity-empty')).toBeInTheDocument();
  });
});
