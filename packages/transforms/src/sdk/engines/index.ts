/**
 * Engines Raven ships with. The host resolves an `EngineId` from a plan to an implementation here;
 * an id in the catalogue with no implementation is not a bug — the router falls through to the next
 * engine in the chain, which is exactly what a fallback chain is for.
 *
 * Only keyless, documented sources live here. Anything needing a credential or a subprocess ships
 * as an integration (`10_INTEGRATIONS.md`), not as a built-in.
 */

import type { EngineId } from '../../types.ts';
import type { TransformEngine } from '../types.ts';

import { createCtLogSearch } from './ct-log-search.ts';
import { createDohResolver } from './doh-resolver.ts';
import { createRdapLookup } from './rdap-lookup.ts';

export { createCtLogSearch, createDohResolver, createRdapLookup };

export const BUILTIN_ENGINES: Readonly<Record<EngineId, () => TransformEngine>> = {
  'doh-resolver': createDohResolver,
  'ct-log-search': createCtLogSearch,
  'rdap-lookup': createRdapLookup,
};
