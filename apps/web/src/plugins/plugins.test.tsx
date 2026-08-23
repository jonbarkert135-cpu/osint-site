import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '../app/commands/registry';
import { INSTALLED_PLUGINS_KEY, readInstalledPlugins } from './installed';
import { startPlugin, type PluginWorker, type SpawnWorker } from './runtime';
import { pluginCommands, usePlugins } from './usePlugins';

const manifest = {
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

/** A worker stand-in: jsdom has no Workers, and the protocol is what these tests are about. */
function fakeWorker() {
  const posted: unknown[] = [];
  const handlers = new Set<(event: MessageEvent<unknown>) => void>();
  const worker: PluginWorker = {
    postMessage: (message) => posted.push(message),
    addEventListener: (_type, handler) => handlers.add(handler),
    terminate: () => handlers.clear(),
  };
  return {
    worker,
    posted,
    fromPlugin: (data: unknown) => {
      for (const handler of [...handlers]) handler({ data } as MessageEvent<unknown>);
    },
  };
}

function install(records: unknown) {
  window.localStorage.setItem(INSTALLED_PLUGINS_KEY, JSON.stringify(records));
}

beforeEach(() => {
  window.localStorage.clear();
  commandRegistry.clear();
});

describe('readInstalledPlugins', () => {
  it('loads a valid install record', () => {
    install([{ manifest, source: 'export {};' }]);
    const { installed, rejected } = readInstalledPlugins();
    expect(rejected).toEqual([]);
    expect(installed[0]?.manifest.name).toBe('Wayback Snapshots');
  });

  it('rejects an invalid manifest and an incompatible API version, and skips disabled plugins', () => {
    install([
      { manifest: { ...manifest, permissions: [] }, source: 'export {};' },
      {
        manifest: { ...manifest, id: 'from-the-future', apiVersion: '^9.0.0' },
        source: 'export {};',
      },
      { manifest: { ...manifest, id: 'switched-off' }, source: 'export {};', enabled: false },
    ]);
    const { installed, rejected } = readInstalledPlugins();
    expect(installed).toEqual([]);
    expect(rejected).toEqual([
      { id: 'wayback-snapshots', reason: 'Array must contain at least 1 element(s)' },
      { id: 'from-the-future', reason: 'needs host API ^9.0.0' },
    ]);
  });

  it('treats unreadable storage as no plugins', () => {
    window.localStorage.setItem(INSTALLED_PLUGINS_KEY, 'not json');
    expect(readInstalledPlugins().installed).toEqual([]);
  });
});

describe('startPlugin', () => {
  it('answers hello with a context that carries no credentials, and routes ui.notify', () => {
    const io = fakeWorker();
    const onNotify = vi.fn();
    const running = startPlugin(
      { manifest: manifest as never, source: '' },
      { onNotify },
      'board-9',
      () => io.worker,
    );

    io.fromPlugin({ t: 'hello', protocol: 1, pluginId: 'wayback-snapshots', apiVersion: '1.0.0' });
    expect(io.posted[0]).toMatchObject({ t: 'ready', context: { boardId: 'board-9' } });
    expect(JSON.stringify(io.posted[0])).not.toContain('token');

    io.fromPlugin({
      t: 'call',
      id: 'c1',
      ns: 'ui',
      method: 'notify',
      args: { message: 'Saved 3 snapshots' },
    });
    expect(onNotify).toHaveBeenCalledWith('wayback-snapshots', 'Saved 3 snapshots');
    expect(io.posted[1]).toMatchObject({ t: 'result', id: 'c1', ok: true });

    running.invokeCommand('snapshot');
    expect(io.posted[2]).toMatchObject({
      t: 'invoke',
      kind: 'command',
      args: { commandId: 'snapshot' },
    });
  });

  it('denies a call the manifest has no permission for and refuses unknown methods', () => {
    const io = fakeWorker();
    const onNotify = vi.fn();
    const quiet = { ...manifest, permissions: ['ui:command'] };
    startPlugin({ manifest: quiet as never, source: '' }, { onNotify }, null, () => io.worker);

    io.fromPlugin({ t: 'call', id: 'c1', ns: 'ui', method: 'notify', args: { message: 'hi' } });
    expect(onNotify).not.toHaveBeenCalled();
    expect(io.posted[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });

    io.fromPlugin({ t: 'call', id: 'c2', ns: 'graph', method: 'mutate', args: {} });
    expect(io.posted[1]).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
  });

  it('drops frames that are not valid envelopes', () => {
    const io = fakeWorker();
    const onLog = vi.fn();
    startPlugin(
      { manifest: manifest as never, source: '' },
      { onNotify: vi.fn(), onLog },
      null,
      () => io.worker,
    );
    io.fromPlugin({ t: 'evil', payload: 1 });
    expect(onLog).toHaveBeenCalledWith('wayback-snapshots', 'error', 'dropped an invalid frame');
    expect(io.posted).toEqual([]);
  });
});

describe('plugin contributions', () => {
  function Harness({ spawn }: { spawn: SpawnWorker }) {
    const { notice } = usePlugins({ spawn });
    return (
      <p data-testid="notice">
        {notice === null ? 'nothing' : `${notice.pluginName}: ${notice.message}`}
      </p>
    );
  }

  it('puts a plugin command in the palette registry and runs it in the plugin', async () => {
    install([{ manifest, source: 'export {};' }]);
    const io = fakeWorker();
    render(<Harness spawn={() => io.worker} />);

    await waitFor(() => expect(commandRegistry.get('wayback-snapshots.snapshot')).toBeDefined());
    const command = commandRegistry.get('wayback-snapshots.snapshot');
    expect(command).toMatchObject({ title: 'Snapshot this URL', group: 'plugin' });

    void command?.run({
      role: 'owner',
      view: 'board',
      projectId: null,
      boardId: null,
      navigate: vi.fn(),
    });
    expect(io.posted).toContainEqual(
      expect.objectContaining({ t: 'invoke', kind: 'command', args: { commandId: 'snapshot' } }),
    );
  });

  it('shows a notice attributed to the plugin that asked for it', async () => {
    install([{ manifest, source: 'export {};' }]);
    const io = fakeWorker();
    render(<Harness spawn={() => io.worker} />);
    await waitFor(() => expect(commandRegistry.get('wayback-snapshots.snapshot')).toBeDefined());

    io.fromPlugin({
      t: 'call',
      id: 'c1',
      ns: 'ui',
      method: 'notify',
      args: { message: 'Saved 3 snapshots' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('notice')).toHaveTextContent(
        'Wayback Snapshots: Saved 3 snapshots',
      ),
    );
  });

  it('registers nothing for a plugin without the ui:command permission', () => {
    expect(
      pluginCommands(
        { manifest: { ...manifest, permissions: ['ui:notify'] } as never, source: '' },
        null,
      ),
    ).toEqual([]);
  });
});
