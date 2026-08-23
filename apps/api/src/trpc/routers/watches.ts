/**
 * `watches.*` — the username watchlist (13_SHERLOCK.md §6.6).
 *
 * The router only stores intent: which handle, how often, who authorized it. Every rule that could
 * drift — cadence spacing with ±10% jitter, the 90-day consent expiry, the 25/project and
 * 100/instance quotas — comes from `@nexus/integrations/watch`, the same module the
 * scheduler uses. Results of a scheduled run are always a pending diff for review (N4); nothing
 * here can apply anything.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@nexus/db';
import { newId } from '@nexus/domain';
import {
  WATCH_CADENCES,
  checkWatchQuota,
  consentExpired,
  nextRunAt,
} from '@nexus/integrations/watch';

import { audit } from '../../audit.ts';
import { orgProcedure, router } from '../trpc.ts';

const zNotifyOn = z.enum(['appeared', 'disappeared', 'becameUnknown']);

interface WatchRow {
  id: string;
  nodeId: string;
  handle: string;
  projectId: string;
  cadence: string;
  sites: unknown;
  notifyOn: unknown;
  consentId: string;
  pausedAt: Date | null;
  lastRunId: string | null;
  nextRunAt: Date;
}

const toApi = (row: WatchRow) => ({
  id: row.id,
  nodeId: row.nodeId,
  handle: row.handle,
  projectId: row.projectId,
  cadence: row.cadence,
  sites: Array.isArray(row.sites) ? (row.sites as string[]) : null,
  notifyOn: Array.isArray(row.notifyOn) ? (row.notifyOn as string[]) : [],
  consentId: row.consentId,
  pausedAt: row.pausedAt,
  lastRunId: row.lastRunId,
  nextRunAt: row.nextRunAt,
});

export const watchesRouter = router({
  /** Watches of one project, soonest first, so the UI can show "next check" without sorting. */
  list: orgProcedure('viewer')
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const rows = (await prisma.usernameWatch.findMany({
        where: { orgId: ctx.org.id, projectId: input.projectId },
        orderBy: { nextRunAt: 'asc' },
        take: 100,
      })) as WatchRow[];
      return rows.map(toApi);
    }),

  create: orgProcedure('editor')
    .input(
      z.object({
        projectId: z.string().min(1),
        nodeId: z.string().min(1),
        handle: z.string().min(1).max(120),
        cadence: z.enum(WATCH_CADENCES),
        sites: z.array(z.string().max(120)).max(400).nullable().default(null),
        notifyOn: z.array(zNotifyOn).min(1).default(['appeared', 'disappeared']),
        consentId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      // A watch is a standing authorization: it may only lean on a consent that is this user's,
      // for this project, and still inside its 90-day window.
      const consent = await prisma.consent.findFirst({
        where: {
          id: input.consentId,
          orgId: ctx.org.id,
          projectId: input.projectId,
          userId: ctx.user.id,
          revokedAt: null,
        },
      });
      if (consent === null || consentExpired(consent.acceptedAt, now)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Confirm authorization again to monitor @${input.handle}.`,
        });
      }

      const [project, instance] = await Promise.all([
        prisma.usernameWatch.count({ where: { projectId: input.projectId } }),
        prisma.usernameWatch.count({}),
      ]);
      const quota = checkWatchQuota({ project, instance });
      if (!quota.ok) throw new TRPCError({ code: 'FORBIDDEN', message: quota.reason });

      const created = (await prisma.usernameWatch.create({
        data: {
          id: newId.usernameWatch(),
          orgId: ctx.org.id,
          projectId: input.projectId,
          nodeId: input.nodeId,
          handle: input.handle,
          createdBy: ctx.user.id,
          cadence: input.cadence,
          ...(input.sites === null ? {} : { sites: input.sites }),
          notifyOn: input.notifyOn,
          consentId: input.consentId,
          pausedAt: null,
          lastRunId: null,
          // The first check is one cadence away, jittered, so a bulk import does not stampede.
          nextRunAt: nextRunAt(input.cadence, now),
          updatedAt: now,
        },
      })) as WatchRow;

      await audit(
        {
          action: 'integration.watch.created',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'usernameWatch',
          targetId: created.id,
          ip: ctx.ip,
          metadata: { cadence: input.cadence, consentId: input.consentId },
        },
        ctx.logger,
      );
      return toApi(created);
    }),

  /** Pause and resume are the same door; resuming re-books the next slot from now. */
  setPaused: orgProcedure('editor')
    .input(z.object({ watchId: z.string().min(1), paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const watch = (await prisma.usernameWatch.findFirst({
        where: { id: input.watchId, orgId: ctx.org.id },
      })) as WatchRow | null;
      if (watch === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That watch no longer exists.' });
      }
      const now = new Date();
      const cadence = watch.cadence as (typeof WATCH_CADENCES)[number];
      const updated = (await prisma.usernameWatch.update({
        where: { id: watch.id },
        data: input.paused
          ? { pausedAt: now, updatedAt: now }
          : { pausedAt: null, nextRunAt: nextRunAt(cadence, now), updatedAt: now },
      })) as WatchRow;
      return toApi(updated);
    }),

  remove: orgProcedure('editor')
    .input(z.object({ watchId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const watch = (await prisma.usernameWatch.findFirst({
        where: { id: input.watchId, orgId: ctx.org.id },
      })) as WatchRow | null;
      if (watch === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That watch no longer exists.' });
      }
      await prisma.usernameWatch.delete({ where: { id: watch.id } });
      await audit(
        {
          action: 'integration.watch.removed',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'usernameWatch',
          targetId: watch.id,
          ip: ctx.ip,
        },
        ctx.logger,
      );
      return { removed: true };
    }),
});
