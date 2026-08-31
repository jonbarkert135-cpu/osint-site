/**
 * "Run on the host" (Part 2 §36, §37).
 *
 * The tab runs a plan itself — that is the point of a local-first app (N2). What it cannot do is
 * run a containerized engine or a crawl longer than the laptop's patience, and until now nothing
 * asked the host for one. This button is that ask: it enqueues `query.plan` and reports the run id
 * the runner will publish progress under. It never claims the run finished, because it did not:
 * queued is the honest word for what happened here.
 *
 * Kept as its own component so a deployment without a host (local mode, no API) simply does not
 * mount it, and so the panel around it stays testable without a tRPC provider.
 */

import { Button } from '@nexus/ui';
import { useState } from 'react';

import { errorMessage } from '../lib/trpc.tsx';
import { trpc } from '../lib/trpc.tsx';

export interface HostRunButtonProps {
  /** The raw query, exactly as typed: the runner plans it, the tab does not send a plan. */
  query: string;
  mode: 'strict-local' | 'zero-credential' | 'free-tier' | 'configured' | 'maximum-coverage';
  permissions?: readonly ('network' | 'filesystem' | 'subprocess' | 'credentials' | 'browser')[];
  disabled?: boolean;
}

export function HostRunButton({ query, mode, permissions, disabled }: HostRunButtonProps) {
  const [queuedRunId, setQueuedRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = trpc.queries.plan.useMutation({
    onSuccess: (data: { runId: string }) => {
      setError(null);
      setQueuedRunId(data.runId);
    },
    onError: (cause: unknown) => {
      setQueuedRunId(null);
      setError(errorMessage(cause));
    },
  });

  return (
    <>
      <Button
        variant="secondary"
        data-testid="ask-run-host"
        disabled={disabled === true || query.trim() === '' || plan.isPending}
        onClick={() => {
          setQueuedRunId(null);
          plan.mutate({ query, mode, permissions: [...(permissions ?? ['network'])] });
        }}
      >
        {plan.isPending ? 'Queueing…' : 'Run on the host'}
      </Button>
      {queuedRunId !== null ? (
        <span className="nx-muted" data-testid="ask-host-queued">
          queued on the host · run {queuedRunId}
        </span>
      ) : null}
      {error !== null ? (
        <span className="nx-muted" data-testid="ask-host-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
