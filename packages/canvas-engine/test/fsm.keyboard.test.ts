import { describe, expect, it } from 'vitest';

import { reduce } from '../src/interaction/fsm';
import type { FsmEvent, FsmState, Modifiers } from '../src/interaction/fsm';
import { at, context, intentsOf, mods, node, onNode, pointer, run } from './fsm.support';

const nodes = [node('a', 0, 0), node('b', 300, 0), node('l', 600, 0, 100, 60, { locked: true })];

const key = (k: string, over: Partial<Modifiers> = {}, repeat = false): FsmEvent => ({
  t: 'keydown',
  key: k,
  mods: mods(over),
  repeat,
});

describe('keyboard', () => {
  it('Ctrl+A and Cmd+A select every node', () => {
    const ctx = context(nodes);
    for (const modifier of [{ ctrl: true }, { meta: true }]) {
      const res = reduce({ name: 'idle' }, key('a', modifier), ctx);
      expect(intentsOf(res.effects)).toEqual([
        { t: 'select', ids: ['a', 'b', 'l'], mode: 'replace' },
      ]);
    }
    expect(intentsOf(reduce({ name: 'idle' }, key('A', { ctrl: true }), ctx).effects)).toHaveLength(
      1,
    );
    // An unbound primary-modifier chord is left for the host's global shortcuts.
    expect(reduce({ name: 'idle' }, key('s', { meta: true }), ctx).effects).toEqual([]);
  });

  it('Escape clears the selection when nothing is in flight', () => {
    const ctx = context(nodes, { selection: ['a'] });
    for (const state of [
      { name: 'idle' },
      { name: 'hover', target: onNode('a') },
      { name: 'spacePan' },
    ] satisfies FsmState[]) {
      const res = reduce(state, key('Escape'), ctx);
      expect(res.state).toEqual(state);
      expect(intentsOf(res.effects)).toEqual([{ t: 'select', ids: [], mode: 'replace' }]);
    }
  });

  it('arrows nudge 1 px, with Shift 10 px, in a single committed patch', () => {
    const ctx = context(nodes, { selection: ['a', 'b'] });
    const left = reduce({ name: 'idle' }, key('ArrowLeft'), ctx);
    expect(intentsOf(left.effects)).toEqual([
      {
        t: 'move-nodes',
        phase: 'end',
        deltas: [
          { id: 'a', dx: -1, dy: 0 },
          { id: 'b', dx: -1, dy: 0 },
        ],
      },
    ]);
    const down = reduce({ name: 'idle' }, key('ArrowDown', { shift: true }), ctx);
    expect(intentsOf(down.effects)).toEqual([
      {
        t: 'move-nodes',
        phase: 'end',
        deltas: [
          { id: 'a', dx: 0, dy: 10 },
          { id: 'b', dx: 0, dy: 10 },
        ],
      },
    ]);
    expect(intentsOf(reduce({ name: 'idle' }, key('ArrowRight'), ctx).effects)[0]).toEqual({
      t: 'move-nodes',
      phase: 'end',
      deltas: [
        { id: 'a', dx: 1, dy: 0 },
        { id: 'b', dx: 1, dy: 0 },
      ],
    });
    expect(intentsOf(reduce({ name: 'idle' }, key('ArrowUp'), ctx).effects)[0]).toEqual({
      t: 'move-nodes',
      phase: 'end',
      deltas: [
        { id: 'a', dx: 0, dy: -1 },
        { id: 'b', dx: 0, dy: -1 },
      ],
    });
  });

  it('a nudge never moves locked nodes and does nothing on an empty selection', () => {
    expect(
      reduce({ name: 'idle' }, key('ArrowLeft'), context(nodes, { selection: ['l'] })).effects,
    ).toEqual([]);
    expect(reduce({ name: 'idle' }, key('ArrowLeft'), context(nodes)).effects).toEqual([]);
  });

  it('Delete and Backspace delete the selection, and do nothing without one', () => {
    const ctx = context(nodes, { selection: ['a', 'b'] });
    for (const k of ['Delete', 'Backspace']) {
      expect(intentsOf(reduce({ name: 'idle' }, key(k), ctx).effects)).toEqual([
        { t: 'delete', ids: ['a', 'b'] },
      ]);
    }
    expect(reduce({ name: 'idle' }, key('Delete'), context(nodes)).effects).toEqual([]);
  });

  it('[ and ] reorder, Enter edits the anchor', () => {
    const ctx = context(nodes, { selection: ['a', 'b'] });
    expect(intentsOf(reduce({ name: 'idle' }, key('['), ctx).effects)).toEqual([
      { t: 'z-order', ids: ['a', 'b'], op: 'backward' },
    ]);
    expect(intentsOf(reduce({ name: 'idle' }, key(']'), ctx).effects)).toEqual([
      { t: 'z-order', ids: ['a', 'b'], op: 'forward' },
    ]);
    const edit = reduce({ name: 'idle' }, key('Enter'), ctx);
    expect(edit.state).toEqual({ name: 'editing', id: 'b' });
    expect(intentsOf(edit.effects)).toEqual([{ t: 'begin-edit-text', id: 'b' }]);
    expect(reduce({ name: 'idle' }, key('Enter'), context(nodes)).state.name).toBe('idle');
    expect(
      reduce({ name: 'idle' }, key('Enter'), context(nodes, { selection: ['ghost'] })).effects,
    ).toEqual([]);
  });

  it('camera keys emit camera commands', () => {
    const ctx = context(nodes);
    const table: Array<[string, string]> = [
      ['f', 'fit-all'],
      ['F', 'fit-all'],
      ['0', 'fit-all'],
      ['1', 'zoom-100'],
      ['2', 'fit-selection'],
      ['+', 'zoom-in'],
      ['=', 'zoom-in'],
      ['-', 'zoom-out'],
    ];
    for (const [k, cmd] of table) {
      expect(reduce({ name: 'idle' }, key(k), ctx).effects).toEqual([{ t: 'camera-command', cmd }]);
    }
    expect(reduce({ name: 'idle' }, key('q'), ctx).effects).toEqual([]);
  });

  it('H latches and unlatches hand mode, the same state Space holds', () => {
    const ctx = context(nodes);
    const latched = reduce({ name: 'idle' }, key('h'), ctx);
    expect(latched.state.name).toBe('spacePan');
    expect(latched.effects).toEqual([]);
    expect(reduce(latched.state, key('H'), ctx).state.name).toBe('idle');
  });

  it('mid-gesture only Escape is honoured', () => {
    const ctx = context(nodes, { selection: ['a'] });
    const dragging = run(
      [
        pointer('pointerdown', at(10, 10), onNode('a')),
        pointer('pointermove', at(80, 10), onNode('a')),
      ],
      ctx,
    );
    const ignored = reduce(dragging.state, key('a', { ctrl: true }), ctx);
    expect(ignored.state).toBe(dragging.state);
    expect(ignored.effects).toEqual([]);
    expect(reduce(dragging.state, key('Delete'), ctx).effects).toEqual([]);
    expect(reduce(dragging.state, key(' '), ctx).state.name).toBe('draggingNodes');
    expect(reduce(dragging.state, key('Escape'), ctx).state.name).toBe('idle');
  });

  it('while editing, only Escape reaches the engine', () => {
    const ctx = context(nodes, { selection: ['a'] });
    const editing: FsmState = { name: 'editing', id: 'a' };
    for (const k of ['a', 'Delete', 'ArrowLeft', ' ']) {
      const res = reduce(editing, key(k, { ctrl: true }), ctx);
      expect(res.state).toBe(editing);
      expect(res.effects).toEqual([]);
    }
    expect(reduce(editing, key('Escape'), ctx).state.name).toBe('idle');
  });

  it('keyup of a non-space key changes nothing', () => {
    const ctx = context(nodes);
    const res = reduce({ name: 'idle' }, { t: 'keyup', key: 'Shift', mods: mods({}) }, ctx);
    expect(res.state.name).toBe('idle');
    expect(res.effects).toEqual([]);
  });
});
