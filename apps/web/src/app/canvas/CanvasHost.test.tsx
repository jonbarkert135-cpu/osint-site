import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasHost } from './CanvasHost';
import type { Engine } from '@nexus/canvas-engine';

/**
 * jsdom has no 2D context, no rAF loop and no ResizeObserver: all three are faked so the mount,
 * resize and teardown paths of the host run for real (roadmap §11).
 */
const observe = vi.fn();
const disconnect = vi.fn();
let frameCb: FrameRequestCallback | null = null;

function fakeContext(): CanvasRenderingContext2D {
  return {
    canvas: { width: 800, height: 600 },
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 42 })),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) })),
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '13px sans-serif',
    textBaseline: 'middle',
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  frameCb = null;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameCb = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.__ravenBench;
});

describe('CanvasHost', () => {
  it('mounts the canvas, the overlay layer and the empty teaching state', () => {
    render(<CanvasHost />);

    expect(screen.getByTestId('canvas-surface')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty')).toBeInTheDocument();
    expect(screen.getByRole('application')).toHaveAttribute(
      'aria-roledescription',
      'Research canvas',
    );
    expect(observe).toHaveBeenCalled();
  });

  it('exposes the bench hook and keyboard-reachable zoom controls', () => {
    render(<CanvasHost />);

    expect(window.__ravenBench?.nodeCount).toBe(0);
    expect(window.__ravenBench?.frameTimes()).toEqual([]);

    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom level')).toBeInTheDocument();
  });

  it('paints a frame through the engine when the loop runs', () => {
    render(<CanvasHost />);
    frameCb?.(performance.now());
    expect(window.__ravenBench?.frameTimes().length).toBeGreaterThan(0);
  });

  it('mounts the minimap and moves the camera when it is clicked', () => {
    let engine: Engine | null = null;
    render(<CanvasHost onEngine={(e) => (engine = e ?? engine)} />);

    const minimap = screen.getByTestId('canvas-minimap');
    // jsdom has neither PointerEvent nor pointer capture.
    minimap.setPointerCapture = vi.fn();
    minimap.hasPointerCapture = vi.fn(() => false);
    const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 170, clientY: 110 });
    Object.defineProperty(down, 'pointerId', { value: 1 });

    const before = engine!.camera.state.x;
    minimap.dispatchEvent(down);

    expect(engine!.camera.state.x).not.toBe(before);
    expect(Number.isFinite(engine!.camera.state.x)).toBe(true);
  });

  it('zooms the board when the wheel is used over the minimap', () => {
    let engine: Engine | null = null;
    render(<CanvasHost onEngine={(e) => (engine = e ?? engine)} />);

    const before = engine!.camera.state.zoom;
    screen
      .getByTestId('canvas-minimap')
      .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));

    expect(engine!.camera.state.zoom).toBeGreaterThan(before);
  });

  it('hides and shows the minimap with M, but not while typing', () => {
    render(<CanvasHost />);
    expect(screen.getByTestId('canvas-minimap')).not.toHaveAttribute('hidden');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });
    expect(screen.getByTestId('canvas-minimap')).toHaveAttribute('hidden');

    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    expect(screen.getByTestId('canvas-minimap')).toHaveAttribute('hidden');
    field.remove();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M' }));
    });
    expect(screen.getByTestId('canvas-minimap')).not.toHaveAttribute('hidden');
  });

  it('tears the engine down on unmount', () => {
    const view = render(<CanvasHost />);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(window.__ravenBench).toBeUndefined();
  });
});
