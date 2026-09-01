import type { ProviderManifest } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { createPacer } from '../src/pace.ts';

const provider = (limits: ProviderManifest['limits'], id = 'crtsh'): ProviderManifest =>
  ({
    id,
    name: id,
    credentialClass: 'A',
    credentials: 'none',
    pricing: 'free',
    licence: 'unknown',
    limits,
    lastVerified: '2026-01-01',
    status: 'configured',
    alternatives: [],
  }) as ProviderManifest;

/** A clock the test drives: `sleep` advances it instead of waiting for a real timer. */
const fakeClock = () => {
  let t = 1_000;
  const slept: number[] = [];
  return {
    slept,
    now: (): number => t,
    sleep: async (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
      await Promise.resolve();
    },
    advance: (ms: number): void => {
      t += ms;
    },
  };
};

describe('createPacer', () => {
  it('lets a provider without limits through without waiting', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const verdict = await pacer.take(provider({}));
    expect(verdict).toEqual({ ok: true, waitedMs: 0 });
    expect(clock.slept).toEqual([]);
  });

  it('spaces calls by the minute limit instead of firing them all at once', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const limited = provider({ requestsPerMinute: 60 });

    const first = await pacer.take(limited);
    const second = await pacer.take(limited);

    expect(first).toEqual({ ok: true, waitedMs: 0 });
    expect(second.ok).toBe(true);
    expect(clock.slept).toEqual([1_000]);
  });

  it('does not make a caller wait when the interval has already passed', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const limited = provider({ requestsPerMinute: 60 });

    await pacer.take(limited);
    clock.advance(5_000);
    const second = await pacer.take(limited);

    expect(second).toEqual({ ok: true, waitedMs: 0 });
    expect(clock.slept).toEqual([]);
  });

  it('keeps one provider’s queue out of another’s way', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take(provider({ requestsPerMinute: 6 }, 'slow'));
    const other = await pacer.take(provider({ requestsPerMinute: 6 }, 'fast'));

    expect(other).toEqual({ ok: true, waitedMs: 0 });
  });

  it('caps a single wait so one strict provider cannot stall a run forever', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep, maxWaitMs: 500 });
    const strict = provider({ requestsPerMinute: 1 });

    await pacer.take(strict);
    const second = await pacer.take(strict);

    expect(second).toEqual({ ok: true, waitedMs: 500 });
  });

  it('refuses rather than queues when the daily quota is spent', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const capped = provider({ requestsPerDay: 2 });

    await pacer.take(capped);
    await pacer.take(capped);
    const third = await pacer.take(capped);

    expect(third.ok).toBe(false);
    expect(third.ok === false && third.reason).toBe('daily-quota');
    expect(third.ok === false && third.message).toMatch(/daily quota/u);
  });

  it('reopens the daily quota once the window has rolled over', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const capped = provider({ requestsPerDay: 1 });

    await pacer.take(capped);
    expect((await pacer.take(capped)).ok).toBe(false);
    clock.advance(86_400_001);
    expect((await pacer.take(capped)).ok).toBe(true);
  });

  it('counts what it charged to a provider, and nothing for one it never saw', async () => {
    const pacer = createPacer({ now: () => 0, sleep: async () => undefined });
    await pacer.take(provider({ requestsPerDay: 10 }));
    expect(pacer.used('crtsh')).toBe(1);
    expect(pacer.used('never-called')).toBe(0);
  });

  it('ignores a nonsensical zero-per-minute limit instead of dividing by it', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    expect(await pacer.take(provider({ requestsPerMinute: 0 }))).toEqual({ ok: true, waitedMs: 0 });
  });

  it('uses a real timer when none is injected', async () => {
    const pacer = createPacer();
    const limited = provider({ requestsPerMinute: 6_000 });
    await pacer.take(limited);
    const second = await pacer.take(limited);
    expect(second.ok).toBe(true);
  });
});
