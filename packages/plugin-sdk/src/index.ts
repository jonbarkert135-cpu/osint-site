/**
 * `@nexus/plugin-sdk` — the package a third-party author installs (17_PLUGIN_SDK.md §4).
 *
 * A plugin exports `definePlugin({ activate, deactivate })`. The host activates it inside a
 * sandboxed iframe, hands it a `PluginContext`, and calls the command handlers the plugin
 * registered. Everything a plugin can do goes through this context: there is no ambient authority
 * and no graph-mutation API — see README.md.
 */

export * from './manifest.ts';
export * from './protocol.ts';
export * from './plugin.ts';
export { startWorkerPlugin } from './worker.ts';
