/**
 * §63's gate: every source that ships in the production registry proves its contract here, so a
 * new adapter cannot be merged and then discovered to be broken at run time.
 */

import { describe, expect, it } from 'vitest';

import { BUILTIN_SOURCES, builtinRegistry } from '../src/registry.ts';
import { safeParseManifest } from '../src/manifest.ts';
import { checkAdapterContract } from '../src/testkit/contract.ts';

const idOf = (raw: unknown): string => {
  const parsed = safeParseManifest(raw);
  return parsed.ok ? parsed.manifest.id : '(unparseable)';
};

describe('built-in adapters honour the contract', () => {
  for (const source of BUILTIN_SOURCES) {
    it(`${idOf(source.raw)} passes every contract`, async () => {
      await expect(checkAdapterContract(source)).resolves.toEqual([]);
    });
  }

  it('nothing is rejected from the production registry', () => {
    expect(builtinRegistry().rejected).toEqual([]);
  });
});
