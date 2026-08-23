/**
 * `safeFetch` — the only outbound HTTP path in the product (15_SECURITY.md §4, N7).
 *
 * Policy in one place: scheme/port allowlist, DNS pinning, redirect cap with re-validation at every
 * hop, hard timeout, body cap, `Content-Type` allowlist, and never a credential on the wire. The
 * transport and the resolver are injected so `packages/domain` stays runtime-free and the SSRF
 * corpus runs offline; the server passes a transport that dials `pinned.address` (see
 * `apps/api/src/net/transport.ts`).
 */

import { pinHost, type PinnedHost, type Resolver } from './dnsPin.ts';
import { ALLOWED_CONTENT_TYPES, UrlRejected, validateUrl } from './urlValidator.ts';

export const REDIRECT_LIMIT = 5;
export const TOTAL_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Metadata lives in `<head>`; the rest of the page is never buffered (§7). */
export const HEAD_LIMIT_BYTES = 512 * 1024;

export interface TransportRequest {
  readonly url: URL;
  readonly pinned: PinnedHost;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** GET unless the caller asked for a write; the transport must send exactly this. */
  readonly method?: 'GET' | 'POST';
  readonly body?: string | undefined;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** Body chunks; `safeFetch` stops reading at the cap. */
  body(): AsyncIterable<Uint8Array>;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchOptions {
  readonly resolve: Resolver;
  readonly transport: Transport;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly redirectLimit?: number | undefined;
  readonly contentTypes?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Extra request headers; opt-in, for integrations that must authenticate (10_INTEGRATIONS §4.1). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * `POST` is opt-in and never redirected: a write that a redirect could replay is a way to send
   * the body to a host the caller never validated, so a 3xx on a POST is refused outright.
   */
  readonly method?: 'GET' | 'POST' | undefined;
  readonly body?: string | undefined;
}

export interface SafeFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** True when the body was cut at `maxBytes` rather than ending on its own. */
  readonly truncated: boolean;
}

const decoder = new TextDecoder('utf-8');

export async function safeFetch(
  input: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const limit = options.redirectLimit ?? REDIRECT_LIMIT;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const allowed = options.contentTypes ?? ALLOWED_CONTENT_TYPES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TOTAL_TIMEOUT_MS);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort);

  try {
    let target = input;
    for (let hop = 0; hop <= limit; hop += 1) {
      // Re-validated at *every* hop: a public URL that 302s to 127.0.0.1 is the classic bypass.
      const { url } = validateUrl(target);
      const pinned = await pinHost(url.hostname, options.resolve);

      if (controller.signal.aborted) throw new UrlRejected('timeout');

      let response: TransportResponse;
      try {
        response = await options.transport({
          url,
          pinned,
          // No cookies, no auth, no referer — the fetch carries nothing of ours (§9).
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'user-agent': 'RavenUnfurl/1.0',
            ...(options.headers ?? {}),
          },
          signal: controller.signal,
          method: options.method ?? 'GET',
          ...(options.body === undefined ? {} : { body: options.body }),
        });
      } catch (error) {
        throw controller.signal.aborted ? new UrlRejected('timeout') : toRejection(error);
      }

      if (response.status >= 300 && response.status < 400) {
        if ((options.method ?? 'GET') === 'POST') {
          throw new UrlRejected(
            'http_error',
            'The host redirected a POST; the body was not resent.',
          );
        }
        const location = response.headers.get('location');
        if (location === null) throw new UrlRejected('http_error');
        target = new URL(location, url).href;
        continue;
      }
      if (response.status >= 400)
        throw new UrlRejected('http_error', `HTTP ${String(response.status)}.`);

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!allowed.includes(contentType)) throw new UrlRejected('content_type_not_allowed');

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_BODY_BYTES) throw new UrlRejected('body_too_large');

      const { text, truncated } = await readCapped(response, maxBytes, controller.signal);
      return { url: url.href, status: response.status, contentType, body: text, truncated };
    }
    throw new UrlRejected('too_many_redirects');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

async function readCapped(
  response: TransportResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of response.body()) {
    if (signal.aborted) throw new UrlRejected('timeout');
    size += chunk.byteLength;
    if (size > maxBytes) {
      chunks.push(chunk.subarray(0, chunk.byteLength - (size - maxBytes)));
      truncated = true;
      break;
    }
    chunks.push(chunk);
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decoder.decode(joined), truncated };
}

const toRejection = (error: unknown): UrlRejected =>
  error instanceof UrlRejected ? error : new UrlRejected('http_error');
