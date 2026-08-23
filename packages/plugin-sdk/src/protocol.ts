/**
 * The postMessage envelope between the host page and a plugin's sandboxed iframe
 * (17_PLUGIN_SDK.md §5.4). Both sides validate every frame with this schema — the host because a
 * plugin is untrusted, the plugin because a malicious page could be embedding it.
 *
 * Only the frames the current host implements are here: the handshake, host→plugin invocations,
 * plugin→host calls and their results, and logging. Streaming events arrive with `event`.
 */

import { z } from 'zod';

import { zHostEvent, zPluginPermission } from './manifest.ts';

export const PROTOCOL_VERSION = 1;

/** What the host tells the plugin about the world at activation. Never contains credentials. */
export const zPluginContextPayload = z.object({
  pluginId: z.string(),
  hostVersion: z.string(),
  apiVersion: z.string(),
  boardId: z.string().nullable(),
  locale: z.string(),
  permissions: z.array(zPluginPermission),
});

export const zEnvelope = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.literal(PROTOCOL_VERSION),
    pluginId: z.string(),
    apiVersion: z.string(),
  }),
  z.object({
    t: z.literal('ready'),
    protocol: z.literal(PROTOCOL_VERSION),
    context: zPluginContextPayload,
  }),
  z.object({
    t: z.literal('invoke'),
    id: z.string().min(1),
    kind: z.enum(['command', 'deactivate']),
    args: z.unknown(),
  }),
  z.object({
    t: z.literal('call'),
    id: z.string().min(1),
    ns: z.string(),
    method: z.string(),
    args: z.unknown(),
  }),
  // One `result` shape rather than an ok:true/ok:false pair: a discriminated union may not reuse
  // the discriminator value, and callers narrow on `ok` anyway.
  z.object({
    t: z.literal('result'),
    id: z.string().min(1),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({ t: z.literal('event'), event: zHostEvent, payload: z.unknown() }),
  z.object({
    t: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string().max(2000),
  }),
]);

export type Envelope = z.infer<typeof zEnvelope>;
export type PluginContextPayload = z.infer<typeof zPluginContextPayload>;

/** Parses an untrusted frame; `null` means "drop it" — never throw on a hostile message. */
export function parseEnvelope(raw: unknown): Envelope | null {
  const parsed = zEnvelope.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
