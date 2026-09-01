/**
 * The adapter contract, static half (§63).
 *
 * §63 asks for six contracts — input, execution, progress, result, error and metadata — and for a
 * violating adapter never to reach the production registry. Two things follow from that. The parts
 * that can be decided by looking at a manifest live here and are enforced by `buildRegistry`, so a
 * broken adapter is rejected at load time exactly like a schema-invalid one. The parts that can
 * only be decided by *running* the adapter live in `./testkit/contract.ts` and are enforced in CI,
 * because the registry may not execute arbitrary parser code while booting.
 */

import type { IntegrationManifest, ManifestIssue } from './manifest.ts';
import type { OutputParser } from './pipeline.ts';

export type ContractName = 'input' | 'execution' | 'progress' | 'result' | 'error' | 'metadata';

export interface ContractViolation {
  readonly contract: ContractName;
  readonly message: string;
}

/**
 * Everything about an adapter that can be judged without running it. Pure, cheap and total: it
 * returns every violation rather than the first, because an adapter author should not learn about
 * them one CI run apiece.
 */
export function checkStaticContract(
  manifest: IntegrationManifest,
  parser: OutputParser,
): readonly ContractViolation[] {
  const violations: ContractViolation[] = [];

  /* input — the form the UI renders must be answerable, and selection-fed fields must accept the
     kinds the consent scope allows. */
  for (const field of manifest.inputs) {
    if (field.required && field.default === undefined && field.from.source === 'derived') {
      violations.push({
        contract: 'input',
        message: `input "${field.name}" is required and derived, so the user can never supply it: give it a default`,
      });
    }
    if (field.from.source === 'selection' && (field.entityKinds ?? field.from.kinds).length === 0) {
      violations.push({
        contract: 'input',
        message: `input "${field.name}" reads from the selection but names no entity kinds — the UI cannot tell what to offer`,
      });
    }
  }

  /* execution — whatever reaches the network must have somewhere to reach. */
  if (manifest.execution.kind !== 'builtin' && manifest.execution.network.mode === 'allowlist') {
    if (manifest.execution.network.allow.length === 0) {
      violations.push({
        contract: 'execution',
        message:
          'network mode is allowlist but the allowlist is empty — the tool can reach nothing',
      });
    }
  }

  /* execution — the sandbox must be able to hold the output the manifest promises. */
  if (manifest.execution.kind === 'container') {
    const { limits } = manifest.execution;
    for (const output of manifest.outputs) {
      if (output.maxBytes > limits.maxOutputBytes) {
        violations.push({
          contract: 'execution',
          message: `output "${output.name}" allows ${String(output.maxBytes)} bytes but the run cap is ${String(limits.maxOutputBytes)}`,
        });
      }
    }
    if (manifest.outputs.length > limits.maxArtifacts) {
      violations.push({
        contract: 'execution',
        message: `${String(manifest.outputs.length)} outputs declared but at most ${String(limits.maxArtifacts)} artifacts are kept`,
      });
    }
  }

  /* result — the parser is handed the primary artifact, so it has to be readable from somewhere.
     Where "somewhere" is depends on the execution kind: a container writes a file or stdout, an
     HTTP adapter names a request. A builtin produces its output in process, so there is nothing to
     check. */
  const primary = manifest.outputs.find((output) => output.primary);
  if (primary !== undefined) {
    if (
      manifest.execution.kind === 'container' &&
      primary.path === undefined &&
      !primary.fromStdout
    ) {
      violations.push({
        contract: 'result',
        message: `primary output "${primary.name}" has neither a path nor fromStdout — nothing would be collected`,
      });
    }
  }

  /* metadata — the manifest and the parser have to agree on which output versions exist, or the
     run fails at parse time with a shrug. */
  if (parser.schemaVersions.length === 0) {
    violations.push({
      contract: 'metadata',
      message: 'parser declares no schemaVersions',
    });
  } else {
    const declared = new Set(manifest.parser.supportedOutputVersions);
    const overlap = parser.schemaVersions.some((version) => declared.has(version));
    if (!overlap) {
      violations.push({
        contract: 'metadata',
        message: `parser handles [${parser.schemaVersions.join(', ')}] but the manifest declares [${manifest.parser.supportedOutputVersions.join(', ')}]`,
      });
    }
  }

  return violations;
}

/** Contract violations wear the registry's rejection shape so Admin renders them unchanged. */
export function contractIssues(violations: readonly ContractViolation[]): readonly ManifestIssue[] {
  return violations.map((violation) => ({
    path: `contract.${violation.contract}`,
    message: violation.message,
  }));
}
