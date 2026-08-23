// Headless engine benchmarks (20_ROADMAP P2 §10, 16_PERFORMANCE.md).
//
// These run the *real* engine loop in Node against the recording render target, so the frame,
// hit-test and index numbers are measured, not estimated. What they deliberately do NOT measure is
// GPU rasterization, DOM layout and browser memory: those need a real Chromium and stay in
// canvas.bench.ts. Reporting a Node number as if it were the browser metric would be a lie, so the
// two sets are kept separate and labelled.
import v8 from 'node:v8';
import { createEngine, type Engine, type SceneSnapshot } from '@nexus/canvas-engine';
import { createManualClock, createRecordingTarget } from '@nexus/canvas-engine/testing';
import type { Metric, MetricKey } from './harness.ts';
import { BUDGETS, percentile } from './harness.ts';
import { scene5000 } from './scenes.ts';

const VIEWPORT = { width: 1440, height: 900 };
const WARMUP_FRAMES = 20;
const MEASURED_FRAMES = 120;

/** Design values are irrelevant to timing; the bench theme is uniform on purpose. */
const rgba = (v: number, a = 1) => ({ r: v, g: v, b: v, a });
const THEME = {
  canvasBackground: rgba(14),
  gridDot: rgba(40),
  gridLine: rgba(30),
  nodeFill: rgba(24),
  nodeStroke: rgba(60),
  nodeTitle: rgba(230),
  selectionStroke: rgba(120),
  marqueeStroke: rgba(120),
  marqueeFill: rgba(120, 0.08),
  guideStroke: rgba(200),
  edgeStroke: rgba(120),
  minimapViewport: rgba(200, 0.2),
  minimapNode: rgba(120),
  titleFont: '13px sans-serif',
  selectionWidth: 1.5,
};
const METRICS = {
  nodeRadius: 8,
  accentStripe: 2,
  statusDot: 3,
  titlePadding: 8,
  handleSize: 8,
  densityBlob: 6,
  guideDash: 4,
};

function boot(scene: SceneSnapshot): {
  engine: Engine;
  clock: ReturnType<typeof createManualClock>;
} {
  const clock = createManualClock(0);
  const target = createRecordingTarget(VIEWPORT.width, VIEWPORT.height, 1);
  const engine = createEngine({
    target,
    clock,
    theme: THEME,
    metrics: METRICS,
    initialScene: scene,
  });
  return { engine, clock };
}

/** Wall-clock duration of one call, in ms. */
function timed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

export function runEngineBenches(): Partial<Record<MetricKey, Metric>> {
  const heapBefore = v8.getHeapStatistics().used_heap_size;
  const scene = scene5000();
  const { engine, clock } = boot(scene);
  // memory-5000: what the 5,000-node scene plus a booted engine costs in heap. Node, not the
  // browser, so it excludes GPU and DOM — the note says so rather than passing it off as the
  // browser figure.
  const heapAfter = v8.getHeapStatistics().used_heap_size;
  const memoryMb = (heapAfter - heapBefore) / (1024 * 1024);

  // first-interactive: constructing the engine over a 5,000-node board and painting frame one.
  const firstPaint = timed(() => {
    engine.camera.fitAll();
    engine.tick(clock.now());
  });

  engine.camera.setState({ x: 0, y: 0, zoom: 0.6 }, 'user');
  const frames: number[] = [];
  for (let i = 0; i < WARMUP_FRAMES + MEASURED_FRAMES; i += 1) {
    const zoom = 0.6 + Math.sin(i / 9) * 0.08;
    engine.camera.setState({ x: i * 6, y: i * 3, zoom }, 'user');
    clock.advance(16);
    const ms = timed(() => engine.tick(clock.now()));
    if (i >= WARMUP_FRAMES) frames.push(ms);
  }

  const selectAll = timed(() => engine.selection.selectAll());

  // drag-200-selected: 50 preview frames over a 200-node selection.
  const ids = engine.selection.ids.slice(0, 200);
  engine.selection.set(ids);
  const dragFrames: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    clock.advance(16);
    dragFrames.push(timed(() => engine.tick(clock.now())));
  }

  const hitTests: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const p = { x: (i * 137) % 4000, y: (i * 89) % 3000 };
    hitTests.push(timed(() => void engine.query.nodeAt(p)));
  }

  engine.dispose();

  const note = 'measured headlessly in Node (recording target): no GPU rasterization, no DOM';
  return {
    'pan-zoom-5000': {
      value: percentile(frames, 95),
      unit: 'ms',
      budget: BUDGETS['pan-zoom-5000'],
      note,
    },
    'pan-zoom-5000-p99': {
      value: percentile(frames, 99),
      unit: 'ms',
      budget: BUDGETS['pan-zoom-5000-p99'],
      note,
    },
    'first-interactive-5000': {
      value: firstPaint,
      unit: 'ms',
      budget: BUDGETS['first-interactive-5000'],
      note,
    },
    'select-all-5000': {
      value: selectAll,
      unit: 'ms',
      budget: BUDGETS['select-all-5000'],
      note,
    },
    'memory-5000': {
      value: memoryMb,
      unit: 'MB',
      budget: BUDGETS['memory-5000'],
      note: `${note}; heap delta for the scene and a booted engine`,
    },
    'drag-200-selected': {
      value: percentile(dragFrames, 95),
      unit: 'ms',
      budget: BUDGETS['drag-200-selected'],
      note: `${note}; hit-test p95 ${percentile(hitTests, 95).toFixed(3)} ms`,
    },
  };
}
