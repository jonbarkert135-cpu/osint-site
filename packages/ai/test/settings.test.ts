/** The endpoint probe and its error taxonomy (14 §2.2, §2.5). */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AI_SETTINGS,
  normalizeBaseUrl,
  probeAiEndpoint,
  parseAiSettings,
  probeErrorMessage,
} from '../src/settings.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseAiSettings', () => {
  it('reads a row written by an older version back as the defaults', () => {
    expect(parseAiSettings({})).toEqual(DEFAULT_AI_SETTINGS);
    expect(parseAiSettings(null)).toEqual(DEFAULT_AI_SETTINGS);
    expect(parseAiSettings('nonsense')).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('normalizes what it keeps', () => {
    expect(
      parseAiSettings({
        enabled: true,
        baseUrl: ' http://localhost:11434/v1/ ',
        chatModel: ' llama3.1:8b ',
        embedModel: '',
      }),
    ).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'llama3.1:8b',
      embedModel: '',
    });
  });
});

describe('normalizeBaseUrl', () => {
  it('drops trailing slashes so the probe never builds //models', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1//')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('///')).toBe('');
  });
});

describe('probeAiEndpoint', () => {
  it('returns the model ids from GET /models and sends the key as a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: 'llama3.1:8b' }] }));

    const result = await probeAiEndpoint({
      baseUrl: 'http://localhost:11434/v1/',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl,
    });

    expect(result).toEqual({ ok: true, models: ['llama3.1:8b'] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/models');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
  });

  it('omits the authorization header for a keyless local runtime', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [] }));

    const result = await probeAiEndpoint({
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl: fetchImpl,
    });

    expect(result).toEqual({ ok: true, models: [] });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('says "not configured" for an empty base URL instead of calling anything', async () => {
    const fetchImpl = vi.fn();
    const result = await probeAiEndpoint({
      baseUrl: '/',
      fetchImpl: fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      code: 'no_provider',
      message: probeErrorMessage('no_provider'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'upstream'],
    [404, 'upstream'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}, status));
    const result = await probeAiEndpoint({
      baseUrl: 'http://ai.local/v1',
      fetchImpl: fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, code });
  });

  it('reports an unreadable answer when the body is not an OpenAI model list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ models: ['a'] }));
    const result = await probeAiEndpoint({
      baseUrl: 'http://ai.local/v1',
      fetchImpl: fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('reports an unreadable answer when the entries carry no ids', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ name: 'nope' }] }));
    const result = await probeAiEndpoint({
      baseUrl: 'http://ai.local/v1',
      fetchImpl: fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('reports an unreadable answer when the body is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>not here</html>'));
    const result = await probeAiEndpoint({
      baseUrl: 'http://ai.local/v1',
      fetchImpl: fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('reports upstream when the host cannot be reached', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await probeAiEndpoint({
      baseUrl: 'http://ai.local/v1',
      fetchImpl: fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, code: 'upstream' });
  });

  it('reports a timeout when the endpoint stalls past timeoutMs', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const result = await probeAiEndpoint({
      baseUrl: 'http://ai.local/v1',
      timeoutMs: 5,
      fetchImpl: fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, code: 'timeout' });
  });
});
