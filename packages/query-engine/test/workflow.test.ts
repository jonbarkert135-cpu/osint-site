import { createCatalogRegistry, type PlannerContext } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { buildDag } from '../src/schedule.ts';
import {
  WORKFLOW_TEMPLATES,
  compileWorkflow,
  parseWorkflow,
  validateWorkflow,
  type Workflow,
} from '../src/workflow.ts';

const registry = createCatalogRegistry();
const template = WORKFLOW_TEMPLATES[0] as Workflow;

const ctx = (): Omit<PlannerContext, 'budget'> => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network', 'subprocess', 'filesystem'] as const),
});

const withNodes = (nodes: Workflow['nodes']): Workflow => ({ ...template, nodes });

describe('validateWorkflow', () => {
  it('accepts the brief pipeline', () => {
    expect(validateWorkflow(registry, template)).toEqual([]);
  });

  it('rejects an unknown transform instead of skipping the step', () => {
    const issues = validateWorkflow(
      registry,
      withNodes([
        { id: 'input', stage: 'input', after: [] },
        { id: 'x', stage: 'transform', transform: 'does-not-exist', after: ['input'] },
      ]),
    );
    expect(issues.some((issue) => issue.message.includes('unknown transform'))).toBe(true);
  });

  it('rejects a summary that runs before the graph', () => {
    const issues = validateWorkflow(
      registry,
      withNodes([
        { id: 'input', stage: 'input', after: [] },
        { id: 'p', stage: 'transform', transform: 'username-to-profiles', after: ['input'] },
        { id: 'summary', stage: 'ai-summary', after: ['p'] },
        { id: 'graph', stage: 'graph', after: ['summary'] },
      ]),
    );
    expect(issues.some((issue) => issue.message.includes('cannot come after'))).toBe(true);
  });

  it('rejects a forward reference, which is how a cycle shows up here', () => {
    const issues = validateWorkflow(
      registry,
      withNodes([
        { id: 'input', stage: 'input', after: [] },
        { id: 'a', stage: 'transform', transform: 'username-to-profiles', after: ['b'] },
        { id: 'b', stage: 'transform', transform: 'username-to-repositories', after: ['input'] },
      ]),
    );
    expect(issues.some((issue) => issue.message.includes('declared earlier'))).toBe(true);
  });

  it('rejects a workflow with no input, two inputs or no transform', () => {
    const noInput = validateWorkflow(registry, withNodes([{ id: 'g', stage: 'graph', after: [] }]));
    expect(noInput.length).toBeGreaterThan(0);
    const twoInputs = validateWorkflow(
      registry,
      withNodes([
        { id: 'a', stage: 'input', after: [] },
        { id: 'b', stage: 'input', after: [] },
      ]),
    );
    expect(twoInputs.some((issue) => issue.message.includes('exactly one input'))).toBe(true);
    const noTransform = validateWorkflow(
      registry,
      withNodes([
        { id: 'input', stage: 'input', after: [] },
        { id: 'n', stage: 'normalize', after: ['input'] },
      ]),
    );
    expect(noTransform.some((issue) => issue.message.includes('collect nothing'))).toBe(true);
  });

  it('refuses a transform id on a stage that does not run one', () => {
    const issues = validateWorkflow(
      registry,
      withNodes([
        { id: 'input', stage: 'input', after: [] },
        { id: 'p', stage: 'transform', transform: 'username-to-profiles', after: ['input'] },
        { id: 'g', stage: 'graph', transform: 'username-to-profiles', after: ['p'] },
      ]),
    );
    expect(issues.some((issue) => issue.message.includes('cannot name a transform'))).toBe(true);
  });
});

describe('compileWorkflow', () => {
  it('compiles the template into a schedulable plan', () => {
    const compiled = compileWorkflow(registry, template, ctx());
    expect(compiled.issues).toEqual([]);
    const steps = compiled.plan?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    const dag = buildDag(steps);
    expect(dag.warnings).toEqual([]);
    expect(dag.roots.length).toBeGreaterThan(0);
  });

  it('sees through the non-transform stages when wiring dependencies', () => {
    const compiled = compileWorkflow(registry, template, ctx());
    const repos = compiled.plan?.steps.find(
      (step) => step.transform === 'username-to-repositories',
    );
    // repos sits behind `profiles` in the template, and the normalize stage in front of both is
    // transparent: the edge must land on the transform, not vanish.
    if (repos) expect(repos.dependsOn).toEqual(['username-to-profiles']);
    const profiles = compiled.plan?.steps.find((step) => step.transform === 'username-to-profiles');
    if (profiles) expect(profiles.dependsOn).toEqual([]);
  });

  it('carries no plan when the workflow is invalid', () => {
    const compiled = compileWorkflow(
      registry,
      withNodes([{ id: 'g', stage: 'graph', after: [] }]),
      ctx(),
    );
    expect(compiled.plan).toBeUndefined();
    expect(compiled.issues.length).toBeGreaterThan(0);
  });

  it('reports steps the cost ceiling priced out rather than dropping them silently', () => {
    const compiled = compileWorkflow(registry, template, {
      ...ctx(),
      costCeiling: {
        maxExecutionClass: 'fast',
        cpu: 1,
        memoryMb: 128,
        runtimeMs: 1_000,
        networkRequests: 1,
        allowQueued: false,
        allowDegraded: false,
        minValueForExpensive: 0.9,
      },
    });
    expect(compiled.plan?.steps).toEqual([]);
    expect(compiled.plan?.excluded.length).toBeGreaterThan(0);
  });
});

describe('parseWorkflow', () => {
  it('round-trips a saved workflow', () => {
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(template)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateWorkflow(registry, parsed.workflow)).toEqual([]);
  });

  it('rejects junk with readable issues', () => {
    expect(parseWorkflow('nope').ok).toBe(false);
    const parsed = parseWorkflow({ id: 'x', name: 'x', version: 2, nodes: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.issues.some((issue) => issue.message.includes('version'))).toBe(true);
  });

  it('rejects a node with an unknown stage', () => {
    const parsed = parseWorkflow({
      id: 'x',
      name: 'x',
      version: 1,
      nodes: [{ id: 'a', stage: 'teleport', after: [] }],
    });
    expect(parsed.ok).toBe(false);
  });
});
