/**
 * The adapter contract, behavioural half (§62 engine testing, §63 contract testing).
 *
 * `checkStaticContract` reads a manifest; this runs the adapter. It is the harness every engine
 * test leans on, and `test/contract.builtins.test.ts` runs it over every built-in source, so an
 * adapter that misbehaves fails CI before it can be merged into the production registry.
 *
 * The checks deliberately use only the pieces of an adapter that are total by contract — `accepts`,
 * `adapt` and `parse` — and feed them the inputs a real run eventually will: nothing, garbage, and
 * the same fixture twice.
 */

import { isIntegrationError } from '../errors.ts';
import type { IntegrationManifest } from '../manifest.ts';
import {
  manifestInputAdapter,
  type IntegrationInvocation,
  type IntegrationSource,
  type OutputParser,
  type ParsedDocument,
} from '../pipeline.ts';
import { checkStaticContract, type ContractViolation } from '../contract.ts';
import { safeParseManifest } from '../manifest.ts';
import { fakeRunResult, memoryParseContext } from './harness.ts';

export interface ContractRunOptions {
  /** §62's timeout test: a parser that cannot finish a small fixture in time is broken. */
  readonly budgetMs?: number;
  /** Fixture bytes the parser is expected to handle; defaults to an empty primary artifact. */
  readonly fixture?: string;
}

const emptyInvocation = (manifest: IntegrationManifest): IntegrationInvocation => ({
  integrationId: manifest.id,
  boardId: 'board-contract',
  selection: [],
  formValues: {},
  actorUserId: 'user-contract',
});

const isFiniteInRange = (value: number, max: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= max;

async function withBudget<T>(
  label: string,
  budgetMs: number,
  work: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | { ok: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, budgetMs);
  });
  try {
    const raced = await Promise.race([
      work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      timeout,
    ]);
    if (raced === 'timeout') return { ok: 'timeout' };
    if ('error' in raced) return { ok: false, error: raced.error };
    return { ok: true, value: raced.value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void label;
  }
}

function checkDocument(doc: ParsedDocument): readonly ContractViolation[] {
  const violations: ContractViolation[] = [];
  for (const [index, record] of doc.records.entries()) {
    if (typeof record.pointer !== 'string' || record.pointer.length === 0) {
      violations.push({
        contract: 'result',
        message: `record ${String(index)} has no pointer — provenance would be unattributable`,
      });
    }
    if (Number.isNaN(Date.parse(record.observedAt))) {
      violations.push({
        contract: 'result',
        message: `record ${String(index)} observedAt "${record.observedAt}" is not a date`,
      });
    }
    if (!isFiniteInRange(record.parserConfidence, 1)) {
      violations.push({
        contract: 'result',
        message: `record ${String(index)} parserConfidence ${String(record.parserConfidence)} is outside 0..1`,
      });
    }
  }
  for (const [key, value] of Object.entries(doc.counters)) {
    if (!Number.isFinite(value) || value < 0) {
      violations.push({
        contract: 'result',
        message: `counter "${key}" is ${String(value)} — counters are non-negative numbers`,
      });
    }
  }
  for (const issue of doc.nonFatalIssues) {
    if (issue.message.trim().length === 0) {
      violations.push({
        contract: 'result',
        message: 'a nonFatalIssue carries an empty message (U5: honest errors say something)',
      });
    }
  }
  return violations;
}

async function checkParse(
  parser: OutputParser,
  manifest: IntegrationManifest,
  options: Required<ContractRunOptions>,
): Promise<readonly ContractViolation[]> {
  const violations: ContractViolation[] = [];
  const result = fakeRunResult();

  const first = await withBudget(
    'parse',
    options.budgetMs,
    parser.parse(result, memoryParseContext(manifest, options.fixture)),
  );
  if (first.ok === 'timeout') {
    return [
      {
        contract: 'progress',
        message: `parse did not finish a ${String(options.fixture.length)}-byte fixture within ${String(options.budgetMs)}ms`,
      },
    ];
  }
  if (first.ok === false) {
    // Failing on an empty fixture is allowed — failing *opaquely* is not (§11, U5).
    if (!isIntegrationError(first.error)) {
      violations.push({
        contract: 'error',
        message: `parse threw ${String(first.error)} instead of an IntegrationError with a code`,
      });
    }
  } else {
    violations.push(...checkDocument(first.value));

    // Duplicate handling (§62): the same bytes twice produce the same records.
    const second = await withBudget(
      'parse-again',
      options.budgetMs,
      parser.parse(result, memoryParseContext(manifest, options.fixture)),
    );
    if (second.ok === true) {
      const pointers = (doc: ParsedDocument): string => doc.records.map((r) => r.pointer).join('|');
      if (pointers(second.value) !== pointers(first.value)) {
        violations.push({
          contract: 'result',
          message:
            'parsing the same fixture twice produced different records — the parser is not deterministic',
        });
      }
    }
  }

  // Error contract: bytes that are not the declared shape must still fail as a coded error.
  const garbage = await withBudget(
    'parse-garbage',
    options.budgetMs,
    parser.parse(result, memoryParseContext(manifest, '\u0000 not the declared shape \uFFFD')),
  );
  if (garbage.ok === 'timeout') {
    violations.push({
      contract: 'progress',
      message: `parse hung on malformed input for more than ${String(options.budgetMs)}ms`,
    });
  } else if (garbage.ok === false && !isIntegrationError(garbage.error)) {
    violations.push({
      contract: 'error',
      message: `malformed input threw ${String(garbage.error)} instead of an IntegrationError with a code`,
    });
  } else if (garbage.ok === true) {
    violations.push(...checkDocument(garbage.value));
  }

  return violations;
}

/**
 * Runs the full contract — static plus behavioural — over one adapter source. An empty array means
 * the adapter may be registered.
 */
export async function checkAdapterContract(
  source: IntegrationSource,
  options: ContractRunOptions = {},
): Promise<readonly ContractViolation[]> {
  const parsed = safeParseManifest(source.raw);
  if (!parsed.ok) {
    return parsed.issues.map((issue) => ({
      contract: 'metadata' as const,
      message: `${issue.path}: ${issue.message}`,
    }));
  }
  const manifest = parsed.manifest;
  const resolved: Required<ContractRunOptions> = {
    budgetMs: options.budgetMs ?? 5_000,
    fixture: options.fixture ?? '',
  };
  const violations: ContractViolation[] = [...checkStaticContract(manifest, source.parser)];

  // Input contract: an adapter is handed empty selections by the UI all the time. It may refuse —
  // it may not blow up in a way the API cannot turn into a message.
  const adapter = (source.inputAdapter ?? manifestInputAdapter)(manifest);
  try {
    if (typeof adapter.accepts([]) !== 'boolean') {
      violations.push({ contract: 'input', message: 'accepts() did not return a boolean' });
    }
  } catch (error) {
    violations.push({ contract: 'input', message: `accepts([]) threw ${String(error)}` });
  }
  try {
    const adapted = adapter.adapt(emptyInvocation(manifest));
    const allowed = new Set<string>(manifest.consent.allowedTargetScopes);
    for (const target of adapted.targets) {
      if (!allowed.has(target.scope)) {
        violations.push({
          contract: 'input',
          message: `adapt() produced target scope "${target.scope}", which consent does not allow`,
        });
      }
    }
  } catch (error) {
    if (!isIntegrationError(error)) {
      violations.push({
        contract: 'input',
        message: `adapt() rejected an empty invocation with ${String(error)} instead of an IntegrationError`,
      });
    }
  }

  violations.push(...(await checkParse(source.parser, manifest, resolved)));
  return violations;
}

export async function assertAdapterContract(
  source: IntegrationSource,
  options: ContractRunOptions = {},
): Promise<void> {
  const violations = await checkAdapterContract(source, options);
  if (violations.length > 0) {
    throw new Error(
      `adapter breaks its contract:\n  - ${violations
        .map((violation) => `${violation.contract}: ${violation.message}`)
        .join('\n  - ')}`,
    );
  }
}
