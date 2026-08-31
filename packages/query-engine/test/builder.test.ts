import { createCatalogRegistry, type PlannerContext } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import {
  deserializeWorkflow,
  graphToWorkflow,
  layoutWorkflow,
  runWorkflow,
  serializeWorkflow,
  type EditorGraph,
} from '../src/builder.ts';
import { WORKFLOW_TEMPLATES, validateWorkflow, type Workflow } from '../src/workflow.ts';

const registry = createCatalogRegistry();
const template = WORKFLOW_TEMPLATES[0] as Workflow;

const ctx = (): Omit<PlannerContext, 'budget'> => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network', 'subprocess', 'filesystem'] as const),
});

describe('layoutWorkflow', () => {
  it('puts the input first and every step right of what it consumes', () => {
    const graph = layoutWorkflow(template);
    const x = new Map(graph.nodes.map((node) => [node.id, node.x] as const));
    expect(x.get('input')).toBe(0);
    for (const node of template.nodes) {
      for (const parent of node.after) {
        expect(x.get(node.id) ?? 0).toBeGreaterThan(x.get(parent) ?? 0);
      }
    }
  });

  it('draws one arrow per dependency', () => {
    const graph = layoutWorkflow(template);
    const expected = template.nodes.reduce((total, node) => total + node.after.length, 0);
    expect(graph.edges).toHaveLength(expected);
  });

  it('separates the two branches that share a column', () => {
    const graph = layoutWorkflow(template);
    const branches = graph.nodes.filter((node) => node.id === 'profiles' || node.id === 'mentions');
    expect(branches).toHaveLength(2);
    expect(branches[0]?.x).toBe(branches[1]?.x);
    expect(branches[0]?.y).not.toBe(branches[1]?.y);
  });
});

describe('graphToWorkflow', () => {
  it('round-trips the template through the canvas', () => {
    const built = graphToWorkflow(layoutWorkflow(template), {
      id: template.id,
      name: template.name,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateWorkflow(registry, built.workflow)).toEqual([]);
    expect(new Set(built.workflow.nodes.map((node) => node.id))).toEqual(
      new Set(template.nodes.map((node) => node.id)),
    );
    expect(built.workflow.nodes.find((node) => node.id === 'input')?.kind).toBe('username');
    for (const node of built.workflow.nodes) {
      const original = template.nodes.find((candidate) => candidate.id === node.id);
      expect([...node.after].sort()).toEqual([...(original?.after ?? [])].sort());
    }
  });

  it('reports a cycle as a cycle, not as a declaration-order complaint', () => {
    const graph: EditorGraph = {
      nodes: [
        { id: 'input', stage: 'input', label: 'in', x: 0, y: 0 },
        { id: 'a', stage: 'transform', transform: 'username-to-profiles', label: 'a', x: 1, y: 0 },
        {
          id: 'b',
          stage: 'transform',
          transform: 'username-to-repositories',
          label: 'b',
          x: 2,
          y: 0,
        },
      ],
      edges: [
        { id: '1', from: 'input', to: 'a' },
        { id: '2', from: 'a', to: 'b' },
        { id: '3', from: 'b', to: 'a' },
      ],
    };
    const built = graphToWorkflow(graph, { id: 'w', name: 'w' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.some((issue) => issue.message.includes('cycle'))).toBe(true);
  });

  it('rejects an arrow that points at nothing and a self-loop', () => {
    const nodes = layoutWorkflow(template).nodes;
    const dangling = graphToWorkflow(
      { nodes, edges: [{ id: 'x', from: 'input', to: 'ghost' }] },
      { id: 'w', name: 'w' },
    );
    expect(dangling.ok).toBe(false);
    const selfLoop = graphToWorkflow(
      { nodes, edges: [{ id: 'x', from: 'input', to: 'input' }] },
      { id: 'w', name: 'w' },
    );
    expect(selfLoop.ok).toBe(false);
  });
});

describe('saving a workflow', () => {
  it('survives a save and a load', () => {
    const loaded = deserializeWorkflow(serializeWorkflow(template));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.workflow).toEqual(template);
  });

  it('treats a broken file as input, not as a crash', () => {
    expect(deserializeWorkflow('{oops').ok).toBe(false);
    expect(deserializeWorkflow('{"id":"a"}').ok).toBe(false);
  });
});

describe('runWorkflow', () => {
  it('re-runs the saved pipeline for a new username', () => {
    const run = runWorkflow(registry, template, 'someone-else', ctx());
    expect(run.issues).toEqual([]);
    expect(run.query?.chosen?.kind).toBe('username');
    expect(run.query?.input).toBe('someone-else');
    expect((run.query?.plan?.steps ?? []).length).toBeGreaterThan(0);
  });

  it('refuses an input of the wrong kind instead of coercing it', () => {
    const run = runWorkflow(registry, template, 'example.com', ctx());
    expect(run.query).toBeUndefined();
    expect(run.issues[0]?.message).toContain('expects a username');
  });

  it("carries the workflow's own issues instead of running a broken pipeline", () => {
    const broken: Workflow = {
      ...template,
      nodes: [
        { id: 'input', stage: 'input', after: [] },
        { id: 'x', stage: 'transform', transform: 'nope', after: ['input'] },
      ],
    };
    const run = runWorkflow(registry, broken, 'someone', ctx());
    expect(run.query).toBeUndefined();
    expect(run.issues.length).toBeGreaterThan(0);
  });
});
