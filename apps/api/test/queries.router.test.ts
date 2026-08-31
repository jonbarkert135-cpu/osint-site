/** `queries.plan` enqueues a host-side plan and never derives one itself (Part 2 §36, §37, N5). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const enqueuePlan = vi.fn();
vi.mock('../src/integrations/queue.ts', () => ({ enqueuePlan }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');

const caller = createCallerFactory(appRouter);

beforeEach(() => {
  vi.clearAllMocks();
  recordAuditMock.mockResolvedValue(undefined);
  enqueuePlan.mockResolvedValue(undefined);
});

describe('queries.plan', () => {
  it('queues the query with the stated mode and permissions', async () => {
    const result = await caller(ctx({ role: 'editor' })).queries.plan({
      query: 'raven.io',
      mode: 'configured',
      permissions: ['network', 'subprocess'],
      depth: 2,
    });

    expect(result.queued).toBe(true);
    expect(result.runId).toMatch(/.+/);
    expect(enqueuePlan).toHaveBeenCalledWith({
      runId: result.runId,
      orgId: 'o1',
      query: 'raven.io',
      mode: 'configured',
      permissions: ['network', 'subprocess'],
      depth: 2,
    });
  });

  it('defaults to a keyless mode with no permissions, and omits an unset depth', async () => {
    await caller(ctx({ role: 'editor' })).queries.plan({ query: 'raven.io' });

    const payload = enqueuePlan.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.mode).toBe('zero-credential');
    expect(payload.permissions).toEqual([]);
    expect('depth' in payload).toBe(false);
  });

  it('audits the request without recording the query string', async () => {
    await caller(ctx({ role: 'editor' })).queries.plan({
      query: 'someone@example.com',
      permissions: ['network'],
    });

    const entry = recordAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe('query.plan.requested');
    expect(entry.metadata).toEqual({ mode: 'zero-credential', permissions: 1, queryLength: 19 });
    expect(JSON.stringify(entry)).not.toContain('someone@example.com');
  });

  it('refuses a viewer, and queues nothing', async () => {
    await expect(
      caller(ctx({ role: 'viewer' })).queries.plan({ query: 'raven.io' }),
    ).rejects.toThrow();
    expect(enqueuePlan).not.toHaveBeenCalled();
  });

  it('refuses an empty query', async () => {
    await expect(caller(ctx({ role: 'editor' })).queries.plan({ query: '' })).rejects.toThrow();
    expect(enqueuePlan).not.toHaveBeenCalled();
  });
});
