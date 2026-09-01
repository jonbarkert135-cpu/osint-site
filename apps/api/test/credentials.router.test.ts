import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');
const { useCredential, hasCredential } = await import('../src/secrets/decrypt.ts');

const caller = createCallerFactory(appRouter);
const admin = () => caller(ctx({ role: 'admin' }));

const SECRET = 'ghp_thisisapersonalaccesstoken';

/** The row shape the store writes, as the DB would hand it back. */
type Row = Record<string, unknown>;

let stored: Row | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  stored = undefined;
  process.env.CREDENTIALS_MASTER_KEY = randomBytes(32).toString('base64');
  recordAuditMock.mockResolvedValue(undefined);
  prismaMock.integrationCredential.create.mockImplementation(async ({ data }: { data: Row }) => {
    stored = { ...data, createdAt: new Date(), lastUsedAt: null, rotatedAt: null };
    return stored;
  });
  prismaMock.integrationCredential.update.mockImplementation(
    async ({ data }: { data: Row }) => ({ ...(stored ?? {}), ...data }) as Row,
  );
  prismaMock.integrationCredential.findFirst.mockImplementation(async () => stored ?? null);
  prismaMock.integrationCredential.findMany.mockImplementation(async () =>
    stored === undefined ? [] : [stored],
  );
  prismaMock.integrationCredential.deleteMany.mockResolvedValue({ count: 1 });
});

const create = async (over: Record<string, unknown> = {}) =>
  admin().credentials.create({
    integrationId: 'github',
    label: 'CI token',
    secret: SECRET,
    ...over,
  });

describe('credentials.create', () => {
  it('stores ciphertext only and never echoes the secret back', async () => {
    const created = await create();

    const row = stored as Row;
    expect((row.ciphertext as Buffer).toString('utf8')).not.toContain('ghp_');
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(created.lastFour).toBe('oken');
    expect(created.fingerprint).toHaveLength(16);
    expect(row.orgId).toBe(ORG_ID);
    expect(row.createdBy).toBe('u1');
  });

  it('audits the write with the fingerprint, not the secret', async () => {
    await create();

    const entry = recordAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(entry.action).toBe('credential.created');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(entry.metadata.fingerprint).toBeDefined();
  });

  it('says plainly when credential storage is not configured', async () => {
    delete process.env.CREDENTIALS_MASTER_KEY;

    await expect(create()).rejects.toThrow(/CREDENTIALS_MASTER_KEY is missing/);
    expect(prismaMock.integrationCredential.create).not.toHaveBeenCalled();
  });

  it('refuses viewers and editors — a credential is an org-wide grant', async () => {
    await expect(
      caller(ctx({ role: 'editor' })).credentials.create({
        integrationId: 'github',
        label: 'x',
        secret: SECRET,
      }),
    ).rejects.toThrow(/higher role/);
  });
});

describe('credentials.list / rotate / remove', () => {
  it('lists identifying fields without any sealed bytes', async () => {
    await create();

    const [item] = await admin().credentials.list({ integrationId: 'github' });

    expect(item?.label).toBe('CI token');
    expect(Object.keys(item ?? {})).not.toContain('ciphertext');
    expect(Object.keys(item ?? {})).not.toContain('encDek');
  });

  it('keeps the id across a rotation and stamps rotatedAt', async () => {
    const created = await create();

    const rotated = await admin().credentials.rotate({
      credentialId: created.id,
      secret: 'ghp_arotatedtokenvalue',
    });

    expect(rotated.id).toBe(created.id);
    expect(rotated.fingerprint).not.toBe(created.fingerprint);
    expect(rotated.rotatedAt).toBeInstanceOf(Date);
  });

  it('reports a missing credential as missing on rotate and remove', async () => {
    prismaMock.integrationCredential.findFirst.mockResolvedValue(null);
    prismaMock.integrationCredential.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      admin().credentials.rotate({ credentialId: 'nope', secret: SECRET }),
    ).rejects.toThrow(/no longer exists/);
    await expect(admin().credentials.remove({ credentialId: 'nope' })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('deletes and audits', async () => {
    const created = await create();
    recordAuditMock.mockClear();

    await expect(admin().credentials.remove({ credentialId: created.id })).resolves.toEqual({
      deleted: true,
    });
    expect((recordAuditMock.mock.calls[0]?.[0] as { action: string }).action).toBe(
      'credential.deleted',
    );
  });
});

describe('decrypt path (15 §8.2)', () => {
  it('hands the plaintext to the caller and zeroes it afterwards', async () => {
    const created = await create();

    let leaked: Buffer | undefined;
    const seen = await useCredential({ orgId: ORG_ID, credentialId: created.id }, (secret) => {
      leaked = secret;
      return secret.toString('utf8');
    });

    expect(seen).toBe(SECRET);
    expect(leaked?.every((byte) => byte === 0)).toBe(true);
    expect(prismaMock.integrationCredential.update).toHaveBeenCalled();
  });

  it('wipes the buffer even when the caller throws', async () => {
    const created = await create();

    let leaked: Buffer | undefined;
    await expect(
      useCredential({ orgId: ORG_ID, credentialId: created.id }, (secret) => {
        leaked = secret;
        throw new Error('upstream exploded');
      }),
    ).rejects.toThrow('upstream exploded');
    expect(leaked?.every((byte) => byte === 0)).toBe(true);
  });

  it('finds the org-wide credential by integration id', async () => {
    await create();

    await expect(
      useCredential({ orgId: ORG_ID, integrationId: 'github' }, (s) => s.toString('utf8')),
    ).resolves.toBe(SECRET);
    await expect(hasCredential({ orgId: ORG_ID, integrationId: 'github' })).resolves.toBe(true);
  });

  it('returns undefined — not an empty key — when nothing is stored', async () => {
    prismaMock.integrationCredential.findFirst.mockResolvedValue(null);
    prismaMock.integrationCredential.findMany.mockResolvedValue([]);

    await expect(
      useCredential({ orgId: ORG_ID, credentialId: 'missing' }, () => 'used'),
    ).resolves.toBeUndefined();
    await expect(hasCredential({ orgId: ORG_ID, integrationId: 'github' })).resolves.toBe(false);
  });

  it('refuses an expired credential instead of calling out with it', async () => {
    await create({ expiresAt: new Date(Date.now() - 1000) });

    await expect(
      useCredential({ orgId: ORG_ID, integrationId: 'github' }, () => 'used'),
    ).rejects.toThrow(/expired/);
    await expect(hasCredential({ orgId: ORG_ID, integrationId: 'github' })).resolves.toBe(false);
  });

  it('does not open a credential belonging to another organization', async () => {
    await create();

    await expect(
      useCredential({ orgId: 'other-org', credentialId: (stored as Row).id as string }, (s) =>
        s.toString('utf8'),
      ),
    ).rejects.toThrow();
  });
});
