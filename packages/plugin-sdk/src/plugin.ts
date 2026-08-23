/**
 * Plugin runtime: the context contract and the loop that speaks the host protocol.
 *
 * It lives next to `index.ts` rather than inside it so that `worker.ts` can import the runtime
 * without importing the package barrel (dependency-cruiser: no-circular).
 */

import { parseEnvelope, PROTOCOL_VERSION, type PluginContextPayload } from './protocol.ts';
import type { HostEvent, PluginPermission } from './manifest.ts';

/** The host API version this SDK implements. A manifest's `apiVersion` range is checked against it. */
export const PLUGIN_API_VERSION = '1.0.0';

/**
 * Caret compatibility, the one semver rule the manifest may express (`"^1.2.0"`): same major, and
 * the host must be at least as new as the plugin expects. Deliberately not a semver dependency —
 * this is the only range syntax the manifest accepts.
 */
export function isApiVersionSupported(range: string, host: string = PLUGIN_API_VERSION): boolean {
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const have = /^(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (wanted === null || have === null) return false;
  const [wMajor, wMinor, wPatch] = wanted.slice(1).map(Number) as [number, number, number];
  const [hMajor, hMinor, hPatch] = have.slice(1).map(Number) as [number, number, number];
  if (wMajor !== hMajor) return false;
  if (hMinor !== wMinor) return hMinor > wMinor;
  return hPatch >= wPatch;
}

export interface CommandsApi {
  /** Registers the handler for a command declared in `contributes.commands`. */
  register(commandId: string, handler: () => void | Promise<void>): void;
}

export interface UiApi {
  /** Shows a toast attributed to the plugin. Requires `ui:notify`. */
  notify(message: string): Promise<void>;
}

export interface LogApi {
  info(message: string): void;
  error(message: string): void;
}

export interface EventsApi {
  /** Subscribes to a host event. Requires `events:subscribe`. Returns an unsubscribe function. */
  on(event: HostEvent, handler: (payload: unknown) => void): () => void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly hostVersion: string;
  readonly apiVersion: string;
  readonly boardId: string | null;
  readonly locale: string;
  readonly permissions: readonly PluginPermission[];
  readonly commands: CommandsApi;
  readonly ui: UiApi;
  readonly events: EventsApi;
  readonly log: LogApi;
}

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  /** Release resources. The host allows 500 ms before tearing the frame down (§7.7). */
  deactivate?(): void | Promise<void>;
}

/** Identity with a type: the one entry point a plugin's `index.ts` default-exports. */
export function definePlugin(plugin: PluginModule): PluginModule {
  return plugin;
}

/** The two calls a plugin frame needs from its embedder; injected so tests need no DOM. */
export interface PluginTransport {
  post(message: unknown): void;
  subscribe(handler: (message: unknown) => void): () => void;
}

/**
 * Runs a plugin against a transport: says `hello`, waits for `ready`, activates, then routes
 * `invoke` frames to the handlers the plugin registered. A command that throws is reported back as
 * a failed result instead of taking the frame down with it (§7.7: plugin errors stay the plugin's).
 */
export async function runPlugin(
  plugin: PluginModule,
  transport: PluginTransport,
  pluginId = '',
): Promise<void> {
  const handlers = new Map<string, () => void | Promise<void>>();
  const listeners = new Map<HostEvent, Set<(payload: unknown) => void>>();

  const contextOf = (payload: PluginContextPayload): PluginContext => ({
    pluginId: payload.pluginId,
    hostVersion: payload.hostVersion,
    apiVersion: payload.apiVersion,
    boardId: payload.boardId,
    locale: payload.locale,
    permissions: payload.permissions,
    commands: {
      register: (commandId, handler) => handlers.set(commandId, handler),
    },
    ui: {
      notify: async (message) => {
        transport.post({
          t: 'call',
          id: crypto.randomUUID(),
          ns: 'ui',
          method: 'notify',
          args: { message },
        });
        return Promise.resolve();
      },
    },
    events: {
      on: (event, handler) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
    },
    log: {
      info: (message) => transport.post({ t: 'log', level: 'info', message }),
      error: (message) => transport.post({ t: 'log', level: 'error', message }),
    },
  });

  await new Promise<void>((resolve) => {
    const unsubscribe = transport.subscribe((raw) => {
      const frame = parseEnvelope(raw);
      if (frame === null) return;

      if (frame.t === 'ready') {
        void (async () => {
          try {
            await plugin.activate(contextOf(frame.context));
          } catch (error) {
            transport.post({ t: 'log', level: 'error', message: describe(error) });
          }
          resolve();
        })();
        return;
      }

      if (frame.t === 'event') {
        for (const handler of listeners.get(frame.event) ?? []) handler(frame.payload);
        return;
      }

      if (frame.t === 'invoke') {
        void (async () => {
          try {
            if (frame.kind === 'deactivate') {
              await plugin.deactivate?.();
              unsubscribe();
            } else {
              const args = frame.args as { commandId?: unknown };
              const commandId = typeof args?.commandId === 'string' ? args.commandId : '';
              const handler = handlers.get(commandId);
              if (handler === undefined) throw new Error(`no handler for command "${commandId}"`);
              await handler();
            }
            transport.post({ t: 'result', id: frame.id, ok: true, value: null });
          } catch (error) {
            transport.post({
              t: 'result',
              id: frame.id,
              ok: false,
              error: { code: 'PLUGIN_ERROR', message: describe(error) },
            });
          }
        })();
      }
    });

    transport.post({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      pluginId,
      apiVersion: PLUGIN_API_VERSION,
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
