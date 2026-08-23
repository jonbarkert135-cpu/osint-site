/**
 * Host side of the plugin protocol (17_PLUGIN_SDK.md §5.4).
 *
 * A plugin's bundle runs in a Web Worker — no DOM, no cookies, no host globals — and can only
 * reach the app through frames this router validates. Every inbound frame is zod-parsed, every
 * privileged call is permission-checked here, and anything that fails is dropped and logged
 * against the plugin instead of surfacing as a host error (§7.7).
 */

import {
  parseEnvelope,
  PLUGIN_API_VERSION,
  PROTOCOL_VERSION,
  type PluginManifest,
} from '@nexus/plugin-sdk';

export interface PluginWorker {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

export interface PluginHostCallbacks {
  /** A toast attributed to the plugin (`ui:notify`). */
  onNotify: (pluginId: string, message: string) => void;
  onLog?: (pluginId: string, level: string, message: string) => void;
}

export interface RunningPlugin {
  id: string;
  invokeCommand: (commandId: string) => void;
  stop: () => void;
}

export type SpawnWorker = (source: string, name: string) => PluginWorker;

/** Default spawn: a module worker over a blob of the plugin's bundle. */
export const spawnBlobWorker: SpawnWorker = (source, name) => {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'module', name });
  URL.revokeObjectURL(url);
  return worker;
};

export function startPlugin(
  plugin: { manifest: PluginManifest; source: string },
  callbacks: PluginHostCallbacks,
  boardId: string | null = null,
  spawn: SpawnWorker = spawnBlobWorker,
): RunningPlugin {
  const { manifest } = plugin;
  const worker = spawn(plugin.source, manifest.id);
  let calls = 0;

  worker.addEventListener('message', (event) => {
    const frame = parseEnvelope(event.data);
    if (frame === null) {
      callbacks.onLog?.(manifest.id, 'error', 'dropped an invalid frame');
      return;
    }

    if (frame.t === 'hello') {
      worker.postMessage({
        t: 'ready',
        protocol: PROTOCOL_VERSION,
        context: {
          pluginId: manifest.id,
          hostVersion: PLUGIN_API_VERSION,
          apiVersion: PLUGIN_API_VERSION,
          boardId,
          locale: 'en',
          // The plugin is told what it was granted; the host enforces it regardless.
          permissions: manifest.permissions,
        },
      });
      return;
    }

    if (frame.t === 'log') {
      callbacks.onLog?.(manifest.id, frame.level, frame.message);
      return;
    }

    if (frame.t === 'call') {
      if (frame.ns === 'ui' && frame.method === 'notify') {
        if (!manifest.permissions.includes('ui:notify')) {
          worker.postMessage({
            t: 'result',
            id: frame.id,
            ok: false,
            error: { code: 'PERMISSION_DENIED', message: 'ui:notify was not granted' },
          });
          return;
        }
        const args = frame.args as { message?: unknown };
        const message = typeof args?.message === 'string' ? args.message.slice(0, 200) : '';
        callbacks.onNotify(manifest.id, message);
        worker.postMessage({ t: 'result', id: frame.id, ok: true, value: null });
        return;
      }
      worker.postMessage({
        t: 'result',
        id: frame.id,
        ok: false,
        error: { code: 'NOT_IMPLEMENTED', message: `${frame.ns}.${frame.method} is not available` },
      });
    }
  });

  return {
    id: manifest.id,
    invokeCommand: (commandId) => {
      calls += 1;
      worker.postMessage({
        t: 'invoke',
        id: `${manifest.id}-${String(calls)}`,
        kind: 'command',
        args: { commandId },
      });
    },
    stop: () => {
      worker.postMessage({
        t: 'invoke',
        id: `${manifest.id}-stop`,
        kind: 'deactivate',
        args: null,
      });
      worker.terminate();
    },
  };
}
