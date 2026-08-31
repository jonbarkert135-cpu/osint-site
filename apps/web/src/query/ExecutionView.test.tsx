/** Execution View (Part 2 §53) on screen. */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExecutionView } from './ExecutionView.tsx';
import type { QueryRunState } from './useQueryRun.ts';

const state = (over: Partial<QueryRunState> = {}): QueryRunState => ({
  phase: 'running',
  steps: [],
  progress: 0,
  inFlight: 0,
  found: 0,
  counts: {},
  relations: 0,
  result: null,
  error: null,
  log: [],
  ...over,
});

describe('ExecutionView', () => {
  it('draws the pipeline with a mark per stage', () => {
    render(
      <ExecutionView
        state={state({
          found: 2,
          steps: [
            {
              transform: 'domain-to-dns',
              state: 'done',
              detail: '2 result(s)',
              fraction: 1,
              produced: 2,
            },
            {
              transform: 'domain-to-certificates',
              state: 'running',
              detail: 'via crt.sh',
              fraction: 0.3,
              produced: 0,
            },
          ],
        })}
        query="example.com"
      />,
    );

    expect(screen.getByTestId('exec-query')).toHaveTextContent('example.com');
    expect(screen.getByTestId('exec-planner')).toHaveTextContent('2 step(s)');
    expect(screen.getByTestId('exec-domain-to-dns')).toHaveTextContent('✅');
    expect(screen.getByTestId('exec-domain-to-certificates')).toHaveTextContent('⏳');
    // The three downstream stages are always drawn, pending until the engines settle.
    expect(screen.getByTestId('exec-aggregator')).toHaveTextContent('2 result(s)');
    expect(screen.getByTestId('exec-resolver')).toBeInTheDocument();
    expect(screen.getByTestId('exec-graph')).toBeInTheDocument();
  });

  it('says so when no engine has been scheduled', () => {
    render(<ExecutionView state={state({ phase: 'idle' })} query="" />);

    expect(screen.getByTestId('exec-no-engines')).toBeInTheDocument();
  });
});
