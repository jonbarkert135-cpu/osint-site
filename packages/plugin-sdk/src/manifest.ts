/**
 * The plugin manifest an external author ships (17_PLUGIN_SDK.md §2).
 *
 * This is the first slice of the public schema: identity, the permission taxonomy, and the
 * contributions the host can actually honour today — commands, settings and node types. Panels,
 * inspectors and context-menu items are declared in the spec but not accepted here yet, because a
 * manifest that validates must mean "the host will do this", not "the host might, one day".
 */

import { z } from 'zod';

export const zPluginId = z.string().regex(/^[a-z][a-z0-9-]{2,39}$/);

const zSemver = z.string().regex(/^\d+\.\d+\.\d+$/);

/** What a plugin may ask for. A capability with no permission cannot be reached at all (P3). */
export const zPluginPermission = z.enum([
  'graph:read',
  'graph:propose',
  'ui:command',
  'ui:notify',
  'storage:local',
  'events:subscribe',
]);

export const zContributionCommand = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]{2,63}$/),
  title: z.string().min(2).max(60),
  category: z.string().max(30).default('Plugin'),
  showInPalette: z.boolean().default(true),
});

export const zContributionSetting = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/),
  label: z.string().max(60),
  type: z.enum(['string', 'number', 'boolean']),
  default: z.unknown().optional(),
});

export const zContributionNodeType = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
  label: z.string().min(2).max(40),
  icon: z.string(),
});

/** Host-side events a plugin can subscribe to (§2.1). */
export const zHostEvent = z.enum([
  'selection.changed',
  'node.created',
  'node.updated',
  'node.deleted',
  'board.opened',
  'board.closed',
]);

export const zPluginManifest = z
  .object({
    manifestVersion: z.literal(1),
    kind: z.enum(['ui', 'backend', 'hybrid']),
    id: zPluginId,
    name: z.string().min(2).max(60),
    version: zSemver,
    /** Host SDK range the plugin was written against, e.g. "^1.0.0" (§7.8). */
    apiVersion: z.string().regex(/^\^\d+\.\d+\.\d+$/),
    publisher: z.object({
      id: z.string(),
      name: z.string(),
      url: z.string().url().optional(),
    }),
    license: z.string(),
    description: z.string().min(20).max(400),
    permissions: z.array(zPluginPermission).min(1),
    contributes: z
      .object({
        commands: z.array(zContributionCommand).max(50).default([]),
        settings: z.array(zContributionSetting).max(40).default([]),
        nodeTypes: z.array(zContributionNodeType).max(20).default([]),
      })
      .default({ commands: [], settings: [], nodeTypes: [] }),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // A contribution the plugin has no permission for is a manifest bug, not a silent no-op:
    // the author finds out at validation time instead of wondering why nothing shows up.
    if (manifest.contributes.commands.length > 0 && !manifest.permissions.includes('ui:command')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: 'contributes.commands requires the "ui:command" permission',
      });
    }
  });

export type PluginManifest = z.infer<typeof zPluginManifest>;
export type PluginPermission = z.infer<typeof zPluginPermission>;
export type ContributionCommand = z.infer<typeof zContributionCommand>;
export type HostEvent = z.infer<typeof zHostEvent>;

/** Commands are namespaced by the host so two plugins can both contribute an "export" (§2.1). */
export function namespacedCommandId(pluginId: string, commandId: string): string {
  return `${pluginId}.${commandId}`;
}
