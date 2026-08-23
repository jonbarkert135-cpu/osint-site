/**
 * The SpiderFoot scan client (12_SPIDERFOOT.md §4.2, §4.4, §4.5, §4.6, §4.7).
 *
 * Until now Raven could only *read* a scan the analyst had already started on their own instance.
 * This module starts one: probe -> createScan -> poll status with a bounded backoff -> read partial
 * results on every poll -> cancel. Transport is injected (like `github/client.ts`), so this package
 * stays runtime-free, the worker passes an SSRF-guarded fetch (N7) and the tests run offline.
 *
 * Endpoint shapes are the ones `sfwebui.py` of SpiderFoot v4.0.0 actually serves:
 *   GET  /ping                -> ["SUCCESS", "4.0.0"]
 *   GET  /modules             -> [{ name, descr }, ...]
 *   POST /startscan           -> ["SUCCESS", scanId]   (form-encoded, `accept: application/json`)
 *   GET  /scanstatus?id=      -> [name, target, created, started, ended, status, riskmatrix]
 *   GET  /scaneventresults?id -> [[lastSeen, data, sourceData, module, eventType, ...], ...]
 *   GET  /stopscan?id=        -> "" on success, an error object otherwise
 * They are still treated as assumptions (§4.2): nothing is called before the probe confirmed it,
 * and an unconfirmed operation is reported unsupported instead of being attempted.
 */

export type SpiderFootErrorCode =
  | 'SF_UNREACHABLE'
  | 'SF_AUTH'
  | 'SF_UNSUPPORTED_OPERATION'
  | 'SF_PROBE_FAILED'
  | 'SF_SCAN_REJECTED'
  | 'SF_PARSE'
  | 'SF_TIMEOUT';

export class SpiderFootError extends Error {
  constructor(
    readonly code: SpiderFootErrorCode,
    message: string,
    readonly detail: { readonly httpStatus?: number; readonly operation?: string } = {},
  ) {
    super(message);
    this.name = 'SpiderFootError';
  }
}

export interface SpiderFootHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface SpiderFootHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The one seam to the network; always a URL on the configured instance host. */
export type SpiderFootHttp = (request: SpiderFootHttpRequest) => Promise<SpiderFootHttpResponse>;

export type KnownOperation =
  | 'ping'
  | 'listModules'
  | 'createScan'
  | 'scanStatus'
  | 'scanEvents'
  | 'cancelScan';

export interface SpiderFootModule {
  readonly name: string;
  readonly descr: string | null;
}

export interface SpiderFootCapabilities {
  readonly probedAt: string;
  readonly reachable: boolean;
  readonly version: string | null;
  readonly modules: readonly SpiderFootModule[];
  readonly supports: Readonly<Record<KnownOperation, boolean>>;
  readonly notes: readonly string[];
}

export type ScanState =
  | 'created'
  | 'starting'
  | 'running'
  | 'finished'
  | 'aborted'
  | 'failed'
  | 'unknown';

export interface ScanStatus {
  readonly scanId: string;
  readonly state: ScanState;
  /** The instance's own status string, preserved verbatim. */
  readonly raw: string;
  readonly target: string | null;
}

export interface CreateScanRequest {
  readonly name: string;
  readonly target: string;
  readonly moduleNames?: readonly string[] | undefined;
  readonly useCase?: 'passive' | 'footprint' | 'investigate' | 'all' | undefined;
}

/** Terminal states: nothing more will happen on the instance. */
export function isTerminal(state: ScanState): boolean {
  return state === 'finished' || state === 'aborted' || state === 'failed';
}

/** §4.5's bounded backoff: 2s under a minute, 5s under ten, 15s after that. */
export function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 2_000;
  if (elapsedMs < 600_000) return 5_000;
  return 15_000;
}

/** sfwebui's own status vocabulary (`sfscan.py`), mapped onto §4.1's states. */
function toState(raw: string): ScanState {
  switch (raw.trim().toUpperCase()) {
    case 'CREATED':
      return 'created';
    case 'INITIALIZING':
    case 'STARTING':
    case 'STARTED':
      return 'starting';
    case 'RUNNING':
    case 'ABORT-REQUESTED':
      return 'running';
    case 'FINISHED':
      return 'finished';
    case 'ABORTED':
    case 'ABORTING':
      return 'aborted';
    case 'ERROR-FAILED':
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export interface SpiderFootClientOptions {
  readonly http: SpiderFootHttp;
  readonly baseUrl: string;
  /** Sent as-is on every request, e.g. an `authorization` header for a protected instance. */
  readonly authHeaders?: Readonly<Record<string, string>> | undefined;
  readonly now?: (() => number) | undefined;
}

export class SpiderFootClient {
  private capabilities: SpiderFootCapabilities | null = null;

  constructor(private readonly options: SpiderFootClientOptions) {}

  private url(path: string, query: Readonly<Record<string, string>> = {}): string {
    const base = this.options.baseUrl.replace(/\/$/, '');
    const search = new URLSearchParams(query).toString();
    return search === '' ? `${base}${path}` : `${base}${path}?${search}`;
  }

  private async send(
    operation: KnownOperation,
    request: Omit<SpiderFootHttpRequest, 'headers'> & {
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<string> {
    let response: SpiderFootHttpResponse;
    try {
      response = await this.options.http({
        url: request.url,
        method: request.method,
        headers: { accept: 'application/json', ...this.options.authHeaders, ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (cause) {
      throw new SpiderFootError('SF_UNREACHABLE', `SpiderFoot is unreachable: ${String(cause)}`, {
        operation,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new SpiderFootError('SF_AUTH', 'SpiderFoot rejected the credentials.', {
        httpStatus: response.status,
        operation,
      });
    }
    if (response.status < 200 || response.status >= 400) {
      throw new SpiderFootError('SF_UNREACHABLE', `SpiderFoot answered ${response.status}.`, {
        httpStatus: response.status,
        operation,
      });
    }
    return response.body;
  }

  private json(operation: KnownOperation, body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      throw new SpiderFootError(
        'SF_PARSE',
        'SpiderFoot answered with something that is not JSON.',
        {
          operation,
        },
      );
    }
  }

  private assertSupported(operation: KnownOperation): SpiderFootCapabilities {
    const capabilities = this.capabilities;
    if (capabilities === null) {
      throw new SpiderFootError('SF_PROBE_FAILED', 'Probe the instance before using it.', {
        operation,
      });
    }
    if (!capabilities.supports[operation]) {
      throw new SpiderFootError(
        'SF_UNSUPPORTED_OPERATION',
        `This SpiderFoot instance does not support ${operation}.`,
        { operation },
      );
    }
    return capabilities;
  }

  /**
   * §4.2's probe. `/ping` decides reachability and version; `/modules` decides whether the module
   * picker is offered. The write operations are never *called* by the probe — a probe that starts a
   * scan would be worse than no probe — they are enabled by a reachable, JSON-speaking instance and
   * confirmed lazily by their first real use.
   */
  async probe(): Promise<SpiderFootCapabilities> {
    const notes: string[] = [];
    let version: string | null = null;
    let reachable = false;

    try {
      const pong = this.json(
        'ping',
        await this.send('ping', { url: this.url('/ping'), method: 'GET' }),
      );
      if (Array.isArray(pong) && text(pong[0])?.toUpperCase() === 'SUCCESS') {
        reachable = true;
        version = text(pong[1]);
      } else {
        notes.push('/ping did not answer with the expected ["SUCCESS", version] shape.');
      }
    } catch (error) {
      if (error instanceof SpiderFootError && error.code === 'SF_AUTH') throw error;
      notes.push(error instanceof Error ? error.message : String(error));
    }

    let modules: SpiderFootModule[] = [];
    if (reachable) {
      try {
        const listed = this.json(
          'listModules',
          await this.send('listModules', { url: this.url('/modules'), method: 'GET' }),
        );
        if (Array.isArray(listed)) {
          modules = listed.flatMap((entry): SpiderFootModule[] => {
            if (typeof entry !== 'object' || entry === null) return [];
            const record = entry as Record<string, unknown>;
            const name = text(record.name);
            return name === null ? [] : [{ name, descr: text(record.descr) }];
          });
        }
      } catch {
        notes.push('This instance did not report its module list; use a scan profile instead.');
      }
    }

    const capabilities: SpiderFootCapabilities = {
      probedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      reachable,
      version,
      modules,
      supports: {
        ping: reachable,
        listModules: modules.length > 0,
        createScan: reachable,
        scanStatus: reachable,
        scanEvents: reachable,
        cancelScan: reachable,
      },
      notes,
    };
    this.capabilities = capabilities;
    if (!reachable) {
      throw new SpiderFootError('SF_UNREACHABLE', notes[0] ?? 'SpiderFoot did not answer /ping.', {
        operation: 'ping',
      });
    }
    return capabilities;
  }

  /** The last probe result, or `null` when the instance has never been probed in this process. */
  get probed(): SpiderFootCapabilities | null {
    return this.capabilities;
  }

  /** §4.4. Form-encoded, because that is what `startscan` reads; the id comes back in the JSON. */
  async createScan(request: CreateScanRequest): Promise<string> {
    this.assertSupported('createScan');
    const modules = request.moduleNames ?? [];
    if (modules.length === 0 && request.useCase === undefined) {
      throw new SpiderFootError(
        'SF_SCAN_REJECTED',
        'A scan needs either a module list or a use case.',
        { operation: 'createScan' },
      );
    }
    const form = new URLSearchParams({
      scanname: request.name,
      scantarget: request.target,
      modulelist: modules.length === 0 ? '' : `module_${modules.join(',module_')}`,
      typelist: '',
      usecase: modules.length > 0 ? '' : (request.useCase ?? ''),
    });

    const body = await this.send('createScan', {
      url: this.url('/startscan'),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const answer = this.json('createScan', body);
    if (!Array.isArray(answer) || answer.length < 2) {
      throw new SpiderFootError('SF_PARSE', 'Raven could not read the scan id from the answer.', {
        operation: 'createScan',
      });
    }
    const status = text(answer[0])?.toUpperCase();
    const value = text(answer[1]);
    if (status !== 'SUCCESS' || value === null) {
      throw new SpiderFootError(
        'SF_SCAN_REJECTED',
        value ?? 'SpiderFoot refused to start the scan.',
        { operation: 'createScan' },
      );
    }
    return value;
  }

  /** §4.5. An empty array means the instance does not know this scan (deleted, or wrong id). */
  async getStatus(scanId: string): Promise<ScanStatus> {
    this.assertSupported('scanStatus');
    const answer = this.json(
      'scanStatus',
      await this.send('scanStatus', {
        url: this.url('/scanstatus', { id: scanId }),
        method: 'GET',
      }),
    );
    if (!Array.isArray(answer) || answer.length === 0) {
      return { scanId, state: 'unknown', raw: '', target: null };
    }
    const raw = text(answer[5]) ?? '';
    return { scanId, state: toState(raw), raw, target: text(answer[1]) };
  }

  /**
   * §4.6. sfwebui has no cursor, so a page is always the whole result set so far — which is exactly
   * what "partial results while the scan runs" needs, and the caller dedupes by row identity.
   */
  async fetchEvents(scanId: string): Promise<readonly unknown[]> {
    this.assertSupported('scanEvents');
    const answer = this.json(
      'scanEvents',
      await this.send('scanEvents', {
        url: this.url('/scaneventresults', { id: scanId, eventType: 'ALL', filterfp: 'True' }),
        method: 'GET',
      }),
    );
    if (!Array.isArray(answer)) {
      throw new SpiderFootError('SF_PARSE', 'SpiderFoot answered results in an unknown shape.', {
        operation: 'scanEvents',
      });
    }
    return answer as readonly unknown[];
  }

  /** §4.7. `stopscan` answers an empty body on success and an error object when it refuses. */
  async cancel(scanId: string): Promise<void> {
    this.assertSupported('cancelScan');
    const body = await this.send('cancelScan', {
      url: this.url('/stopscan', { id: scanId }),
      method: 'GET',
    });
    if (body.trim() === '' || body.trim() === '""') return;
    const answer = this.json('cancelScan', body);
    if (typeof answer === 'object' && answer !== null && 'error' in answer) {
      const detail = (answer as { error?: { message?: unknown } }).error;
      throw new SpiderFootError(
        'SF_SCAN_REJECTED',
        text(detail?.message) ?? 'SpiderFoot refused to stop the scan.',
        { operation: 'cancelScan' },
      );
    }
  }
}

export interface RunScanProgress {
  readonly scanId: string;
  readonly status: ScanStatus;
  /** Everything the instance has produced so far — partial while the scan runs (§4.6). */
  readonly events: readonly unknown[];
}

export interface RunScanOptions {
  readonly timeoutMs?: number | undefined;
  readonly onProgress?: ((progress: RunScanProgress) => void) | undefined;
  /** Aborting stops collecting *and* cancels the scan on the instance (§4.7). */
  readonly signal?: { readonly aborted: boolean } | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface RunScanResult {
  readonly scanId: string;
  readonly status: ScanStatus;
  readonly events: readonly unknown[];
  /** True when collection stopped before a terminal state (timeout or cancel): still importable. */
  readonly partial: boolean;
  readonly canceled: boolean;
}

const DEFAULT_TIMEOUT_MS = 1_800_000;

/**
 * Start a scan and follow it to the end: §4.4 create, §4.5 backoff polling, §4.6 partial results on
 * every poll, §4.7 cancel on abort or timeout. Partial results always survive — a timed-out or
 * canceled scan returns everything read so far instead of throwing them away.
 */
export async function runScan(
  client: SpiderFootClient,
  request: CreateScanRequest,
  options: RunScanOptions = {},
): Promise<RunScanResult> {
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const scanId = await client.createScan(request);
  const startedAt = now();
  let status: ScanStatus = { scanId, state: 'created', raw: 'CREATED', target: request.target };
  let events: readonly unknown[] = [];
  let canceled = false;

  for (;;) {
    const elapsed = now() - startedAt;
    if (options.signal?.aborted === true || elapsed >= timeoutMs) {
      canceled = true;
      try {
        await client.cancel(scanId);
      } catch {
        // §4.7: never a fake success, but a failed cancel does not lose what was already read.
      }
      break;
    }

    await sleep(pollIntervalMs(elapsed));
    status = await client.getStatus(scanId);
    events = await client.fetchEvents(scanId);
    options.onProgress?.({ scanId, status, events });
    if (isTerminal(status.state)) break;
  }

  return { scanId, status, events, partial: !isTerminal(status.state), canceled };
}
