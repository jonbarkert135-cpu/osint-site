import { afterEach, describe, expect, it } from 'vitest';

import {
  clearRawOutput,
  hasRawOutput,
  keepRawOutput,
  rawOutputOf,
  rawOutputText,
} from './rawOutput.ts';

const chunk = (raw: string) => ({
  at: '2026-08-31T00:00:00.000Z',
  payload: { raw },
  exhaustive: true,
});

afterEach(clearRawOutput);

describe('raw run output', () => {
  it('accumulates per run and renders JSONL tagged with the run it came from', () => {
    keepRawOutput('run-1', [chunk('a')]);
    keepRawOutput('run-1', [chunk('b')]);
    keepRawOutput('run-2', [chunk('c')]);
    expect(rawOutputOf('run-1')).toHaveLength(2);
    expect(hasRawOutput('run-2')).toBe(true);
    expect(hasRawOutput('run-3')).toBe(false);
    expect(rawOutputText(['run-1', 'run-2']).split('\n')).toHaveLength(3);
    expect(rawOutputText(['run-3'])).toBe('');
  });

  it('forgets the oldest runs instead of growing without bound', () => {
    for (let index = 0; index < 25; index += 1) keepRawOutput(`run-${String(index)}`, [chunk('x')]);
    expect(hasRawOutput('run-0')).toBe(false);
    expect(hasRawOutput('run-24')).toBe(true);
  });
});
