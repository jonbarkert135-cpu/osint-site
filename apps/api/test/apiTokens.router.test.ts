import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');
const { ROLE_SCOPES } = await import('../src/auth/apiToken.ts');

const caller = createCallerFactory(appRouter);

const editorScopes = ROLE_SCOPES.editor;
const readScope = ROLE_SCOPES.viewer[0]!;
/** A scope an editor holds but a viewer does not — the escalation case. */
const editorOnlyScope = editorScopes.find((s) => !ROLE_SCOPES.viewer.includes(s))!;

beforeEach(() => {
  vi.clearAllMocks();
  recordAuditMock.mockResolvedValue(undefined);
  prismaMock.apiToken.count.mockResolvedValue(0);
});

describe('apiTokens.list', () => {
  it('returns the caller own tokens and never the hash', async () => {
    prismaMock.apiToken.findMany.mockResolvedValue([
      {
        id: 't1',
        name: 'CI',
        prefix: 'nx_abc',
        hash: 'do-not-leak',
        scopes: [readScope],
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    ]);

    const rows = await caller(ctx({ role: 'viewer' })).apiTokens.list();

    expect(prismaMock.apiToken.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, userId: 'u1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows[0]).not.toHaveProperty('hash');
    expect(rows[0]?.prefix).toBe('nx_abc');
  });
});

describe('apiTokens.create', () => {
  const created = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    name: 'CI',
    scopes: [readScope],
    expiresAt: null,
    ...over,
  });

  // argon2id at 19 MiB is deliberately slow; under coverage-instrumented CI one hash can take
  // ~10 s, so the hashing tests get a generous timeout instead of the 20 s default.
  it(
    'stores only the hash and returns the plaintext exactly once',
    { timeout: 90_000 },
    async () => {
      prismaMock.apiToken.create.mockResolvedValue(created());

      const result = await caller(ctx({ role: 'editor' })).apiTokens.create({
        name: 'CI',
        scopes: [readScope],
      });

      const data = prismaMock.apiToken.create.mock.calls[0]?.[0].data as Record<string, string>;
      expect(data.hash).toBeTruthy();
      expect(data.hash).not.toBe(result.token);
      expect(result.token).toContain(data.prefix);
      // The plaintext must not reach the audit trail.
      expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain(result.token);
      expect(recordAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'apiToken.created', targetId: 't1' }),
      );
    },
  );

  it('refuses scopes the caller role does not hold', async () => {
    await expect(
      caller(ctx({ role: 'viewer' })).apiTokens.create({
        name: 'CI',
        scopes: [editorOnlyScope],
      }),
    ).rejects.toThrow();
    expect(prismaMock.apiToken.create).not.toHaveBeenCalled();
  });

  it('caps the number of active tokens per user', async () => {
    prismaMock.apiToken.count.mockResolvedValue(20);
    await expect(
      caller(ctx({ role: 'editor' })).apiTokens.create({ name: 'CI', scopes: [readScope] }),
    ).rejects.toThrow(/Revoke one first/i);
    expect(prismaMock.apiToken.count).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, userId: 'u1', revokedAt: null },
    });
    expect(prismaMock.apiToken.create).not.toHaveBeenCalled();
  });

  it('passes an explicit expiry through and defaults it to null', { timeout: 90_000 }, async () => {
    prismaMock.apiToken.create.mockResolvedValue(created());
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');

    await caller(ctx({ role: 'editor' })).apiTokens.create({
      name: 'CI',
      scopes: [readScope],
      expiresAt,
    });
    expect(prismaMock.apiToken.create.mock.calls[0]?.[0].data.expiresAt).toEqual(expiresAt);

    await caller(ctx({ role: 'editor' })).apiTokens.create({ name: 'CI', scopes: [readScope] });
    expect(prismaMock.apiToken.create.mock.calls[1]?.[0].data.expiresAt).toBeNull();
  });

  it('rejects an empty name and an empty scope list', async () => {
    await expect(
      caller(ctx({ role: 'editor' })).apiTokens.create({ name: '   ', scopes: [readScope] }),
    ).rejects.toThrow();
    await expect(
      caller(ctx({ role: 'editor' })).apiTokens.create({ name: 'CI', scopes: [] }),
    ).rejects.toThrow();
  });
});

describe('apiTokens.revoke', () => {
  it('revokes a token the caller owns', async () => {
    prismaMock.apiToken.findFirst.mockResolvedValue({ id: 't1' });
    prismaMock.apiToken.update.mockResolvedValue({});

    const result = await caller(ctx({ role: 'editor' })).apiTokens.revoke({ tokenId: 't1' });

    expect(prismaMock.apiToken.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { revokedAt: result.revokedAt },
    });
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'apiToken.revoked', targetId: 't1' }),
    );
  });

  it('throws NOT_FOUND for a token owned by someone else', async () => {
    prismaMock.apiToken.findFirst.mockResolvedValue(null);
    await expect(
      caller(ctx({ role: 'editor' })).apiTokens.revoke({ tokenId: 't1' }),
    ).rejects.toThrow(/no longer exists/i);
    expect(prismaMock.apiToken.update).not.toHaveBeenCalled();
  });
});
