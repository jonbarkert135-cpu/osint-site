/**
 * The UI extension point (17_PLUGIN_SDK.md §3): installed plugins contribute commands, and those
 * commands appear in Ctrl+K next to the app's own — same registry, same ranking, same recents.
 *
 * Plugins start once per session and stop when the app unmounts. A command's `run` only posts an
 * invoke frame to the plugin's worker; whatever the plugin does with it comes back as a call the
 * host validates (`runtime.ts`), so a slow or broken plugin cannot block the palette.
 */

import { useEffect, useMemo, useState } from 'react';
import { namespacedCommandId } from '@nexus/plugin-sdk';

import type { Command } from '../app/commands/registry.ts';
import { useRegisterCommands } from '../app/commands/useRegisterCommands.ts';
import { readInstalledPlugins, type InstalledPlugin } from './installed.ts';
import { startPlugin, type RunningPlugin, type SpawnWorker } from './runtime.ts';

export interface PluginNotice {
  pluginId: string;
  pluginName: string;
  message: string;
}

/** Commands a plugin declared, bound to the running instance that will execute them. */
export function pluginCommands(plugin: InstalledPlugin, running: RunningPlugin | null): Command[] {
  if (!plugin.manifest.permissions.includes('ui:command')) return [];
  return plugin.manifest.contributes.commands
    .filter((command) => command.showInPalette)
    .map((command) => ({
      id: namespacedCommandId(plugin.manifest.id, command.id),
      title: command.title,
      group: 'plugin' as const,
      keywords: [plugin.manifest.name, command.category],
      run: () => running?.invokeCommand(command.id),
    }));
}

export interface UsePluginsOptions {
  storage?: Storage;
  spawn?: SpawnWorker;
}

/**
 * Starts every installed plugin and keeps its commands registered. Returns the latest notice a
 * plugin asked to show, so the shell can render it attributed to that plugin.
 */
export function usePlugins(options: UsePluginsOptions = {}): {
  notice: PluginNotice | null;
  dismissNotice: () => void;
} {
  const { storage, spawn } = options;
  const installed = useMemo(
    () => readInstalledPlugins(storage ?? window.localStorage).installed,
    [storage],
  );
  const [running, setRunning] = useState<ReadonlyMap<string, RunningPlugin>>(new Map());
  const [notice, setNotice] = useState<PluginNotice | null>(null);

  useEffect(() => {
    if (installed.length === 0) return undefined;
    const started = new Map<string, RunningPlugin>();
    for (const plugin of installed) {
      const instance = startPlugin(
        plugin,
        {
          onNotify: (pluginId, message) =>
            setNotice({ pluginId, pluginName: plugin.manifest.name, message }),
        },
        null,
        spawn,
      );
      started.set(plugin.manifest.id, instance);
    }
    setRunning(started);
    return () => {
      for (const instance of started.values()) instance.stop();
      setRunning(new Map());
    };
  }, [installed, spawn]);

  const commands = useMemo(
    () =>
      installed.flatMap((plugin) =>
        pluginCommands(plugin, running.get(plugin.manifest.id) ?? null),
      ),
    [installed, running],
  );
  useRegisterCommands(commands);

  return { notice, dismissNotice: () => setNotice(null) };
}
