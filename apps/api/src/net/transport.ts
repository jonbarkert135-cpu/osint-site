/**
 * The server side of `safeFetch` (P6 §5.9): the resolver and the transport it injects. The policy
 * itself lives in `@nexus/domain/net` — this file only supplies the runtime.
 *
 * Redirects are handled by `safeFetch`, never by `fetch`, because every hop must be re-validated.
 * The socket-level pin is enforced one layer out by the egress allowlist proxy (19_DEPLOYMENT.md
 * §3); `pinned.address` is passed through so a dispatcher can enforce it in-process later.
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
