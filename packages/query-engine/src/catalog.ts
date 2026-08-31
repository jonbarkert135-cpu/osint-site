/**
 * The Integrations catalogue (Part 2 §55).
 *
 * One screen answering one question per engine: *can I use this, and if not, why not*. The five
 * states are the ones a user acts on — `installed` (it is here), `recommended` (it is not, and it
 * would help), `available` (it is not, and it is your call), `deprecated` (do not start using it)
 * and `incompatible` (this host cannot run it, no button will fix that).
 *
 * There is no marketplace here on purpose (§55 says the architecture must *allow* one, not ship
 * one). The extension point is the input: this takes a list of `EngineDocument`s, so a remote
 * index is one more source of documents concatenated with the local registry's — no other part of
 * this module changes when installing from the outside becomes real.
 */

import type { DeprecationAssessment, EngineDocument, TransformRegistry } from '@nexus/transforms';
import { engineDocuments } from '@nexus/transforms';

export const CATALOG_STATES = [
  'installed',
  'recommended',
  'available',
  'deprecated',
  'incompatible',
] as const;
export type CatalogState = (typeof CATALOG_STATES)[number];

export interface CatalogEntry {
  readonly engine: string;
  readonly version: string;
  readonly provider: string;
  readonly capabilities: readonly string[];
  readonly state: CatalogState;
  /** One sentence, shown under the name: why it is in this state. */
  readonly detail: string;
  /** True when the entry needs credentials before it can produce anything. */
  readonly needsCredentials: boolean;
  /** What the row's button does; `none` for an entry nothing can be done about. */
  readonly action: 'open' | 'install' | 'replace' | 'none';
}

export interface CatalogContext {
  /** Engines this build actually has an adapter registered for (`createEngineLibrary` keys). */
  readonly installed: ReadonlySet<string>;
  /** Providers with a credential stored, so a keyed engine is not offered as one click away. */
  readonly configuredProviders?: ReadonlySet<string>;
  /** Extra documents from outside the local registry: a remote index, a sideloaded package. */
  readonly external?: readonly EngineDocument[];
  /**
   * Deprecation verdicts from `deprecationReport()` (Part 2 §57), keyed by engine. An engine whose
   * upstream died is `deprecated` here even while its manifest still says `stable` — the manifest is
   * always the last thing to be updated.
   */
  readonly deprecation?: Readonly<Record<string, DeprecationAssessment>>;
}

const stateOf = (
  document: EngineDocument,
  ctx: CatalogContext,
): { readonly state: CatalogState; readonly detail: string } => {
  const { execution, provider, status } = document;
  const assessment = ctx.deprecation?.[document.name];
  if (assessment && (assessment.verdict === 'deprecated' || assessment.verdict === 'suspected')) {
    const because = assessment.evidence[0] ?? 'upstream signals';
    return {
      state: 'deprecated',
      detail: assessment.replacement
        ? `${because}; replace with ${assessment.replacement.engine} (${assessment.replacement.reasons.join(', ').toLowerCase()})`
        : `${because}; no replacement candidate in this registry`,
    };
  }
  if (status === 'deprecated')
    return {
      state: 'deprecated',
      detail: `superseded; ${provider.id} is no longer maintained for this capability`,
    };
  if (execution.adapter === 'planned')
    return { state: 'incompatible', detail: `no ${document.runtime} adapter in this build` };
  if (!execution.hostCompatible)
    return {
      state: 'incompatible',
      detail: `needs a ${document.deployment} deployment this host does not offer`,
    };
  if (ctx.installed.has(document.name))
    return {
      state: 'installed',
      detail:
        document.transforms.length === 0
          ? 'installed; no transform routes to it yet'
          : `installed; serves ${document.transforms.join(', ')}`,
    };
  // Not installed and it costs nothing to add: that is a recommendation, not a listing.
  if (provider.credentials === 'none' && provider.pricing !== 'paid')
    return { state: 'recommended', detail: `free and keyless; adds ${document.capabilities[0]}` };
  return {
    state: 'available',
    detail:
      provider.credentials === 'required'
        ? `available once ${provider.id} credentials are stored`
        : `available; ${provider.pricing} provider`,
  };
};

const actionFor = (state: CatalogState): CatalogEntry['action'] => {
  if (state === 'installed') return 'open';
  if (state === 'deprecated') return 'replace';
  if (state === 'incompatible') return 'none';
  return 'install';
};

const ORDER: readonly CatalogState[] = CATALOG_STATES;

/** Every engine this host knows about, plus anything the caller found elsewhere, as one list. */
export const integrationCatalog = (
  registry: TransformRegistry,
  ctx: CatalogContext,
): readonly CatalogEntry[] =>
  [...engineDocuments(registry), ...(ctx.external ?? [])]
    .map((document) => {
      const { state, detail } = stateOf(document, ctx);
      const configured = ctx.configuredProviders?.has(document.provider.id) === true;
      return {
        engine: document.name,
        version: document.version,
        provider: document.provider.id,
        capabilities: document.capabilities,
        state,
        detail,
        needsCredentials: document.provider.credentials === 'required' && !configured,
        action: actionFor(state),
      };
    })
    .sort(
      (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.engine.localeCompare(b.engine),
    );

/** Counts per state, for the filter chips above the list. */
export const catalogSummary = (
  entries: readonly CatalogEntry[],
): Readonly<Record<CatalogState, number>> =>
  entries.reduce<Record<CatalogState, number>>(
    (acc, entry) => ({ ...acc, [entry.state]: acc[entry.state] + 1 }),
    { installed: 0, recommended: 0, available: 0, deprecated: 0, incompatible: 0 },
  );
