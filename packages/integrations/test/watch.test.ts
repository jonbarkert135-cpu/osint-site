import { describe, expect, it } from 'vitest';
import {
  WATCH_QUOTA_INSTANCE,
  WATCH_QUOTA_PROJECT,
  checkWatchQuota,
  consentExpired,
  nextRunAt,
  planWatchTick,
} from '../src/watch.ts';

const at = (iso: string) => new Date(iso);
const base = {
  id: 'w1',
  handle: 'ada',
  cadence: 'daily' as const,
  pausedAt: null,
  nextRunAt: at('2026-03-01T00:00:00.000Z'),
};

describe('identity watch scheduling', () => {
  it('spreads the next slot within ±10% of the cadence', () => {
    const from = at('2026-03-01T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    expect(nextRunAt('daily', from, () => 0.5).getTime()).toBe(from.getTime() + day);
    expect(nextRunAt('daily', from, () => 0).getTime()).toBe(from.getTime() + day - day * 0.1);
    expect(nextRunAt('daily', from, () => 1).getTime()).toBe(from.getTime() + day + day * 0.1);
    expect(nextRunAt('weekly', from, () => 0.5).getTime()).toBe(from.getTime() + 7 * day);
    expect(nextRunAt('monthly', from, () => 0.5).getTime()).toBe(from.getTime() + 30 * day);
  });

  it('expires a standing consent after 90 days', () => {
    const accepted = at('2026-01-01T00:00:00.000Z');
    expect(consentExpired(accepted, at('2026-03-01T00:00:00.000Z'))).toBe(false);
    expect(consentExpired(accepted, at('2026-04-02T00:00:00.000Z'))).toBe(true);
  });

  it('enforces the per-project and per-instance quotas', () => {
    expect(checkWatchQuota({ project: 3, instance: 10 })).toEqual({ ok: true });
    const project = checkWatchQuota({ project: WATCH_QUOTA_PROJECT, instance: 30 });
    expect(project.ok).toBe(false);
    const instance = checkWatchQuota({ project: 1, instance: WATCH_QUOTA_INSTANCE });
    expect(instance.ok).toBe(false);
    if (!instance.ok) expect(instance.reason).toContain('instance');
  });

  it('never runs a paused watch', () => {
    const plan = planWatchTick({
      watch: { ...base, pausedAt: at('2026-02-01T00:00:00.000Z') },
      consentAcceptedAt: at('2026-02-01T00:00:00.000Z'),
      now: at('2026-03-02T00:00:00.000Z'),
    });
    expect(plan).toEqual({ action: 'skip', reason: 'paused' });
  });

  it('auto-pauses instead of running once consent is stale', () => {
    const plan = planWatchTick({
      watch: base,
      consentAcceptedAt: at('2025-01-01T00:00:00.000Z'),
      now: at('2026-03-02T00:00:00.000Z'),
    });
    expect(plan.action).toBe('pause');
    if (plan.action === 'pause') expect(plan.notification).toContain('@ada');
  });

  it('auto-pauses when the consent record is gone', () => {
    const plan = planWatchTick({
      watch: base,
      consentAcceptedAt: null,
      now: at('2026-03-02T00:00:00.000Z'),
    });
    expect(plan.action).toBe('pause');
  });

  it('waits until the slot is due', () => {
    const plan = planWatchTick({
      watch: base,
      consentAcceptedAt: at('2026-02-20T00:00:00.000Z'),
      now: at('2026-02-28T00:00:00.000Z'),
    });
    expect(plan).toEqual({ action: 'skip', reason: 'not-due' });
  });

  it('runs a due watch and books the following slot', () => {
    const now = at('2026-03-02T00:00:00.000Z');
    const plan = planWatchTick(
      { watch: base, consentAcceptedAt: at('2026-02-20T00:00:00.000Z'), now },
      () => 0.5,
    );
    expect(plan.action).toBe('run');
    if (plan.action === 'run') {
      expect(plan.nextRunAt.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    }
  });
});
