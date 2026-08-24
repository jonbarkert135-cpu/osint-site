/**
 * The engine ⇄ React bridge (P4 §7). The engine decides which nodes get a DOM host; React only
 * fills the slots it is given. The fake engine here is exactly the surface the bridge uses, which
 * is the point: if the bridge starts needing more of the engine, this test stops compiling.
 */

import { createBoardDoc, createNode, updateNode } from '@nexus/domain';
import { createOverlay } from '@nexus/canvas-engine';
import type { Engine, EngineEvents, HitTarget, Intent, NodeView } from '@nexus/canvas-engine';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NodeHosts } from './NodeHosts.tsx';
import { createNodeStore } from './nodeStore.ts';

const T0 = '2026-06-01T00:00:00.000Z';

function fakeEngine(interaction: string = 'idle'): {
  engine: Engine;
  emitHosts: (ids: string[]) => void;
  emitZoom: (zoom: number) => void;
  emitHover: (target: HitTarget) => void;
  emitIntent: (intent: Intent) => void;
} {
  const hosts: Array<EngineEvents['hostsChanged']> = [];
  const cameras: Array<EngineEvents['cameraChanged']> = [];
  const hovers: Array<EngineEvents['hoverChanged']> = [];
  const intents: Array<EngineEvents['intent']> = [];
  const engine = {
    camera: { state: { x: 0, y: 0, zoom: 1 } },
    state: { interaction },
    on: (event: keyof EngineEvents, listener: unknown) => {
      if (event === 'hostsChanged') hosts.push(listener as EngineEvents['hostsChanged']);
      if (event === 'cameraChanged') cameras.push(listener as EngineEvents['cameraChanged']);
      if (event === 'hoverChanged') hovers.push(listener as EngineEvents['hoverChanged']);
      if (event === 'intent') intents.push(listener as EngineEvents['intent']);
      return () => undefined;
    },
  } as unknown as Engine;
  return {
    engine,
    emitHosts: (ids) => {
      for (const listener of hosts) listener(ids);
    },
    emitZoom: (zoom) => {
      for (const listener of cameras) listener({ x: 0, y: 0, zoom }, 'user');
    },
    emitHover: (target) => {
      for (const listener of hovers) listener(target);
    },
    emitIntent: (intent) => {
      for (const listener of intents) listener(intent);
    },
  };
}

function setup() {
  const doc = createBoardDoc({ boardId: 'b_hosts', now: T0 });
  const ids: string[] = [];
  let counter = 0;
  for (const title of ['First', 'Second']) {
    const { node } = createNode(
      doc,
      {
        type: 'website',
        x: 0,
        y: 0,
        title,
        data: { url: 'https://example.com', description: 'Detail text' },
      },
      { now: T0, makeId: () => `n_${String(++counter)}` },
    );
    ids.push(node.id);
  }
  const slots = new Map<string, HTMLElement>();
  for (const id of ids) {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slots.set(id, slot);
  }
  return { doc, ids, slots, store: createNodeStore(doc) };
}

describe('NodeHosts', () => {
  it('renders a card into each promoted slot and drops it when the engine unmounts it', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    render(<NodeHosts engine={engine} doc={doc} store={store} slotOf={(id) => slots.get(id)} />);

    expect(screen.queryByText('First')).not.toBeInTheDocument();

    act(() => emitHosts(ids));
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();

    act(() => emitHosts([ids[0] ?? '']));
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('dims cards that do not carry the active tag filter', () => {
    const { doc, ids, slots, store } = setup();
    const first = ids[0] ?? '';
    updateNode(doc, first, { tags: ['infra'] }, { origin: 'local:edit', now: T0 });
    const { engine, emitHosts } = fakeEngine();
    render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(id) => slots.get(id)}
        tagFilter="infra"
      />,
    );
    act(() => emitHosts(ids));

    expect(screen.getByTestId(`node-card-${first}`)).not.toHaveAttribute('data-dimmed');
    expect(screen.getByTestId(`node-card-${ids[1] ?? ''}`)).toHaveAttribute('data-dimmed', 'true');
  });

  it('skips ids the overlay has no slot for', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    render(<NodeHosts engine={engine} doc={doc} store={store} slotOf={(id) => slots.get(id)} />);
    act(() => emitHosts([...ids, 'n_missing']));
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('switches to detailed cards above the L3 zoom threshold', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts, emitZoom } = fakeEngine();
    render(<NodeHosts engine={engine} doc={doc} store={store} slotOf={(id) => slots.get(id)} />);
    act(() => emitHosts([ids[0] ?? '']));
    expect(screen.queryByText('Detail text')).not.toBeInTheDocument();

    act(() => emitZoom(2));
    expect(screen.getByText('Detail text')).toBeInTheDocument();
  });

  it('marks the selected card, and multi-selection when several are selected', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    const { rerender } = render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(id) => slots.get(id)}
        selectedIds={[ids[0] ?? '']}
      />,
    );
    act(() => emitHosts(ids));
    expect(screen.getByTestId(`node-card-${ids[0] ?? ''}`)).toHaveAttribute(
      'data-state',
      'selected',
    );

    rerender(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(id) => slots.get(id)}
        selectedIds={ids}
      />,
    );
    expect(screen.getByTestId(`node-card-${ids[0] ?? ''}`)).toHaveAttribute(
      'data-state',
      'multi-selected',
    );
  });

  it('re-renders a card when its own node changes', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    render(<NodeHosts engine={engine} doc={doc} store={store} slotOf={(id) => slots.get(id)} />);
    act(() => emitHosts(ids));

    act(() => {
      updateNode(doc, ids[0] ?? '', { title: 'Renamed' }, { origin: 'local:edit', now: T0 });
    });
    expect(screen.getByText('Renamed')).toBeInTheDocument();
  });

  /**
   * Regression (P4): the overlay recycles slots, and a slot that hosted a card must never have its
   * children cleared by the engine — React still owns them and its next unmount would throw
   * `removeChild: not a child of this node`, which took the whole board down in e2e.
   */
  it('survives the engine releasing a slot that still hosts a card', () => {
    const { doc, ids, store } = setup();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = createOverlay<HTMLElement>({ document, container });
    const id = ids[0] ?? '';
    const view: NodeView = {
      id,
      kind: 'website',
      x: 0,
      y: 0,
      w: 240,
      h: 120,
      z: 1,
      layerId: 'l_main',
      groupId: null,
      rotation: 0,
      locked: false,
      hidden: false,
      glyph: {
        accent: { r: 1, g: 1, b: 1, a: 1 },
        fill: { r: 0, g: 0, b: 0, a: 1 },
        icon: 'globe',
        title: 'First',
        badgeCount: 0,
        thumbnailKey: null,
        status: 'none',
      },
      domKey: `${id}:1`,
      visualVersion: 1,
    };
    overlay.sync([view]);
    const slot = overlay.slotOf(id);
    expect(slot).toBeDefined();

    const { engine, emitHosts } = fakeEngine();
    const view2 = render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(nodeId) => overlay.slotOf(nodeId)}
      />,
    );
    act(() => emitHosts([id]));
    expect(slot?.querySelector('article')).not.toBeNull();

    // The engine drops the node first (as undo does), React only learns about it afterwards.
    act(() => {
      overlay.sync([]);
    });
    expect(slot?.querySelector('article')).not.toBeNull();
    expect(() => {
      act(() => emitHosts([]));
    }).not.toThrow();
    expect(slot?.querySelector('article')).toBeNull();
    expect(() => {
      view2.unmount();
    }).not.toThrow();
    overlay.dispose();
  });

  /**
   * Cards are transparent to the pointer so the canvas keeps owning gestures (05 §3), which means
   * the browser never hovers them. Hover therefore arrives from the engine's hit test.
   */
  it('marks the hovered card from the engine hit test, including a port or handle hit', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts, emitHover } = fakeEngine();
    render(<NodeHosts engine={engine} doc={doc} store={store} slotOf={(id) => slots.get(id)} />);
    act(() => emitHosts(ids));
    const first = ids[0] ?? '';
    const second = ids[1] ?? '';

    expect(screen.getByTestId(`node-card-${first}`)).not.toHaveAttribute('data-hover');

    act(() => emitHover({ t: 'node', id: first }));
    expect(screen.getByTestId(`node-card-${first}`)).toHaveAttribute('data-hover', 'true');
    expect(screen.getByTestId(`node-card-${second}`)).not.toHaveAttribute('data-hover');

    // The port band sits on the card's own border, so a port hit keeps the rail reachable.
    act(() => emitHover({ t: 'port', id: second, anchor: { side: 'auto', t: 0.5 } }));
    expect(screen.getByTestId(`node-card-${second}`)).toHaveAttribute('data-hover', 'true');
    expect(screen.getByTestId(`node-card-${first}`)).not.toHaveAttribute('data-hover');

    act(() => emitHover({ t: 'handle', id: first, handle: 'se' }));
    expect(screen.getByTestId(`node-card-${first}`)).toHaveAttribute('data-hover', 'true');

    act(() => emitHover({ t: 'canvas' }));
    expect(screen.getByTestId(`node-card-${first}`)).not.toHaveAttribute('data-hover');
    act(() => emitHover({ t: 'edge', id: 'e_1' }));
    expect(screen.getByTestId(`node-card-${first}`)).not.toHaveAttribute('data-hover');
  });

  it('renders nothing without an engine', () => {
    const { doc, slots, store } = setup();
    render(<NodeHosts engine={null} doc={doc} store={store} slotOf={(id) => slots.get(id)} />);
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });
});

describe('NodeHosts in-place editing', () => {
  it('starts editing on Enter with one node selected, and stops on Escape', async () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    const id = ids[0] ?? '';
    // A text node is the only kind that can be edited in place.
    const note = createNode(
      doc,
      { type: 'note', x: 0, y: 0, title: 'Note' },
      { now: T0, makeId: () => 'n_note' },
    ).node;
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slots.set(note.id, slot);

    render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(nodeId) => slots.get(nodeId)}
        selectedIds={[note.id]}
      />,
    );
    act(() => emitHosts([id, note.id]));
    expect(screen.queryByTestId(`card-editor-${note.id}`)).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(await screen.findByTestId(`card-editor-${note.id}`)).toBeInTheDocument();
    // The editor is code-split, so the card shows its slot first and the surface a tick later.
    // Under coverage instrumentation that dynamic import is slow, hence the explicit timeout.
    expect(
      await screen.findByTestId(`richtext-${note.id}`, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();

    act(() => {
      screen
        .getByRole('textbox')
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    await waitFor(() =>
      expect(screen.queryByTestId(`card-editor-${note.id}`)).not.toBeInTheDocument(),
    );
  });

  /**
   * The double-click gesture is the engine's (the card cannot receive it while it is transparent to
   * the pointer), so the bridge listens for the intent the engine publishes instead.
   */
  it('starts editing on the engine begin-edit-text intent', async () => {
    const { doc, slots, store } = setup();
    const { engine, emitHosts, emitIntent } = fakeEngine();
    const note = createNode(
      doc,
      { type: 'note', x: 0, y: 0, title: 'Note' },
      { now: T0, makeId: () => 'n_note_intent' },
    ).node;
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slots.set(note.id, slot);

    render(
      <NodeHosts engine={engine} doc={doc} store={store} slotOf={(nodeId) => slots.get(nodeId)} />,
    );
    act(() => emitHosts([note.id]));
    expect(screen.queryByTestId(`card-editor-${note.id}`)).not.toBeInTheDocument();

    act(() => emitIntent({ t: 'begin-edit-text', id: note.id }));
    expect(await screen.findByTestId(`card-editor-${note.id}`)).toBeInTheDocument();
  });

  /** Enter also confirms a pending connection (P5 §6); the editor must not steal it. */
  it('leaves Enter to the engine while a connection is pending', () => {
    const { doc, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine('connecting');
    const note = createNode(
      doc,
      { type: 'note', x: 0, y: 0, title: 'Note' },
      { now: T0, makeId: () => 'n_note_connect' },
    ).node;
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slots.set(note.id, slot);

    render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(nodeId) => slots.get(nodeId)}
        selectedIds={[note.id]}
      />,
    );
    act(() => emitHosts([note.id]));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(screen.queryByTestId(`card-editor-${note.id}`)).not.toBeInTheDocument();
  });

  it('ignores Enter while a form field has focus, and with a multi-selection', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(nodeId) => slots.get(nodeId)}
        selectedIds={ids}
      />,
    );
    act(() => emitHosts(ids));
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(document.querySelector('.nx-card-editor')).toBeNull();
    input.remove();
  });

  it('never starts editing a type that has no text body', () => {
    const { doc, ids, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(id) => slots.get(id)}
        selectedIds={[ids[0] ?? '']}
      />,
    );
    act(() => emitHosts(ids));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    // The seeded nodes are websites: the Edit affordance is absent and Enter does nothing.
    expect(document.querySelector('.nx-card-editor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
  });

  it('drops the editing state when the engine stops hosting the node', async () => {
    const { doc, slots, store } = setup();
    const { engine, emitHosts } = fakeEngine();
    const note = createNode(
      doc,
      { type: 'note', x: 0, y: 0, title: 'Note' },
      { now: T0, makeId: () => 'n_note2' },
    ).node;
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slots.set(note.id, slot);

    render(
      <NodeHosts
        engine={engine}
        doc={doc}
        store={store}
        slotOf={(nodeId) => slots.get(nodeId)}
        selectedIds={[note.id]}
      />,
    );
    act(() => emitHosts([note.id]));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(
      await screen.findByTestId(`card-editor-${note.id}`, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();

    act(() => emitHosts([]));
    await waitFor(() =>
      expect(screen.queryByTestId(`card-editor-${note.id}`)).not.toBeInTheDocument(),
    );
  });
});
