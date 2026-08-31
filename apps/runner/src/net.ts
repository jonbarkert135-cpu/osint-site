/**
 * The runner's runtime for `safeFetch` (P6 §5.9).
 *
 * `packages/domain` owns the SSRF policy and stays runtime-free; this file supplies the resolver
 * and the socket. Everything the runner sends leaves through `safeFetch` or the egress proxy —
 * there is no bare `fetch` anywhere else in this service (§7 of the phase spec).
 */

import { lookup } from 'node:dns/promises';
import {
  ALLOWED_CONTENT_TYPES,
  safeFetch,
  type Resolver,
  type SafeFetchResult,
  type Transport,
  type TransportResponse,
} from '@nexus/domain';
import type { HostFetch } from '@nexus/transforms';

export const nodeResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

export const nodeTransport: Transport = async (request): Promise<TransportResponse> => {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    ...(request.body === undefined ? {} : { body: request.body }),
    headers: { ...request.headers },
    redirect: 'manual',
    credentials: 'omit',
    signal: request.signal,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: async function* () {
      const stream = response.body as ReadableStream<Uint8Array> | null;
      if (stream === null) return;
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) yield value;
      }
    },
  };
};

/**
 * `HostFetch` for engines executed on this host (Part 2 §37). The contract is small on purpose:
 * a status and a body, never a throw — an engine that gets an exception instead of a status turns
 * a dead endpoint into a failed run (U5). It goes through `safeFetch`, so an engine cannot reach
 * the metadata service or a private address any more than an integration can.
 */
export const nodeHostFetch: HostFetch = async (url, init) => {
  try {
    const response = await safeFetch(url, {
      resolve: nodeResolver,
      transport: nodeTransport,
      method: init?.method === 'POST' ? 'POST' : 'GET',
      // Engines talk to JSON APIs; the unfurl allowlist is HTML-only, so widen it by exactly one.
      contentTypes: [...ALLOWED_CONTENT_TYPES, 'application/json'],
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
    });
    return { status: response.status, body: parseBody(response) };
  } catch {
    // The URL was refused, the host did not resolve, or the transport failed: one status, because
    // the engine can do nothing different with the distinction.
    return { status: 502, body: null };
  }
};

const parseBody = (response: SafeFetchResult): unknown => {
  if (!response.contentType.includes('json')) return response.body;
  try {
    return JSON.parse(response.body);
  } catch {
    // Declared JSON that is not JSON is the server's error, not the engine's: hand back the text.
    return response.body;
  }
};
