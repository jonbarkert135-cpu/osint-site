import { describe, expect, it, vi } from 'vitest';

import { createBrowserHostFetch, isAllowed } from './hostFetch.ts';

const ok = (body: string) =>
  vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

describe('browser host fetch', () => {
  it('allows only https requests to catalogued providers', () => {
    expect(isAllowed('https://crt.sh/?q=example.com')).toBe(true);
    expect(isAllowed('http://crt.sh/?q=example.com')).toBe(false);
    expect(isAllowed('https://evil.example/steal')).toBe(false);
    expect(isAllowed('not a url')).toBe(false);
  });

  it('refuses a request outside the allowlist instead of making it', async () => {
    const fetchMock = ok('{}');
    const hostFetch = createBrowserHostFetch({ fetch: fetchMock });

    await expect(hostFetch('https://evil.example/steal')).rejects.toThrow('Blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses JSON and never sends credentials', async () => {
    const fetchMock = ok('{"ok":true}');
    const hostFetch = createBrowserHostFetch({ fetch: fetchMock });

    const response = await hostFetch('https://rdap.org/domain/example.com');

    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(vi.mocked(fetchMock).mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
  });

  it('keeps a non-JSON body verbatim rather than failing the step', async () => {
    const hostFetch = createBrowserHostFetch({ fetch: ok('plain text') });
    await expect(hostFetch('https://crt.sh/?q=a')).resolves.toEqual({
      status: 200,
      body: 'plain text',
    });
  });

  it('caps the response size', async () => {
    const hostFetch = createBrowserHostFetch({ fetch: ok('x'.repeat(50)), maxBytes: 10 });
    await expect(hostFetch('https://crt.sh/?q=a')).rejects.toThrow('exceeded');
  });

  it('routes through the egress proxy when a deployment configures one', async () => {
    const fetchMock = ok('{}');
    const hostFetch = createBrowserHostFetch({ fetch: fetchMock, proxy: '/api/egress?url=' });

    await hostFetch('https://rdap.org/domain/example.com');

    expect(vi.mocked(fetchMock).mock.calls[0]?.[0]).toBe(
      `/api/egress?url=${encodeURIComponent('https://rdap.org/domain/example.com')}`,
    );
  });
});
