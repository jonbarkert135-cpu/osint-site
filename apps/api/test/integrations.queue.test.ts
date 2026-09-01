/** The API's half of the job protocol (§6.5): it enqueues and signals, and never executes (N5). */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueAdd = vi.fn();
const queueClose = vi.fn();
const QueueCtor = vi.fn();
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd;
    close = queueClose;
    constructor(...args: unknown[]) {
      QueueCtor(...args);
    }
  },
}));

const redisSet = vi.fn();
const redisPublish = vi.fn();
const redisDisconnect = vi.fn();
const RedisCtor = vi.fn();
vi.mock('ioredis', () => ({
  default: class {
    set = redisSet;
    publish = redisPublish;
    disconnect = redisDisconnect;
    constructor(...args: unknown[]) {
      RedisCtor(...args);
    }
  },
}));

vi.mock('../src/env.ts', () => ({
  loadServerEnvFromProcess: () => ({ REDIS_URL: 'redis://localhost:6379' }),
}));

const {
  PLAN_QUEUE,
  RUN_QUEUE,
  closeQueue,
  enqueuePlan,
  enqueueRun,
  publishRunEvent,
  requestRunCancel,
} = await import('../src/integrations/queue.ts');

const payload = { runId: 'r1', orgId: 'o1', attempt: 1 };

beforeEach(async () => {
  await closeQueue();
  queueAdd.mockResolvedValue(undefined);
  queueClose.mockResolvedValue(undefined);
  redisSet.mockResolvedValue('OK');
  redisPublish.mockResolvedValue(1);
  QueueCtor.mockClear();
  RedisCtor.mockClear();
  queueClose.mockClear();
  redisDisconnect.mockClear();
});

describe('enqueueRun', () => {
  it('adds one job with no automatic retry (§11.3)', async () => {
    await enqueueRun(payload);

    expect(queueAdd).toHaveBeenCalledWith(RUN_QUEUE, payload, {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    expect(QueueCtor).toHaveBeenCalledTimes(1);
  });

  it('opens the connection lazily and reuses it', async () => {
    await enqueueRun(payload);
    await enqueueRun(payload);

    expect(RedisCtor).toHaveBeenCalledTimes(1);
    expect(RedisCtor).toHaveBeenCalledWith('redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    expect(QueueCtor).toHaveBeenCalledTimes(1);
  });
});

describe('enqueuePlan', () => {
  it('adds one plan job on its own queue, sharing the redis connection (§36)', async () => {
    await enqueuePlan({
      runId: 'r1',
      orgId: 'o1',
      query: 'raven.io',
      mode: 'zero-credential',
      permissions: ['network'],
    });

    expect(queueAdd).toHaveBeenCalledWith(
      PLAN_QUEUE,
      {
        runId: 'r1',
        orgId: 'o1',
        query: 'raven.io',
        mode: 'zero-credential',
        permissions: ['network'],
      },
      { attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 },
    );
    expect(QueueCtor).toHaveBeenCalledTimes(1);
    expect(RedisCtor).toHaveBeenCalledTimes(1);
  });

  it('closes with the rest and reopens on the next call', async () => {
    const job = { runId: 'r1', orgId: 'o1', query: 'raven.io', mode: 'free-tier', permissions: [] };
    await enqueuePlan(job);
    await closeQueue();
    await enqueuePlan(job);

    expect(QueueCtor).toHaveBeenCalledTimes(2);
  });
});

describe('requestRunCancel', () => {
  it('writes the authoritative cancel key and announces the status (§6.7)', async () => {
    await requestRunCancel('r1', 60_000);

    expect(redisSet).toHaveBeenCalledWith('cancel:r1', '1', 'PX', 60_000);
    const [channel, message] = redisPublish.mock.calls[0] as [string, string];
    expect(channel).toBe('run:r1');
    expect(JSON.parse(message)).toMatchObject({ t: 'status', status: 'cancelled' });
  });
});

describe('publishRunEvent', () => {
  it('fires a run event without awaiting redis', () => {
    publishRunEvent('r1', { t: 'stdout', chunk: 'hi' });

    expect(redisPublish).toHaveBeenCalledWith(
      'run:r1',
      JSON.stringify({ t: 'stdout', chunk: 'hi' }),
    );
  });
});

describe('closeQueue', () => {
  it('closes whatever was opened and lets the next call reopen it', async () => {
    await enqueueRun(payload);
    await closeQueue();

    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(redisDisconnect).toHaveBeenCalledTimes(1);

    await enqueueRun(payload);
    expect(RedisCtor).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when nothing was ever opened', async () => {
    await expect(closeQueue()).resolves.toBeUndefined();
    expect(queueClose).not.toHaveBeenCalled();
  });
});
