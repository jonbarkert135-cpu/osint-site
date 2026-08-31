/**
 * Execution View (Part 2 §53): the run drawn as the pipeline it is.
 *
 * A tree, not a canvas — the shape is fixed (one query, one planner, N engines, three downstream
 * stages), so the honest rendering is text with connectors and a state mark per node. It reads as
 * the diagram in the spec, and it stays legible with twenty engines, which a hand-drawn graph
 * would not. It is a view: nothing here starts, stops or retries anything.
 */

import { executionGraph, STATE_MARK, type ExecutionNode } from './executionView.ts';
import type { QueryRunState } from './useQueryRun.ts';

export interface ExecutionViewProps {
  readonly state: QueryRunState;
  readonly query: string;
}

const Row = ({ node, prefix }: { readonly node: ExecutionNode; readonly prefix: string }) => (
  <li className="nx-exec-row" data-state={node.state} data-testid={`exec-${node.id}`}>
    <span className="nx-exec-prefix" aria-hidden="true">
      {prefix}
    </span>
    <span className="nx-exec-label">{node.label}</span>
    <span className="nx-exec-mark" aria-label={node.state}>
      {STATE_MARK[node.state]}
    </span>
    {node.detail === undefined ? null : <span className="nx-muted">{node.detail}</span>}
  </li>
);

export function ExecutionView({ state, query }: ExecutionViewProps) {
  const graph = executionGraph(state, query);

  return (
    <section className="nx-exec" aria-label="Execution view" data-testid="execution-view">
      <ol className="nx-exec-list">
        {graph.before.map((node) => (
          <Row key={node.id} node={node} prefix="↓" />
        ))}
        {graph.engines.length === 0 ? (
          <li className="nx-exec-row nx-muted" data-testid="exec-no-engines">
            No engine has been scheduled yet.
          </li>
        ) : (
          graph.engines.map((node, index) => (
            <Row
              key={node.id}
              node={node}
              prefix={index === graph.engines.length - 1 ? '└──' : '├──'}
            />
          ))
        )}
        {graph.after.map((node) => (
          <Row key={node.id} node={node} prefix="↓" />
        ))}
      </ol>
    </section>
  );
}
