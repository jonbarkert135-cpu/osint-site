/** `aiSettings.*` — the Settings → AI screen: org config, write-only key, honest probe (14 §2). */

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const loadServerEnvFromProcess = vi.fn();
vi.mock('../src/env.ts', () => ({ loadServerEnvFromProcess }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');

const caller = createCallerFactory(appRouter);
const admin = () => caller(ctx({ role: 'admin' }));

type Row = Record<string, unknown>;

let settingsRow: Row | null;
let credential: Row | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  settingsRow = null;
  credential = undefined;
  process.env.CREDENTIALS_MASTER_KEY = randomBytes(32).toString('base64');
  recordAuditMock.mockResolvedValue(undefined);
  loadServerEnvFromProcess.mockReturnValue({
    AI_PROVIDER: 'mock',
    AI_EMBED_MODEL: 'text-embedding-3-small',
  });
  prismaMock.workspaceSetting.findUnique.mockImplementation(async () => settingsRow);
  prismaMock.workspaceSetting.upsert.mockImplementation(async ({ create }: { create: Row }) => {
    settingsRow = { value: create['value'] };
    return settingsRow;
  });
  prismaMock.integrationCredential.create.mockImplementation(async ({ data }: { data: Row }) => {
    credential = { ...data, createdAt: new Date(), lastUsedAt: null, rotatedAt: null };
    return credential;
  });
  prismaMock.integrationCredential.update.mockImplementation(
    async ({ data }: { data: Row }) => ({ ...(credential ?? {}), ...data }) as Row,
  );
  prismaMock.integrationCredential.findMany.mockImplementation(async () =>
    credential === undefined ? [] : [credential],
  );
  prismaMock.integrationCredential.deleteMany.mockImplementation(async () => {
    const count = credential === undefined ? 0 : 1;
    credential = undefined;
    return { count };
  });
});

const save = async (over: Record<string, unknown> = {}) =>
  admin().aiSettings.update({
    enabled: true,
    baseUrl: 'http://localhost:11434/v1',
    chatModel: 'llama3.1:8b',
    embedModel: 'nomic-embed-text',
    ...over,
  });

describe('aiSettings.get', () => {
  it('reports "not configured" on a fresh org instead of inventing an endpoint', async () => {
    const result = await admin().aiSettings.get();

    expect(result.settings).toEqual({
      enabled: false,
      baseUrl: null,
      chatModel: '',
      embedModel: '',
    });
    expect(result.key).toEqual({ present: false, lastFour: null, fingerprint: null });
    expect(result.effective).toMatchObject({ configured: false, baseUrl: null, source: 'none' });
  });

  it('falls back to the deployment env when the org saved nothing', async () => {
    loadServerEnvFromProcess.mockReturnValue({
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://env.local/v1/',
      AI_EMBED_MODEL: 'embed-env',
      AI_API_KEY: 'sk-env',
    });

    const result = await admin().aiSettings.get();

    expect(result.effective).toMatchObject({
      configured: true,
      baseUrl: 'http://env.local/v1',
      embedModel: 'embed-env',
      source: 'env',
    });
  });

  it('prefers the org row over the env once one is saved', async () => {
    loadServerEnvFromProcess.mockReturnValue({
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://env.local/v1',
      AI_EMBED_MODEL: 'embed-env',
    });
    await save();

    const result = await admin().aiSettings.get();

    expect(result.effective).toMatchObject({
      configured: true,
      baseUrl: 'http://localhost:11434/v1',
      embedModel: 'nomic-embed-text',
      source: 'org',
    });
  });
});

describe('aiSettings.update', () => {
  it('saves a normalized row and audits the change without any secret', async () => {
    const saved = await save({ baseUrl: 'http://localhost:11434/v1//' });

    expect(saved.baseUrl).toBe('http://localhost:11434/v1');
    expect(prismaMock.workspaceSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_key: { orgId: ORG_ID, key: 'ai' } } }),
    );
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.settings.updated', outcome: 'success' }),
    );
  });

  it('refuses to switch AI on with no endpoint to talk to', async () => {
    await expect(save({ enabled: true, baseUrl: null })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('allows clearing the endpoint while AI is off', async () => {
    await expect(save({ enabled: false, baseUrl: null })).resolves.toMatchObject({
      baseUrl: null,
      enabled: false,
    });
  });

  it('is admin-only', async () => {
    await expect(
      caller(ctx({ role: 'editor' })).aiSettings.update({
        enabled: false,
        baseUrl: null,
        chatModel: '',
        embedModel: '',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('aiSettings.setKey / clearKey', () => {
  it('stores the key write-only and returns only its last four characters', async () => {
    const result = await admin().aiSettings.setKey({ secret: 'sk-live-abcdefgh1234' });

    expect(result).toMatchObject({ present: true, lastFour: '1234' });
    expect(JSON.stringify(credential)).not.toContain('sk-live-abcdefgh1234');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credential.created' }),
    );
  });

  it('replaces the previous key instead of piling up keys', async () => {
    await admin().aiSettings.setKey({ secret: 'sk-first-000011112222' });
    await admin().aiSettings.setKey({ secret: 'sk-second-33334444' });

    const { key } = await admin().aiSettings.get();
    expect(key).toMatchObject({ present: true, lastFour: '4444' });
    expect(prismaMock.integrationCredential.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('clearKey removes the stored key and audits the deletion', async () => {
    await admin().aiSettings.setKey({ secret: 'sk-live-abcdefgh1234' });

    await expect(admin().aiSettings.clearKey()).resolves.toEqual({ removed: 1 });
    await expect(admin().aiSettings.get()).resolves.toMatchObject({
      key: { present: false },
    });
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credential.deleted' }),
    );
  });

  it('clearKey on an org with no key is a no-op, not an error', async () => {
    await expect(admin().aiSettings.clearKey()).resolves.toEqual({ removed: 0 });
  });
});

describe('aiSettings.probe', () => {
  const models = (): Response =>
    new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }), {
      headers: { 'content-type': 'application/json' },
    });

  it('lists the models the configured endpoint reports, with the stored key attached', async () => {
    await save();
    await admin().aiSettings.setKey({ secret: 'sk-live-abcdefgh1234' });
    const fetchMock = vi.fn().mockResolvedValue(models());
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(admin().aiSettings.probe()).resolves.toEqual({
        ok: true,
        models: ['llama3.1:8b'],
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:11434/v1/models');
      expect((init.headers as Record<string, string>)['authorization']).toBe(
        'Bearer sk-live-abcdefgh1234',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('probes a URL the admin is still typing, before it is saved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(models());
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(admin().aiSettings.probe({ baseUrl: 'http://other.local/v1' })).resolves.toEqual(
        { ok: true, models: ['llama3.1:8b'] },
      );
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://other.local/v1/models');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says AI is not configured rather than failing, when there is no endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(admin().aiSettings.probe()).resolves.toMatchObject({
        ok: false,
        code: 'no_provider',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a rejected key as an auth problem, as data the form can render', async () => {
    await save();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    try {
      await expect(admin().aiSettings.probe()).resolves.toMatchObject({
        ok: false,
        code: 'auth',
        models: [],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is admin-only', async () => {
    await expect(caller(ctx({ role: 'viewer' })).aiSettings.probe()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
