/**
 * The interaction finite state machine (05_CANVAS_ENGINE.md §7, roadmap P2 requirements 9–13).
 *
 * One state variable, one pure reducer, effects returned as data. Nothing here touches the DOM, the
 * camera or the document: the caller executes the effects. That is what makes every transition —
 * including the cancel paths — testable in plain Node.
 *
 * Deliberate deviations from 05 §7.5, both in favour of the numbered roadmap requirements:
 *  - a press on empty canvas goes through `pressPending` first and only becomes `marquee` after
 *    DRAG_THRESHOLD_PX, so that *no* selection mutation happens before the threshold (req 10);
 *  - marquee contain-mode is `Alt` (req 11), not `Ctrl` as §7.5 says.
 */

import type {
  AnchorSpec,
  EntityId,
  HitTarget,
  Intent,
  NodeId,
  NodeView,
  Rect,
  ResizeHandle,
  SceneQuery,
  SelectionMode,
  Vec2,
} from '../types';
import { CONNECT_CANDIDATE_LIMIT, DRAG_THRESHOLD_PX, MIN_NODE_SIZE } from '../constants';
import type { GuideLine } from './snapping';
import { snapDrag } from './snapping';

/* -------------------------------------------------------------------- state */

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export interface NodePosition {
  id: NodeId;
  x: number;
  y: number;
}

export type FsmState =
  | { name: 'idle' }
  | { name: 'hover'; target: HitTarget }
  | { name: 'spacePan' }
  | {
      name: 'pressPending';
      pointerId: number;
      screen: Vec2;
      world: Vec2;
      target: HitTarget;
      mode: SelectionMode;
      time: number;
      /** Set when the press started while Space was latched, so we return to `spacePan`. */
      fromSpace: boolean;
    }
  | { name: 'panning'; pointerId: number; screen: Vec2; fromSpace: boolean }
  | {
      name: 'marquee';
      pointerId: number;
      origin: Vec2;
      current: Vec2;
      mode: SelectionMode;
      contain: boolean;
    }
  | {
      name: 'draggingNodes';
      pointerId: number;
      origin: Vec2;
      ids: readonly NodeId[];
      snapshot: readonly NodePosition[];
      box: Rect;
      delta: Vec2;
      fromSpace: boolean;
    }
  | {
      name: 'resizing';
      pointerId: number;
      id: NodeId;
      handle: ResizeHandle;
      origin: Vec2;
      start: Rect;
      current: Rect;
    }
  | {
      name: 'connecting';
      pointerId: number;
      from: NodeId;
      fromAnchor: AnchorSpec;
      current: Vec2;
      /** Pointer drags follow the cursor; keyboard connections step through `candidates`. */
      via: 'pointer' | 'keyboard';
      candidates: readonly NodeId[];
      candidateIndex: number;
    }
  | {
      name: 'draggingWaypoint';
      pointerId: number;
      edgeId: string;
      index: number;
      current: Vec2;
    }
  | { name: 'editing'; id: NodeId };

export type FsmStateName = FsmState['name'];

export const initialState: FsmState = { name: 'idle' };

/* -------------------------------------------------------------------- events */

interface PointerFields {
  pointerId: number;
  button: number;
  screen: Vec2;
  world: Vec2;
  target: HitTarget;
  mods: Modifiers;
  time: number;
}

export type FsmEvent =
  | ({ t: 'pointerdown' } & PointerFields)
  | ({ t: 'pointermove' } & PointerFields)
  | ({ t: 'pointerup' } & PointerFields)
  | { t: 'pointercancel'; pointerId: number }
  | { t: 'pointerleave' }
  | { t: 'blur' }
  | { t: 'dblclick'; world: Vec2; target: HitTarget }
  | { t: 'longpress'; world: Vec2; target: HitTarget }
  | { t: 'contextmenu'; world: Vec2; target: HitTarget }
  | { t: 'wheel'; mode: 'zoom' | 'pan'; deltaX: number; deltaY: number; anchorScreen: Vec2 }
  | { t: 'pinch'; factor: number; anchorScreen: Vec2; panScreen: Vec2 }
  | { t: 'keydown'; key: string; mods: Modifiers; repeat: boolean }
  | { t: 'keyup'; key: string; mods: Modifiers }
  | { t: 'edit-end'; commit: boolean };

/* ------------------------------------------------------------------- effects */

export type CameraCommand = 'fit-all' | 'fit-selection' | 'zoom-100' | 'zoom-in' | 'zoom-out';

export type Effect =
  | { t: 'intent'; intent: Intent }
  | { t: 'capture'; pointerId: number }
  | { t: 'release'; pointerId: number }
  /** Rubber-band rect in world px, `null` clears it. */
  | { t: 'marquee'; rect: Rect | null }
  | { t: 'guides'; guides: readonly GuideLine[] }
  /** Visual-only transform of the dragged selection; nothing is committed (req 13). */
  | { t: 'preview-move'; ids: readonly NodeId[]; dx: number; dy: number }
  | { t: 'restore-geometry'; positions: readonly NodePosition[] }
  | { t: 'camera-pan'; dxScreen: number; dyScreen: number }
  | { t: 'camera-zoom'; steps: number; anchorScreen: Vec2 }
  | { t: 'camera-zoom-factor'; factor: number; anchorScreen: Vec2 }
  | { t: 'camera-command'; cmd: CameraCommand }
  | { t: 'focus-editor'; id: NodeId };

export interface FsmResult {
  state: FsmState;
  effects: readonly Effect[];
}

/**
 * Read-only view of everything outside the FSM that a transition needs (05 §7.1 `(state, event,
 * ctx)`). It is queried, never mutated.
 */
export interface FsmContext {
  scene: SceneQuery;
  selection: readonly EntityId[];
  zoom: number;
  /** Viewport in world px; snap candidates come from it plus a margin. */
  viewportWorld: Rect;
  features: { snapToGrid: boolean; alignmentGuides: boolean };
}

/* ------------------------------------------------------------------ helpers */

const NUDGE_PX = 1;
const NUDGE_SHIFT_PX = 10;
/** Snap candidates come from the viewport inflated by this much (05 §7.8). */
const SNAP_MARGIN_PX = 256;

const result = (state: FsmState, effects: readonly Effect[] = []): FsmResult => ({
  state,
  effects,
});

const intent = (i: Intent): Effect => ({ t: 'intent', intent: i });

const primaryMod = (mods: Modifiers): boolean => mods.ctrl || mods.meta;

const modeFor = (mods: Modifiers): SelectionMode =>
  mods.shift ? 'toggle' : mods.alt ? 'subtract' : 'replace';

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

const rectBetween = (a: Vec2, b: Vec2): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

const isNodeTarget = (t: HitTarget): t is { t: 'node'; id: NodeId } => t.t === 'node';

/** Nodes and edges are both selectable; ports and handles are affordances, not entities. */
const selectableId = (t: HitTarget): EntityId | null =>
  t.t === 'node' || t.t === 'edge' ? t.id : null;

const selectedNodes = (ctx: FsmContext): NodeView[] => {
  const out: NodeView[] = [];
  for (const id of ctx.selection) {
    const node = ctx.scene.node(id);
    if (node !== undefined) out.push(node);
  }
  return out;
};

const boundsOf = (nodes: readonly NodeView[]): Rect => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

/**
 * §7.11: dragging a node outside the selection replaces the selection with it; dragging one inside
 * it drags the whole selection. Locked nodes never move.
 */
function resolveDragSet(
  ctx: FsmContext,
  pressed: NodeId,
): { nodes: NodeView[]; replaced: boolean } {
  const inSelection = ctx.selection.includes(pressed);
  if (inSelection) return { nodes: selectedNodes(ctx).filter((n) => !n.locked), replaced: false };
  const node = ctx.scene.node(pressed);
  return { nodes: node === undefined || node.locked ? [] : [node], replaced: true };
}

function snapCandidates(ctx: FsmContext): readonly NodeView[] {
  return ctx.scene.nodesIn(inflate(ctx.viewportWorld, SNAP_MARGIN_PX));
}

/** The one `abortGesture()` of 05 §7.5: identical for Escape, pointercancel, blur and disable. */
function abort(state: FsmState): FsmResult {
  switch (state.name) {
    case 'draggingNodes':
      return result({ name: 'idle' }, [
        { t: 'release', pointerId: state.pointerId },
        intent({ t: 'move-nodes', deltas: [], phase: 'cancel' }),
        { t: 'restore-geometry', positions: state.snapshot },
        { t: 'preview-move', ids: state.ids, dx: 0, dy: 0 },
        { t: 'guides', guides: [] },
      ]);
    case 'resizing':
      return result({ name: 'idle' }, [
        { t: 'release', pointerId: state.pointerId },
        intent({
          t: 'resize-node',
          id: state.id,
          w: state.start.w,
          h: state.start.h,
          x: state.start.x,
          y: state.start.y,
          phase: 'cancel',
        }),
        {
          t: 'restore-geometry',
          positions: [{ id: state.id, x: state.start.x, y: state.start.y }],
        },
      ]);
    case 'marquee':
      return result({ name: 'idle' }, [
        { t: 'release', pointerId: state.pointerId },
        { t: 'marquee', rect: null },
      ]);
    case 'panning':
      return result({ name: state.fromSpace ? 'spacePan' : 'idle' }, [
        { t: 'release', pointerId: state.pointerId },
      ]);
    case 'connecting':
    case 'pressPending':
      return result({ name: 'idle' }, [{ t: 'release', pointerId: state.pointerId }]);
    case 'draggingWaypoint':
      // A cancelled waypoint drag reverts through undo of the interim writes, like a node drag.
      return result({ name: 'idle' }, [
        { t: 'release', pointerId: state.pointerId },
        intent({
          t: 'edge-waypoint',
          op: 'move',
          edgeId: state.edgeId,
          index: state.index,
          at: state.current,
          phase: 'cancel',
        }),
      ]);
    case 'editing':
    case 'idle':
    case 'hover':
    case 'spacePan':
      return result({ name: 'idle' });
  }
}

/* --------------------------------------------------------------- transitions */

function onPointerDown(
  state: FsmState,
  e: FsmEvent & { t: 'pointerdown' },
  ctx: FsmContext,
): FsmResult {
  if (state.name === 'editing') {
    // Click-away commits the editor (§7.5 last-but-one row) and the press is consumed.
    return result({ name: 'idle' }, []);
  }
  // Middle button, or Space latched: camera pan.
  if (e.button === 1 || state.name === 'spacePan') {
    return result(
      {
        name: 'panning',
        pointerId: e.pointerId,
        screen: e.screen,
        fromSpace: state.name === 'spacePan',
      },
      [{ t: 'capture', pointerId: e.pointerId }],
    );
  }
  if (e.button !== 0) return result(state);

  if (e.target.t === 'handle' && ctx.selection.length === 1) {
    const node = ctx.scene.node(e.target.id);
    if (node !== undefined && !node.locked) {
      const start: Rect = { x: node.x, y: node.y, w: node.w, h: node.h };
      return result(
        {
          name: 'resizing',
          pointerId: e.pointerId,
          id: e.target.id,
          handle: e.target.handle,
          origin: e.world,
          start,
          current: start,
        },
        [{ t: 'capture', pointerId: e.pointerId }],
      );
    }
  }
  if (e.target.t === 'waypoint') {
    return result(
      {
        name: 'draggingWaypoint',
        pointerId: e.pointerId,
        edgeId: e.target.id,
        index: e.target.index,
        current: e.world,
      },
      [
        { t: 'capture', pointerId: e.pointerId },
        intent({
          t: 'edge-waypoint',
          op: 'move',
          edgeId: e.target.id,
          index: e.target.index,
          at: e.world,
          phase: 'start',
        }),
      ],
    );
  }
  if (e.target.t === 'port') {
    return result(
      {
        name: 'connecting',
        pointerId: e.pointerId,
        from: e.target.id,
        fromAnchor: e.target.anchor,
        current: e.world,
        via: 'pointer',
        candidates: [],
        candidateIndex: -1,
      },
      [{ t: 'capture', pointerId: e.pointerId }],
    );
  }

  // Node or empty canvas: both wait for the drag threshold before mutating anything (req 10).
  return result(
    {
      name: 'pressPending',
      pointerId: e.pointerId,
      screen: e.screen,
      world: e.world,
      target: e.target,
      mode: modeFor(e.mods),
      time: e.time,
      fromSpace: false,
    },
    [{ t: 'capture', pointerId: e.pointerId }],
  );
}

function beginDrag(
  press: FsmState & { name: 'pressPending' },
  e: FsmEvent & { t: 'pointermove' },
  ctx: FsmContext,
  pressed: NodeId,
): FsmResult {
  const { nodes, replaced } = resolveDragSet(ctx, pressed);
  if (nodes.length === 0) {
    // Locked (or vanished) node: the gesture degrades to a marquee (§7.7) instead of dead-ending.
    return result(
      {
        name: 'marquee',
        pointerId: press.pointerId,
        origin: press.world,
        current: e.world,
        mode: press.mode === 'toggle' ? 'add' : 'replace',
        contain: e.mods.alt,
      },
      [{ t: 'marquee', rect: rectBetween(press.world, e.world) }],
    );
  }
  const ids = nodes.map((n) => n.id);
  const effects: Effect[] = [];
  if (replaced) effects.push(intent({ t: 'select', ids: [pressed], mode: 'replace' }));
  effects.push(intent({ t: 'move-nodes', deltas: [], phase: 'start' }));
  return result(
    {
      name: 'draggingNodes',
      pointerId: press.pointerId,
      origin: press.world,
      ids,
      snapshot: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      box: boundsOf(nodes),
      delta: { x: 0, y: 0 },
      fromSpace: press.fromSpace,
    },
    effects,
  );
}

function resizeRect(start: Rect, handle: ResizeHandle, dx: number, dy: number): Rect {
  const left = handle === 'nw' || handle === 'w' || handle === 'sw';
  const right = handle === 'ne' || handle === 'e' || handle === 'se';
  const top = handle === 'nw' || handle === 'n' || handle === 'ne';
  const bottom = handle === 'sw' || handle === 's' || handle === 'se';

  let { x, y, w, h } = start;
  if (left) {
    w = Math.max(MIN_NODE_SIZE, start.w - dx);
    x = start.x + start.w - w;
  } else if (right) {
    w = Math.max(MIN_NODE_SIZE, start.w + dx);
  }
  if (top) {
    h = Math.max(MIN_NODE_SIZE, start.h - dy);
    y = start.y + start.h - h;
  } else if (bottom) {
    h = Math.max(MIN_NODE_SIZE, start.h + dy);
  }
  return { x, y, w, h };
}

function onPointerMove(
  state: FsmState,
  e: FsmEvent & { t: 'pointermove' },
  ctx: FsmContext,
): FsmResult {
  switch (state.name) {
    case 'idle':
    case 'hover':
      return result(
        e.target.t === 'canvas' ? { name: 'idle' } : { name: 'hover', target: e.target },
      );

    case 'spacePan':
    case 'editing':
      return result(state);

    case 'pressPending': {
      if (dist(state.screen, e.screen) <= DRAG_THRESHOLD_PX) return result(state);
      if (isNodeTarget(state.target)) {
        const started = beginDrag(state, e, ctx, state.target.id);
        if (started.state.name !== 'draggingNodes') return started; // locked → marquee
        // The move that crossed the threshold is also the first drag move.
        const first = onPointerMove(started.state, e, ctx);
        return result(first.state, [...started.effects, ...first.effects]);
      }
      return result(
        {
          name: 'marquee',
          pointerId: state.pointerId,
          origin: state.world,
          current: e.world,
          // Marquee modes are Shift = add, Alt = contain (req 11); Alt does not subtract here.
          mode: state.mode === 'toggle' ? 'add' : 'replace',
          contain: e.mods.alt,
        },
        [{ t: 'marquee', rect: rectBetween(state.world, e.world) }],
      );
    }

    case 'panning':
      return result({ ...state, screen: e.screen }, [
        {
          t: 'camera-pan',
          dxScreen: e.screen.x - state.screen.x,
          dyScreen: e.screen.y - state.screen.y,
        },
      ]);

    case 'marquee': {
      const rect = rectBetween(state.origin, e.world);
      return result({ ...state, current: e.world, contain: e.mods.alt }, [{ t: 'marquee', rect }]);
    }

    case 'draggingNodes': {
      const raw = { x: e.world.x - state.origin.x, y: e.world.y - state.origin.y };
      const snapped = snapDrag({
        box: state.box,
        delta: raw,
        candidates: ctx.features.alignmentGuides ? snapCandidates(ctx) : [],
        moving: new Set(state.ids),
        zoom: ctx.zoom,
        gridSnap: ctx.features.snapToGrid,
        objectSnap: ctx.features.alignmentGuides,
        suspend: primaryMod(e.mods),
      });
      return result({ ...state, delta: snapped.delta }, [
        { t: 'preview-move', ids: state.ids, dx: snapped.delta.x, dy: snapped.delta.y },
        { t: 'guides', guides: snapped.guides },
        // Visual-only phase: the deltas ride the `end` event so the host commits one patch (req 13).
        intent({ t: 'move-nodes', deltas: [], phase: 'update' }),
      ]);
    }

    case 'resizing': {
      const rect = resizeRect(
        state.start,
        state.handle,
        e.world.x - state.origin.x,
        e.world.y - state.origin.y,
      );
      return result({ ...state, current: rect }, [
        intent({
          t: 'resize-node',
          id: state.id,
          w: rect.w,
          h: rect.h,
          x: rect.x,
          y: rect.y,
          phase: 'update',
        }),
      ]);
    }

    case 'draggingWaypoint':
      return result({ ...state, current: e.world }, [
        intent({
          t: 'edge-waypoint',
          op: 'move',
          edgeId: state.edgeId,
          index: state.index,
          at: e.world,
          phase: 'update',
        }),
      ]);

    case 'connecting':
      return result({ ...state, current: e.world });
  }
}

function onPointerUp(
  state: FsmState,
  e: FsmEvent & { t: 'pointerup' },
  ctx: FsmContext,
): FsmResult {
  const release: Effect = { t: 'release', pointerId: e.pointerId };
  switch (state.name) {
    case 'pressPending': {
      const target = state.target;
      const picked = selectableId(target);
      const rest: FsmState = picked === null ? { name: 'idle' } : { name: 'hover', target };
      const ids = picked === null ? [] : [picked];
      // Click on empty canvas clears; shift/alt-click on empty canvas keeps the selection.
      if (ids.length === 0 && state.mode !== 'replace') return result(rest, [release]);
      return result(rest, [release, intent({ t: 'select', ids, mode: state.mode })]);
    }

    case 'draggingNodes': {
      const deltas = state.ids.map((id) => ({ id, dx: state.delta.x, dy: state.delta.y }));
      return result({ name: state.fromSpace ? 'spacePan' : 'idle' }, [
        release,
        intent({ t: 'move-nodes', deltas, phase: 'end' }),
        { t: 'guides', guides: [] },
      ]);
    }

    case 'marquee': {
      const rect = rectBetween(state.origin, e.world);
      const hits = state.contain ? ctx.scene.nodesContainedIn(rect) : ctx.scene.nodesIn(rect);
      return result({ name: 'idle' }, [
        release,
        { t: 'marquee', rect: null },
        intent({ t: 'select', ids: hits.map((n) => n.id), mode: state.mode }),
      ]);
    }

    case 'draggingWaypoint':
      return result({ name: 'idle' }, [
        release,
        intent({
          t: 'edge-waypoint',
          op: 'move',
          edgeId: state.edgeId,
          index: state.index,
          at: e.world,
          phase: 'end',
        }),
      ]);

    case 'panning':
      return result({ name: state.fromSpace ? 'spacePan' : 'idle' }, [release]);

    case 'resizing':
      return result({ name: 'idle' }, [
        release,
        intent({
          t: 'resize-node',
          id: state.id,
          w: state.current.w,
          h: state.current.h,
          x: state.current.x,
          y: state.current.y,
          phase: 'end',
        }),
      ]);

    case 'connecting': {
      const to = e.target;
      if (to.t === 'port' && to.id !== state.from) {
        return result({ name: 'idle' }, [
          release,
          intent({
            t: 'create-edge',
            from: state.from,
            fromAnchor: state.fromAnchor,
            to: to.id,
            toAnchor: to.anchor,
          }),
        ]);
      }
      if (isNodeTarget(to) && to.id !== state.from) {
        return result({ name: 'idle' }, [
          release,
          intent({
            t: 'create-edge',
            from: state.from,
            fromAnchor: state.fromAnchor,
            to: to.id,
            toAnchor: { side: 'auto', t: 0.5 },
          }),
        ]);
      }
      if (to.t === 'canvas') {
        // Dropping into the void is a creation gesture, not a cancel: the host offers the quick
        // menu at the drop point (P5 §5.3). Escape and pointercancel still cancel outright.
        return result({ name: 'idle' }, [
          release,
          intent({
            t: 'connect-to-empty',
            from: state.from,
            fromAnchor: state.fromAnchor,
            at: e.world,
          }),
        ]);
      }
      return result({ name: 'idle' }, [release]);
    }

    case 'editing':
      return result(state, [release]); // release the capture the consumed press took

    case 'idle':
    case 'hover':
    case 'spacePan':
      return result(state);
  }
}

function nudge(ctx: FsmContext, dx: number, dy: number): FsmResult {
  const deltas = selectedNodes(ctx)
    .filter((n) => !n.locked)
    .map((n) => ({ id: n.id, dx, dy }));
  if (deltas.length === 0) return result({ name: 'idle' });
  // A nudge is atomic: one patch, no start/update phases.
  return result({ name: 'idle' }, [intent({ t: 'move-nodes', deltas, phase: 'end' })]);
}

const centreOf = (n: NodeView): Vec2 => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

/**
 * Targets offered to a keyboard connection: visible, unlocked nodes ordered by distance from the
 * source (P5 §6 "Tab cycles candidate targets by proximity"). Proximity, not document order, is
 * what makes the first candidate the one the analyst means.
 */
function connectCandidates(ctx: FsmContext, from: NodeView): NodeId[] {
  const origin = centreOf(from);
  return ctx.scene
    .nodesIn(inflate(ctx.viewportWorld, SNAP_MARGIN_PX))
    .filter((n) => n.id !== from.id && !n.hidden)
    .map((n) => ({ id: n.id, d: dist(origin, centreOf(n)) }))
    .sort((a, b) => (a.d === b.d ? (a.id < b.id ? -1 : 1) : a.d - b.d))
    .slice(0, CONNECT_CANDIDATE_LIMIT)
    .map((entry) => entry.id);
}

/** Places the free end on the current candidate; an empty candidate list parks it on the source. */
function aimAtCandidate(
  state: FsmState & { name: 'connecting' },
  ctx: FsmContext,
  index: number,
): FsmResult {
  const id = state.candidates[index];
  const node = id === undefined ? undefined : ctx.scene.node(id);
  const source = ctx.scene.node(state.from);
  const current =
    node !== undefined ? centreOf(node) : source !== undefined ? centreOf(source) : state.current;
  return result({ ...state, candidateIndex: index, current });
}

/** `C`, `Tab`, `Enter`: the keyboard half of edge creation (P5 §6, N6 full operability). */
function onConnectKey(
  state: FsmState & { name: 'connecting' },
  e: FsmEvent & { t: 'keydown' },
  ctx: FsmContext,
): FsmResult {
  if (state.via !== 'keyboard') return result(state);
  const count = state.candidates.length;
  if (e.key === 'Tab' && count > 0) {
    const step = e.mods.shift ? -1 : 1;
    return aimAtCandidate(state, ctx, (state.candidateIndex + step + count) % count);
  }
  if (e.key === 'Enter') {
    const id = state.candidates[state.candidateIndex];
    if (id === undefined || id === state.from) return result({ name: 'idle' });
    return result({ name: 'idle' }, [
      intent({
        t: 'create-edge',
        from: state.from,
        fromAnchor: state.fromAnchor,
        to: id,
        toAnchor: { side: 'auto', t: 0.5 },
      }),
    ]);
  }
  return result(state);
}

function startKeyboardConnect(state: FsmState, ctx: FsmContext): FsmResult {
  const anchorId = ctx.selection[ctx.selection.length - 1];
  const source = anchorId === undefined ? undefined : ctx.scene.node(anchorId);
  if (source === undefined) return result(state);
  const candidates = connectCandidates(ctx, source);
  const started: FsmState = {
    name: 'connecting',
    pointerId: -1,
    from: source.id,
    fromAnchor: { side: 'auto', t: 0.5 },
    current: centreOf(source),
    via: 'keyboard',
    candidates,
    candidateIndex: -1,
  };
  return candidates.length === 0 ? result(started) : aimAtCandidate(started, ctx, 0);
}

function onKeyDown(state: FsmState, e: FsmEvent & { t: 'keydown' }, ctx: FsmContext): FsmResult {
  if (state.name === 'editing') {
    // Shortcut shield (§7.6): only Escape reaches the engine while editing.
    return e.key === 'Escape' ? result({ name: 'idle' }) : result(state);
  }
  if (e.key === 'Escape') {
    if (state.name === 'idle' || state.name === 'hover' || state.name === 'spacePan') {
      return result(state, [intent({ t: 'select', ids: [], mode: 'replace' })]);
    }
    return abort(state);
  }
  if (e.key === ' ' && (state.name === 'idle' || state.name === 'hover')) {
    return result({ name: 'spacePan' });
  }
  if (state.name === 'connecting') return onConnectKey(state, e, ctx);
  if (
    (e.key === 'c' || e.key === 'C') &&
    !primaryMod(e.mods) &&
    (state.name === 'idle' || state.name === 'hover')
  ) {
    return startKeyboardConnect(state, ctx);
  }
  if (state.name !== 'idle' && state.name !== 'hover' && state.name !== 'spacePan') {
    return result(state); // mid-gesture: only Escape is honoured
  }

  if (primaryMod(e.mods)) {
    switch (e.key) {
      case 'a':
      case 'A':
        return result(state, [
          intent({
            t: 'select',
            ids: ctx.scene.nodesIn(ctx.scene.sceneBounds).map((n) => n.id),
            mode: 'replace',
          }),
        ]);
      default:
        return result(state);
    }
  }

  const step = e.mods.shift ? NUDGE_SHIFT_PX : NUDGE_PX;
  switch (e.key) {
    case 'ArrowLeft':
      return nudge(ctx, -step, 0);
    case 'ArrowRight':
      return nudge(ctx, step, 0);
    case 'ArrowUp':
      return nudge(ctx, 0, -step);
    case 'ArrowDown':
      return nudge(ctx, 0, step);
    case 'Delete':
    case 'Backspace':
      return ctx.selection.length === 0
        ? result(state)
        : result(state, [intent({ t: 'delete', ids: [...ctx.selection] })]);
    case '[':
      return result(state, [intent({ t: 'z-order', ids: [...ctx.selection], op: 'backward' })]);
    case ']':
      return result(state, [intent({ t: 'z-order', ids: [...ctx.selection], op: 'forward' })]);
    case 'Enter': {
      const anchor = ctx.selection[ctx.selection.length - 1];
      if (anchor === undefined || ctx.scene.node(anchor) === undefined) return result(state);
      return result({ name: 'editing', id: anchor }, [
        intent({ t: 'begin-edit-text', id: anchor }),
        { t: 'focus-editor', id: anchor },
      ]);
    }
    // `F` is the fit key every canvas tool has; `0` stays as the numeric-row equivalent.
    case 'f':
    case 'F':
      return result(state, [{ t: 'camera-command', cmd: 'fit-all' }]);
    // `H` latches hand/pan mode, the same state Space holds down, so it can be toggled hands-free.
    case 'h':
    case 'H':
      return result(state.name === 'spacePan' ? { name: 'idle' } : { name: 'spacePan' });
    case '0':
      return result(state, [{ t: 'camera-command', cmd: 'fit-all' }]);
    case '1':
      return result(state, [{ t: 'camera-command', cmd: 'zoom-100' }]);
    case '2':
      return result(state, [{ t: 'camera-command', cmd: 'fit-selection' }]);
    case '+':
    case '=':
      return result(state, [{ t: 'camera-command', cmd: 'zoom-in' }]);
    case '-':
      return result(state, [{ t: 'camera-command', cmd: 'zoom-out' }]);
    default:
      return result(state);
  }
}

/**
 * The whole interaction layer, as one pure function. `ctx` is a read-only view of the scene,
 * selection and camera; the reducer never mutates it and never performs a side effect.
 */
export function reduce(state: FsmState, event: FsmEvent, ctx: FsmContext): FsmResult {
  switch (event.t) {
    case 'pointerdown':
      return onPointerDown(state, event, ctx);
    case 'pointermove':
      return onPointerMove(state, event, ctx);
    case 'pointerup':
      return onPointerUp(state, event, ctx);
    case 'pointercancel':
    case 'blur':
      return abort(state);
    case 'pointerleave':
      return state.name === 'hover' ? result({ name: 'idle' }) : result(state);
    case 'keydown':
      return onKeyDown(state, event, ctx);
    case 'keyup':
      if (event.key === ' ' && state.name === 'spacePan') return result({ name: 'idle' });
      return result(state);
    case 'dblclick': {
      if (state.name === 'editing') return result(state);
      if (event.target.t === 'edge') {
        return result(state, [
          intent({ t: 'edge-waypoint', op: 'insert', edgeId: event.target.id, at: event.world }),
        ]);
      }
      if (!isNodeTarget(event.target)) return result(state);
      const node = ctx.scene.node(event.target.id);
      if (node === undefined || node.locked) return result(state);
      return result({ name: 'editing', id: node.id }, [
        intent({ t: 'begin-edit-text', id: node.id }),
        { t: 'focus-editor', id: node.id },
      ]);
    }
    case 'longpress':
    case 'contextmenu': {
      if (event.target.t === 'waypoint') {
        return result(state, [
          intent({
            t: 'edge-waypoint',
            op: 'delete',
            edgeId: event.target.id,
            index: event.target.index,
          }),
        ]);
      }
      // §7.5: the selection is left alone when the target is already selected.
      const effects: Effect[] = [];
      const picked = selectableId(event.target);
      if (picked !== null && !ctx.selection.includes(picked)) {
        effects.push(intent({ t: 'select', ids: [picked], mode: 'replace' }));
      }
      effects.push(intent({ t: 'context-menu', at: event.world, target: event.target }));
      return result(state.name === 'idle' ? state : { name: 'idle' }, effects);
    }
    case 'wheel':
      if (state.name === 'editing') return result(state);
      return event.mode === 'zoom'
        ? result(state, [
            { t: 'camera-zoom', steps: -event.deltaY, anchorScreen: event.anchorScreen },
          ])
        : result(state, [{ t: 'camera-pan', dxScreen: -event.deltaX, dyScreen: -event.deltaY }]);
    case 'pinch':
      if (state.name === 'editing') return result(state);
      return result(state, [
        { t: 'camera-pan', dxScreen: event.panScreen.x, dyScreen: event.panScreen.y },
        { t: 'camera-zoom-factor', factor: event.factor, anchorScreen: event.anchorScreen },
      ]);
    case 'edit-end':
      return state.name === 'editing' ? result({ name: 'idle' }) : result(state);
  }
}
