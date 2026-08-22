/**
 * The board surface: one canvas, one absolutely-positioned DOM overlay for near-zoom node hosts,
 * the zoom cluster and the empty-board teaching state (20_ROADMAP P2 §6).
 *
 * React renders this shell exactly once per mount; every frame after that is painted by the engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useCanvasEngine } from './useCanvasEngine';
import { MINIMAP_HEIGHT, MINIMAP_WIDTH, useMinimap } from './useMinimap';
import type { Engine, Intent, SceneSnapshot } from '@nexus/canvas-engine';

const ZOOM_STOPS = [0.25, 0.5, 1, 2] as const;

export interface CanvasHostProps {
  scene?: SceneSnapshot;
  /** Rendered above the canvas; receives the overlay slot lookup for the node card portals. */
  children?:
    | ((api: {
        slotOf: (id: string) => HTMLElement | undefined;
        screenOf: (world: { x: number; y: number }) => { x: number; y: number };
      }) => React.ReactNode)
    | undefined;
  /** Engine intents, forwarded to the document binding (P3 §5.14). */
  onIntent?: ((intent: Intent) => void) | undefined;
  /** Called once the engine exists, so the page can push scene patches into it. */
  onEngine?: ((engine: Engine | null) => void) | undefined;
  /**
   * Authoritative node count from the document. The host tracks the engine's own count, but a page
   * that pushes scene patches (the board) knows the truth first — without this the teaching hint
   * stays on top of the first note the user creates.
   */
  nodeCount?: number | undefined;
  /** True while a non-canvas view mode covers the canvas: hide it from focus and assistive tech. */
  inert?: boolean | undefined;
}

export function CanvasHost({
  scene,
  onIntent,
  onEngine,
  children,
  nodeCount: nodeCountProp,
  inert = false,
}: CanvasHostProps) {
  const {
    canvasRef,
    overlayRef,
    engineRef,
    zoom,
    nodeCount: engineNodeCount,
    slotOf,
    screenOf,
    setBundleDensity,
  } = useCanvasEngine({
    ...(scene === undefined ? {} : { scene }),
    ...(onIntent === undefined ? {} : { onIntent }),
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  // Called after useCanvasEngine so the engine already exists when this effect runs.
  useMinimap(engineRef, minimapRef);
  // Bundling is off at 0, which is where it starts: a fan of parallel relationships is information,
  // and collapsing it is a choice the analyst makes (07 §7.6, P5 part 4 §4).
  const [bundleDensity, setDensity] = useState(0);
  const [minimapVisible, setMinimapVisible] = useState(true);
  const nodeCount = nodeCountProp ?? engineNodeCount;

  // The engine is created in an effect inside the hook, so it exists on the first commit.
  useEffect(() => {
    onEngine?.(engineRef.current);
    return () => onEngine?.(null);
  }, [engineRef, onEngine]);

  // `M` hides and shows the minimap. Typing must never reach it, so a focused field wins (§7.6).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'm' && event.key !== 'M') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) return;
      setMinimapVisible((visible) => !visible);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const centre = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
  }, [canvasRef]);

  const zoomTo = useCallback(
    (value: number) => engineRef.current?.camera.zoomTo(value, centre()),
    [engineRef, centre],
  );

  return (
    <div ref={rootRef} className="nx-canvas-host" data-testid="canvas-host" inert={inert}>
      <div
        role="application"
        aria-roledescription="Research canvas"
        aria-label="Board canvas. Drag to pan, scroll to zoom, drag on empty space to select."
        className="nx-canvas-stack"
      >
        <canvas
          ref={canvasRef}
          data-testid="canvas-surface"
          tabIndex={0}
          aria-label="Board canvas. Drag to pan, scroll to zoom, drag on empty space to select."
          className="nx-canvas-surface"
        />
        {/* Node hosts are mounted here by the engine's overlay; React never touches its children. */}
        <div ref={overlayRef} data-testid="canvas-overlay" className="nx-canvas-overlay" />
        {children?.({ slotOf, screenOf })}
        <canvas
          ref={minimapRef}
          data-testid="canvas-minimap"
          className="nx-minimap"
          width={MINIMAP_WIDTH}
          height={MINIMAP_HEIGHT}
          hidden={!minimapVisible}
          aria-label="Board minimap. Click or drag to move the view, scroll to zoom."
        />
        {nodeCount === 0 ? (
          <p className="nx-canvas-empty" data-testid="canvas-empty">
            Paste a link, drop a file, or press N for a note
          </p>
        ) : null}
      </div>

      <div className="nx-zoom-cluster" role="group" aria-label="Zoom controls">
        <button
          type="button"
          onClick={() => engineRef.current?.camera.zoomBy(-1, centre())}
          aria-label="Zoom out"
        >
          −
        </button>
        <select
          aria-label="Zoom level"
          value={ZOOM_STOPS.find((s) => Math.abs(s - zoom) < 0.001) ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'fit') engineRef.current?.camera.fitAll();
            else zoomTo(Number(value));
          }}
        >
          <option value="">{Math.round(zoom * 100)}%</option>
          {ZOOM_STOPS.map((stop) => (
            <option key={stop} value={stop}>
              {stop * 100}%
            </option>
          ))}
          <option value="fit">Fit</option>
        </select>
        <button
          type="button"
          onClick={() => engineRef.current?.camera.zoomBy(1, centre())}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>

      <div className="nx-zoom-cluster" role="group" aria-label="Edge bundling">
        <label htmlFor="edge-bundling">Bundling</label>
        <input
          id="edge-bundling"
          type="range"
          min={0}
          max={100}
          step={10}
          value={bundleDensity * 100}
          onChange={(event) => {
            const next = Number(event.target.value) / 100;
            setDensity(next);
            setBundleDensity(next);
          }}
        />
        <span className="nx-card-meta">
          {bundleDensity === 0 ? 'off' : `${String(Math.round(bundleDensity * 100))}%`}
        </span>
      </div>
    </div>
  );
}
