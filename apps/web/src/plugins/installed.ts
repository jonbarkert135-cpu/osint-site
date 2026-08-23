/**
 * Which third-party plugins this browser has installed (17_PLUGIN_SDK.md §7).
 *
 * There is no plugin registry service yet, so an install is a local record: the manifest the
 * author published plus the bundled worker source an installer would have unpacked from it. Both
 * are validated here — a manifest that fails the schema, or one written against an incompatible
 * host API, is reported as rejected rather than loaded, so Settings can say why.
 */

import { isApiVersionSupported, zPluginManifest, type PluginManifest } from '@nexus/plugin-sdk';
import { z } from 'zod';

export const INSTALLED_PLUGINS_KEY = 'raven.plugins.installed';

const zInstallRecord = z.object({
  manifest: z.unknown(),
  /** The plugin's bundled entry module, self-contained ES module source. */
  source: z.string().min(1).max(512_000),
  enabled: z.boolean().default(true),
});

export interface InstalledPlugin {
  manifest: PluginManifest;
  source: string;
}

export interface RejectedPlugin {
  id: string;
  reason: string;
}

export interface InstalledPlugins {
  installed: InstalledPlugin[];
  rejected: RejectedPlugin[];
}

const EMPTY: InstalledPlugins = { installed: [], rejected: [] };

/** Reads and validates the install list. Anything unreadable means "no plugins", never a crash. */
export function readInstalledPlugins(storage: Storage = window.localStorage): InstalledPlugins {
  let raw: unknown;
  try {
    const stored = storage.getItem(INSTALLED_PLUGINS_KEY);
    if (stored === null) return EMPTY;
    raw = JSON.parse(stored);
  } catch {
    return EMPTY;
  }

  const records = z.array(zInstallRecord).safeParse(raw);
  if (!records.success) return EMPTY;

  const installed: InstalledPlugin[] = [];
  const rejected: RejectedPlugin[] = [];
  for (const record of records.data) {
    const parsed = zPluginManifest.safeParse(record.manifest);
    if (!parsed.success) {
      rejected.push({
        id: idOf(record.manifest),
        reason: parsed.error.issues[0]?.message ?? 'invalid manifest',
      });
      continue;
    }
    if (!isApiVersionSupported(parsed.data.apiVersion)) {
      rejected.push({ id: parsed.data.id, reason: `needs host API ${parsed.data.apiVersion}` });
      continue;
    }
    if (!record.enabled) continue;
    installed.push({ manifest: parsed.data, source: record.source });
  }
  return { installed, rejected };
}

function idOf(manifest: unknown): string {
  const id = (manifest as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : 'unknown';
}
