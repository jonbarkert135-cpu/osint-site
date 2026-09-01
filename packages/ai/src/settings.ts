/**
 * The AI endpoint configuration and its liveness probe (14_AI_AGENT.md §2.1–2.5).
 *
 * Raven ships no key and no default endpoint: an org points Raven at an OpenAI-compatible `/v1`
 * (Ollama, LM Studio, a g4f server, a paid gateway) and Raven uses exactly that. The probe is the
 * only way the UI learns whether that endpoint answers, and it must fail with a *specific* reason —
 * "AI is not configured", "the key was rejected", "the endpoint is unreachable" are three different
 * problems with three different fixes (U5, `00_MASTER.md` §10.5).
 */

export interface AiEndpointSettings {
  /** Off by default: no AI traffic leaves a Raven install nobody configured. */
  readonly enabled: boolean;
  /** `null` = never configured. Stored without a trailing slash. */
  readonly baseUrl: string | null;
  readonly chatModel: string;
  readonly embedModel: string;
}

export const DEFAULT_AI_SETTINGS: AiEndpointSettings = {
  enabled: false,
  baseUrl: null,
  chatModel: '',
  embedModel: '',
};

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.trim().slice(0, 2000) : fallback;

/**
 * Reads a stored settings row back into the current shape. Input validation belongs to the API
 * (zod, at the tRPC edge); this only has to survive a row written by an older version, because a
 * settings screen that refuses to render is worse than one that shows the defaults.
 */
export function parseAiSettings(value: unknown): AiEndpointSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_AI_SETTINGS;
  const row = value as Record<string, unknown>;
  const baseUrl = str(row['baseUrl']);
  return {
    enabled: row['enabled'] === true,
    baseUrl: baseUrl === '' ? null : normalizeBaseUrl(baseUrl),
    chatModel: str(row['chatModel']).slice(0, 200),
    embedModel: str(row['embedModel']).slice(0, 200),
  };
}

/** §2.2, restricted to the codes a configuration probe can actually produce. */
export type AiProbeErrorCode =
  | 'no_provider'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'unreadable';

const PROBE_COPY: Record<AiProbeErrorCode, string> = {
  no_provider: 'AI is not configured. Add an endpoint URL in Settings → AI.',
  auth: 'The AI provider rejected the key. Check the key in Settings → AI.',
  rate_limited: 'The AI provider is rate-limiting us. Try again in a minute.',
  timeout: 'The endpoint did not answer in time. Check that it is running and reachable.',
  upstream: 'The AI provider is unavailable.',
  unreadable: 'The endpoint answered, but not with an OpenAI-compatible model list.',
};

export const probeErrorMessage = (code: AiProbeErrorCode): string => PROBE_COPY[code];

export type AiProbeResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly code: AiProbeErrorCode; readonly message: string };

export interface ProbeOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Injected so tests never touch the network. */
  readonly fetchImpl?: typeof fetch;
}

export const PROBE_TIMEOUT_MS = 8_000;

export function normalizeBaseUrl(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

const failure = (code: AiProbeErrorCode): AiProbeResult => ({
  ok: false,
  code,
  message: probeErrorMessage(code),
});

function codeForStatus(status: number): AiProbeErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  return 'upstream';
}

/** Parses the `{ data: [{ id }] }` shape; anything else is a wrong endpoint, not an empty list. */
function modelIds(body: unknown): string[] | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const ids: string[] = [];
  for (const entry of data as { id?: unknown }[]) {
    if (typeof entry?.id === 'string' && entry.id !== '') ids.push(entry.id);
  }
  return ids.length === 0 && data.length > 0 ? undefined : ids;
}

/**
 * `GET /v1/models` against the configured endpoint. The cheapest call that proves three things at
 * once — the host is reachable, the key is accepted, and the deployment speaks OpenAI — and it
 * returns the model list the settings screen needs anyway.
 */
export async function probeAiEndpoint(options: ProbeOptions): Promise<AiProbeResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (baseUrl === '') return failure('no_provider');
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.apiKey === undefined || options.apiKey === ''
          ? {}
          : { authorization: `Bearer ${options.apiKey}` }),
      },
      signal: controller.signal,
    });
    if (!response.ok) return failure(codeForStatus(response.status));
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure('unreadable');
    }
    const models = modelIds(body);
    if (models === undefined) return failure('unreadable');
    return { ok: true, models };
  } catch (error) {
    return failure(controller.signal.aborted || isTimeout(error) ? 'timeout' : 'upstream');
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
