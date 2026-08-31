/**
 * `queries.plan` — the caller the plan queue has been waiting for (Part 2 §36, §37).
 *
 * The web app can plan and run a query in the tab (local-first, N2), but a query that needs the
 * host — a containerized engine, a long crawl, a machine that is not the analyst's laptop — has to
 * be asked for. This is that ask: validate, mint a run id, enqueue `query.plan`, audit. The API
 * still never plans and never executes (N5); the plan is derived by the runner at claim time, from
 * the registry, so nothing here can hand it a stale plan.
 *
 * Permissions are *stated*, never widened: what the caller does not name, the runner does not have.
 */

import { z } from 'zod';
import { newId } from '@nexus/domain';

import { audit } from '../../audit.ts';
import { enqueuePlan } from '../../integrations/queue.ts';
import { orgProcedure, router } from '../trpc.ts';

/** Mirrors `zPlanJob` in `apps/runner/src/protocol.ts`: the queue is the contract between them. */
const zPlanInput = z.object({
  query: z.string().min(1).max(2000),
  mode: z
    .enum(['strict-local', 'zero-credential', 'free-tier', 'configured', 'maximum-coverage'])
    .default('zero-credential'),
  permissions: z
    .array(z.enum(['network', 'filesystem', 'subprocess', 'credentials', 'browser']))
    .max(5)
    .default([]),
  depth: z.union([z.literal(1), z.literal(2), z.literal('deep')]).optional(),
});

export const queriesRouter = router({
  /**
   * Queues one host-side plan. Returns the run id immediately — progress arrives on the `run:<id>`
   * channel the runner already publishes to, so a plan is followed exactly like an integration run.
   */
  plan: orgProcedure('editor')
    .input(zPlanInput)
    .mutation(async ({ ctx, input }) => {
      const runId = newId.run();

      await enqueuePlan({
        runId,
        orgId: ctx.org.id,
        query: input.query,
        mode: input.mode,
        permissions: input.permissions,
        ...(input.depth === undefined ? {} : { depth: input.depth }),
      });

      await audit(
        {
          action: 'query.plan.requested',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'run',
          targetId: runId,
          ip: ctx.ip,
          // The query itself is user input about a third party: the audit records its shape, the
          // mode and the permissions, not the string.
          metadata: {
            mode: input.mode,
            permissions: input.permissions.length,
            queryLength: input.query.length,
          },
        },
        ctx.logger,
      );

      return { runId, queued: true };
    }),
});
