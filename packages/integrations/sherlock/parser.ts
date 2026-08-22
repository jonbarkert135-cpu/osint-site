/**
 * The `sherlock` output parser (13_SHERLOCK.md §4).
 *
 * The exact shape of `--json` is not a verified fact, so this is a shape detector followed by a
 * normalizer: three known layouts are read, and anything else is counted as unreadable instead of
 * throwing. The bias rule of §4.3 is the important part — every ambiguity resolves *away from*
 * `claimed`. A false negative costs a lead; a false positive costs an accusation.
 *
 * Only claimed profiles become records: an "available" site says nothing worth putting on a board.
 */

import { IntegrationError } from '../src/errors.ts';
import type {
  ArtifactRef,
  OutputParser,
  ParsedDocument,
  ParsedRecord,
  ParseContext,
  UserMessage,
} from '../src/pipeline.ts';

const MAX_ARTIFACT_BYTES = 33_554_432;
const MAX_EXCERPT = 512;

export type SherlockStatus = 'claimed' | 'available' | 'unknown' | 'error' | 'illegal';

/** §4.3, verbatim. Anything absent from this table is `unknown`, never a hit. */
const STATUS_MAP: Readonly<Record<string, SherlockStatus>> = {
  claimed: 'claimed',
  found: 'claimed',
  exists: 'claimed',
  true: 'claimed',
  available: 'available',
  not_found: 'available',
  notfound: 'available',
  false: 'available',
  error: 'error',
  unknown: 'unknown',
  illegal: 'illegal',
  blocked: 'error',
  waf: 'error',
};

const SITE_KEYS = [
  'status',
  'exists',
  'url_user',
  'url',
  'http_status',
  'response_time_s',
  'error',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeSiteRecord(value: unknown): boolean {
  return isRecord(value) && SITE_KEYS.some((key) => key in value);
}

function pickAny(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Stringifies only scalars: an object stringifies to "[object Object]", which is not a status. */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function readStatus(record: Record<string, unknown>): SherlockStatus {
  const raw = pickAny(record, ['status', 'exists', 'result', 'state']);
  if (raw === undefined) return 'unknown';
  const inner = isRecord(raw) ? raw.status : raw;
  return STATUS_MAP[scalar(inner).toLowerCase().trim()] ?? 'unknown';
}

/**
 * Tool output is untrusted input (N7): a profile URL is kept only when it is an absolute http(s)
 * URL on a public-looking host, otherwise the record travels on without one.
 */
export function safeProfileUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal'))
    return undefined;
  if (/^(?:10|127|0)\./.test(host)) return undefined;
  if (/^169\.254\./.test(host) || /^192\.168\./.test(host)) return undefined;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return undefined;
  if (host.startsWith('[') || host.includes(':')) return undefined;
  return url.toString();
}

export type SherlockShape = 'array-of-records' | 'map-of-sites' | 'map-of-usernames' | 'unknown';

export interface SherlockRow {
  readonly site: string;
  readonly record: Record<string, unknown>;
  readonly username?: string;
}

/** §4.2's shape detection, kept as one pure function so every branch is testable. */
export function detectShape(payload: unknown): { shape: SherlockShape; rows: SherlockRow[] } {
  if (Array.isArray(payload)) {
    const rows = payload.filter(isRecord).map((record) => ({
      site: scalar(pickAny(record, ['site', 'name'])).slice(0, 64),
      record,
    }));
    return { shape: 'array-of-records', rows };
  }
  if (!isRecord(payload)) return { shape: 'unknown', rows: [] };

  const entries = Object.entries(payload);
  const sample = entries[0]?.[1];
  if (looksLikeSiteRecord(sample)) {
    return {
      shape: 'map-of-sites',
      rows: entries
        .filter(([, value]) => isRecord(value))
        .map(([site, value]) => ({
          site: site.slice(0, 64),
          record: value as Record<string, unknown>,
        })),
    };
  }
  if (isRecord(sample) && Object.values(sample).every(looksLikeSiteRecord)) {
    const rows: SherlockRow[] = [];
    for (const [username, sites] of entries) {
      if (!isRecord(sites)) continue;
      for (const [site, value] of Object.entries(sites)) {
        if (isRecord(value)) rows.push({ site: site.slice(0, 64), record: value, username });
      }
    }
    return { shape: 'map-of-usernames', rows };
  }
  return { shape: 'unknown', rows: [] };
}

async function readJson(ref: ArtifactRef, ctx: ParseContext, runId: string): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of await ctx.readArtifact(ref)) {
    bytes += chunk.byteLength;
    if (bytes > MAX_ARTIFACT_BYTES) break;
    chunks.push(chunk);
  }
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(joined));
  } catch {
    throw new IntegrationError('PARSE_UNSUPPORTED_SHAPE', { runId, detail: { artifact: ref.key } });
  }
}

export const parser: OutputParser = {
  schemaVersions: ['1.0'],

  async parse(result, ctx): Promise<ParsedDocument> {
    const ref = result.artifacts[0] ?? result.stdoutRef;
    if (ref === undefined) throw new IntegrationError('OUTPUT_MISSING', { runId: result.runId });

    const payload = await readJson(ref, ctx, result.runId);
    const { shape, rows } = detectShape(payload);
    if (shape === 'unknown') {
      // §4.5: an unreadable document is a failed parse with the raw artifact still downloadable.
      throw new IntegrationError('PARSE_UNSUPPORTED_SHAPE', {
        runId: result.runId,
        detail: { expected: 'an array of site results, or a map keyed by site or by username' },
      });
    }

    const fallbackUsername =
      typeof (ctx.input as { username?: unknown } | undefined)?.username === 'string'
        ? (ctx.input as { username: string }).username
        : undefined;

    const records: ParsedRecord[] = [];
    const counters: Record<string, number> = {
      total: rows.length,
      claimed: 0,
      available: 0,
      error: 0,
      unknown: 0,
      unreadable: 0,
      withoutUrl: 0,
    };
    const issues: UserMessage[] = [];

    for (const [index, row] of rows.entries()) {
      const status = readStatus(row.record);
      counters[status] = (counters[status] ?? 0) + 1;
      if (status !== 'claimed') continue;
      const url = safeProfileUrl(pickAny(row.record, ['url_user', 'url', 'profile_url']));
      if (url === undefined || row.site === '') {
        counters.withoutUrl = (counters.withoutUrl ?? 0) + 1;
        continue;
      }
      records.push({
        type: 'profile',
        data: {
          site: row.site,
          url,
          urlMain: safeProfileUrl(row.record.url_main) ?? new URL(url).origin,
          username: row.username ?? fallbackUsername ?? '',
          status,
          httpStatus: Number(pickAny(row.record, ['http_status', 'status_code'])) || null,
          raw: JSON.stringify(row.record).slice(0, MAX_EXCERPT),
        },
        pointer: `/${String(index)}`,
        observedAt: result.finishedAt,
        parserConfidence: 0.7,
      });
    }

    if ((counters.error ?? 0) > 0) {
      issues.push({
        level: 'info',
        message: `${String(counters.error)} sites answered with an error or blocked the check, so they are neither a hit nor a miss.`,
      });
    }
    if ((counters.withoutUrl ?? 0) > 0) {
      issues.push({
        level: 'warn',
        message: `${String(counters.withoutUrl)} claimed results carried no usable profile link and were left out.`,
      });
    }
    if (result.status === 'partial' || result.status === 'timed_out') {
      issues.push({
        level: 'warn',
        message: 'The run stopped early, so this is what was collected, not the full site list.',
      });
    }

    return { toolReportedVersion: '1.0', records, counters, nonFatalIssues: issues };
  },
};
