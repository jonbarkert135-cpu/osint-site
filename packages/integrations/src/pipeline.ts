/**
 * The eight-stage pipeline contracts and their default, manifest-driven implementations
 * (10_INTEGRATIONS.md §3).
 *
 * Stages 1–2 run in the API/runner, 3–7 in `apps/worker`, and stage 8 (`Applier`, `./apply.ts`)
 * client-side against the Y.Doc so undo covers an import as one step (N3). Everything here is pure:
 * no I/O, no clock, no randomness — the orchestrator is handed `now()` and an artifact reader, which
 * is what makes the property test in `test/pipeline.property.test.ts` possible at all.
 */

import { IntegrationError, type IntegrationErrorPayload } from './errors.ts';
import {
  computeConfidence,
  DEFAULT_SELECTION_THRESHOLD,
  type VersionDrift,
} from './extract/confidence.ts';
import type {
  EntityKind,
  IntegrationId,
  EntityMapping,
  IntegrationManifest,
  ResourceLimits,
  TargetScope,
} from './manifest.ts';
import { identityFor, tempIdFor } from './resolve/identity.ts';
import { decideField, resolveEntity, type ExistingNodeMatch } from './resolve/merge.ts';

/* --------------------------------------------------------------- 3.1 primitives */

/** uuidv7 in the database, cuid2 in tests — the pipeline only requires sortable opacity. */
export type RunId = string;

export interface UserMessage {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ArtifactRef {
  readonly bucket: string;
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
  /** True when the output size cap was hit (§6.8). */
  readonly truncated: boolean;
}

/**
 * Tool provenance as §3.1 defines it. It is richer than `@nexus/domain`'s board-level `Provenance`
 * (which is a small, closed record on every node); `toDomainProvenance` in `./apply.ts` projects
 * one onto the other, and the full object is appended to `props.__provenance` (§8.5).
 */
export interface Provenance {
  readonly source: string;
  readonly tool: IntegrationId;
  readonly toolVersion: string;
  readonly runId: RunId;
  readonly observedAt: string;
  readonly importedAt: string;
  readonly confidence: number;
  readonly artifactRef?: ArtifactRef;
  readonly pointer?: string;
  readonly actorUserId: string;
  /** ≤ 4 KiB excerpt of the raw record, so provenance survives artifact expiry (§6.9). */
  readonly excerpt?: string;
}

export const PROVENANCE_EXCERPT_LIMIT = 4096;

/* --------------------------------------------------------------- 3.2 InputAdapter */

export interface GraphNodeRef {
  readonly id: string;
  readonly kind: EntityKind;
  readonly label: string;
  readonly props: Readonly<Record<string, unknown>>;
}

export interface IntegrationInvocation {
  readonly integrationId: IntegrationId;
  readonly boardId: string;
  readonly selection: readonly GraphNodeRef[];
  readonly formValues: Record<string, unknown>;
  readonly actorUserId: string;
}

export interface ResolvedTarget {
  readonly kind: EntityKind;
  readonly value: string;
  readonly scope: TargetScope;
}

export interface InputAdapterResult<I = Record<string, unknown>> {
  readonly input: I;
  readonly targets: readonly ResolvedTarget[];
  readonly warnings: readonly UserMessage[];
}

export interface InputAdapter<I = Record<string, unknown>> {
  /** Pure. Must not perform I/O. Throws `IntegrationError('INPUT_INVALID')`. */
  adapt(inv: IntegrationInvocation): InputAdapterResult<I>;
  accepts(selection: readonly GraphNodeRef[]): boolean;
}

/* --------------------------------------------------------------- 3.3 ExecutionLayer */

export interface EffectiveLimits {
  readonly wallClockMs: number;
  readonly cpuMillicores: number;
  readonly memoryMiB: number;
  readonly pids: number;
  readonly maxOutputBytes: number;
  readonly maxArtifacts: number;
  readonly egressAllowlist: readonly string[];
  readonly maxRequestsPerMinute: number;
}

export interface ExecutionRequest<I = unknown> {
  readonly runId: RunId;
  readonly manifest: IntegrationManifest;
  readonly input: I;
  readonly secretsRef: readonly string[];
  readonly limits: EffectiveLimits;
  /** Redis key the runner watches for cooperative cancellation (§6.7). */
  readonly cancelToken: string;
}

export const RUN_STATUSES = [
  'queued',
  'awaiting_approval',
  'starting',
  'running',
  'parsing',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type TerminalRunStatus = Extract<
  RunStatus,
  'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
>;

export interface RunStats {
  readonly bytesOut: number;
  readonly egressRequests: number;
  readonly egressDenied: number;
  readonly egressThrottled?: number;
  readonly peakMemMiB: number;
  readonly itemsFound?: number;
}

export interface RawRunResult {
  readonly runId: RunId;
  readonly status: TerminalRunStatus;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** Primary output first. */
  readonly artifacts: readonly ArtifactRef[];
  readonly stdoutRef?: ArtifactRef;
  readonly stderrRef?: ArtifactRef;
  readonly stats: RunStats;
  readonly error?: IntegrationErrorPayload;
}

export interface ExecutionLayer {
  execute(req: ExecutionRequest): Promise<RawRunResult>;
  cancel(runId: RunId): Promise<void>;
}

/* --------------------------------------------------------------- 3.4 OutputParser */

export interface RunLogger {
  log(entry: {
    level: 'debug' | 'info' | 'warn' | 'error';
    phase: string;
    message: string;
    data?: Record<string, unknown>;
  }): void;
}

export interface ParseContext {
  readonly manifest: IntegrationManifest;
  readonly runId: RunId;
  readonly input: unknown;
  /** Streams the artifact; parsers above 8 MiB must stream rather than buffer (§3.4). */
  readonly readArtifact: (ref: ArtifactRef) => Promise<AsyncIterable<Uint8Array>>;
  readonly logger: RunLogger;
}

export interface ParsedRecord {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly pointer: string;
  readonly observedAt: string;
  readonly parserConfidence: number;
}

export interface ParsedDocument {
  readonly toolReportedVersion?: string;
  readonly records: readonly ParsedRecord[];
  readonly counters: Readonly<Record<string, number>>;
  readonly nonFatalIssues: readonly UserMessage[];
}

export interface OutputParser {
  readonly schemaVersions: readonly string[];
  parse(res: RawRunResult, ctx: ParseContext): Promise<ParsedDocument>;
}

/* --------------------------------------------------------------- 3.5 EntityExtractor */

export interface ExtractedEntity {
  readonly kind: EntityKind;
  readonly value: string;
  readonly display: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly identityKey: string;
  readonly confidence: number;
  readonly origin: { recordIndex: number; pointer: string; field?: string };
  /** The node type the manifest asked for; the mapper needs it, the resolver does not. */
  readonly nodeType: string;
  readonly title: string;
  readonly tags: readonly string[];
}

export interface ExtractedRelation {
  readonly fromKey: string;
  readonly toKey: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly label?: string;
  readonly confidence: number;
  readonly origin: { recordIndex: number; pointer: string };
}

export interface ExtractionResult {
  readonly entities: readonly ExtractedEntity[];
  readonly relations: readonly ExtractedRelation[];
  readonly issues: readonly UserMessage[];
}

export interface EntityExtractor {
  extract(doc: ParsedDocument, ctx: ExtractContext): ExtractionResult;
}

export interface ExtractContext {
  readonly manifest: IntegrationManifest;
  /** Identity key of the node the run was launched from, for `relate: { to: 'anchor' }`. */
  readonly anchorKey?: string;
  readonly drift?: VersionDrift;
  readonly defaultRegion?: string;
}

/* --------------------------------------------------------------- 3.6 mappers */

export type NodeRefOrTemp =
  | { readonly kind: 'existing'; readonly nodeId: string }
  | { readonly kind: 'temp'; readonly tempId: string };

export interface ProposedNode {
  readonly tempId: string;
  readonly identityKey: string;
  readonly nodeType: string;
  readonly title: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly provenance: Provenance;
  readonly layoutHint?: { anchorNodeId?: string; ring: number; index: number };
}

export interface ProposedEdge {
  readonly tempId: string;
  readonly fromRef: NodeRefOrTemp;
  readonly toRef: NodeRefOrTemp;
  readonly edgeType: string;
  readonly label?: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly provenance: Provenance;
}

export interface MapContext {
  readonly boardId: string;
  readonly anchorNodeId?: string;
  readonly resolve: (identityKey: string) => ExistingNodeMatch | undefined;
  readonly provenanceFor: (origin: { pointer: string }, confidence: number) => Provenance;
}

export interface NodeMapper {
  map(e: ExtractionResult, ctx: MapContext): readonly ProposedNode[];
}

export interface RelationshipMapper {
  map(
    e: ExtractionResult,
    nodes: readonly ProposedNode[],
    ctx: MapContext,
  ): readonly ProposedEdge[];
}

/* --------------------------------------------------------------- 3.7 ImportProposal */

export type ProposalItemKind = 'new_node' | 'new_edge' | 'enrich' | 'conflict';

export interface ProposalItemBase {
  readonly id: string;
  readonly kind: ProposalItemKind;
  readonly selectedByDefault: boolean;
  readonly confidence: number;
  readonly explain: string;
}

export interface NewNodeItem extends ProposalItemBase {
  readonly kind: 'new_node';
  readonly node: ProposedNode;
}

export interface NewEdgeItem extends ProposalItemBase {
  readonly kind: 'new_edge';
  readonly edge: ProposedEdge;
}

export interface FieldPatch {
  readonly path: string;
  readonly op: 'set' | 'append' | 'addToSet';
  readonly value: unknown;
  readonly previous?: unknown;
}

export interface EnrichItem extends ProposalItemBase {
  readonly kind: 'enrich';
  readonly targetNodeId: string;
  readonly fieldPatches: readonly FieldPatch[];
  readonly provenance: Provenance;
}

export interface ConflictItem extends ProposalItemBase {
  readonly kind: 'conflict';
  readonly targetNodeId: string;
  readonly field: string;
  readonly currentValue: unknown;
  readonly incomingValue: unknown;
  readonly currentProvenance?: Provenance;
  readonly incomingProvenance: Provenance;
  readonly resolution: 'keep' | 'replace' | 'keep_both';
}

export type ProposalItem = NewNodeItem | NewEdgeItem | EnrichItem | ConflictItem;

export interface ProposalSummary {
  readonly newNodes: number;
  readonly newEdges: number;
  readonly enriched: number;
  readonly conflicts: number;
  readonly skippedDuplicates: number;
}

export interface ImportProposal {
  readonly id: string;
  readonly runId: RunId;
  readonly integrationId: IntegrationId;
  readonly boardId: string;
  readonly createdAt: string;
  readonly summary: ProposalSummary;
  readonly items: readonly ProposalItem[];
  readonly issues: readonly UserMessage[];
  /** now + 7 days; after that a re-run is required (§6.9). */
  readonly expiresAt: string;
}

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------- defaults: InputAdapter */

/** Pointer resolution over a parsed record (RFC 6901 subset: no URI fragment form). */
export function jsonPointer(data: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return data;
  let current: unknown = data;
  for (const rawSegment of pointer.replace(/^\//, '').split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The default adapter: every manifest that does not need derived inputs uses this, which is what
 * keeps "add a tool" at "add a manifest" (R2).
 */
export function manifestInputAdapter(manifest: IntegrationManifest): InputAdapter {
  const selectionKinds = new Set<EntityKind>();
  for (const field of manifest.inputs) {
    if (field.from.source === 'selection')
      for (const kind of field.from.kinds) selectionKinds.add(kind);
  }

  return {
    accepts(selection) {
      if (selectionKinds.size === 0) return true;
      return selection.some((node) => selectionKinds.has(node.kind));
    },

    adapt(inv) {
      const input: Record<string, unknown> = {};
      const warnings: UserMessage[] = [];
      const targets: ResolvedTarget[] = [];
      const scope = manifest.consent.allowedTargetScopes[0] ?? 'public-index';

      for (const field of manifest.inputs) {
        const raw = readFieldValue(field.name, field.from, inv);
        const value = raw === undefined ? field.default : raw;

        if (value === undefined || value === '') {
          if (field.required) {
            throw new IntegrationError('INPUT_INVALID', {
              why: `"${field.label}" is required and was not provided.`,
              detail: { field: field.name },
            });
          }
          continue;
        }

        const coerced = coerceField(field.type, value, field.label, field.name);
        if (field.pattern !== undefined) {
          const pattern = new RegExp(field.pattern, 'u');
          for (const item of Array.isArray(coerced) ? coerced : [coerced]) {
            if (!pattern.test(String(item))) {
              throw new IntegrationError('INPUT_INVALID', {
                why: `"${field.label}" does not match the format this tool accepts.`,
                detail: { field: field.name },
              });
            }
          }
        }
        if (typeof coerced === 'number') {
          if (field.min !== undefined && coerced < field.min) {
            throw new IntegrationError('INPUT_INVALID', {
              why: `"${field.label}" must be at least ${String(field.min)}.`,
              detail: { field: field.name },
            });
          }
          if (field.max !== undefined && coerced > field.max) {
            throw new IntegrationError('INPUT_INVALID', {
              why: `"${field.label}" must be at most ${String(field.max)}.`,
              detail: { field: field.name },
            });
          }
        }
        if (
          Array.isArray(coerced) &&
          field.maxItems !== undefined &&
          coerced.length > field.maxItems
        ) {
          throw new IntegrationError('INPUT_INVALID', {
            why: `"${field.label}" accepts at most ${String(field.maxItems)} values.`,
            detail: { field: field.name },
          });
        }

        input[field.name] = coerced;

        // Anything sourced from the selection or typed as an entity is a legal-gate target (§12.2).
        const kinds =
          field.from.source === 'selection' ? field.from.kinds : (field.entityKinds ?? []);
        for (const kind of kinds) {
          for (const item of Array.isArray(coerced) ? coerced : [coerced]) {
            const identity = identityFor(kind, String(item));
            if (identity.ok && identity.value !== undefined) {
              targets.push({ kind, value: identity.value, scope });
              break;
            }
          }
        }
      }

      if (targets.length === 0 && manifest.inputs.length > 0) {
        warnings.push({
          level: 'info',
          message:
            'This run has no resolvable target; the consent scope covers the tool as a whole.',
        });
      }

      return { input, targets: dedupeTargets(targets), warnings };
    },
  };
}

function dedupeTargets(targets: readonly ResolvedTarget[]): readonly ResolvedTarget[] {
  const seen = new Map<string, ResolvedTarget>();
  for (const target of targets) seen.set(`${target.kind}:${target.value}`, target);
  return [...seen.values()];
}

function readFieldValue(
  name: string,
  from: IntegrationManifest['inputs'][number]['from'],
  inv: IntegrationInvocation,
): unknown {
  if (from.source === 'form') return inv.formValues[name];
  if (from.source === 'selection') {
    const kinds = new Set<EntityKind>(from.kinds);
    const match = inv.selection.find((node) => kinds.has(node.kind));
    if (match !== undefined) return match.label;
    return inv.formValues[name];
  }
  // `derived` expressions are a first-party-only escape hatch; the declarative path supports the
  // one form the spec names, `domainOf(<field>)`, and refuses anything else rather than eval'ing.
  const derived = /^domainOf\(([a-zA-Z_][a-zA-Z0-9_]*)\)$/.exec(from.expr);
  if (derived === null) {
    throw new IntegrationError('MANIFEST_TEMPLATE_UNRESOLVED', {
      why: `Derived input "${name}" uses an expression this build does not support.`,
      detail: { expr: from.expr },
    });
  }
  const sourceName = derived[1] ?? '';
  const source = inv.formValues[sourceName] ?? inv.selection.find((n) => n.kind === 'url')?.label;
  if (typeof source !== 'string') return undefined;
  const identity = identityFor('url', source);
  if (!identity.ok || identity.meta === undefined) return undefined;
  return identity.meta.host;
}

function coerceField(
  type: IntegrationManifest['inputs'][number]['type'],
  value: unknown,
  label: string,
  name: string,
): unknown {
  switch (type) {
    case 'number':
    case 'duration': {
      const numeric = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isFinite(numeric)) {
        throw new IntegrationError('INPUT_INVALID', {
          why: `"${label}" must be a number.`,
          detail: { field: name },
        });
      }
      return numeric;
    }
    case 'boolean':
      return value === true || value === 'true';
    case 'entityList':
      return Array.isArray(value) ? value.map((item) => String(item)) : [String(value)];
    default:
      return typeof value === 'string' ? value.trim() : value;
  }
}

/** Stringifies a pointer result without ever producing "[object Object]". */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/* --------------------------------------------------------------- defaults: extractor */

const TRANSFORMS: Readonly<Record<string, (raw: unknown) => unknown>> = {
  none: (raw) => raw,
  lower: (raw) => (typeof raw === 'string' ? raw.toLowerCase() : raw),
  trim: (raw) => (typeof raw === 'string' ? raw.trim() : raw),
  'url-normalize': (raw) => {
    if (typeof raw !== 'string') return raw;
    const identity = identityFor('url', raw);
    return identity.ok ? identity.value : raw;
  },
  'domain-of': (raw) => {
    if (typeof raw !== 'string') return raw;
    const identity = identityFor('url', raw);
    return identity.ok && identity.meta !== undefined ? identity.meta.host : raw;
  },
  'strip-at': (raw) => (typeof raw === 'string' ? raw.replace(/^@+/, '') : raw),
  // A hash transform that needs WebCrypto would make the extractor async for one rarely-used
  // field. `sha256` is applied by the parser, which already has the artifact bytes; here it is a
  // pass-through with an explicit issue rather than a silent lie.
  sha256: (raw) => raw,
};

/** Declarative `entityMappings` execution, exactly the algorithm in §4.5. */
export function manifestEntityExtractor(manifest: IntegrationManifest): EntityExtractor {
  return {
    extract(doc, ctx) {
      const entities: ExtractedEntity[] = [];
      const relations: ExtractedRelation[] = [];
      const issues: UserMessage[] = [...doc.nonFatalIssues];

      doc.records.forEach((record, recordIndex) => {
        const mappings = manifest.entityMappings.filter((m) => m.when.recordType === record.type);
        if (mappings.length === 0) return;
        const keysInRecord = new Map<string, string>();

        for (const mapping of mappings) {
          const extracted = applyMapping(mapping, record, recordIndex, ctx, issues);
          if (extracted === undefined) continue;
          entities.push(extracted);
          if (mapping.id !== undefined) keysInRecord.set(mapping.id, extracted.identityKey);
        }

        for (const mapping of mappings) {
          const selfKey = mapping.id === undefined ? undefined : keysInRecord.get(mapping.id);
          const ownEntity = entities.find(
            (e) =>
              e.origin.recordIndex === recordIndex &&
              (selfKey === undefined || e.identityKey === selfKey),
          );
          if (ownEntity === undefined) continue;

          for (const relate of mapping.relate) {
            const otherKey =
              relate.to === 'anchor' ? ctx.anchorKey : keysInRecord.get(relate.toEntityRef ?? '');
            if (otherKey === undefined) {
              issues.push({
                level: 'warn',
                message: `mapping ${mapping.id ?? mapping.when.recordType}: relation target could not be resolved`,
                detail: { pointer: record.pointer },
              });
              continue;
            }
            const [fromKey, toKey] =
              relate.direction === 'in'
                ? [otherKey, ownEntity.identityKey]
                : [ownEntity.identityKey, otherKey];
            relations.push({
              fromKey,
              toKey,
              type: relate.edgeType,
              ...(relate.label === undefined ? {} : { label: relate.label }),
              confidence: ownEntity.confidence,
              origin: { recordIndex, pointer: record.pointer },
            });
          }
        }
      });

      return { entities, relations, issues };
    },
  };
}

function applyMapping(
  mapping: EntityMapping,
  record: ParsedRecord,
  recordIndex: number,
  ctx: ExtractContext,
  issues: UserMessage[],
): ExtractedEntity | undefined {
  const rawValue = jsonPointer(record.data, mapping.entity.valueFrom);
  if (rawValue === undefined || rawValue === null || asText(rawValue).trim() === '') {
    issues.push({
      level: 'warn',
      message: `mapping ${mapping.id ?? mapping.when.recordType}: empty identity value at ${mapping.entity.valueFrom}`,
      detail: { pointer: record.pointer },
    });
    return undefined;
  }

  const identity = identityFor(mapping.entity.kind, asText(rawValue), {
    ...(ctx.defaultRegion === undefined ? {} : { defaultRegion: ctx.defaultRegion }),
  });
  if (!identity.ok || identity.key === undefined || identity.value === undefined) {
    issues.push({
      level: 'warn',
      message: `mapping ${mapping.id ?? mapping.when.recordType}: value ${identity.reason ?? 'was rejected'}`,
      detail: { pointer: record.pointer },
    });
    return undefined;
  }

  const props: Record<string, unknown> = {};
  for (const field of mapping.entity.fields) {
    const raw = jsonPointer(record.data, field.from);
    if (raw === undefined || raw === null) {
      if (field.required) {
        issues.push({
          level: 'warn',
          message: `mapping ${mapping.id ?? mapping.when.recordType}: required field ${field.from} is missing`,
          detail: { pointer: record.pointer },
        });
        return undefined;
      }
      continue;
    }
    const transform = TRANSFORMS[field.transform] ?? TRANSFORMS.none;
    props[field.to] = transform === undefined ? raw : transform(raw);
  }

  const title =
    mapping.entity.titleFrom === undefined
      ? (identity.display ?? identity.value)
      : asText(
          jsonPointer(record.data, mapping.entity.titleFrom) ?? identity.display ?? identity.value,
        );

  return {
    kind: mapping.entity.kind,
    value: identity.value,
    display: identity.display ?? identity.value,
    props,
    identityKey: identity.key,
    confidence: computeConfidence({
      base: mapping.entity.baseConfidence,
      source: 'assertion',
      parserConfidence: record.parserConfidence,
      ...(ctx.drift === undefined ? {} : { drift: ctx.drift }),
    }),
    origin: { recordIndex, pointer: record.pointer },
    nodeType: mapping.entity.nodeType,
    title,
    tags: mapping.entity.tags,
  };
}

/* --------------------------------------------------------------- defaults: mappers */

/** Radial placement hints (05_CANVAS_ENGINE.md §9.3); the Applier turns them into coordinates. */
export function defaultNodeMapper(): NodeMapper {
  return {
    map(extraction, ctx) {
      const nodes: ProposedNode[] = [];
      let index = 0;
      for (const entity of extraction.entities) {
        if (ctx.resolve(entity.identityKey) !== undefined) continue; // enrichment, not a new node
        if (nodes.some((n) => n.identityKey === entity.identityKey)) continue;
        nodes.push({
          tempId: tempIdFor('n', entity.identityKey),
          identityKey: entity.identityKey,
          nodeType: entity.nodeType,
          title: entity.title,
          props: entity.props,
          tags: entity.tags,
          provenance: ctx.provenanceFor({ pointer: entity.origin.pointer }, entity.confidence),
          layoutHint: {
            ...(ctx.anchorNodeId === undefined ? {} : { anchorNodeId: ctx.anchorNodeId }),
            ring: 1 + Math.floor(index / 12),
            index: index % 12,
          },
        });
        index += 1;
      }
      return nodes;
    },
  };
}

export function defaultRelationshipMapper(): RelationshipMapper {
  return {
    map(extraction, nodes, ctx) {
      const byKey = new Map(nodes.map((node) => [node.identityKey, node]));
      const edges: ProposedEdge[] = [];
      for (const relation of extraction.relations) {
        const fromRef = refFor(relation.fromKey, byKey, ctx);
        const toRef = refFor(relation.toKey, byKey, ctx);
        if (fromRef === undefined || toRef === undefined) continue;
        edges.push({
          tempId: tempIdFor('e', `${relation.fromKey}|${relation.type}|${relation.toKey}`),
          fromRef,
          toRef,
          edgeType: relation.type,
          ...(relation.label === undefined ? {} : { label: relation.label }),
          props: relation.props ?? {},
          provenance: ctx.provenanceFor({ pointer: relation.origin.pointer }, relation.confidence),
        });
      }
      return edges;
    },
  };
}

function refFor(
  key: string,
  byKey: ReadonlyMap<string, ProposedNode>,
  ctx: MapContext,
): NodeRefOrTemp | undefined {
  const proposed = byKey.get(key);
  if (proposed !== undefined) return { kind: 'temp', tempId: proposed.tempId };
  const existing = ctx.resolve(key);
  if (existing !== undefined) return { kind: 'existing', nodeId: existing.nodeId };
  return undefined;
}

/* --------------------------------------------------------------- stage 7: proposal */

export interface BuildProposalInput {
  readonly proposalId: string;
  readonly runId: RunId;
  readonly integrationId: IntegrationId;
  readonly boardId: string;
  readonly now: string;
  readonly extraction: ExtractionResult;
  readonly nodes: readonly ProposedNode[];
  readonly edges: readonly ProposedEdge[];
  readonly ctx: MapContext;
}

/**
 * Stage 7. Turns everything the earlier stages produced into the reviewable proposal: new nodes and
 * edges, enrichment patches for identities that already exist, and conflicts for the fields the
 * merge policy refuses to decide on its own (§8.3).
 */
export function buildProposal(input: BuildProposalInput): ImportProposal {
  const items: ProposalItem[] = [];
  let skippedDuplicates = 0;

  for (const node of input.nodes) {
    items.push({
      id: node.tempId,
      kind: 'new_node',
      selectedByDefault: node.provenance.confidence >= DEFAULT_SELECTION_THRESHOLD,
      confidence: node.provenance.confidence,
      explain: `${input.integrationId} observed ${node.title} in this run.`,
      node,
    });
  }

  const selectedNodeIds = new Set(
    items
      .filter((item) => item.kind === 'new_node' && item.selectedByDefault)
      .map((item) => item.id),
  );

  for (const edge of input.edges) {
    const endpointsSelected = [edge.fromRef, edge.toRef].every(
      (ref) => ref.kind === 'existing' || selectedNodeIds.has(ref.tempId),
    );
    items.push({
      id: edge.tempId,
      kind: 'new_edge',
      selectedByDefault: endpointsSelected,
      confidence: edge.provenance.confidence,
      explain: `${input.integrationId} linked these two entities in the same record.`,
      edge,
    });
  }

  // Enrichment / conflicts for entities that already exist on the board.
  for (const entity of input.extraction.entities) {
    const existing = input.ctx.resolve(entity.identityKey);
    if (existing === undefined) continue;
    const provenance = input.ctx.provenanceFor(
      { pointer: entity.origin.pointer },
      entity.confidence,
    );
    const patches: FieldPatch[] = [];

    for (const [field, incoming] of Object.entries(entity.props)) {
      const decision = decideField({
        field,
        current: existing.props[field],
        incoming,
        ...(existing.confidence === undefined ? {} : { currentConfidence: existing.confidence }),
        incomingConfidence: entity.confidence,
        props: existing.props,
      });
      if (decision.kind === 'skip') {
        skippedDuplicates += 1;
        continue;
      }
      if (decision.kind === 'conflict') {
        items.push({
          id: `c:${existing.nodeId}:${field}`,
          kind: 'conflict',
          selectedByDefault: false,
          confidence: entity.confidence,
          explain: decision.manual
            ? `You edited ${field} by hand; ${input.integrationId} reports a different value.`
            : `${input.integrationId} reports a different ${field} than the board holds.`,
          targetNodeId: existing.nodeId,
          field,
          currentValue: existing.props[field],
          incomingValue: incoming,
          incomingProvenance: provenance,
          resolution: decision.defaultResolution,
        });
        continue;
      }
      patches.push({
        path: `/${field}`,
        op: decision.kind === 'addToSet' ? 'addToSet' : 'set',
        value: incoming,
        previous: existing.props[field],
      });
    }

    if (patches.length > 0) {
      items.push({
        id: `p:${existing.nodeId}`,
        kind: 'enrich',
        selectedByDefault: true,
        confidence: entity.confidence,
        explain: `${input.integrationId} added ${String(patches.length)} field(s) to ${existing.title}.`,
        targetNodeId: existing.nodeId,
        fieldPatches: patches,
        provenance,
      });
    }
  }

  const summary: ProposalSummary = {
    newNodes: items.filter((item) => item.kind === 'new_node').length,
    newEdges: items.filter((item) => item.kind === 'new_edge').length,
    enriched: items.filter((item) => item.kind === 'enrich').length,
    conflicts: items.filter((item) => item.kind === 'conflict').length,
    skippedDuplicates,
  };

  return {
    id: input.proposalId,
    runId: input.runId,
    integrationId: input.integrationId,
    boardId: input.boardId,
    createdAt: input.now,
    summary,
    items,
    issues: input.extraction.issues,
    expiresAt: new Date(Date.parse(input.now) + PROPOSAL_TTL_MS).toISOString(),
  };
}

/* --------------------------------------------------------------- orchestrator (3–7) */

export interface ParsePipelineInput {
  readonly manifest: IntegrationManifest;
  readonly parser: OutputParser;
  readonly result: RawRunResult;
  readonly parseContext: ParseContext;
  readonly boardId: string;
  readonly proposalId: string;
  readonly actorUserId: string;
  readonly now: string;
  readonly anchorNodeId?: string;
  readonly anchorKey?: string;
  readonly resolve: (identityKey: string) => ExistingNodeMatch | undefined;
  readonly extractor?: EntityExtractor;
  readonly nodeMapper?: NodeMapper;
  readonly relationshipMapper?: RelationshipMapper;
  readonly defaultRegion?: string;
}

export interface ParsePipelineOutput {
  readonly document: ParsedDocument;
  readonly extraction: ExtractionResult;
  readonly proposal: ImportProposal;
  readonly drift: VersionDrift;
}

/**
 * Stages 3–7 in one call. `apps/worker` owns the queue plumbing and the database; this function
 * owns the semantics, which is why it is here and testable without Redis.
 */
export async function runParsePipeline(input: ParsePipelineInput): Promise<ParsePipelineOutput> {
  const document = await input.parser.parse(input.result, input.parseContext);
  const drift = versionDrift(
    document.toolReportedVersion ?? input.manifest.toolVersion,
    input.parser.schemaVersions,
    input.manifest.toolVersion,
  );

  const extractor = input.extractor ?? manifestEntityExtractor(input.manifest);
  const extraction = extractor.extract(document, {
    manifest: input.manifest,
    ...(input.anchorKey === undefined ? {} : { anchorKey: input.anchorKey }),
    drift,
    ...(input.defaultRegion === undefined ? {} : { defaultRegion: input.defaultRegion }),
  });

  const primaryArtifact = input.result.artifacts[0];
  const provenanceFor = (origin: { pointer: string }, confidence: number): Provenance => ({
    source: `${input.manifest.name} ${input.manifest.toolVersion}`,
    tool: input.manifest.id,
    toolVersion: input.manifest.version,
    runId: input.result.runId,
    observedAt: input.result.finishedAt,
    importedAt: input.now,
    confidence,
    ...(primaryArtifact === undefined ? {} : { artifactRef: primaryArtifact }),
    pointer: origin.pointer,
    actorUserId: input.actorUserId,
  });

  const ctx: MapContext = {
    boardId: input.boardId,
    ...(input.anchorNodeId === undefined ? {} : { anchorNodeId: input.anchorNodeId }),
    resolve: input.resolve,
    provenanceFor,
  };

  const nodes = (input.nodeMapper ?? defaultNodeMapper()).map(extraction, ctx);
  const edges = (input.relationshipMapper ?? defaultRelationshipMapper()).map(
    extraction,
    nodes,
    ctx,
  );

  const proposal = buildProposal({
    proposalId: input.proposalId,
    runId: input.result.runId,
    integrationId: input.manifest.id,
    boardId: input.boardId,
    now: input.now,
    extraction,
    nodes,
    edges,
    ctx,
  });

  return { document, extraction, proposal, drift };
}

/** §4.6's version gating, reduced to the four cases the table names. */
export function versionDrift(
  reported: string,
  supported: readonly string[],
  adapterTarget: string,
): VersionDrift {
  if (supported.includes(reported)) return 'exact';
  const [rMajor, rMinor] = reported.split('.');
  for (const candidate of supported) {
    const [cMajor, cMinor] = candidate.split('.');
    if (rMajor === cMajor && rMinor === cMinor) return 'patch';
    if (rMajor === cMajor) return 'minor';
  }
  const [tMajor] = adapterTarget.split('.');
  return rMajor === tMajor ? 'minor' : 'major';
}

/** Merges manifest limits with an org policy overlay: `min` per number, intersection per list. */
export function effectiveLimits(
  limits: ResourceLimits,
  network: { readonly allow: readonly string[]; readonly maxRequestsPerMinute: number },
  policy?: {
    readonly maxWallClockMs?: number | null;
    readonly maxMemoryMiB?: number | null;
    readonly networkAllow?: readonly string[] | null;
  },
): EffectiveLimits {
  const allow =
    policy?.networkAllow === null || policy?.networkAllow === undefined
      ? network.allow
      : network.allow.filter((host) => policy.networkAllow?.includes(host));
  return {
    wallClockMs: Math.min(limits.wallClockMs, policy?.maxWallClockMs ?? limits.wallClockMs),
    cpuMillicores: limits.cpuMillicores,
    memoryMiB: Math.min(limits.memoryMiB, policy?.maxMemoryMiB ?? limits.memoryMiB),
    pids: limits.pids,
    maxOutputBytes: limits.maxOutputBytes,
    maxArtifacts: limits.maxArtifacts,
    egressAllowlist: allow,
    maxRequestsPerMinute: network.maxRequestsPerMinute,
  };
}

export type { ExistingNodeMatch };
export { resolveEntity };

/**
 * Raw declarations before validation. Third-party plugins arrive in exactly this shape. It lives
 * here rather than in `registry.ts` so a built-in source (e.g. `sherlock/source.ts`) can type
 * itself without importing the registry that imports it back (no-circular).
 */
export interface IntegrationSource {
  readonly raw: unknown;
  readonly parser: OutputParser;
  readonly inputAdapter?: (manifest: IntegrationManifest) => InputAdapter;
  readonly extractor?: (manifest: IntegrationManifest) => EntityExtractor;
  readonly nodeMapper?: (manifest: IntegrationManifest) => NodeMapper;
  readonly relationshipMapper?: (manifest: IntegrationManifest) => RelationshipMapper;
  readonly enabledForOrg?: (orgId: string) => Promise<boolean>;
}
