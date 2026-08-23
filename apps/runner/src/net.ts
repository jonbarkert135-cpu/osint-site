/**
 * The runner's runtime for `safeFetch` (P6 §5.9).
 *
 * `packages/domain` owns the SSRF policy and stays runtime-free; this file supplies the resolver
 * and the socket. Everything the runner sends leaves through `safeFetch` or the egress proxy —
 * there is no bare `fetch` anywhere else in this service (§7 of the phase spec).
 */

import { lookup } from 'node:dns/promises';
import type { Resolver, Transport, TransportResponse } from '@nexus/domain';

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
