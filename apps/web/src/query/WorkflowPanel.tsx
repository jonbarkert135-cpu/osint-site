/**
 * The visual workflow editor (Part 2 §45) and the surface that re-runs a saved one (§46).
 *
 * The pipeline is assembled the way the rest of Raven is assembled: nodes with arrows between
 * them — `Sherlock → broad sweep → GitHub → Entity resolution → Graph`. The geometry comes from
 * `layoutWorkflow` and the saved document comes back from `graphToWorkflow`, so this component owns
 * no graph logic of its own: it draws, it edits ids, and it hands the result to the query engine.
 *
 * Running is the §46 point: the same pipeline, a new input. `runWorkflow` produces the ordinary
 * `QueryPlan`, so a workflow run is the ordinary orchestrated run — budgets, cost gate, provenance,
 * partial results — and it lands on the board only through the normal proposal review (N4).
 */

import { newId } from '@nexus/domain';
import { applyProposal } from '@nexus/integrations';
import {
  graphToWorkflow,
  layoutWorkflow,
  runWorkflow,
  validateWorkflow,
  WORKFLOW_TEMPLATES,
  EDITOR_LAYOUT,
  type EditorGraph,
  type Workflow,
  type WorkflowIssue,
} from '@nexus/query-engine';
import { createCatalogRegistry, type ExecutionMode, type HostFetch } from '@nexus/transforms';
import { Button } from '@nexus/ui';
import { useCallback, useMemo, useState } from 'react';
import type * as Y from 'yjs';

import { ProposalReview } from '../integrations/ProposalReview.tsx';
import { toImportProposal } from './investigationProposal.ts';
import { RunConsole } from './RunConsole.tsx';
import { useQueryRun } from './useQueryRun.ts';
import { deleteWorkflow, listWorkflows, saveWorkflow } from './workflowStore.ts';

export interface WorkflowPanelProps {
  open: boolean;
  onClose: () => void;
  doc?: Y.Doc;
  boardId?: string;
  hostFetch?: HostFetch;
}

const MODE: ExecutionMode = 'zero-credential';

export function WorkflowPanel({ open, onClose, doc, boardId, hostFetch }: WorkflowPanelProps) {
  const registry = useMemo(() => createCatalogRegistry(), []);
  const runner = useQueryRun(hostFetch === undefined ? {} : { fetch: hostFetch });

  const [saved, setSaved] = useState(() => listWorkflows());
  const [source, setSource] = useState<Workflow>(WORKFLOW_TEMPLATES[0] as Workflow);
  const [graph, setGraph] = useState<EditorGraph>(() =>
    layoutWorkflow(WORKFLOW_TEMPLATES[0] as Workflow),
  );
  const [name, setName] = useState((WORKFLOW_TEMPLATES[0] as Workflow).name);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly WorkflowIssue[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(false);

  const load = useCallback(
    (workflow: Workflow) => {
      setSource(workflow);
      setGraph(layoutWorkflow(workflow));
      setName(workflow.name);
      setSelected(null);
      setIssues([]);
      setStatus(null);
      runner.reset();
    },
    [runner],
  );

  /** The canvas is the source of truth while editing; a workflow is what it compiles to. */
  const compiled = useMemo(() => {
    const built = graphToWorkflow(graph, { id: source.id, name });
    if (!built.ok) return { issues: built.issues };
    return { workflow: built.workflow, issues: validateWorkflow(registry, built.workflow) };
  }, [graph, name, registry, source.id]);

  const addStep = useCallback(
    (transform: string) => {
      const parent = selected ?? graph.nodes.at(-1)?.id;
      if (parent === undefined) return;
      const id = `step-${String(graph.nodes.length + 1)}`;
      const manifest = registry.transform(transform);
      setGraph((current) => ({
        nodes: [
          ...current.nodes,
          {
            id,
            stage: 'transform' as const,
            transform,
            label: manifest?.name ?? transform,
            x: 0,
            y: 0,
          },
        ],
        edges: [...current.edges, { id: `${parent}->${id}`, from: parent, to: id }],
      }));
      setSelected(id);
    },
    [graph.nodes, registry, selected],
  );

  const removeSelected = useCallback(() => {
    if (selected === null) return;
    setGraph((current) => ({
      nodes: current.nodes.filter((node) => node.id !== selected),
      edges: current.edges.filter((edge) => edge.from !== selected && edge.to !== selected),
    }));
    setSelected(null);
  }, [selected]);

  const save = useCallback(() => {
    if (compiled.workflow === undefined || compiled.issues.length > 0) {
      setIssues(compiled.issues);
      setStatus(null);
      return;
    }
    setIssues([]);
    setSaved(saveWorkflow(compiled.workflow));
    setStatus(`Saved “${compiled.workflow.name}”. Run it again any time, for any input.`);
  }, [compiled]);

  const run = useCallback(() => {
    if (compiled.workflow === undefined) {
      setIssues(compiled.issues);
      return;
    }
    const prepared = runWorkflow(registry, compiled.workflow, input, {
      mode: MODE,
      configuredProviders: new Set<string>(),
      grantedPermissions: new Set(['network'] as const),
    });
    if (prepared.query === undefined) {
      setIssues(prepared.issues);
      return;
    }
    setIssues([]);
    setStatus(null);
    void runner.run(prepared.query);
  }, [compiled, input, registry, runner]);

  const investigation = runner.result;
  const proposal = useMemo(
    () =>
      investigation === null || boardId === undefined
        ? null
        : toImportProposal(investigation, { boardId, runId: newId.board() }),
    [investigation, boardId],
  );

  const apply = useCallback(
    (selectedItemIds: string[]) => {
      if (proposal === null || doc === undefined) return;
      const outcome = applyProposal(doc, proposal, {
        selectedItemIds,
        conflictResolutions: {},
        placement: 'radial',
        newId: () => newId.board(),
        now: new Date().toISOString(),
      });
      setStatus(
        `Added ${String(outcome.createdNodeIds.length)} node(s) and ${String(outcome.createdEdgeIds.length)} edge(s).`,
      );
      runner.reset();
    },
    [proposal, doc, runner],
  );

  if (!open) return null;

  const laid = compiled.workflow === undefined ? graph : layoutWorkflow(compiled.workflow);
  const positions = new Map(laid.nodes.map((node) => [node.id, node] as const));
  const width =
    Math.max(...laid.nodes.map((node) => node.x), 0) +
    EDITOR_LAYOUT.nodeWidth +
    EDITOR_LAYOUT.rowGap;
  const height =
    Math.max(...laid.nodes.map((node) => node.y), 0) +
    EDITOR_LAYOUT.nodeHeight +
    EDITOR_LAYOUT.rowGap;

  return (
    <aside className="nx-ask-panel" aria-label="Workflows" data-testid="workflow-panel">
      <header>
        <strong>Workflows</strong>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </header>

      <label className="nx-ask-field">
        <span className="nx-muted">Start from</span>
        <select
          data-testid="workflow-picker"
          value={source.id}
          onChange={(event) => {
            const found =
              [...WORKFLOW_TEMPLATES, ...saved.map((entry) => entry.workflow)].find(
                (workflow) => workflow.id === event.target.value,
              ) ?? source;
            load(found);
          }}
        >
          {WORKFLOW_TEMPLATES.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name} (template)
            </option>
          ))}
          {saved.map((entry) => (
            <option key={entry.workflow.id} value={entry.workflow.id}>
              {entry.workflow.name}
            </option>
          ))}
        </select>
      </label>

      <label className="nx-ask-field">
        <span className="nx-muted">Name</span>
        <input
          type="text"
          value={name}
          data-testid="workflow-name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div
        className="nx-workflow-canvas"
        data-testid="workflow-canvas"
        style={{ inlineSize: `${String(width)}px`, blockSize: `${String(height)}px` }}
      >
        <svg className="nx-workflow-arrows" width={width} height={height} aria-hidden="true">
          {laid.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={edge.id}
                x1={from.x + EDITOR_LAYOUT.nodeWidth}
                y1={from.y + EDITOR_LAYOUT.nodeHeight / 2}
                x2={to.x}
                y2={to.y + EDITOR_LAYOUT.nodeHeight / 2}
                stroke="currentColor"
                strokeWidth={1.5}
              />
            );
          })}
        </svg>
        {laid.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            className="nx-workflow-node"
            data-stage={node.stage}
            data-testid={`workflow-node-${node.id}`}
            aria-pressed={node.id === selected}
            style={{
              transform: `translate(${String(node.x)}px, ${String(node.y)}px)`,
              inlineSize: `${String(EDITOR_LAYOUT.nodeWidth)}px`,
              blockSize: `${String(EDITOR_LAYOUT.nodeHeight)}px`,
            }}
            onClick={() => setSelected(node.id === selected ? null : node.id)}
          >
            <span>{node.label}</span>
            <span className="nx-muted">{node.stage}</span>
          </button>
        ))}
      </div>

      <div className="nx-ask-actions">
        <label className="nx-ask-field">
          <span className="nx-muted">Add step after {selected ?? 'the last node'}</span>
          <select
            data-testid="workflow-add-step"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') addStep(event.target.value);
            }}
          >
            <option value="">Choose a transform…</option>
            {registry.transforms.map((manifest) => (
              <option key={manifest.id} value={manifest.id}>
                {manifest.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={selected === null}
          data-testid="workflow-remove"
          onClick={removeSelected}
        >
          Remove node
        </Button>
        <Button data-testid="workflow-save" onClick={save}>
          Save workflow
        </Button>
        {saved.some((entry) => entry.workflow.id === source.id) ? (
          <Button
            variant="secondary"
            data-testid="workflow-delete"
            onClick={() => {
              setSaved(deleteWorkflow(source.id));
              setStatus('Deleted.');
            }}
          >
            Delete saved
          </Button>
        ) : null}
      </div>

      <label className="nx-ask-field">
        <span className="nx-muted">Run this workflow for</span>
        <input
          type="text"
          value={input}
          placeholder="another username"
          data-testid="workflow-input"
          onChange={(event) => setInput(event.target.value)}
        />
      </label>

      <div className="nx-ask-actions">
        {runner.phase === 'running' ? (
          <Button variant="secondary" onClick={runner.stop} data-testid="workflow-stop">
            Stop
          </Button>
        ) : (
          <Button data-testid="workflow-run" onClick={run}>
            Run workflow
          </Button>
        )}
        {runner.phase === 'running' ? (
          <span className="nx-muted" data-testid="workflow-progress">
            {String(Math.round(runner.progress * 100))}% · {String(runner.found)} found
          </span>
        ) : null}
      </div>

      {issues.length > 0 ? (
        <ul className="nx-ask-dupes" data-testid="workflow-issues">
          {issues.map((issue) => (
            <li key={`${issue.node ?? ''}|${issue.message}`}>
              {issue.node === undefined ? '' : `${issue.node}: `}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {status !== null ? (
        <p role="status" data-testid="workflow-status">
          {status}
        </p>
      ) : null}

      {runner.steps.length > 0 ? (
        <ul className="nx-ask-run" data-testid="workflow-run-steps">
          {runner.steps.map((step) => (
            <li key={step.transform} data-state={step.state}>
              <span className="nx-ask-step">
                {registry.transform(step.transform)?.name ?? step.transform}
              </span>
              <span className="nx-muted">
                {step.state} · {step.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {proposal !== null && doc !== undefined ? (
        <ProposalReview
          proposal={proposal}
          integrationName={name}
          onApply={apply}
          onDiscard={runner.reset}
        />
      ) : investigation !== null ? (
        <p className="nx-muted" data-testid="workflow-no-board">
          The run finished with {String(investigation.entities.length)} entities. Open a board to
          land them on a canvas.
        </p>
      ) : null}

      {runner.log.length > 0 || runner.phase !== 'idle' ? (
        <RunConsole
          lines={runner.log}
          open={consoleOpen}
          onToggle={() => setConsoleOpen((current) => !current)}
          running={runner.phase === 'running'}
        />
      ) : null}
    </aside>
  );
}
