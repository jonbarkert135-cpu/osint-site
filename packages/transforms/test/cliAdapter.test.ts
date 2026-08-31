import { describe, expect, it, vi } from 'vitest';

import {
  createCliAdapter,
  createGoAdapter,
  createPythonAdapter,
  parseCliStdout,
  createRustAdapter,
} from '../src/cliAdapter.ts';
import type { AdapterInput } from '../src/adapters.ts';
import type { CliExit } from '../src/cliAdapter.ts';

const input: AdapterInput = {
  engineId: 'subfinder',
  capability: 'subdomain-discovery',
  payload: { domain: 'example.com' },
  timeoutMs: 5_000,
};

const adapter = (exit: Partial<CliExit>) =>
  createCliAdapter({ run: vi.fn(async () => ({ code: 0, stdout: '', ...exit })) });

describe('parseCliStdout', () => {
  it('reads JSON lines', () => {
    expect(parseCliStdout('{"host":"a.example.com"}\n{"host":"b.example.com"}')).toEqual([
      { host: 'a.example.com' },
      { host: 'b.example.com' },
    ]);
  });

  it('reads one JSON document, array or object', () => {
    expect(parseCliStdout('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseCliStdout('{"a":1}')).toEqual([{ a: 1 }]);
  });

  it('falls back to plain lines', () => {
    expect(parseCliStdout('a.example.com\nb.example.com\n')).toEqual([
      { value: 'a.example.com' },
      { value: 'b.example.com' },
    ]);
  });

  it('treats empty output as zero results, not as a failure', () => {
    expect(parseCliStdout('   \n')).toEqual([]);
  });
});

describe('cli adapter (§37, §38)', () => {
  it('returns parsed items and the raw stdout on success', async () => {
    const result = await adapter({ stdout: '{"host":"a.example.com"}' }).execute(input);
    expect(result).toEqual({
      ok: true,
      output: { items: [{ host: 'a.example.com' }], raw: '{"host":"a.example.com"}' },
    });
  });

  it('refuses a payload the host could not render instead of reporting a tool failure', async () => {
    const result = await adapter({ failure: 'invalid-input' }).execute(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('maps host failures to their own error kinds', async () => {
    for (const [failure, kind] of [
      ['timeout', 'timeout'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const result = await adapter({ failure }).execute(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe(kind);
    }
  });

  it('reports a non-zero exit as upstream, and a kill as retryable', async () => {
    const failed = await adapter({ code: 2, stderr: 'boom' }).execute(input);
    expect(failed).toEqual({
      ok: false,
      error: { kind: 'upstream', message: 'boom', retryable: false },
    });

    const killed = await adapter({ code: null }).execute(input);
    if (!killed.ok) expect(killed.error.retryable).toBe(true);
  });

  it('reports no fake progress fraction', async () => {
    const onProgress = vi.fn();
    await adapter({ stdout: 'a' }).execute(input, onProgress);
    expect(onProgress).toHaveBeenCalledWith({ fraction: null, message: 'running subfinder' });
  });

  it('never lets a thrown spawn escape', async () => {
    const thrower = createCliAdapter({ run: () => Promise.reject(new Error('no docker')) });
    const result = await thrower.execute(input);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'internal', message: 'no docker', retryable: true },
    });
  });

  it('python, go and rust are the same adapter with their own passports', () => {
    const run = async () => ({ code: 0, stdout: '' });
    expect(createPythonAdapter({ run }).runtime).toBe('python');
    expect(createGoAdapter({ run }).runtime).toBe('go');
    expect(createRustAdapter({ run }).runtime).toBe('rust');
  });
});
