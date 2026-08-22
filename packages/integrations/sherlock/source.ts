/**
 * Sherlock's registry entry (13_SHERLOCK.md §2).
 *
 * A list of zero or one: without a pinned image digest the deployment gets no Sherlock at all,
 * which is the §1.2 rule ("disabled, not `:latest`") expressed as data rather than as a branch in
 * the registry.
 */

import type { IntegrationSource } from '../src/registry.ts';
import { manifest } from './manifest.ts';
import { parser } from './parser.ts';

export const sherlockSources: readonly IntegrationSource[] =
  manifest === undefined ? [] : [{ raw: manifest, parser }];
