/**
 * The host side of `HostFetch` for the browser (17_PLUGIN_SDK.md §4.7, 24_UNIFIED_QUERY.md §9).
 *
 * Engines never get ambient network access: they receive this function, and it is the only place a
 * request leaves the app. In the browser the guard is deliberately narrow —
 *
 *  - **https only**, so a plan can never downgrade to plaintext;
 *  - **allowlisted hosts**, taken from the built-in engines' documented providers, so a compromised
 *    or mistaken engine cannot exfiltrate to an arbitrary origin;
 *  - **no credentials**, ever: `credentials: 'omit'` keeps cookies out of provider requests;
 *  - **a size cap**, because a 200 MB CT-log answer is a denial of service, not a result;
 *  - **abort propagation**, so cancelling a run really stops the sockets (§6.3).
 *
 * A browser tab can only reach providers that send CORS headers. That is a property of the network,
 * not a bug in the executor: a blocked provider surfaces as a failed step and the run degrades (U5)
 * instead of failing. A deployment removes the limit by pointing `RAVEN_EGRESS_PROXY` at the
 * server-side egress proxy (19_DEPLOYMENT.md), which this function honours when it is set.
 */

import type { HostFetch } from '@nexus/transforms';

/** Providers the built-in, keyless engines document. Adding an engine means adding its host here. */
export const ALLOWED_HOSTS: readonly string[] = [
  'crt.sh',
  'rdap.org',
  'dns.google',
  'cloudflare-dns.com',
];

/** 4 MiB: larger than any legitimate keyless answer, small enough to never hurt the tab. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface BrowserHostFetchOptions {
  /** Injected for tests; defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  /** Same-origin egress proxy, e.g. `/api/egress?url=`. Unset in local mode (N2). */
  readonly proxy?: string;
  readonly allowedHosts?: readonly string[];
  readonly maxBytes?: number;
}

export class HostFetchDenied extends Error {}

export const isAllowed = (url: string, hosts: readonly string[] = ALLOWED_HOSTS): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && hosts.includes(parsed.hostname);
};

export function createBrowserHostFetch(options: BrowserHostFetchOptions = {}): HostFetch {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const hosts = options.allowedHosts ?? ALLOWED_HOSTS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;

  return async (url, init) => {
    if (!isAllowed(url, hosts)) {
      throw new HostFetchDenied(`Blocked: ${url} is not an allowed provider endpoint.`);
    }

    const target = options.proxy === undefined ? url : `${options.proxy}${encodeURIComponent(url)}`;
    const response = await doFetch(target, {
      method: init?.method ?? 'GET',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      credentials: 'omit',
      redirect: 'follow',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const text = await response.text();
    if (text.length > maxBytes) {
      throw new HostFetchDenied(`Response from ${url} exceeded the ${String(maxBytes)}-byte cap.`);
    }

    // Providers answer JSON; a non-JSON body is still returned verbatim so provenance keeps the
    // raw text and the engine — not the transport — decides whether it can use it.
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    return { status: response.status, body };
  };
}
