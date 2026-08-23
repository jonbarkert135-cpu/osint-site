import { describe, expect, it } from 'vitest';

import {
  definePlugin,
  isApiVersionSupported,
  PLUGIN_API_VERSION,
  namespacedCommandId,
  parseEnvelope,
  runPlugin,
  startWorkerPlugin,
  zPluginManifest,
  type PluginContext,
  type PluginTransport,
} from './index.ts';

const validManifest = {
  manifestVersion: 1,
  kind: 'ui',
  id: 'wayback-snapshots',
  name: 'Wayback Snapshots',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  publisher: { id: 'acme', name: 'Acme' },
  license: 'MIT',
  description: 'Adds archived snapshots of a selected URL to the board as proposals.',
  permissions: ['ui:command', 'ui:notify'],
  contributes: { commands: [{ id: 'snapshot', title: 'Snapshot this URL' }] },
};

describe('manifest', () => {
  it('accepts a well-formed manifest and fills contribution defaults', () => {
    const parsed = zPluginManifest.parse(validManifest);
    expect(parsed.contributes.commands[0]).toMatchObject({
      category: 'Plugin',
      showInPalette: true,
    });
    expect(parsed.contributes.nodeTypes).toEqual([]);
  });

  it('rejects commands contributed without the ui:command permission', () => {
    const result = zPluginManifest.safeParse({ ...validManifest, permissions: ['ui:notify'] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('ui:command');
  });

  it('rejects unknown top-level keys and bad ids', () => {
    expect(zPluginManifest.safeParse({ ...validManifest, extra: true }).success).toBe(false);
    expect(zPluginManifest.safeParse({ ...validManifest, id: 'No Caps' }).success).toBe(false);
  });

  it('namespaces command ids by plugin', () => {
    expect(namespacedCommandId('wayback-snapshots', 'snapshot')).toBe('wayback-snapshots.snapshot');
  });
});

describe('api version compatibility', () => {
  it('accepts a host that is the same major and at least as new', () => {
    expect(isApiVersionSupported('^1.0.0', '1.0.0')).toBe(true);
    expect(isApiVersionSupported('^1.2.0', '1.3.0')).toBe(true);
    expect(isApiVersionSupported('^1.2.3', '1.2.4')).toBe(true);
  });

  it('rejects a different major or an older host', () => {
    expect(isApiVersionSupported('^2.0.0', '1.9.9')).toBe(false);
    expect(isApiVersionSupported('^1.4.0', '1.3.0')).toBe(false);
    expect(isApiVersionSupported('^1.2.3', '1.2.2')).toBe(false);
  });

  it('rejects syntax the manifest does not allow', () => {
    expect(isApiVersionSupported('>=1.0.0')).toBe(false);
    expect(isApiVersionSupported('^1.0.0', 'next')).toBe(false);
    expect(PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('protocol', () => {
  it('drops frames that are not valid envelopes', () => {
    expect(parseEnvelope({ t: 'nope' })).toBeNull();
    expect(parseEnvelope('window.opener.location')).toBeNull();
    expect(parseEnvelope({ t: 'log', level: 'info', message: 'hi' })).toMatchObject({ t: 'log' });
  });
});

/** A transport pair: whatever the plugin posts lands in `sent`, host frames go in via `deliver`. */
function fakeTransport() {
  const sent: unknown[] = [];
  const handlers = new Set<(message: unknown) => void>();
  const transport: PluginTransport = {
    post: (message) => sent.push(message),
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    transport,
    sent,
    deliver: (message: unknown) => {
      for (const handler of [...handlers]) handler(message);
    },
  };
}

const readyFrame = {
  t: 'ready',
  protocol: 1,
  context: {
    pluginId: 'wayback-snapshots',
    hostVersion: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    boardId: 'board-1',
    locale: 'en',
    permissions: ['ui:command', 'ui:notify'],
  },
};

describe('runPlugin', () => {
  it('says hello, activates on ready, and runs an invoked command', async () => {
    const io = fakeTransport();
    const seenContexts: PluginContext[] = [];
    const plugin = definePlugin({
      activate(ctx) {
        seenContexts.push(ctx);
        ctx.commands.register('snapshot', () => void ctx.ui.notify('Snapshot saved'));
      },
    });

    const activated = runPlugin(plugin, io.transport, 'wayback-snapshots');
    expect(io.sent[0]).toMatchObject({ t: 'hello', pluginId: 'wayback-snapshots' });

    io.deliver(readyFrame);
    await activated;
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]?.boardId).toBe('board-1');

    io.deliver({ t: 'invoke', id: 'call-1', kind: 'command', args: { commandId: 'snapshot' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(io.sent).toContainEqual(
      expect.objectContaining({
        t: 'call',
        ns: 'ui',
        method: 'notify',
        args: { message: 'Snapshot saved' },
      }),
    );
    expect(io.sent).toContainEqual(
      expect.objectContaining({ t: 'result', id: 'call-1', ok: true }),
    );
  });

  it('reports a throwing command as a failed result instead of crashing', async () => {
    const io = fakeTransport();
    const plugin = definePlugin({
      activate(ctx) {
        ctx.commands.register('boom', () => {
          throw new Error('nope');
        });
      },
    });
    const activated = runPlugin(plugin, io.transport, 'p');
    io.deliver(readyFrame);
    await activated;

    io.deliver({ t: 'invoke', id: 'c2', kind: 'command', args: { commandId: 'boom' } });
    io.deliver({ t: 'invoke', id: 'c3', kind: 'command', args: { commandId: 'missing' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(io.sent).toContainEqual(
      expect.objectContaining({
        t: 'result',
        id: 'c2',
        ok: false,
        error: { code: 'PLUGIN_ERROR', message: 'nope' },
      }),
    );
    expect(io.sent).toContainEqual(
      expect.objectContaining({
        t: 'result',
        id: 'c3',
        ok: false,
        error: { code: 'PLUGIN_ERROR', message: 'no handler for command "missing"' },
      }),
    );
  });

  it('delivers host events to subscribers and stops on deactivate', async () => {
    const io = fakeTransport();
    const seen: unknown[] = [];
    const plugin = definePlugin({
      activate(ctx) {
        ctx.events.on('selection.changed', (payload) => seen.push(payload));
      },
      deactivate() {
        seen.push('bye');
      },
    });
    const activated = runPlugin(plugin, io.transport, 'p');
    io.deliver(readyFrame);
    await activated;

    io.deliver({ t: 'event', event: 'selection.changed', payload: { nodeIds: ['n1'] } });
    expect(seen).toEqual([{ nodeIds: ['n1'] }]);

    io.deliver({ t: 'invoke', id: 'c4', kind: 'deactivate', args: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toContain('bye');

    // Unsubscribed: further host frames reach nobody.
    io.deliver({ t: 'event', event: 'selection.changed', payload: { nodeIds: ['n2'] } });
    expect(seen).toEqual([{ nodeIds: ['n1'] }, 'bye']);
  });
});

describe('startWorkerPlugin', () => {
  it('speaks the protocol over a worker scope', async () => {
    const sent: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    const scope = {
      postMessage: (message: unknown) => sent.push(message),
      addEventListener: (_type: 'message', handler: (event: { data: unknown }) => void) =>
        listeners.add(handler),
      removeEventListener: (_type: 'message', handler: (event: { data: unknown }) => void) =>
        listeners.delete(handler),
    };

    let activated = false;
    const started = startWorkerPlugin(
      definePlugin({
        activate() {
          activated = true;
        },
      }),
      'p',
      scope,
    );
    expect(sent[0]).toMatchObject({ t: 'hello', pluginId: 'p' });
    for (const listener of listeners) listener({ data: readyFrame });
    await started;
    expect(activated).toBe(true);
  });
});
