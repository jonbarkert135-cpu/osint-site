/**
 * Activity tab (Part 2 §54): the session's history, newest first, filterable by kind.
 *
 * A history is only useful if you can narrow it, so the kinds double as filter chips — but the
 * default is everything, because the common question is "what just happened", not "show me errors".
 */

import { useState } from 'react';

import { ACTIVITY_KINDS, clearActivity, useActivity, type ActivityKind } from './activityLog.ts';

const time = (at: number): string => new Date(at).toLocaleTimeString();

export function ActivityLog() {
  const entries = useActivity();
  const [filter, setFilter] = useState<ActivityKind | 'all'>('all');
  const shown = [...entries].reverse().filter((entry) => filter === 'all' || entry.kind === filter);

  return (
    <section className="nx-stack" data-testid="activity-log">
      <div className="nx-tabs" role="group" aria-label="Activity filters">
        {(['all', ...ACTIVITY_KINDS] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="nx-tab"
            aria-pressed={filter === kind}
            onClick={() => {
              setFilter(kind);
            }}
          >
            {kind}
          </button>
        ))}
        <button
          type="button"
          className="nx-tab"
          onClick={clearActivity}
          data-testid="activity-clear"
        >
          Clear
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="nx-muted" data-testid="activity-empty">
          Nothing has happened in this session yet.
        </p>
      ) : (
        <ul className="nx-activity">
          {shown.map((entry) => (
            <li key={entry.seq} data-kind={entry.kind}>
              <span className="nx-muted">{time(entry.at)}</span>
              <span className="nx-activity-kind">{entry.kind}</span>
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
