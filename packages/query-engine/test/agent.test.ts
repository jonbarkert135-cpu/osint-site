import { createCatalogRegistry, type EntityKind, type PlannerContext } from '@nexus/transforms';
import { describe, expect, it, vi } from 'vitest';

import { createAgentMemory, runAgent, type AgentDeps, type AgentTask } from '../src/agent.ts';
import type { InvestigationResult } from '../src/events.ts';
import type { ResolvedEntity } from '../src/resolve.ts';

const registry = createCatalogRegistry();

const ctx = (): Omit<PlannerContext, 'budget' | 'costCeiling'> => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network', 'subprocess', 'filesystem'] as const),
});

const entity = (kind: EntityKind, value: string): ResolvedEntity => ({
  id: `${kind}:${value}`,
  kind,
  value,
  props: {},
  confidence: 0.8,
  sources: [],
  seed: false,
});

const result = (entities: readonly ResolvedEntity[]): InvestigationResult => ({
  summary: {
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    stepsPlanned: entities.length,
    stepsCompleted: entities.length,
    stepsFailed: 0,
    stepsSkipped: 0,
    cacheHits: 0,
    entities: entities.length,
    relations: 0,
    warnings: [],
  },
  entities,
  relations: [],
  runs: [],
  provenance: [],
  duplicates: [],
});

/** Each executed task invents one fresh repository, so hops always have something to follow. */
const productive = (): AgentDeps['execute'] => {
  let counter = 0;
  return async (task: AgentTask) => {
    counter += 1;
    return result([
      entity('repo', `owner/repo-${String(counter)}`),
      entity(task.entity.kind, task.entity.value),
    ]);
  };
};

const base = (over: Partial<AgentDeps> = {}): AgentDeps => ({
  registry,
  ctx: ctx(),
  seed: 'octocat',
  execute: productive(),
  ...over,
});

describe('runAgent — the loop (§49)', () => {
  it('stops at the depth limit even when there is more to follow', async () => {
    const session = await runAgent(base({ guardrails: { maxDepth: 1, minNewEntities: 1 } }));
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0]?.tasks.length).toBeGreaterThan(0);
    expect(session.rounds[0]?.newEntities).toBeGreaterThan(0);
    expect(session.stop).toBe('max-depth');
    expect(session.note).toContain('depth');
  });

  it('follows what the first round found into a second round', async () => {
    const session = await runAgent(base({ guardrails: { maxDepth: 2, minNewEntities: 1 } }));
    expect(session.rounds.length).toBeGreaterThan(1);
    expect(session.rounds[1]?.observed[0]?.kind).toBe('repo');
    expect(session.rounds[0]?.headline).toContain('new of');
  });

  it('stops as soon as a round adds nothing new, instead of paying for another hop', async () => {
    const session = await runAgent(
      base({
        guardrails: { maxDepth: 5 },
        // Everything it finds is already on the board.
        memory: createAgentMemory([{ kind: 'repo', value: 'owner/repo-1' }]),
        execute: async () => result([entity('repo', 'owner/repo-1')]),
      }),
    );
    expect(session.stop).toBe('no-new-value');
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0]?.newEntities).toBe(0);
  });

  it('reports an unroutable question instead of looping', async () => {
    const session = await runAgent(base({ seed: '   ' }));
    expect(session.stop).toBe('nothing-to-do');
    expect(session.rounds).toEqual([]);
  });
});

describe('runAgent — guardrails (§48)', () => {
  it('never runs more jobs than the session allows', async () => {
    const execute = vi.fn(productive());
    const session = await runAgent(base({ execute, guardrails: { maxJobs: 1, maxDepth: 5 } }));
    expect(session.jobs).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.rounds[0]?.skipped.some((skip) => skip.reason === 'max-jobs')).toBe(true);
  });

  it('stops on the clock', async () => {
    let clock = 0;
    const session = await runAgent(
      base({
        guardrails: { maxRuntimeMs: 10, maxDepth: 5 },
        now: () => {
          clock += 20;
          return clock;
        },
      }),
    );
    expect(session.stop).toBe('timeout');
  });

  it('holds a step that crosses the approval threshold, and runs nothing without an answer', async () => {
    const execute = vi.fn(productive());
    const session = await runAgent(base({ execute, guardrails: { approveAboveNewNodes: 0 } }));
    expect(execute).not.toHaveBeenCalled();
    expect(session.stop).toBe('awaiting-approval');
    expect(session.rounds[0]?.awaitingApproval.length).toBeGreaterThan(0);
    expect(session.rounds[0]?.awaitingApproval[0]?.note).toContain('could add up to');
  });

  it('runs exactly the steps the analyst approved', async () => {
    const execute = vi.fn(productive());
    const approve: NonNullable<AgentDeps['approve']> = async (requests) =>
      requests.slice(0, 1).map((request) => request.transform);
    const approveSpy = vi.fn(approve);
    const session = await runAgent(
      base({
        execute,
        approve: approveSpy,
        guardrails: { approveAboveNewNodes: 0, maxDepth: 1 },
      }),
    );
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(session.jobs).toBe(1);
    expect(session.rounds[0]?.tasks[0]?.steps).toHaveLength(1);
  });
});

describe('runAgent — memory (§50)', () => {
  it('does not re-run a transform the board already has an answer for', async () => {
    const first = await runAgent(base({ guardrails: { maxDepth: 1 } }));
    const ran =
      first.rounds[0]?.tasks.flatMap((task) => task.steps.map((step) => step.transform)) ?? [];
    expect(ran.length).toBeGreaterThan(0);

    const memory = createAgentMemory(
      [],
      ran.map((transform) => ({ transform, kind: 'username' as EntityKind, value: 'octocat' })),
    );
    const execute = vi.fn(productive());
    const second = await runAgent(base({ memory, execute, guardrails: { maxDepth: 1 } }));
    expect(execute).not.toHaveBeenCalled();
    expect(second.stop).toBe('nothing-to-do');
    expect(second.rounds[0]?.skipped.every((skip) => skip.reason === 'already-known')).toBe(true);
  });
});

describe('runAgent — the model may narrow, never widen (§47)', () => {
  it('runs only the steps the brain picked', async () => {
    const offered = (
      await runAgent(base({ guardrails: { maxDepth: 1 } }))
    ).rounds[0]?.tasks.flatMap((task) => task.steps.map((step) => step.transform));
    const pick = offered?.[0];
    expect(pick).toBeDefined();
    const session = await runAgent(
      base({ brain: () => (pick === undefined ? [] : [pick]), guardrails: { maxDepth: 1 } }),
    );
    expect(session.rounds[0]?.tasks.flatMap((task) => task.steps.map((s) => s.transform))).toEqual([
      pick,
    ]);
  });

  it('ignores a transform the planner never offered', async () => {
    const execute = vi.fn(productive());
    const session = await runAgent(
      base({ execute, brain: () => ['made-up-transform'], guardrails: { maxDepth: 1 } }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(session.stop).toBe('nothing-to-do');
    expect(session.rounds[0]?.skipped.every((skip) => skip.reason === 'brain-declined')).toBe(true);
  });
});
