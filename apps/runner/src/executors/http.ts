/**
 * The `http` execution layer (10_INTEGRATIONS.md §3.3, §4.1, §6.6 point 4).
 *
 * Hosted APIs do not need a container, but they do need the same SSRF discipline as everything
 * else: every request goes through `safeFetch` (scheme allowlist, DNS pinning, redirect
 * re-validation, body cap), never a bare `fetch`. Secret headers are injected here and redacted
 * everywhere they could be observed.
 */

import { safeFetch, type Resolver, type Transport } from '@nexus/domain';
import {
  IntegrationError,
  payloadFor,
  toErrorPayload,
  type ExecutionLayer,
  type ArtifactRef,
  type ExecutionRequest,
  type RawRunResult,
} from '@nexus/integrations';

import { collectArtifact, type ArtifactSink } from '../artifacts.ts';
import type { CancelWatch } from '../cancel.ts';
import { renderTemplate } from '../sandbox/flags.ts';
import { scrub } from '../sandbox/secrets.ts';

export interface HttpExecutorDeps {
  readonly sink: ArtifactSink;
  readonly bucket: string;
  readonly orgId: string;
  readonly transport: Transport;
  readonly resolve: Resolver;
  readonly watch: CancelWatch;
  /** secret name → value, referenced by `secretHeaders`. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly now?: () => string;
}

export function createHttpExecutor(deps: HttpExecutorDeps): ExecutionLayer {
  const now = deps.now ?? (() => new Date().toISOString());
  const controllers = new Map<string, AbortController>();

  return {
    async execute(request: ExecutionRequest): Promise<RawRunResult> {
      const execution = request.manifest.execution;
      if (execution.kind !== 'http') {
        throw new IntegrationError('INTERNAL', {
          why: 'HttpExecutor received a non-http manifest.',
        });
      }
      const startedAt = now();
      const start = Date.now();
      const controller = new AbortController();
      controllers.set(request.runId, controller);
      const timeout = setTimeout(() => controller.abort(), request.limits.wallClockMs);
      void deps.watch.signal.then(() => controller.abort());

      const secrets = deps.secrets ?? {};
      const input = request.input as Record<string, unknown>;
      const artifacts: ArtifactRef[] = [];
      let egressRequests = 0;
      let budget = request.limits.maxOutputBytes;

      const finish = (
        status: RawRunResult['status'],
        extra: Partial<RawRunResult> = {},
      ): RawRunResult => ({
        runId: request.runId,
        status,
        exitCode: status === 'succeeded' ? 0 : 1,
        startedAt,
        finishedAt: now(),
        durationMs: Date.now() - start,
        artifacts,
        stats: {
          bytesOut: request.limits.maxOutputBytes - budget,
          egressRequests,
          egressDenied: 0,
          peakMemMiB: 0,
        },
        ...extra,
      });

      try {
        for (const spec of execution.requests) {
          const path = renderTemplate(spec.path, {
            input,
            workdir: '/',
            runId: request.runId,
            secretDir: '/run/secrets',
          }).join('');
          const url = new URL(path.replace(/^\//, ''), `${execution.baseUrl.replace(/\/*$/, '')}/`);
          for (const [key, value] of Object.entries(spec.query)) {
            url.searchParams.set(
              key,
              renderTemplate(value, {
                input,
                workdir: '/',
                runId: request.runId,
                secretDir: '/run/secrets',
              }).join(''),
            );
          }
          const headers: Record<string, string> = { ...spec.headers };
          for (const [header, secretName] of Object.entries(spec.secretHeaders)) {
            const value = secrets[secretName];
            if (value !== undefined) headers[header] = value;
          }

          egressRequests += 1;
          const body =
            spec.method === 'POST' && spec.body !== undefined
              ? renderTemplate(
                  typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body),
                  {
                    input,
                    workdir: '/',
                    runId: request.runId,
                    secretDir: '/run/secrets',
                  },
                ).join('')
              : undefined;
          const response = await safeFetch(url.toString(), {
            resolve: deps.resolve,
            transport: deps.transport,
            method: spec.method,
            ...(body === undefined ? {} : { body }),
            headers,
            signal: controller.signal,
            maxBytes: Math.min(budget, request.limits.maxOutputBytes),
            contentTypes: ['application/json', 'text/plain', 'text/html', 'application/x-ndjson'],
          });

          const output = request.manifest.outputs.find((o) => o.name === spec.collectAs);
          const collected = await collectArtifact(
            deps.sink,
            new TextEncoder().encode(scrub(response.body, secrets)),
            {
              orgId: deps.orgId,
              runId: request.runId,
              name: spec.collectAs,
              kind: output?.kind ?? 'json',
              maxBytes: output?.maxBytes ?? request.limits.maxOutputBytes,
              runBudget: budget,
              bucket: deps.bucket,
            },
          );
          budget -= collected.bytesWritten;
          artifacts.push(collected.ref);
        }

        // The primary artifact must come first (§3.1).
        const primaryName = request.manifest.outputs.find((o) => o.primary)?.name;
        artifacts.sort((a, b) =>
          a.key.endsWith(primaryName ?? '') ? -1 : b.key.endsWith(primaryName ?? '') ? 1 : 0,
        );
        return finish(artifacts.some((ref) => ref.truncated) ? 'partial' : 'succeeded');
      } catch (error) {
        if (deps.watch.cancelled())
          return finish('cancelled', { error: payloadFor('CANCELLED', { runId: request.runId }) });
        if (controller.signal.aborted)
          return finish('timed_out', { error: payloadFor('TIMEOUT', { runId: request.runId }) });
        // safeFetch rejects on any 4xx/5xx, so the upstream status only reaches us as an error.
        const upstream = upstreamCodeOf(error);
        if (upstream !== undefined)
          return finish('failed', { error: payloadFor(upstream, { runId: request.runId }) });
        return finish('failed', { error: toErrorPayload(error, request.runId) });
      } finally {
        clearTimeout(timeout);
        controllers.delete(request.runId);
      }
    },

    cancel(runId: string): Promise<void> {
      controllers.get(runId)?.abort();
      return Promise.resolve();
    },
  };
}

/** `safeFetch` reports an upstream status as `UrlRejected('http_error', 'HTTP 429.')`. */
function upstreamCodeOf(
  error: unknown,
): 'UPSTREAM_AUTH_FAILED' | 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | undefined {
  const match = error instanceof Error ? /HTTP (\d{3})\./.exec(error.message) : null;
  const status = match === null ? 0 : Number(match[1]);
  if (status === 401 || status === 403) return 'UPSTREAM_AUTH_FAILED';
  if (status === 429) return 'UPSTREAM_RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  return undefined;
}
