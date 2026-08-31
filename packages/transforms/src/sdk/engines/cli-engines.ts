/**
 * The adapter-backed engines Raven ships with: subfinder, amass, sherlock.
 *
 * Each one is metadata plus "how do I read an item" — everything else (running, confinement,
 * timeouts, parsing) belongs to the adapter and its host. Adding the next CLI tool is a manifest
 * entry in the catalog and a dozen lines here, which is the §8 promise ("every service is a module")
 * kept honestly rather than by another abstraction.
 */

import { canDispatch, type AdapterRegistry, type EngineAdapter } from '../../adapters.ts';
import type { TransformRegistry } from '../../registry.ts';
import type { EngineId } from '../../types.ts';
import { createAdapterEngine } from '../adapterEngine.ts';
import type { TransformEngine } from '../types.ts';

/** Sherlock reports one line per site it found the username on. */
const sherlockValue = (item: Readonly<Record<string, unknown>>): string | undefined => {
  const url = item['url'] ?? item['value'];
  return typeof url === 'string' && url.startsWith('http') ? url : undefined;
};

export const createSubfinder = (adapter: EngineAdapter): TransformEngine =>
  createAdapterEngine({
    adapter,
    metadata: {
      engine: 'subfinder',
      version: '1.0.0',
      capability: 'subdomain-discovery',
      provider: 'subfinder',
      permissions: ['network', 'subprocess'],
      inputs: ['domain'],
      outputs: ['hostname'],
    },
    payload: (input) => ({ domain: input.value }),
    relationship: 'resolves_to',
  });

export const createAmass = (adapter: EngineAdapter): TransformEngine =>
  createAdapterEngine({
    adapter,
    metadata: {
      engine: 'amass',
      version: '1.0.0',
      capability: 'subdomain-discovery',
      provider: 'amass',
      permissions: ['network', 'subprocess'],
      inputs: ['domain'],
      outputs: ['hostname'],
    },
    payload: (input) => ({ domain: input.value }),
    relationship: 'resolves_to',
  });

export const createSherlock = (adapter: EngineAdapter): TransformEngine =>
  createAdapterEngine({
    adapter,
    metadata: {
      engine: 'sherlock',
      version: '1.0.0',
      capability: 'profile-discovery',
      provider: 'sherlock',
      permissions: ['network', 'subprocess'],
      inputs: ['username'],
      outputs: ['profile'],
    },
    payload: (input) => ({ username: input.value }),
    readValue: sherlockValue,
    relationship: 'has_profile',
    // A hit is a page that exists, not a proven identity: same name, different person is the normal
    // case in username search, so the band stays low until something corroborates it.
    confidence: 0.5,
  });

/**
 * Engines a host can offer once it has a cli/python adapter. Merge into `BUILTIN_ENGINES`:
 * `{ ...BUILTIN_ENGINES, ...adapterEngines(cli, python) }`.
 */
export const adapterEngines = (
  cli: EngineAdapter,
  python: EngineAdapter = cli,
): Readonly<Record<EngineId, () => TransformEngine>> => ({
  subfinder: () => createSubfinder(cli),
  amass: () => createAmass(cli),
  sherlock: () => createSherlock(python),
});

/** The shipped adapter-backed engines, by id. */
const FACTORIES: Readonly<Record<EngineId, (adapter: EngineAdapter) => TransformEngine>> = {
  subfinder: createSubfinder,
  amass: createAmass,
  sherlock: createSherlock,
};

/**
 * The engine library an `AdapterRegistry` can actually serve — the missing link between the
 * adapters (§37) and plan execution (§11–§14). An engine whose runtime has no adapter on this host
 * is simply absent, so the executor skips its step with `engine-unavailable` instead of the host
 * pretending a Python tool is installed (U5: a stated gap beats a fake capability).
 */
export const registryEngines = (
  adapters: AdapterRegistry,
  catalog: TransformRegistry,
): Readonly<Record<EngineId, () => TransformEngine>> => {
  const library: Record<EngineId, () => TransformEngine> = {};
  for (const [id, create] of Object.entries(FACTORIES)) {
    const manifest = catalog.engine(id);
    if (manifest === undefined || canDispatch(adapters, manifest) !== null) continue;
    const adapter = adapters.for(manifest);
    if (adapter === undefined) continue;
    library[id] = () => create(adapter);
  }
  return library;
};
