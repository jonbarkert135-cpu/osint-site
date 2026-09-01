/** The adapter contract checker itself — it gates the registry, so it is tested (§63). */

import { describe, expect, it } from 'vitest';

import { manifest as expandUrl } from '../builtin/manifest.ts';
import { parser as expandUrlParser } from '../builtin/parser.ts';
import { sherlockSources } from '../sherlock/source.ts';
import { checkStaticContract, contractIssues } from '../src/contract.ts';
import { IntegrationError } from '../src/errors.ts';
import { parseManifest, type IntegrationManifest } from '../src/manifest.ts';
import type { OutputParser, ParsedDocument } from '../src/pipeline.ts';
import { checkAdapterContract, assertAdapterContract } from '../src/testkit/contract.ts';

const raw = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(expandUrl)) as Record<string, unknown>;

const manifestOf = (
  mutate: (m: Record<string, unknown>) => void = () => undefined,
): IntegrationManifest => {
  const value = raw();
  mutate(value);
  return parseManifest(value);
};

const containerRaw = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(sherlockSources[0]!.raw)) as Record<string, unknown>;

const containerManifestOf = (mutate: (m: Record<string, unknown>) => void): IntegrationManifest => {
  const value = containerRaw();
  mutate(value);
  return parseManifest(value);
};

const contracts = (m: IntegrationManifest, parser: OutputParser = expandUrlParser): string[] =>
  checkStaticContract(m, parser).map((violation) => violation.contract);

const sherlockParser = sherlockSources[0]!.parser;

const emptyDoc: ParsedDocument = { records: [], counters: {}, nonFatalIssues: [] };

const stubParser = (
  parse: OutputParser['parse'],
  schemaVersions: readonly string[] = expandUrlParser.schemaVersions,
): OutputParser => ({ schemaVersions, parse });

describe('checkStaticContract', () => {
  it('passes a shipped adapter', () => {
    expect(checkStaticContract(manifestOf(), expandUrlParser)).toEqual([]);
  });

  it('rejects a parser that handles none of the declared output versions', () => {
    expect(contracts(manifestOf(), stubParser(expandUrlParser.parse, ['99.0']))).toEqual([
      'metadata',
    ]);
  });

  it('rejects a parser with no declared schema versions', () => {
    expect(contracts(manifestOf(), stubParser(expandUrlParser.parse, []))).toEqual(['metadata']);
  });

  it('rejects an output larger than the run output cap', () => {
    const m = containerManifestOf((value) => {
      const outputs = value.outputs as { maxBytes?: number }[];
      outputs[0]!.maxBytes = 400 * 1024 * 1024;
    });
    expect(contracts(m, sherlockParser)).toEqual(['execution']);
  });

  it('rejects an empty egress allowlist', () => {
    const m = containerManifestOf((value) => {
      const execution = value.execution as { network: { mode: string; allow: string[] } };
      execution.network.mode = 'allowlist';
      execution.network.allow = [];
    });
    expect(contracts(m, sherlockParser)).toContain('execution');
  });

  it('rejects a container primary output that is collected from nowhere', () => {
    const m = containerManifestOf((value) => {
      const outputs = value.outputs as Record<string, unknown>[];
      const target = outputs.find((output) => output.primary === true) ?? outputs[0]!;
      delete target.path;
      target.fromStdout = false;
    });
    expect(contracts(m, sherlockParser)).toContain('result');
  });

  it('rejects a required derived input the user cannot fill', () => {
    const m = manifestOf((value) => {
      const inputs = value.inputs as Record<string, unknown>[];
      inputs[0]!.from = { source: 'derived', expr: 'selection[0].props.url' };
      inputs[0]!.required = true;
      delete inputs[0]!.default;
    });
    expect(contracts(m)).toContain('input');
  });

  it('rejects a selection-fed input that names no entity kinds', () => {
    const m = manifestOf((value) => {
      const inputs = value.inputs as Record<string, unknown>[];
      inputs[0]!.entityKinds = [];
      inputs[0]!.from = { source: 'form' };
    });
    // a form field with an empty kind list is fine; only selection-fed ones need kinds
    expect(contracts(m)).toEqual([]);
  });

  it('maps violations onto the registry rejection shape', () => {
    const issues = contractIssues([{ contract: 'result', message: 'nope' }]);
    expect(issues).toEqual([{ path: 'contract.result', message: 'nope' }]);
  });
});

describe('checkAdapterContract', () => {
  it('passes a shipped adapter', async () => {
    await expect(checkAdapterContract({ raw: raw(), parser: expandUrlParser })).resolves.toEqual(
      [],
    );
  });

  it('reports a manifest that does not even parse as metadata', async () => {
    const violations = await checkAdapterContract({ raw: { id: 'nope' }, parser: expandUrlParser });
    expect(violations.every((violation) => violation.contract === 'metadata')).toBe(true);
  });

  it('flags a parser that throws a bare error instead of an IntegrationError', async () => {
    const violations = await checkAdapterContract({
      raw: raw(),
      parser: stubParser(() => Promise.reject(new TypeError('undefined is not a function'))),
    });
    expect(violations.map((violation) => violation.contract)).toContain('error');
  });

  it('accepts a parser that fails with a coded error', async () => {
    const violations = await checkAdapterContract({
      raw: raw(),
      parser: stubParser(() => Promise.reject(new IntegrationError('PARSE_EMPTY'))),
    });
    expect(violations).toEqual([]);
  });

  it('flags a parser that hangs', async () => {
    const violations = await checkAdapterContract(
      { raw: raw(), parser: stubParser(() => new Promise<ParsedDocument>(() => undefined)) },
      { budgetMs: 20 },
    );
    expect(violations.map((violation) => violation.contract)).toEqual(['progress']);
  });

  it('flags records without a pointer or with an impossible confidence', async () => {
    const violations = await checkAdapterContract({
      raw: raw(),
      parser: stubParser(() =>
        Promise.resolve({
          ...emptyDoc,
          records: [
            { type: 'row', data: {}, pointer: '', observedAt: 'yesterday', parserConfidence: 4 },
          ],
        }),
      ),
    });
    expect(violations).toHaveLength(6); // three problems, on both the empty and the garbage fixture
    expect(violations.every((violation) => violation.contract === 'result')).toBe(true);
  });

  it('flags a negative counter', async () => {
    const violations = await checkAdapterContract({
      raw: raw(),
      parser: stubParser(() => Promise.resolve({ ...emptyDoc, counters: { seen: -1 } })),
    });
    expect(violations[0]?.message).toMatch(/counter "seen"/);
  });

  it('flags a non-deterministic parser', async () => {
    let calls = 0;
    const violations = await checkAdapterContract({
      raw: raw(),
      parser: stubParser(() => {
        calls += 1;
        return Promise.resolve({
          ...emptyDoc,
          records: [
            {
              type: 'row',
              data: {},
              pointer: `/records/${String(calls)}`,
              observedAt: '2026-01-01T00:00:00.000Z',
              parserConfidence: 1,
            },
          ],
        });
      }),
    });
    expect(violations.map((violation) => violation.message)).toContain(
      'parsing the same fixture twice produced different records — the parser is not deterministic',
    );
  });

  it('assertAdapterContract throws with every violation listed', async () => {
    await expect(
      assertAdapterContract({
        raw: raw(),
        parser: stubParser(() => Promise.reject(new TypeError('boom')), []),
      }),
    ).rejects.toThrow(/metadata: parser declares no schemaVersions[\s\S]*error:/);
  });

  it('assertAdapterContract stays silent on a shipped adapter', async () => {
    await expect(
      assertAdapterContract({ raw: raw(), parser: expandUrlParser }),
    ).resolves.toBeUndefined();
  });
});
