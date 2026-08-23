/**
 * The builtin module registry (10_INTEGRATIONS.md §3.3).
 *
 * `builtin` executions run in the runner process — no container — but only for modules listed
 * here. Third parties cannot contribute one (17_PLUGIN_SDK.md §5.3): the whole point of the
 * sandbox is that unknown code never runs in our process.
 */

import { REDIRECT_LIMIT, safeFetch, type Resolver, type Transport } from '@nexus/domain';
import { IntegrationError } from '@nexus/integrations';
import {
  runScan,
  SpiderFootClient,
  SpiderFootError,
  type SpiderFootHttp,
} from '@nexus/integrations/spiderfoot/client';
import {
  configuredScanBaseUrl,
  SCAN_WALL_CLOCK_MS,
  SPIDERFOOT_SCAN_MODULE,
} from '@nexus/integrations/spiderfoot/scan-manifest';

/** ponytail: one scan's findings must fit in memory; §4.6 caps the proposal anyway. */
const MAX_SCAN_BODY_BYTES = 33_554_432;

export interface BuiltinContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly transport: Transport;
  readonly resolve: Resolver;
  readonly now: () => string;
  readonly log: (message: string) => void;
}

export interface BuiltinModule {
  readonly name: string;
  /** Returns the primary artifact body; the executor caps, hashes and uploads it. */
  run(input: Record<string, unknown>, ctx: BuiltinContext): Promise<string>;
}

/**
 * `expand-url`: follows redirects on a pasted link through `safeFetch` (P6), which enforces the
 * scheme allowlist, DNS pinning, the redirect cap and the body cap for us. The output is the
 * document `builtin/parser.ts` expects.
 */
export const expandUrlModule: BuiltinModule = {
  name: 'expand-url',

  async run(input, ctx) {
    const url = typeof input.url === 'string' ? input.url : '';
    if (url === '') {
      throw new IntegrationError('INPUT_INVALID', { why: 'No URL was provided to expand.' });
    }
    const chain: string[] = [url];
    let result;
    try {
      result = await safeFetch(url, {
        resolve: ctx.resolve,
        transport: ctx.transport,
        redirectLimit: REDIRECT_LIMIT,
        signal: ctx.signal,
        // The destination is a page; we only need enough of it to know we arrived.
        maxBytes: 64 * 1024,
      });
    } catch (error) {
      throw new IntegrationError('UPSTREAM_UNAVAILABLE', {
        why:
          error instanceof Error ? error.message.slice(0, 140) : 'The destination did not answer.',
      });
    }
    if (result.url !== url) chain.push(result.url);
    ctx.log(`expanded to ${result.url}`);

    return JSON.stringify({
      version: '1.0',
      inputUrl: url,
      finalUrl: result.url,
      hops: chain.length - 1,
      status: result.status,
      chain,
      observedAt: ctx.now(),
    });
  },
};

/**
 * `spiderfoot-scan`: starts a scan on the deployment's own SpiderFoot instance and follows it to
 * the end (12_SPIDERFOOT.md §4.4–§4.7). The loop lives in the integrations package; this module is
 * only the binding between it and `safeFetch`, so the same SSRF guard, redirect cap and body cap a
 * builtin gets everywhere else apply to every call it makes.
 *
 * Cancelling the run aborts `ctx.signal`, which makes `runScan` stop the scan on the instance and
 * still return everything it had read — a stopped scan imports its partial findings (§4.6).
 */
export const spiderFootScanModule: BuiltinModule = {
  name: SPIDERFOOT_SCAN_MODULE,

  async run(input, ctx) {
    const target = typeof input.target === 'string' ? input.target.trim() : '';
    if (target === '') {
      throw new IntegrationError('INPUT_INVALID', { why: 'No target was provided to scan.' });
    }
    const baseUrl = configuredScanBaseUrl(process.env);
    if (baseUrl === undefined) {
      throw new IntegrationError('UPSTREAM_UNAVAILABLE', {
        why: 'This deployment has no SPIDERFOOT_BASE_URL configured, so there is no instance to scan with.',
      });
    }

    const http: SpiderFootHttp = async (request) => {
      const result = await safeFetch(request.url, {
        resolve: ctx.resolve,
        transport: ctx.transport,
        redirectLimit: REDIRECT_LIMIT,
        signal: ctx.signal,
        headers: request.headers,
        method: request.method,
        // sfwebui answers JSON; text/plain is what an empty `stopscan` success looks like.
        contentTypes: ['application/json', 'text/plain', 'text/html'],
        // ponytail: safeFetch's own body cap; a scan bigger than that is truncated, not streamed.
        maxBytes: MAX_SCAN_BODY_BYTES,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return { status: result.status, body: result.body };
    };

    const client = new SpiderFootClient({ http, baseUrl });
    try {
      const capabilities = await client.probe();
      ctx.log(
        `instance reachable${capabilities.version === null ? '' : ` (v${capabilities.version})`}`,
      );
      const useCase = typeof input.useCase === 'string' ? input.useCase : 'passive';
      const result = await runScan(
        client,
        {
          name: `Raven ${target}`,
          target,
          useCase: useCase as 'passive' | 'footprint' | 'investigate' | 'all',
        },
        {
          signal: ctx.signal,
          timeoutMs: SCAN_WALL_CLOCK_MS,
          onProgress: (progress) =>
            ctx.log(`${String(progress.events.length)} findings so far (${progress.status.raw})`),
        },
      );
      ctx.log(
        `${String(result.events.length)} findings${result.partial ? ' (partial: the scan did not finish)' : ''}`,
      );
      return JSON.stringify(result.events);
    } catch (error) {
      if (error instanceof SpiderFootError) {
        throw new IntegrationError(
          error.code === 'SF_AUTH'
            ? 'UPSTREAM_AUTH_FAILED'
            : error.code === 'SF_SCAN_REJECTED'
              ? 'INPUT_INVALID'
              : 'UPSTREAM_UNAVAILABLE',
          { why: error.message.slice(0, 140), detail: { code: error.code } },
        );
      }
      throw error;
    }
  },
};

export const BUILTIN_MODULES: ReadonlyMap<string, BuiltinModule> = new Map([
  [expandUrlModule.name, expandUrlModule],
  [spiderFootScanModule.name, spiderFootScanModule],
]);

export function requireBuiltin(name: string): BuiltinModule {
  const module = BUILTIN_MODULES.get(name);
  if (module === undefined) {
    throw new IntegrationError('MANIFEST_INVALID', {
      why: `No builtin module named "${name}" is registered in this build.`,
      detail: { module: name },
    });
  }
  return module;
}
