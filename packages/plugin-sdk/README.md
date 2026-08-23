# `@nexus/plugin-sdk`

Write a plugin for Raven. A plugin adds commands to the app; it runs in its own worker, with no
access to the page, the network, cookies or your investigation data unless the manifest asks for it
and the user grants it.

This is the first public slice of the SDK described in `RAVEN-SPEC/17_PLUGIN_SDK.md`. Commands,
notifications and host events work today. Panels, inspector sections, custom node cards and
`graph.propose()` are specified but not yet accepted by the host — a manifest that declares them is
rejected rather than silently ignored.

## 1. Write the plugin

```ts
// src/index.ts
import { definePlugin, startWorkerPlugin } from '@nexus/plugin-sdk';

const plugin = definePlugin({
  async activate(ctx) {
    ctx.log.info(`activated on board ${ctx.boardId ?? 'none'}`);

    ctx.commands.register('snapshot', async () => {
      await ctx.ui.notify('Snapshot saved');
    });

    ctx.events.on('selection.changed', (payload) => {
      ctx.log.info(`selection: ${JSON.stringify(payload)}`);
    });
  },

  async deactivate() {
    // Release resources. The host gives you 500 ms.
  },
});

startWorkerPlugin(plugin, 'wayback-snapshots');
```

`activate` receives a `PluginContext`:

| Member                                                               | Needs              | Does                                                |
| -------------------------------------------------------------------- | ------------------ | --------------------------------------------------- |
| `ctx.commands.register`                                              | `ui:command`       | binds a handler to a command from the manifest      |
| `ctx.ui.notify`                                                      | `ui:notify`        | shows a toast, always attributed to your plugin     |
| `ctx.events.on`                                                      | `events:subscribe` | subscribes to a host event; returns an unsubscriber |
| `ctx.log.info` / `.error`                                            | —                  | writes to your plugin's log                         |
| `ctx.pluginId`, `.boardId`, `.locale`, `.permissions`, `.apiVersion` | —                  | read-only context                                   |

There is no API that writes to the graph. Plugins propose; the user decides (§P1).

## 2. Write the manifest

```json
{
  "manifestVersion": 1,
  "kind": "ui",
  "id": "wayback-snapshots",
  "name": "Wayback Snapshots",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "publisher": { "id": "acme", "name": "Acme" },
  "license": "MIT",
  "description": "Adds archived snapshots of a selected URL to the board as proposals.",
  "permissions": ["ui:command", "ui:notify"],
  "contributes": {
    "commands": [{ "id": "snapshot", "title": "Snapshot this URL" }]
  }
}
```

Rules the schema enforces:

- `id` is lowercase, `a-z0-9-`, 3–40 characters, and namespaces your commands: the host shows
  `snapshot` as `wayback-snapshots.snapshot`.
- `apiVersion` is a caret range against the host SDK version (`PLUGIN_API_VERSION`, currently
  `1.0.0`). Same major and a host at least as new: `^1.2.0` runs on `1.3.0`, not on `1.1.0`.
- Every contribution needs its permission. Declaring commands without `ui:command` fails validation.
- Unknown top-level keys are rejected, so a typo never becomes a silent no-op.

Validate it yourself before publishing:

```ts
import { zPluginManifest } from '@nexus/plugin-sdk/manifest';
zPluginManifest.parse(JSON.parse(manifestJson));
```

## 3. Bundle and install

Bundle `src/index.ts` into a single self-contained ES module (the SDK is tiny and should be inlined;
your bundle must not import anything at runtime). The host loads that module into a `Worker`.

Until the plugin registry ships, install locally by putting the manifest and bundle in
`localStorage` under `raven.plugins.installed`:

```js
localStorage.setItem(
  'raven.plugins.installed',
  JSON.stringify([{ manifest, source: '<your bundled module>', enabled: true }]),
);
```

Reload the app, press `Ctrl+K`, and your command is in the palette next to Raven's own.

## 4. What the host guarantees

- Every frame between host and plugin is schema-validated; an invalid frame is dropped, not trusted.
- The context payload never contains tokens, cookies or session material.
- A call your manifest has no permission for comes back `PERMISSION_DENIED`; a method the host does
  not implement comes back `NOT_IMPLEMENTED`. Neither takes your plugin down.
- A command handler that throws is reported as a failed result and logged against your plugin —
  it never surfaces as a Raven error.
