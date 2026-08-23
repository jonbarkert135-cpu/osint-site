/**
 * The hostile URL corpus (18_TESTING.md §11.1, N7). Every entry must be refused with a *specific*
 * reason code — "blocked" without a reason is how a policy silently stops matching reality.
 */

import { describe, expect, it } from 'vitest';

import {
  UrlRejected,
  normalizeUrl,
  validateUrl,
  type UrlErrorCode,
} from '../src/net/urlValidator.ts';
import { pinHost } from '../src/net/dnsPin.ts';
import { safeFetch, type Transport } from '../src/net/safeFetch.ts';

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

const codeOf = (fn: () => unknown): UrlErrorCode => {
  try {
    fn();
  } catch (error) {
    if (error instanceof UrlRejected) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
};

const REJECTED: ReadonlyArray<[string, UrlErrorCode]> = [
  ['file:///etc/passwd', 'scheme_not_allowed'],
  ['gopher://example.com/', 'scheme_not_allowed'],
  ['javascript:alert(1)', 'scheme_not_allowed'],
  ['data:text/html,<script>', 'scheme_not_allowed'],
  ['ftp://example.com/x', 'scheme_not_allowed'],
  ['http://user:pass@example.com/', 'userinfo_not_allowed'],
  ['http://evil.com@example.com/', 'userinfo_not_allowed'],
  ['http://example.com:22/', 'port_not_allowed'],
  ['http://example.com:6379/', 'port_not_allowed'],
  ['http://example.com:11211/', 'port_not_allowed'],
  ['not a url', 'url_malformed'],
  ['http://exа mple.com/', 'url_malformed'],
  ['http://аpple.com/', 'host_mixed_script'],
  ['http://example.com/%252e%252e/admin', 'encoding_not_normalized'],
  ['http://example.com/a/%2e%2e/b', 'encoding_not_normalized'],
];

describe('validateUrl — hostile corpus', () => {
  for (const [url, expected] of REJECTED) {
    it(`refuses ${url} with ${expected}`, () => {
      expect(codeOf(() => validateUrl(url))).toBe(expected);
    });
  }

  it('accepts ordinary http and https URLs on allowed ports', () => {
    for (const url of ['http://example.com/', 'https://example.com:8443/a?b=1']) {
      expect(validateUrl(url).hostname).toBe('example.com');
    }
  });

  it('punycodes an internationalised host instead of rejecting it', () => {
    expect(validateUrl('https://münchen.de/').hostname).toBe('xn--mnchen-3ya.de');
  });

  it('keeps the message actionable', () => {
    expect(new UrlRejected('address_blocked').message).toContain('private network');
  });
});

describe('normalizeUrl', () => {
  it('is the same key for tracking params, trailing slash and case', () => {
    expect(normalizeUrl('https://Example.com/a/?utm_source=x&b=2&a=1')).toBe(
      normalizeUrl('https://example.com/a?b=2&a=1#frag'),
    );
  });

  it('keeps a non-default port and drops the default one', () => {
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
  });
});

describe('safeFetch', () => {
  const html = '<html><head><title>Hi</title></head></html>';
  const okTransport: Transport = async () => ({
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'text/html; charset=utf-8' : null) },
    body: async function* () {
      yield new TextEncoder().encode(html);
    },
  });

  const rejection = async (promise: Promise<unknown>): Promise<UrlErrorCode> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof UrlRejected) return error.code;
      throw error;
    }
    throw new Error('expected a rejection');
  };

  it('fetches an allowed page and returns the decoded body', async () => {
    const result = await safeFetch('https://example.com/', {
      resolve: publicResolver,
      transport: okTransport,
    });
    expect(result.body).toBe(html);
    expect(result.status).toBe(200);
    expect(result.truncated).toBe(false);
  });

  it('sends no credentials and pins the resolved address', async () => {
    let seen: { headers: Record<string, string>; address: string } | null = null;
    await safeFetch('https://example.com/', {
      resolve: publicResolver,
      transport: async (request) => {
        seen = { headers: { ...request.headers }, address: request.pinned.address };
        return okTransport(request);
      },
    });
    const captured = seen as unknown as { headers: Record<string, string>; address: string };
    expect(captured.address).toBe('93.184.216.34');
    expect(Object.keys(captured.headers)).not.toContain('cookie');
    expect(Object.keys(captured.headers)).not.toContain('authorization');
  });

  it('sends a POST body through the same policy path', async () => {
    let seen: { method: string | undefined; body: string | undefined } | null = null;
    await safeFetch('https://example.com/', {
      resolve: publicResolver,
      transport: async (request) => {
        seen = { method: request.method, body: request.body };
        return okTransport(request);
      },
      method: 'POST',
      body: 'scanname=raven',
    });
    const captured = seen as unknown as { method: string; body: string };
    expect(captured.method).toBe('POST');
    expect(captured.body).toBe('scanname=raven');
  });

  it('refuses to follow a redirect on a POST instead of replaying the body', async () => {
    const redirecting: Transport = async () => ({
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'https://elsewhere.example/' : null) },
      body: async function* () {},
    });
    const code = await rejection(
      safeFetch('https://example.com/', {
        resolve: publicResolver,
        transport: redirecting,
        method: 'POST',
        body: 'x=1',
      }),
    );
    expect(code).toBe('http_error');
  });

  it('blocks a redirect to a private address at the hop', async () => {
    const redirecting: Transport = async (request) =>
      request.url.hostname === 'example.com'
        ? {
            status: 302,
            headers: { get: (name) => (name === 'location' ? 'http://127.0.0.1/admin' : null) },
            body: async function* () {},
          }
        : okTransport(request);
    const code = await rejection(
      safeFetch('https://example.com/', { resolve: publicResolver, transport: redirecting }),
    );
    expect(code).toBe('address_blocked');
  });

  it('gives up after the redirect cap', async () => {
    const looping: Transport = async () => ({
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'https://example.com/next' : null) },
      body: async function* () {},
    });
    const code = await rejection(
      safeFetch('https://example.com/', { resolve: publicResolver, transport: looping }),
    );
    expect(code).toBe('too_many_redirects');
  });

  it('refuses a non-page content type and an error status', async () => {
    const binary: Transport = async () => ({
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'application/zip' : null) },
      body: async function* () {},
    });
    expect(
      await rejection(
        safeFetch('https://example.com/', { resolve: publicResolver, transport: binary }),
      ),
    ).toBe('content_type_not_allowed');

    const notFound: Transport = async () => ({
      status: 404,
      headers: { get: () => null },
      body: async function* () {},
    });
    expect(
      await rejection(
        safeFetch('https://example.com/', { resolve: publicResolver, transport: notFound }),
      ),
    ).toBe('http_error');
  });

  it('refuses a redirect without a location header', async () => {
    const headless: Transport = async () => ({
      status: 301,
      headers: { get: () => null },
      body: async function* () {},
    });
    expect(
      await rejection(
        safeFetch('https://example.com/', { resolve: publicResolver, transport: headless }),
      ),
    ).toBe('http_error');
  });

  it('refuses an over-large declared body and truncates an over-large stream', async () => {
    const huge: Transport = async () => ({
      status: 200,
      headers: {
        get: (name) =>
          name === 'content-type' ? 'text/html' : name === 'content-length' ? '99999999999' : null,
      },
      body: async function* () {},
    });
    expect(
      await rejection(
        safeFetch('https://example.com/', { resolve: publicResolver, transport: huge }),
      ),
    ).toBe('body_too_large');

    const chatty: Transport = async () => ({
      status: 200,
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      body: async function* () {
        yield new TextEncoder().encode('abcdef');
        yield new TextEncoder().encode('ghij');
      },
    });
    const capped = await safeFetch('https://example.com/', {
      resolve: publicResolver,
      transport: chatty,
      maxBytes: 8,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.body).toBe('abcdefgh');
  });

  it('reports a transport failure as a fetch error and an abort as a timeout', async () => {
    const failing: Transport = async () => {
      throw new Error('ECONNRESET');
    };
    expect(
      await rejection(
        safeFetch('https://example.com/', { resolve: publicResolver, transport: failing }),
      ),
    ).toBe('http_error');

    const slow: Transport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    expect(
      await rejection(
        safeFetch('https://example.com/', {
          resolve: publicResolver,
          transport: slow,
          timeoutMs: 5,
        }),
      ),
    ).toBe('timeout');
  });

  it('propagates the caller abort signal', async () => {
    const controller = new AbortController();
    const slow: Transport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const promise = safeFetch('https://example.com/', {
      resolve: publicResolver,
      transport: slow,
      signal: controller.signal,
    });
    controller.abort();
    expect(await rejection(promise)).toBe('timeout');
  });

  it('never resolves a blocked host in the first place', async () => {
    expect(
      await rejection(pinHost('127.0.0.1', publicResolver) as unknown as Promise<unknown>),
    ).toBe('address_blocked');
  });
});
