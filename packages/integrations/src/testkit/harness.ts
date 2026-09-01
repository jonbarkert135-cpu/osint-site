/**
 * The manifest + parser conformance harness (10_INTEGRATIONS.md §1.1, §13).
 *
 * Every integration — first-party today, third-party through the plugin SDK later — proves itself
 * against these helpers rather than against a hand-written test per tool. `assertManifestConforms`
 * is what makes §13 point 1's five assertions a one-liner in each tool's PR.
 */

import { classifyLicense } from '../license.ts';
import { safeParseManifest, type IntegrationManifest } from '../manifest.ts';
import type {
  ArtifactRef,
  OutputParser,
  ParsedDocument,
  RawRunResult,
  RunLogger,
  ParseContext,
} from '../pipeline.ts';

export interface ConformanceIssue {
  readonly rule: string;
  readonly message: string;
}

export interface ConformanceOptions {
  /** Node registry keys that exist in this build; mappings may not invent node types. */
  readonly knownNodeTypes?: ReadonlySet<string>;
  readonly knownEdgeTypes?: ReadonlySet<string>;
}

/** Returns every violation at once — a manifest author should not fix these one round-trip apiece. */
export function checkManifestConformance(
  raw: unknown,
  options: ConformanceOptions = {},
): readonly ConformanceIssue[] {
  const parsed = safeParseManifest(raw);
  if (!parsed.ok) {
    return parsed.issues.map((issue) => ({
      rule: 'schema',
      message: `${issue.path}: ${issue.message}`,
    }));
  }
  const manifest = parsed.manifest;
  const issues: ConformanceIssue[] = [];

  // §13's other four assertions (one primary output, pinned container digest, consent scope text,
  // at least one allowed target scope) are enforced by the manifest schema itself, so they can
  // only ever surface above as `schema` issues. Re-checking them here would be dead code; what the
  // schema cannot know is which node and edge types this *build* registers, so that is what is
  // left.
  // §60: the schema only knows `license` is a string. Whether that string means anything is a
  // separate question, and an unreviewed licence is a conformance failure, not a warning.
  const license = classifyLicense(manifest.license);
  if (license.category === 'unknown') {
    issues.push({
      rule: 'license-known',
      message: `license "${manifest.license}" is not a reviewed SPDX id — add it to license.ts after checking it`,
    });
  }

  for (const mapping of manifest.entityMappings) {
    if (
      options.knownNodeTypes !== undefined &&
      !options.knownNodeTypes.has(mapping.entity.nodeType)
    ) {
      issues.push({
        rule: 'node-type-exists',
        message: `entityMappings node type "${mapping.entity.nodeType}" is not in the node registry`,
      });
    }
    for (const relate of mapping.relate) {
      if (options.knownEdgeTypes !== undefined && !options.knownEdgeTypes.has(relate.edgeType)) {
        issues.push({
          rule: 'edge-type-exists',
          message: `entityMappings edge type "${relate.edgeType}" is not in the edge registry`,
        });
      }
    }
  }
  return issues;
}

export function assertManifestConforms(
  raw: unknown,
  options: ConformanceOptions = {},
): IntegrationManifest {
  const issues = checkManifestConformance(raw, options);
  if (issues.length > 0) {
    throw new Error(
      `manifest does not conform:\n  - ${issues.map((i) => `${i.rule}: ${i.message}`).join('\n  - ')}`,
    );
  }
  const parsed = safeParseManifest(raw);
  if (!parsed.ok) throw new Error('unreachable: conformance passed but parse failed');
  return parsed.manifest;
}

/** Collects log lines instead of writing them, so a parser test can assert on the run log. */
export function memoryLogger(): RunLogger & { readonly lines: readonly string[] } {
  const lines: string[] = [];
  return {
    lines,
    log(entry) {
      lines.push(`${entry.level} ${entry.phase} ${entry.message}`);
    },
  };
}

export function fakeArtifactRef(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    bucket: 'test',
    key: 'runs/test/result.json',
    bytes: 0,
    sha256: '0'.repeat(64),
    contentType: 'application/json',
    truncated: false,
    ...overrides,
  };
}

export function fakeRunResult(overrides: Partial<RawRunResult> = {}): RawRunResult {
  return {
    runId: 'run-test',
    status: 'succeeded',
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    artifacts: [fakeArtifactRef()],
    stats: { bytesOut: 0, egressRequests: 0, egressDenied: 0, peakMemMiB: 8 },
    ...overrides,
  };
}

/** A `ParseContext` backed by in-memory bytes; no S3, no clock, no network. */
export function memoryParseContext(
  manifest: IntegrationManifest,
  content: string,
  runId = 'run-test',
): ParseContext & { readonly logger: ReturnType<typeof memoryLogger> } {
  const logger = memoryLogger();
  return {
    manifest,
    runId,
    input: {},
    logger,
    readArtifact: () =>
      Promise.resolve(
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* stream() {
          yield new TextEncoder().encode(content);
        })(),
      ),
  };
}

/** Runs a parser over a fixture string; the golden-test primitive (§13 point 2). */
export async function parseFixture(
  parser: OutputParser,
  manifest: IntegrationManifest,
  content: string,
  result: RawRunResult = fakeRunResult(),
): Promise<ParsedDocument> {
  return parser.parse(result, memoryParseContext(manifest, content, result.runId));
}
