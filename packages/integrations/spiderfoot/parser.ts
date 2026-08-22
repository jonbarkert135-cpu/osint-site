/**
 * The `spiderfoot` output parser (stage 3, 12_SPIDERFOOT.md §4.3, §6).
 *
 * SpiderFoot's `/scaneventresults` has no published contract: some builds answer with an array of
 * row arrays (`[lastSeen, data, sourceData, module, eventType, ...]`), others with objects. Both
 * are read here — the tolerant-reader rule of §4.3 — and a row that fits neither shape is counted
 * as skipped rather than failing the whole import. Only the artifact being absent or not being
 * JSON at all is fatal.
 *
 * `RAW_*` payloads stay in the run artifact and never become nodes (§6.2).
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
import { classifyEvent, isArtifactOnly } from './mapping.ts';

/** The manifest caps the artifact at 32 MiB; this is the parser's hard stop. */
const MAX_ARTIFACT_BYTES = 33_554_432;
/** §4.6's ceiling, scaled to what one proposal can sanely hold. */
const MAX_EVENTS = 25_000;
/** A raw excerpt is provenance, not storage (§3.1 PROVENANCE_EXCERPT_LIMIT). */
const MAX_EXCERPT = 512;

interface SpiderFootEvent {
  readonly value: string;
  readonly eventType: string;
  readonly module: string;
  readonly sourceValue: string;
  readonly observedAt: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Row form: `[lastSeen, data, sourceData, module, eventType, ...]` (the sfwebui column order). */
function fromRow(row: readonly unknown[]): SpiderFootEvent | undefined {
  const value = str(row[1]);
  const eventType = str(row[4]);
  if (value === '' || eventType === '') return undefined;
  return {
    value,
    eventType,
    module: str(row[3]),
    sourceValue: str(row[2]),
    observedAt: str(row[0]),
  };
}

/** Object form, accepting both the snake_case and camelCase spellings seen in the wild. */
function fromObject(row: Record<string, unknown>): SpiderFootEvent | undefined {
  const value = str(row.data ?? row.value);
  const eventType = str(row.type ?? row.eventType ?? row.event_type);
  if (value === '' || eventType === '') return undefined;
  return {
    value,
    eventType,
    module: str(row.module ?? row.sourceModule ?? row.source_module),
    sourceValue: str(row.sourceData ?? row.source_data ?? row.source),
    observedAt: str(row.lastSeen ?? row.last_seen ?? row.generated ?? row.created),
  };
}

function readEvent(row: unknown): SpiderFootEvent | undefined {
  if (Array.isArray(row)) return fromRow(row);
  if (typeof row === 'object' && row !== null) return fromObject(row as Record<string, unknown>);
  return undefined;
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

/** Some builds wrap the rows in `{ data: [...] }`; both are accepted (§4.3). */
function rowsOf(payload: unknown): readonly unknown[] | undefined {
  if (Array.isArray(payload)) return payload as unknown[];
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as { data?: unknown; results?: unknown };
    const wrapped = record.data ?? record.results;
    if (Array.isArray(wrapped)) return wrapped as unknown[];
  }
  return undefined;
}

export const parser: OutputParser = {
  schemaVersions: ['1.0'],

  async parse(result, ctx): Promise<ParsedDocument> {
    const ref = result.artifacts[0] ?? result.stdoutRef;
    if (ref === undefined) throw new IntegrationError('OUTPUT_MISSING', { runId: result.runId });

    const rows = rowsOf(await readJson(ref, ctx, result.runId));
    if (rows === undefined) {
      throw new IntegrationError('PARSE_UNSUPPORTED_SHAPE', {
        runId: result.runId,
        detail: { expected: 'an array of scan events' },
      });
    }

    const includeUnmapped =
      (ctx.input as { includeUnmapped?: unknown } | undefined)?.includeUnmapped !== false;
    const records: ParsedRecord[] = [];
    const counters: Record<string, number> = { events: rows.length, skipped: 0, artifactOnly: 0 };
    const issues: UserMessage[] = [];

    for (const [index, row] of rows.entries()) {
      if (records.length >= MAX_EVENTS) {
        issues.push({
          level: 'warn',
          message: `This scan returned more than ${String(MAX_EVENTS)} findings; Raven imported the first ${String(MAX_EVENTS)}. Narrow the scan to see the rest.`,
        });
        break;
      }
      const event = readEvent(row);
      if (event === undefined) {
        counters.skipped = (counters.skipped ?? 0) + 1;
        continue;
      }
      if (isArtifactOnly(event.eventType)) {
        counters.artifactOnly = (counters.artifactOnly ?? 0) + 1;
        continue;
      }
      const mapping = classifyEvent(event.eventType);
      if (mapping.recordType === 'observation' && !includeUnmapped) {
        counters.skipped = (counters.skipped ?? 0) + 1;
        continue;
      }
      counters[mapping.recordType] = (counters[mapping.recordType] ?? 0) + 1;
      records.push({
        type: mapping.recordType,
        data: {
          value: event.value,
          eventType: event.eventType,
          module: event.module,
          sourceValue: event.sourceValue,
          observedAt: event.observedAt,
          raw: JSON.stringify(row).slice(0, MAX_EXCERPT),
        },
        pointer: `/${String(index)}`,
        observedAt: event.observedAt === '' ? result.finishedAt : event.observedAt,
        parserConfidence: mapping.baseConfidence,
      });
    }

    if ((counters.skipped ?? 0) > 0) {
      issues.push({
        level: 'info',
        message: `${String(counters.skipped)} rows were not in a shape Raven could read and were left out of the proposal.`,
      });
    }

    return { toolReportedVersion: '1.0', records, counters, nonFatalIssues: issues };
  },
};
