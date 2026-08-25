import { describe, expect, it } from 'vitest';

import { createResourceManager, DEFAULT_RESOURCE_BUDGET, type Grant } from '../src/resources.ts';

const lease = (grant: Grant) => {
  if (!grant.ok) throw new Error(`expected a grant, got ${grant.reason}`);
  return grant.lease;
};

const refusal = (grant: Grant) => {
  if (grant.ok) throw new Error('expected a refusal');
  return grant;
};

describe('createResourceManager', () => {
  it('grants inside the budget and tracks usage', () => {
    const rm = createResourceManager();
    const held = lease(rm.acquire({ engine: 'sherlock', cpu: 0.5, memoryMb: 200 }));
    expect(rm.usage().inFlight).toBe(1);
    expect(rm.usage().memoryMb).toBe(200);
    expect(rm.usage().byEngine['sherlock']).toBe(1);
    held.release();
    expect(rm.usage().inFlight).toBe(0);
    expect(rm.usage().memoryMb).toBe(0);
  });

  it('is idempotent on release', () => {
    const rm = createResourceManager();
    const held = lease(rm.acquire({ engine: 'sherlock' }));
    held.release();
    held.release();
    expect(rm.usage().inFlight).toBe(0);
  });

  it('never lets one engine take every slot (fair share)', () => {
    const rm = createResourceManager({
      ...DEFAULT_RESOURCE_BUDGET,
      concurrency: 5,
      cpu: 100,
      memoryMb: 100_000,
      processes: 100,
    });
    const held = [
      lease(rm.acquire({ engine: 'spiderfoot' })),
      lease(rm.acquire({ engine: 'spiderfoot' })),
      lease(rm.acquire({ engine: 'spiderfoot' })),
    ];
    expect(held).toHaveLength(3);
    expect(refusal(rm.acquire({ engine: 'spiderfoot' })).reason).toBe('engine-concurrency');
    // Another engine still gets in — this is the whole point of §32.
    expect(rm.acquire({ engine: 'sherlock' }).ok).toBe(true);
  });

  it('refuses when the global concurrency ceiling is reached', () => {
    const rm = createResourceManager({ ...DEFAULT_RESOURCE_BUDGET, concurrency: 2 });
    lease(rm.acquire({ engine: 'a' }));
    lease(rm.acquire({ engine: 'b' }));
    expect(refusal(rm.acquire({ engine: 'c' })).reason).toBe('concurrency');
  });

  it('refuses over-budget cpu, memory, disk, processes, network and time', () => {
    const rm = createResourceManager({
      cpu: 1,
      memoryMb: 100,
      diskMb: 10,
      processes: 1,
      concurrency: 4,
      networkRequests: 5,
      executionMs: 1_000,
    });
    expect(refusal(rm.acquire({ engine: 'x', executionMs: 5_000 })).reason).toBe('execution-time');
    expect(refusal(rm.acquire({ engine: 'x', cpu: 2, memoryMb: 1 })).reason).toBe('cpu');
    expect(refusal(rm.acquire({ engine: 'x', cpu: 0.1, memoryMb: 500 })).reason).toBe('memory');
    expect(refusal(rm.acquire({ engine: 'x', cpu: 0.1, memoryMb: 1, diskMb: 50 })).reason).toBe(
      'disk',
    );
    expect(refusal(rm.acquire({ engine: 'x', cpu: 0.1, memoryMb: 1, processes: 4 })).reason).toBe(
      'processes',
    );
    expect(
      refusal(rm.acquire({ engine: 'x', cpu: 0.1, memoryMb: 1, networkRequests: 50 })).reason,
    ).toBe('network');
  });

  it('explains a refusal in words an analyst can read', () => {
    const rm = createResourceManager({ ...DEFAULT_RESOURCE_BUDGET, concurrency: 1 });
    lease(rm.acquire({ engine: 'a' }));
    expect(refusal(rm.acquire({ engine: 'b' })).message).toContain('run slots');
  });

  it('does not leak network budget back on release', () => {
    const rm = createResourceManager({ ...DEFAULT_RESOURCE_BUDGET, networkRequests: 3 });
    lease(rm.acquire({ engine: 'a', networkRequests: 3 })).release();
    expect(refusal(rm.acquire({ engine: 'a', networkRequests: 1 })).reason).toBe('network');
  });
});
