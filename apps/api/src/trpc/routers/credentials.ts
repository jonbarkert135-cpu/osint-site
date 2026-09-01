/**
 * `credentials.*` — write-only credential management (15_SECURITY.md §8.2).
 *
 * There is no read procedure: `list` returns label, fingerprint and last four characters, which is
 * everything the UI needs to answer "which key is this?" and nothing an attacker can use. Admin
 * only, because a credential is an org-wide grant (N4).
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { audit } from '../../audit.ts';
import { CredentialCryptoError } from '../../secrets/envelope.ts';
import {
  createCredential,
  deleteCredential,
  listCredentials,
  rotateCredential,
} from '../../secrets/store.ts';
import { orgProcedure, router } from '../trpc.ts';

const zIntegrationId = z.string().min(1).max(64);
const zSecret = z.string().min(1).max(8192);

/** Configuration problems must read as configuration problems, not as "something went wrong". */
function toTrpcError(error: unknown): never {
  if (error instanceof CredentialCryptoError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
  }
  throw error;
}

export const credentialsRouter = router({
  list: orgProcedure('admin')
    .input(z.object({ integrationId: zIntegrationId.optional() }).default({}))
    .query(async ({ ctx, input }) => listCredentials(ctx.org.id, input.integrationId)),

  create: orgProcedure('admin')
    .input(
      z.object({
        integrationId: zIntegrationId,
        projectId: z.string().min(1).nullable().default(null),
        label: z.string().trim().min(1).max(120),
        secret: zSecret,
        expiresAt: z.date().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let created;
      try {
        created = await createCredential({
          orgId: ctx.org.id,
          createdBy: ctx.user.id,
          integrationId: input.integrationId,
          projectId: input.projectId,
          label: input.label,
          secret: input.secret,
          expiresAt: input.expiresAt,
        });
      } catch (error) {
        toTrpcError(error);
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
          // Fingerprint, never the secret: it identifies the key across rotations.
          metadata: { integrationId: input.integrationId, fingerprint: created.fingerprint },
        },
        ctx.logger,
      );
      return created;
    }),

  rotate: orgProcedure('admin')
    .input(z.object({ credentialId: z.string().min(1), secret: zSecret }))
    .mutation(async ({ ctx, input }) => {
      let rotated;
      try {
        rotated = await rotateCredential(ctx.org.id, input.credentialId, input.secret);
      } catch (error) {
        toTrpcError(error);
      }
      if (rotated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That credential no longer exists.' });
      }
      await audit(
        {
          action: 'credential.rotated',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'credential',
          targetId: rotated.id,
          ip: ctx.ip,
          metadata: { integrationId: rotated.integrationId, fingerprint: rotated.fingerprint },
        },
        ctx.logger,
      );
      return rotated;
    }),

  remove: orgProcedure('admin')
    .input(z.object({ credentialId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteCredential(ctx.org.id, input.credentialId);
      if (!deleted) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That credential no longer exists.' });
      }
      await audit(
        {
          action: 'credential.deleted',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'credential',
          targetId: input.credentialId,
          ip: ctx.ip,
        },
        ctx.logger,
      );
      return { deleted: true };
    }),
});
