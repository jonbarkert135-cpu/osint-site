import { router } from './trpc.ts';
import { authRouter } from './routers/auth.ts';
import { projectRouter } from './routers/project.ts';
import { boardRouter } from './routers/board.ts';
import { boardTokenRouter } from './routers/boardToken.ts';
import { commentsRouter } from './routers/comments.ts';
import { filesRouter } from './routers/files.ts';
import { unfurlRouter } from './routers/unfurl.ts';
import { integrationsRouter } from './routers/integrations.ts';
import { runsRouter, proposalsRouter } from './routers/runs.ts';
import { consentsRouter } from './routers/consents.ts';
import { apiTokensRouter } from './routers/apiTokens.ts';
import { repositoriesRouter } from './routers/repositories.ts';
import { watchesRouter } from './routers/watches.ts';
import { queriesRouter } from './routers/queries.ts';
import { aiRouter } from './routers/aiSearch.ts';
import { credentialsRouter } from './routers/credentials.ts';
import { aiSettingsRouter } from './routers/aiSettings.ts';

export const appRouter = router({
  auth: authRouter,
  project: projectRouter,
  board: boardRouter,
  boardToken: boardTokenRouter,
  comments: commentsRouter,
  files: filesRouter,
  unfurl: unfurlRouter,
  integrations: integrationsRouter,
  runs: runsRouter,
  proposals: proposalsRouter,
  consents: consentsRouter,
  apiTokens: apiTokensRouter,
  repositories: repositoriesRouter,
  watches: watchesRouter,
  queries: queriesRouter,
  ai: aiRouter,
  credentials: credentialsRouter,
  aiSettings: aiSettingsRouter,
});

/** Consumed by `apps/web` as a type-only import — the client never imports the runtime router. */
export type AppRouter = typeof appRouter;
