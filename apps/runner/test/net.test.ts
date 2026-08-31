/**
 * The runner's `safeFetch` runtime (§37): resolver, transport and the `HostFetch` an engine sees.
 * DNS and the socket are stubbed; what is asserted is that a dead endpoint becomes a status and
 * never a throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

const { nodeHostFetch, nodeResolver, nodeTransport } = await import('../src/net.ts');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const respondWith = (body: string | null, contentType: string, status = 200): void => {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response(body, { status, headers: { 'content-type': contentType } })),
  ) as unknown as typeof fetch;
};

describe('nodeResolver', () => {
  it('returns the addresses DNS gave, in order', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34' },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    await expect(nodeResolver('example.com')).resolves.toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
  });
});

describe('nodeTransport', () => {
  it('streams the body back chunk by chunk', async () => {
    respondWith('hello', 'text/plain');
    const response = await nodeTransport({
      url: new URL('https://example.com/'),
      pinned: { hostname: 'example.com', address: '93.184.216.34' },
      headers: {},
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body()) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))).toBe(
      'hello',
    );
  });

  it('yields nothing when the response has no body', async () => {
    respondWith(null, 'text/plain', 204);
    const response = await nodeTransport({
      url: new URL('https://example.com/'),
      pinned: { hostname: 'example.com', address: '93.184.216.34' },
      headers: {},
      method: 'POST',
      body: '{}',
      signal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body()) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });
});

describe('nodeHostFetch', () => {
  it('parses a JSON body', async () => {
    respondWith('{"ok":true}', 'application/json');
    await expect(nodeHostFetch('https://example.com/api')).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it('hands back the text when declared JSON is not JSON', async () => {
    respondWith('not json', 'application/json');
    const result = await nodeHostFetch('https://example.com/api');
    expect(result.body).toBe('not json');
  });

  it('leaves a non-JSON body as text', async () => {
    respondWith('plain', 'text/plain');
    const result = await nodeHostFetch('https://example.com/', {
      method: 'POST',
      headers: { 'x-test': '1' },
    });
    expect(result.body).toBe('plain');
  });

  it('turns a refused URL into 502 rather than a throw', async () => {
    respondWith('never', 'text/plain');
    await expect(nodeHostFetch('file:///etc/passwd')).resolves.toEqual({
      status: 502,
      body: null,
    });
  });

  it('turns a transport failure into 502', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('socket'))) as unknown as typeof fetch;
    await expect(nodeHostFetch('https://example.com/')).resolves.toEqual({
      status: 502,
      body: null,
    });
  });
});
