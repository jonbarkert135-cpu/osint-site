/**
 * Worker entry for a bundled plugin (17_PLUGIN_SDK.md §5.2, isolation model).
 *
 * The host runs command-only plugins in a Web Worker rather than the spec's sandboxed iframe: a
 * worker has no DOM, no cookies and no ambient authority at all, which is strictly stronger than
 * `sandbox="allow-scripts"` and needs no bootstrap document. The iframe host is still required for
 * plugins that contribute panels, inspectors or node renderers — those cannot render from a worker.
 *
 * A plugin bundle's entry file is expected to be self-contained and to call this once:
 *
 * ```ts
 * import { definePlugin, startWorkerPlugin } from '@nexus/plugin-sdk';
 * startWorkerPlugin(definePlugin({ async activate(ctx) { … } }), 'my-plugin');
 * ```
 */

import { runPlugin, type PluginModule, type PluginTransport } from './plugin.ts';

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
}

/** Wires a plugin to its worker scope. Returns once the host has activated it. */
export function startWorkerPlugin(
  plugin: PluginModule,
  pluginId: string,
  scope: WorkerScope = globalThis as unknown as WorkerScope,
): Promise<void> {
  const transport: PluginTransport = {
    post: (message) => scope.postMessage(message),
    subscribe: (handler) => {
      const listener = (event: { data: unknown }) => handler(event.data);
      scope.addEventListener('message', listener);
      return () => scope.removeEventListener('message', listener);
    },
  };
  return runPlugin(plugin, transport, pluginId);
}
