import type { PlanStep } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { buildDag, createScheduler } from '../src/schedule.ts';

const step = (
  transform: string,
  dependsOn: readonly string[] = [],
  depth = dependsOn.length + 1,
): PlanStep =>
  ({
    transform,
    inputKind: 'domain',
    dependsOn,
    depth,
    chain: [],
    estimatedRuntimeMs: 100,
    maxResults: 10,
  }) as unknown as PlanStep;

describe('buildDag', () => {
  it('makes independent steps roots and ranks a chain by its longest path', () => {
    const dag = buildDag([step('a'), step('b'), step('c', ['a']), step('d', ['c', 'b'])]);

    expect([...dag.roots]).toEqual(['a', 'b']);
    expect(dag.nodes.get('c')?.rank).toBe(1);
    expect(dag.nodes.get('d')?.rank).toBe(2);
    expect(dag.depth).toBe(3);
    expect(dag.width).toBe(2);
    expect(dag.warnings).toEqual([]);
  });

  it('records dependents so a finished step knows who it unblocks', () => {
    const dag = buildDag([step('a'), step('b', ['a']), step('c', ['a'])]);
    expect([...(dag.nodes.get('a')?.dependents ?? [])].sort()).toEqual(['b', 'c']);
  });

  it('drops an edge to a step that is not in the plan instead of stalling on it', () => {
    const dag = buildDag([step('b', ['missing'])]);
    expect(dag.roots).toEqual(['b']);
    expect(dag.warnings.join(' ')).toMatch(/missing/u);
  });

  it('breaks a dependency cycle and says so, because a stuck plan is worse than a warning', () => {
    const dag = buildDag([step('a', ['b']), step('b', ['a'])]);
    expect(dag.roots.length).toBeGreaterThan(0);
    expect(dag.warnings.join(' ')).toMatch(/cycle/u);
  });

  it('ignores a self-edge and a duplicated step', () => {
    const dag = buildDag([step('a', ['a']), step('a')]);
    expect(dag.nodes.size).toBe(1);
    expect(dag.roots).toEqual(['a']);
    expect(dag.warnings.join(' ')).toMatch(/duplicate/u);
  });

  it('is empty for an empty plan', () => {
    const dag = buildDag([]);
    expect(dag.depth).toBe(0);
    expect(dag.width).toBe(0);
    expect(dag.roots).toEqual([]);
  });
});

describe('createScheduler', () => {
  it('hands out every independent step at once rather than one rank at a time', () => {
    const scheduler = createScheduler(buildDag([step('a'), step('b'), step('c', ['a'])]));
    expect([...scheduler.take(4)]).toEqual(['a', 'b']);
    expect(scheduler.inFlight()).toBe(2);
    expect(scheduler.take(4)).toEqual([]);
  });

  it('respects the parallelism ceiling it is given', () => {
    const scheduler = createScheduler(buildDag([step('a'), step('b'), step('c')]));
    expect(scheduler.take(2)).toHaveLength(2);
    expect(scheduler.take(2)).toEqual(['c']);
  });

  it('releases a dependent as soon as its own predecessor settles, not the whole rank', () => {
    const scheduler = createScheduler(
      buildDag([step('slow'), step('fast'), step('after', ['fast'])]),
    );
    scheduler.take(4);
    scheduler.settle('fast');
    expect(scheduler.take(4)).toEqual(['after']);
    expect(scheduler.finished()).toBe(false);
    scheduler.settle('after');
    scheduler.settle('slow');
    expect(scheduler.finished()).toBe(true);
  });

  it('unlocks dependents of a failed step too: partial beats perfect', () => {
    const scheduler = createScheduler(buildDag([step('a'), step('b', ['a'])]));
    scheduler.take(4);
    scheduler.settle('a');
    expect(scheduler.take(4)).toEqual(['b']);
  });

  it('waits for every predecessor of a join node', () => {
    const scheduler = createScheduler(buildDag([step('a'), step('b'), step('join', ['a', 'b'])]));
    scheduler.take(4);
    scheduler.settle('a');
    expect(scheduler.take(4)).toEqual([]);
    scheduler.settle('b');
    expect(scheduler.take(4)).toEqual(['join']);
  });

  it('reports nodes that never ran as blocked', () => {
    const scheduler = createScheduler(buildDag([step('a'), step('b', ['a'])]));
    scheduler.take(4);
    scheduler.settle('a');
    expect(scheduler.blocked()).toEqual(['b']);
  });

  it('ignores a duplicate settle', () => {
    const scheduler = createScheduler(buildDag([step('a'), step('b', ['a'])]));
    scheduler.take(4);
    scheduler.settle('a');
    scheduler.settle('a');
    expect(scheduler.take(4)).toEqual(['b']);
  });
});
