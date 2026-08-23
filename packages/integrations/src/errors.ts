/**
 * The integration error taxonomy (10_INTEGRATIONS.md §11).
 *
 * Every failure anywhere in the pipeline — API, runner, worker, client applier — is one of these
 * codes, and every code has exactly one canonical three-sentence copy (what / why / action) plus a
 * retry policy. Nothing in the product is allowed to invent a message: `payloadFor()` is the only
 * source of user-facing wording, so a new failure mode is a new row here, not a string literal
 * three layers deep.
 */

export type IntegrationErrorCode =
  // input / config
  | 'INPUT_INVALID'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_TEMPLATE_UNRESOLVED'
  | 'INTEGRATION_DISABLED'
  | 'PERMISSION_DENIED'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_EXPIRED'
  | 'TARGET_NOT_ALLOWED'
  // capacity / policy
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONCURRENCY_LIMIT'
  | 'QUEUE_TIMEOUT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  // execution
  | 'IMAGE_PULL_TIMEOUT'
  | 'IMAGE_DIGEST_MISMATCH'
  | 'IMAGE_REGISTRY_DENIED'
  | 'IMAGE_INCOMPATIBLE'
  | 'START_TIMEOUT'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_EXIT_NONZERO'
  | 'TIMEOUT'
  | 'OOM_KILLED'
  | 'CANCELLED'
  | 'SANDBOX_VIOLATION'
  | 'RUNNER_CRASHED'
  // network
  | 'EGRESS_DENIED'
  | 'EGRESS_THROTTLED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_AUTH_FAILED'
  | 'UPSTREAM_RATE_LIMITED'
  // output
  | 'OUTPUT_MISSING'
  | 'OUTPUT_TOO_LARGE'
  | 'PARSE_TIMEOUT'
  | 'PARSE_UNSUPPORTED_SHAPE'
  | 'PARSE_EMPTY'
  // apply
  | 'PROPOSAL_EXPIRED'
  | 'TARGET_MISSING'
  | 'APPLY_CONFLICT'
  | 'PROVENANCE_MISSING'
  // catch-all
  | 'INTERNAL';

export interface IntegrationErrorPayload {
  code: IntegrationErrorCode;
  /** What happened, ≤ 90 chars. */
  what: string;
  /** Why it happened, ≤ 140 chars. */
  why: string;
  /** What to do about it, ≤ 90 chars, imperative. */
  action: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** Never contains secrets: the runner redacts before it reaches here (§6.6). */
  detail?: Record<string, unknown>;
  runId?: string;
}

/** How a code may be retried (§11.3). `auto` retries reuse the same run row. */
export type RetryMode = 'auto' | 'manual' | 'never';

interface CopyRow {
  readonly what: string;
  readonly why: string;
  readonly action: string;
  readonly retry: RetryMode;
  /** Attempts including the first, for `auto`. */
  readonly maxAttempts?: number;
  readonly backoffMs?: readonly number[];
}

/**
 * §11.2 verbatim where the spec gives copy, and in the same what/why/action shape where it does
 * not. Tool names are italicised by the UI, never here — this table is tool-agnostic (R1).
 */
const COPY: Readonly<Record<IntegrationErrorCode, CopyRow>> = {
  INPUT_INVALID: {
    what: "That input isn't valid.",
    why: 'One of the fields does not match what this tool accepts.',
    action: 'Fix the highlighted field.',
    retry: 'never',
  },
  MANIFEST_INVALID: {
    what: "This tool couldn't be loaded.",
    why: 'Its manifest does not match the integration schema, so it was not registered.',
    action: 'Report this to your administrator.',
    retry: 'never',
  },
  MANIFEST_TEMPLATE_UNRESOLVED: {
    what: "The tool couldn't be prepared.",
    why: 'Its command template references a value that this run does not provide.',
    action: 'Report this to your administrator.',
    retry: 'never',
  },
  INTEGRATION_DISABLED: {
    what: 'This tool is switched off.',
    why: 'An administrator disabled it for your organization.',
    action: 'Ask an admin to enable it.',
    retry: 'never',
  },
  PERMISSION_DENIED: {
    what: "You can't run this tool.",
    why: 'Your role in this project does not allow starting runs.',
    action: 'Ask a project admin for editor access.',
    retry: 'never',
  },
  CONSENT_REQUIRED: {
    what: 'Confirm authorization first.',
    why: 'This tool contacts third-party services on your behalf.',
    action: 'Tick the authorization box to continue.',
    retry: 'never',
  },
  CONSENT_EXPIRED: {
    what: 'Your authorization expired.',
    why: 'Consent is scoped to a target set and a time window, both of which have moved on.',
    action: 'Confirm the authorization again.',
    retry: 'never',
  },
  TARGET_NOT_ALLOWED: {
    what: "This target isn't permitted.",
    why: 'Your organization restricts this tool to assets you own.',
    action: 'Add the domain to Verified assets, or ask an admin.',
    retry: 'never',
  },
  QUOTA_EXCEEDED: {
    what: 'Hourly limit reached.',
    why: "You've used every run this tool allows you this hour.",
    action: 'Try again later, or ask an admin to raise the limit.',
    retry: 'never',
  },
  RATE_LIMITED: {
    what: 'Slow down for a moment.',
    why: 'The same input ran a moment ago; results rarely change that fast.',
    action: 'Open the previous result, or wait and retry.',
    retry: 'never',
  },
  CONCURRENCY_LIMIT: {
    what: 'Too many runs at once.',
    why: 'Your organization allows a fixed number of concurrent runs and they are all active.',
    action: 'Wait for a run to finish, or cancel one.',
    retry: 'never',
  },
  QUEUE_TIMEOUT: {
    what: 'The run never started.',
    why: 'It waited 15 minutes for a free runner slot.',
    action: 'Start the run again in a few minutes.',
    retry: 'auto',
    maxAttempts: 2,
    backoffMs: [5_000, 30_000],
  },
  APPROVAL_REQUIRED: {
    what: 'Waiting for approval.',
    why: 'A project admin must approve runs of this tool.',
    action: "We've notified your admins — you'll get a notification.",
    retry: 'never',
  },
  APPROVAL_DENIED: {
    what: 'An admin declined this run.',
    why: 'A project admin reviewed the request and denied it.',
    action: 'Ask the admin who declined for the reason.',
    retry: 'never',
  },
  IMAGE_PULL_TIMEOUT: {
    what: 'The tool image took too long to download.',
    why: 'The registry did not answer within 120 seconds.',
    action: 'Retry; if it persists, tell your administrator.',
    retry: 'auto',
    maxAttempts: 2,
    backoffMs: [5_000, 30_000],
  },
  IMAGE_DIGEST_MISMATCH: {
    what: 'Tool image failed verification.',
    why: "The downloaded image doesn't match the pinned digest.",
    action: 'Contact your administrator — do not retry.',
    retry: 'never',
  },
  IMAGE_REGISTRY_DENIED: {
    what: 'That image registry is not allowed.',
    why: "The tool's image comes from a registry your organization does not trust.",
    action: 'Ask an admin to allow the registry, or remove the tool.',
    retry: 'never',
  },
  IMAGE_INCOMPATIBLE: {
    what: "That tool image doesn't support this integration.",
    why: 'The pinned image is missing a command-line option the integration depends on.',
    action: 'Ask an admin to pin a supported image digest.',
    retry: 'never',
  },
  START_TIMEOUT: {
    what: "The tool couldn't start in time.",
    why: 'The sandbox did not report a running container within 30 seconds.',
    action: 'Retry; if it persists, tell your administrator.',
    retry: 'auto',
    maxAttempts: 2,
    backoffMs: [5_000, 30_000],
  },
  TOOL_UNAVAILABLE: {
    what: "The tool couldn't start.",
    why: "The container image isn't available on this server.",
    action: 'Ask an admin to pull the image, then retry.',
    retry: 'manual',
  },
  TOOL_EXIT_NONZERO: {
    what: 'The tool stopped with an error.',
    why: 'It exited with a non-zero status code.',
    action: "Open the run log to see the tool's own message.",
    retry: 'manual',
  },
  TIMEOUT: {
    what: 'The run hit its time limit.',
    why: 'It ran for the maximum wall-clock time allowed for this tool.',
    action: 'Narrow the input, or import the partial results.',
    retry: 'manual',
  },
  OOM_KILLED: {
    what: 'The run ran out of memory.',
    why: 'It exceeded the memory limit configured for this tool.',
    action: 'Reduce the scope, or ask an admin to raise the limit.',
    retry: 'manual',
  },
  CANCELLED: {
    what: 'The run was cancelled.',
    why: 'Someone stopped it before it finished.',
    action: 'Start it again if you still need the result.',
    retry: 'manual',
  },
  SANDBOX_VIOLATION: {
    what: 'The run was stopped for safety.',
    why: 'The tool attempted an operation the sandbox forbids.',
    action: 'Report this integration to your administrator.',
    retry: 'never',
  },
  RUNNER_CRASHED: {
    what: 'The run stopped unexpectedly.',
    why: 'The runner process ended while the tool was still executing.',
    action: 'Retry; anything already collected is still available.',
    retry: 'manual',
  },
  EGRESS_DENIED: {
    what: 'A network request was blocked.',
    why: 'The tool tried to reach a private address, which is never allowed.',
    action: 'Import what was collected, or report the tool.',
    retry: 'never',
  },
  EGRESS_THROTTLED: {
    what: 'The tool was slowed down.',
    why: 'It exceeded the outbound request rate allowed for this run.',
    action: 'Import the results, or narrow the scope and retry.',
    retry: 'manual',
  },
  UPSTREAM_UNAVAILABLE: {
    what: "The service didn't answer.",
    why: 'The third-party service returned a server error.',
    action: "We'll retry automatically — or run again later.",
    retry: 'auto',
    maxAttempts: 3,
    backoffMs: [2_000, 8_000, 32_000],
  },
  UPSTREAM_AUTH_FAILED: {
    what: 'The service rejected our credentials.',
    why: 'The stored token for this tool is invalid or expired.',
    action: 'Update the token in Settings → Secrets.',
    retry: 'never',
  },
  UPSTREAM_RATE_LIMITED: {
    what: 'The service asked us to wait.',
    why: 'The third-party rate limit was reached.',
    action: "We'll retry automatically — or run again later.",
    retry: 'auto',
    maxAttempts: 2,
    backoffMs: [5_000, 30_000],
  },
  OUTPUT_MISSING: {
    what: 'The tool produced no output file.',
    why: 'It exited successfully but wrote nothing to its declared output.',
    action: 'Open the run log; this usually means no matches.',
    retry: 'manual',
  },
  OUTPUT_TOO_LARGE: {
    what: 'Output was too large.',
    why: 'The tool wrote more than its output cap; we kept everything up to the cap.',
    action: 'Import the partial results, or narrow the scope.',
    retry: 'manual',
  },
  PARSE_TIMEOUT: {
    what: 'Reading the output took too long.',
    why: 'Parsing exceeded 120 seconds; the raw artifacts were kept.',
    action: 'Download the raw output, or narrow the scope and retry.',
    retry: 'manual',
  },
  PARSE_UNSUPPORTED_SHAPE: {
    what: "We couldn't read the tool's output.",
    why: "The format doesn't match the version this adapter targets.",
    action: 'Download the raw output and report this — no data was imported.',
    retry: 'manual',
  },
  PARSE_EMPTY: {
    what: 'No results found.',
    why: 'The tool ran to completion and reported nothing for this input.',
    action: 'Try a different input, or another tool.',
    retry: 'manual',
  },
  PROPOSAL_EXPIRED: {
    what: 'This result set expired.',
    why: 'Proposals are kept for 7 days so imports reflect current data.',
    action: 'Re-run the tool.',
    retry: 'manual',
  },
  TARGET_MISSING: {
    what: "Some items couldn't be applied.",
    why: 'Nodes they referenced were deleted while you reviewed.',
    action: 'Re-run to get a fresh proposal.',
    retry: 'manual',
  },
  APPLY_CONFLICT: {
    what: 'Some fields need a decision.',
    why: 'The incoming values disagree with what is already on the board.',
    action: 'Resolve the highlighted conflicts, then apply.',
    retry: 'never',
  },
  PROVENANCE_MISSING: {
    what: 'Something went wrong on our side.',
    why: 'A proposed item carried no provenance, so it was refused (N4).',
    action: 'Report this with the run reference.',
    retry: 'never',
  },
  INTERNAL: {
    what: 'Something went wrong on our side.',
    why: 'The run failed before it produced results.',
    action: 'Retry; if it persists, send us the run reference.',
    retry: 'auto',
    maxAttempts: 2,
    backoffMs: [5_000, 30_000],
  },
};

export const INTEGRATION_ERROR_CODES = Object.keys(COPY) as readonly IntegrationErrorCode[];

export interface RetryPolicy {
  readonly mode: RetryMode;
  readonly maxAttempts: number;
  /** Delay before attempt `n` (1-based, so `delayMs[0]` precedes the second attempt). */
  readonly delayMs: readonly number[];
}

/** §11.3 as data. `shouldRetry` is the only place that decides whether a run tries again. */
export function retryPolicy(code: IntegrationErrorCode): RetryPolicy {
  const row = COPY[code];
  return {
    mode: row.retry,
    maxAttempts: row.retry === 'auto' ? (row.maxAttempts ?? 2) : 1,
    delayMs: row.backoffMs ?? [],
  };
}

/** Jitter ±20% (§11.3) so a fleet-wide failure does not produce a synchronized retry storm. */
export function retryDelayMs(
  code: IntegrationErrorCode,
  attempt: number,
  random: () => number = Math.random,
): number | undefined {
  const policy = retryPolicy(code);
  if (policy.mode !== 'auto' || attempt >= policy.maxAttempts) return undefined;
  const base = policy.delayMs[attempt - 1] ?? policy.delayMs.at(-1);
  if (base === undefined) return undefined;
  return Math.round(base * (0.8 + random() * 0.4));
}

export function shouldRetry(code: IntegrationErrorCode, attempt: number): boolean {
  const policy = retryPolicy(code);
  return policy.mode === 'auto' && attempt < policy.maxAttempts;
}

export interface PayloadOptions {
  readonly why?: string;
  readonly action?: string;
  readonly detail?: Record<string, unknown>;
  readonly runId?: string;
  readonly retryAfterMs?: number;
}

/**
 * The canonical payload for a code. `why`/`action` may be specialised with concrete numbers (the
 * spec's copy table interpolates counts and tool names) but never replaced by a generic sentence.
 */
export function payloadFor(
  code: IntegrationErrorCode,
  options: PayloadOptions = {},
): IntegrationErrorPayload {
  const row = COPY[code];
  const policy = retryPolicy(code);
  return {
    code,
    what: row.what,
    why: options.why ?? row.why,
    action: options.action ?? row.action,
    retryable: policy.mode !== 'never',
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  };
}

/** The one error class the pipeline throws. It always carries a user-presentable payload. */
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly payload: IntegrationErrorPayload;

  constructor(code: IntegrationErrorCode, options: PayloadOptions = {}) {
    const payload = payloadFor(code, options);
    super(`${code}: ${payload.what} ${payload.why}`);
    this.name = 'IntegrationError';
    this.code = code;
    this.payload = payload;
  }
}

export function isIntegrationError(value: unknown): value is IntegrationError {
  return value instanceof IntegrationError;
}

/** Anything thrown anywhere in the pipeline becomes a payload; nothing escapes as a stack trace. */
export function toErrorPayload(error: unknown, runId?: string): IntegrationErrorPayload {
  if (isIntegrationError(error)) {
    return runId === undefined ? error.payload : { ...error.payload, runId };
  }
  return payloadFor('INTERNAL', {
    ...(runId === undefined ? {} : { runId }),
    detail: { message: error instanceof Error ? error.message : String(error) },
  });
}
