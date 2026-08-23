import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, PROJECT_ID, ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');
const { WATCH_QUOTA_PROJECT } = await import('@nexus/integrations/watch');

const caller = createCallerFactory(appRouter);

const freshConsent = () => ({
  id: 'c1',
  acceptedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  revokedAt: null,
});

const createInput = (over: Record<string, unknown> = {}) => ({
  projectId: PROJECT_ID,
  nodeId: 'n1',
  handle: 'ada',
  cadence: 'weekly' as const,
  consentId: 'c1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  recordAuditMock.mockResolvedValue(undefined);
  prismaMock.usernameWatch.count.mockResolvedValue(0);
  prismaMock.usernameWatch.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => data,
  );
});

describe('watches.create', () => {
  it('stores the watch and books the first check one cadence away', async () => {
    prismaMock.consent.findFirst.mockResolvedValue(freshConsent());

    const result = await caller(ctx({ role: 'editor' })).watches.create(createInput());

    const created = prismaMock.usernameWatch.create.mock.calls[0]?.[0].data as Record<
      string,
      unknown
    >;
    expect(created.orgId).toBe(ORG_ID);
    expect(created.handle).toBe('ada');
    expect(created.createdBy).toBe('u1');
    expect(created.pausedAt).toBeNull();
    const week = 7 * 24 * 60 * 60 * 1000;
    const delay = (created.nextRunAt as Date).getTime() - Date.now();
    // Jitter is ±10%, never zero-spacing and never a second cadence.
    expect(delay).toBeGreaterThan(week * 0.85);
    expect(delay).toBeLessThan(week * 1.15);
    expect(result.notifyOn).toEqual(['appeared', 'disappeared']);
  });

  it('refuses a watch whose standing consent is older than 90 days', async () => {
    prismaMock.consent.findFirst.mockResolvedValue({
      id: 'c1',
      acceptedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
      revokedAt: null,
    });

    await expect(caller(ctx({ role: 'editor' })).watches.create(createInput())).rejects.toThrow(
      /Confirm authorization/,
    );
    expect(prismaMock.usernameWatch.create).not.toHaveBeenCalled();
  });

  it('enforces the per-project quota', async () => {
    prismaMock.consent.findFirst.mockResolvedValue(freshConsent());
    prismaMock.usernameWatch.count.mockImplementation(
      async (args: { where?: { projectId?: string } }) =>
        args.where?.projectId === undefined ? 30 : WATCH_QUOTA_PROJECT,
    );

    await expect(caller(ctx({ role: 'editor' })).watches.create(createInput())).rejects.toThrow(
      /project already has/,
    );
  });
});

describe('watches.setPaused', () => {
  it('resuming re-books the next check from now', async () => {
    prismaMock.usernameWatch.findFirst.mockResolvedValue({
      id: 'w1',
      cadence: 'daily',
      pausedAt: new Date(),
      nextRunAt: new Date(0),
    });
    prismaMock.usernameWatch.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ id: 'w1', ...data }),
    );

    await caller(ctx({ role: 'editor' })).watches.setPaused({ watchId: 'w1', paused: false });

    const data = prismaMock.usernameWatch.update.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data.pausedAt).toBeNull();
    expect((data.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('pausing only stamps pausedAt', async () => {
    prismaMock.usernameWatch.findFirst.mockResolvedValue({
      id: 'w1',
      cadence: 'daily',
      pausedAt: null,
      nextRunAt: new Date(),
    });
    prismaMock.usernameWatch.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ id: 'w1', ...data }),
    );

    await caller(ctx({ role: 'editor' })).watches.setPaused({ watchId: 'w1', paused: true });

    const data = prismaMock.usernameWatch.update.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data.pausedAt).toBeInstanceOf(Date);
    expect(data.nextRunAt).toBeUndefined();
  });
});

describe('watches.remove', () => {
  it('404s for a watch of another org', async () => {
    prismaMock.usernameWatch.findFirst.mockResolvedValue(null);
    await expect(caller(ctx({ role: 'editor' })).watches.remove({ watchId: 'w9' })).rejects.toThrow(
      /no longer exists/,
    );
    expect(prismaMock.usernameWatch.delete).not.toHaveBeenCalled();
  });
});
