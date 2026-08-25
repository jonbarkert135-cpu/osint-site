/**
 * The run console (Part 2 §24).
 *
 * A pull-up drawer at the foot of Ask Raven, the way an editor keeps its terminal: a thin handle
 * with an arrow, one click to raise it, one to fold it away. Inside is the plain truth of the run —
 * which transform is running, through which engine, on which input, and what came back — so the
 * automation is legible instead of magic. It is a log, not a control: nothing here writes.
 */

import { useEffect, useRef } from 'react';

import type { ConsoleLine } from './useQueryRun.ts';

export interface RunConsoleProps {
  readonly lines: readonly ConsoleLine[];
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Shown on the handle while the run is live. */
  readonly running?: boolean;
}

export function RunConsole({ lines, open, onToggle, running = false }: RunConsoleProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // The interesting line is always the last one; follow it while the drawer is open.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [open, lines]);

  return (
    <section className="nx-console" data-open={open} data-testid="ask-console">
      <button
        type="button"
        className="nx-console-handle"
        aria-expanded={open}
        aria-controls="nx-console-body"
        data-testid="ask-console-toggle"
        onClick={onToggle}
      >
        <span className="nx-console-arrow" aria-hidden="true">
          ⌃
        </span>
        <span>Console</span>
        <span className="nx-muted">{running ? 'running' : `${String(lines.length)} line(s)`}</span>
      </button>
      <div
        className="nx-console-body"
        id="nx-console-body"
        ref={bodyRef}
        role="log"
        aria-live="polite"
        aria-label="Run console"
        hidden={!open}
      >
        {lines.length === 0 ? (
          <p className="nx-console-line" data-level="info">
            Nothing has run yet.
          </p>
        ) : (
          lines.map((line) => (
            <p key={line.seq} className="nx-console-line" data-level={line.level}>
              <span className="nx-console-seq">{String(line.seq).padStart(3, '0')}</span>
              {line.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
