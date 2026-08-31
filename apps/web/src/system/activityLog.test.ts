/** The unified activity log (Part 2 §54): one history, fed from the run stream. */

import type { QueryEvent } from '@nexus/query-engine';
import { beforeEach, describe, expect, it } from 'vitest';

import { activitySnapshot, clearActivity, logActivity, recordQueryEvent } from './activityLog.ts';

const step = { transform: 'domain.certificates', stage: 0, input: { kind: 'domain', value: 'a' } };
const event = (partial: Record<string, unknown>): QueryEvent =>
  ({ step, ...partial }) as unknown as QueryEvent;

describe('activityLog', () => {
  beforeEach(() => {
    clearActivity();
  });

  it('records entries newest last, with a kind and a timestamp', () => {
    logActivity('import', 'Added 2 node(s)');
    const [entry] = activitySnapshot();

    expect(entry).toMatchObject({ kind: 'import', text: 'Added 2 node(s)' });
    expect(entry?.at).toBeGreaterThan(0);
  });

  it('translates the run stream into the kinds §54 asks for', () => {
    recordQueryEvent(event({ type: 'plan.started', stages: 1, steps: 2 }));
    recordQueryEvent(event({ type: 'step.started', engine: 'ct-log-search' }));
    recordQueryEvent(event({ type: 'step.skipped', reason: 'requires-configuration' }));
    recordQueryEvent(
      event({ type: 'entity.found', entity: { kind: 'hostname', value: 'a.example.com' } }),
    );
    recordQueryEvent(
      event({ type: 'relation.found', relation: { kind: 'resolves-to', derived: true } }),
    );
    recordQueryEvent(event({ type: 'step.failed', message: 'timeout', fallback: true }));

    expect(activitySnapshot().map((entry) => entry.kind)).toEqual([
      'query',
      'engine',
      'engine',
      'entity',
      'connection',
      'error',
    ]);
    expect(activitySnapshot().at(-1)?.text).toContain('retrying');
    expect(activitySnapshot()[4]?.text).toContain('derived');
  });

  it('logs a cached answer but keeps ordinary progress out of the history', () => {
    recordQueryEvent(event({ type: 'step.done', engine: 'e', cached: true, produced: 1 }));
    recordQueryEvent(event({ type: 'step.done', engine: 'e', cached: false, produced: 1 }));
    recordQueryEvent(event({ type: 'run.progress', fraction: 0.5 }));

    expect(activitySnapshot()).toHaveLength(1);
    expect(activitySnapshot()[0]?.text).toContain('from cache');
  });

  it('clears on demand', () => {
    logActivity('export', 'x');
    clearActivity();

    expect(activitySnapshot()).toEqual([]);
  });
});
