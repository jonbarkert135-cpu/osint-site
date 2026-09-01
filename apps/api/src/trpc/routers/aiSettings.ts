/**
 * `aiSettings.*` — the Settings → AI screen (14_AI_AGENT.md §2.1–2.5).
 *
 * Admin-only: pointing an org's AI traffic at an endpoint is an org-wide grant, and the key behind
 * it is a secret (N4). `get` never returns the key — only whether one exists and its last four
 * characters, which is what "is this the key I pasted?" actually needs.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { normalizeBaseUrl, probeAiEndpoint } from '@nexus/ai';

import {
  AI_CREDENTIAL_INTEGRATION,
  loadAiSettings,
  resolveAiEndpoint,
  saveAiSettings,
  withAiKey,
} from '../../ai/settings.ts';
import { audit } from '../../audit.ts';
import { CredentialCryptoError } from '../../secrets/envelope.ts';
import { createCredential, deleteCredential, listCredentials } from '../../secrets/store.ts';
import { orgProcedure, router } from '../trpc.ts';

const zUpdate = z.object({
  enabled: z.boolean(),
  /** A URL, or `null` to forget the endpoint entirely. */
  baseUrl: z.string().url().max(2000).nullable(),
  chatModel: z.string().trim().max(200),
  embedModel: z.string().trim().max(200),
});

async function keySummary(
  orgId: string,
): Promise<{ present: boolean; lastFour: string | null; fingerprint: string | null }> {
  const [credential] = await listCredentials(orgId, AI_CREDENTIAL_INTEGRATION);
  if (credential === undefined) return { present: false, lastFour: null, fingerprint: null };
  return {
    present: true,
    lastFour: credential.lastFour,
    fingerprint: credential.fingerprint,
  };
}

export const aiSettingsRouter = router({
  get: orgProcedure('admin').query(async ({ ctx }) => {
    const [settings, resolved, key] = await Promise.all([
      loadAiSettings(ctx.org.id),
      resolveAiEndpoint(ctx.org.id),
      keySummary(ctx.org.id),
    ]);
    return {
      settings,
      key,
      /** What the endpoint resolves to right now, including the env fallback (§2.5). */
      effective: {
        configured: resolved.configured,
        baseUrl: resolved.baseUrl,
        embedModel: resolved.embedModel,
        source: resolved.source,
      },
    };
  }),

  update: orgProcedure('admin')
    .input(zUpdate)
    .mutation(async ({ ctx, input }) => {
      if (input.enabled && (input.baseUrl === null || normalizeBaseUrl(input.baseUrl) === '')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Add the endpoint URL before turning AI on.',
        });
      }
      const saved = await saveAiSettings(ctx.org.id, ctx.user.id, input);
      await audit(
        {
          action: 'ai.settings.updated',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'org',
          targetId: ctx.org.id,
          ip: ctx.ip,
          metadata: {
            enabled: saved.enabled,
            baseUrl: saved.baseUrl,
            chatModel: saved.chatModel,
            embedModel: saved.embedModel,
          },
        },
        ctx.logger,
      );
      return saved;
    }),

  /** One key per org for the AI endpoint: setting a new one replaces the old one outright. */
  setKey: orgProcedure('admin')
    .input(z.object({ secret: z.string().min(1).max(8192) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await listCredentials(ctx.org.id, AI_CREDENTIAL_INTEGRATION);
      for (const credential of existing) await deleteCredential(ctx.org.id, credential.id);
      let created;
      try {
        created = await createCredential({
          orgId: ctx.org.id,
          createdBy: ctx.user.id,
          integrationId: AI_CREDENTIAL_INTEGRATION,
          projectId: null,
          label: 'AI endpoint key',
          secret: input.secret,
          expiresAt: null,
        });
      } catch (error) {
        if (error instanceof CredentialCryptoError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
        }
        throw error;
      }
      await audit(
        {
          action: 'credential.created',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'credential',
          targetId: created.id,
          ip: ctx.ip,
          metadata: { integrationId: AI_CREDENTIAL_INTEGRATION, fingerprint: created.fingerprint },
        },
        ctx.logger,
      );
      return { present: true, lastFour: created.lastFour, fingerprint: created.fingerprint };
    }),

  clearKey: orgProcedure('admin').mutation(async ({ ctx }) => {
    const existing = await listCredentials(ctx.org.id, AI_CREDENTIAL_INTEGRATION);
    for (const credential of existing) {
      await deleteCredential(ctx.org.id, credential.id);
      await audit(
        {
          action: 'credential.deleted',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'credential',
          targetId: credential.id,
          ip: ctx.ip,
        },
        ctx.logger,
      );
    }
    return { removed: existing.length };
  }),

  /**
   * `GET /v1/models` against the saved (or, for an unsaved edit, the supplied) endpoint. Returns
   * the failure as data rather than as a tRPC error: a rejected key is a normal answer for this
   * screen, and the UI has to render the reason next to the field that caused it (§2.2).
   */
  probe: orgProcedure('admin')
    .input(z.object({ baseUrl: z.string().url().max(2000).optional() }).default({}))
    .mutation(async ({ ctx, input }) => {
      const resolved = await resolveAiEndpoint(ctx.org.id);
      const baseUrl = input.baseUrl ?? resolved.baseUrl;
      if (baseUrl === null || normalizeBaseUrl(baseUrl) === '') {
        return {
          ok: false as const,
          code: 'no_provider' as const,
          message: 'AI is not configured. Add an endpoint URL in Settings → AI.',
          models: [] as string[],
        };
      }
      const result = await withAiKey(ctx.org.id, async (apiKey) =>
        probeAiEndpoint({ baseUrl, ...(apiKey === undefined ? {} : { apiKey }) }),
      );
      return result.ok
        ? { ok: true as const, models: [...result.models] }
        : {
            ok: false as const,
            code: result.code,
            message: result.message,
            models: [] as string[],
          };
    }),
});
