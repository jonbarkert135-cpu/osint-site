/** The host ask (Part 2 §36, §37): it queues a plan, says so, and never claims more than that. */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
let handlers: {
  onSuccess?: (data: { runId: string }) => void;
  onError?: (cause: unknown) => void;
} = {};
let pending = false;

vi.mock('../lib/trpc.tsx', () => ({
  errorMessage: () => 'That request could not be queued.',
  trpc: {
    queries: {
      plan: {
        useMutation: (options: typeof handlers) => {
          handlers = options;
          return { mutate, isPending: pending };
        },
      },
    },
  },
}));

const { HostRunButton } = await import('./HostRunButton.tsx');

beforeEach(() => {
  vi.clearAllMocks();
  handlers = {};
  pending = false;
});

describe('HostRunButton', () => {
  it('queues the raw query, the mode and the granted permissions', async () => {
    render(<HostRunButton query="raven.io" mode="configured" permissions={['subprocess']} />);

    await userEvent.click(screen.getByTestId('ask-run-host'));

    expect(mutate).toHaveBeenCalledWith({
      query: 'raven.io',
      mode: 'configured',
      permissions: ['subprocess'],
    });
  });

  it('reports the run id the host will publish under, and only that', async () => {
    render(<HostRunButton query="raven.io" mode="zero-credential" />);

    await userEvent.click(screen.getByTestId('ask-run-host'));
    act(() => {
      handlers.onSuccess?.({ runId: 'run_1' });
    });

    expect(await screen.findByTestId('ask-host-queued')).toHaveTextContent('run run_1');
  });

  it('says what happened when the host refuses', async () => {
    render(<HostRunButton query="raven.io" mode="zero-credential" />);

    await userEvent.click(screen.getByTestId('ask-run-host'));
    act(() => {
      handlers.onError?.(new Error('nope'));
    });

    expect(await screen.findByTestId('ask-host-error')).toHaveTextContent('could not be queued');
    expect(screen.queryByTestId('ask-host-queued')).toBeNull();
  });

  it('is disabled on an empty query, while queueing, and when the caller says so', () => {
    const { rerender } = render(<HostRunButton query="   " mode="zero-credential" />);
    expect(screen.getByTestId('ask-run-host')).toBeDisabled();

    rerender(<HostRunButton query="raven.io" mode="zero-credential" disabled />);
    expect(screen.getByTestId('ask-run-host')).toBeDisabled();

    pending = true;
    rerender(<HostRunButton query="raven.io" mode="zero-credential" />);
    expect(screen.getByTestId('ask-run-host')).toHaveTextContent('Queueing');
    expect(screen.getByTestId('ask-run-host')).toBeDisabled();
  });
});
