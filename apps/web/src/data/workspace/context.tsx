/**
 * Wiring for the workspace repository: one provider, and a hook per query/mutation, so no
 * component knows whether the data came from IndexedDB or from the API.
 *
 * `WorkspaceProvider` is the seam. In local mode `main.tsx` hands it the IndexedDB implementation;
 * in server mode `TrpcWorkspaceBridge` builds the tRPC-backed one. Tests hand it a fake.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { trpc } from '../../lib/trpc.tsx';
import { capabilities } from '../../mode/appMode.ts';
import { createServerRuns } from './runs.ts';
import { createServerWorkspaceRepository } from './server.ts';
import type {
  ListBoardsOptions,
  ListProjectsOptions,
  WorkspaceBoard,
  WorkspaceProject,
  WorkspaceRepository,
} from './types.ts';

const WorkspaceContext = createContext<WorkspaceRepository | null>(null);

export function WorkspaceProvider({
  repository,
  children,
}: {
  repository: WorkspaceRepository;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={repository}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceRepository {
  const repository = useContext(WorkspaceContext);
  if (repository === null) {
    throw new Error('useWorkspace must be used inside a <WorkspaceProvider>.');
  }
  return repository;
}

/** The caller's capability in this workspace (P7 §12) — see `WorkspaceRepository.role`. */
export function useWorkspaceRole() {
  return useWorkspace().role();
}

/**
 * Server mode only: adapts the tRPC client to the repository interface. Mounted inside
 * `TRPCProvider`, so it may use `useUtils()`; local mode never renders it, which is what keeps the
 * API router out of the local runtime path.
 */
export function TrpcWorkspaceBridge({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const repository = useMemo(
    () => ({
      // P9: the run surface exists only where the capability is on (ADR-002); local mode installs
      // the throwing implementation instead, so a stray call is a test failure, not a no-op.
      ...(capabilities.integrations
        ? {
            runs: createServerRuns({
              acceptConsent: (input) =>
                utils.client.consents.accept.mutate(
                  input as Parameters<typeof utils.client.consents.accept.mutate>[0],
                ),
              getProposal: (input) => utils.client.proposals.get.query(input),
              // The router speaks `Date`; the repository speaks ISO strings, as everywhere else.
              listRuns: async (input) => {
                const page = await utils.client.runs.list.query(input);
                return {
                  runs: page.runs.map((row) => ({
                    ...row,
                    createdAt: row.createdAt.toISOString(),
                  })),
                  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
                };
              },
              startRun: (input) => utils.client.runs.start.mutate(input),
              cancelRun: (input) => utils.client.runs.cancel.mutate(input),
              getRunLog: async (input) =>
                (await utils.client.runs.log.query(input)).map((line) => ({
                  ...line,
                  at: line.at.toISOString(),
                })),
            }),
          }
        : {}),
      ...createServerWorkspaceRepository({
        listProjects: (input) => utils.client.project.list.query(input),
        createProject: (input) => utils.client.project.create.mutate(input),
        renameProject: (input) => utils.client.project.rename.mutate(input),
        setProjectAppearance: (input) => utils.client.project.setAppearance.mutate(input),
        archiveProject: (input) => utils.client.project.archive.mutate(input),
        restoreProject: (input) => utils.client.project.restore.mutate(input),
        deleteProject: (input) => utils.client.project.delete.mutate(input),
        listBoards: (input) => utils.client.board.list.query(input),
        createBoard: (input) => utils.client.board.create.mutate(input),
        renameBoard: (input) => utils.client.board.rename.mutate(input),
        moveBoard: (input) => utils.client.board.move.mutate(input),
        archiveBoard: (input) => utils.client.board.archive.mutate(input),
        restoreBoard: (input) => utils.client.board.restore.mutate(input),
        deleteBoard: (input) => utils.client.board.delete.mutate(input),
        duplicateBoard: (input) => utils.client.board.duplicate.mutate(input),
        saveBoardAsTemplate: (input) => utils.client.board.saveAsTemplate.mutate(input),
        touchBoardOpened: (input) => utils.client.board.touchOpened.mutate(input),
        reportBoardCounts: (input) => utils.client.board.reportCounts.mutate(input),
      }),
    }),
    [utils],
  );
  return <WorkspaceProvider repository={repository}>{children}</WorkspaceProvider>;
}

export const projectsKey = (options: ListProjectsOptions = {}) =>
  ['workspace', 'projects', options] as const;
export const boardsKey = (projectId: string, options: ListBoardsOptions = {}) =>
  ['workspace', 'boards', projectId, options] as const;

export function useProjects(options: ListProjectsOptions = {}): UseQueryResult<WorkspaceProject[]> {
  const repository = useWorkspace();
  return useQuery({
    queryKey: projectsKey(options),
    queryFn: () => repository.listProjects(options),
  });
}

export function useCreateProject(onCreated: (project: WorkspaceProject) => void | Promise<void>) {
  const repository = useWorkspace();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; color?: string; icon?: string }) =>
      repository.createProject(input),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['workspace', 'projects'] });
      await onCreated(project);
    },
  });
}

/** Shared invalidation for any project mutation: every `useProjects` view goes stale. */
function useProjectMutation<TInput>(
  fn: (repository: WorkspaceRepository, input: TInput) => Promise<WorkspaceProject>,
) {
  const repository = useWorkspace();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(repository, input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'projects'] });
    },
  });
}

export const useRenameProject = () =>
  useProjectMutation<{ projectId: string; name: string }>((r, i) => r.renameProject(i));
export const useSetProjectAppearance = () =>
  useProjectMutation<{ projectId: string; color?: string | null; icon?: string | null }>((r, i) =>
    r.setProjectAppearance(i),
  );
export const useArchiveProject = () =>
  useProjectMutation<{ projectId: string }>((r, i) => r.archiveProject(i));
export const useRestoreProject = () =>
  useProjectMutation<{ projectId: string }>((r, i) => r.restoreProject(i));

export function useDeleteProject() {
  const repository = useWorkspace();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; confirmName: string }) =>
      repository.deleteProject(input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'projects'] });
    },
  });
}

export function useBoards(
  projectId: string,
  options: ListBoardsOptions = {},
): UseQueryResult<WorkspaceBoard[]> {
  const repository = useWorkspace();
  return useQuery({
    queryKey: boardsKey(projectId, options),
    queryFn: () => repository.listBoards(projectId, options),
    enabled: projectId !== '',
  });
}

/**
 * Every board the caller can see, across all their projects — the input to workspace-wide search
 * (03_UX.md §9.2 `@@`). Disabled by default: it fans out one list per project, so it runs only when
 * a surface actually asks for cross-project results.
 */
export function useAllBoards(enabled: boolean): UseQueryResult<WorkspaceBoard[]> {
  const repository = useWorkspace();
  return useQuery({
    queryKey: ['workspace', 'boards', 'all'] as const,
    queryFn: async () => {
      const projects = await repository.listProjects({});
      const lists = await Promise.all(projects.map((project) => repository.listBoards(project.id)));
      return lists.flat();
    },
    enabled,
  });
}

export function useCreateBoard(
  projectId: string,
  onCreated: (board: WorkspaceBoard) => void | Promise<void>,
) {
  const repository = useWorkspace();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; templateId?: string }) =>
      repository.createBoard({ projectId, ...input }),
    onSuccess: async (board) => {
      await client.invalidateQueries({ queryKey: ['workspace', 'boards', projectId] });
      await onCreated(board);
    },
  });
}

/** Shared invalidation for any board mutation: both the source and (if moved) target project. */
function useBoardMutation<TInput extends { boardId: string }, TOut>(
  fn: (repository: WorkspaceRepository, input: TInput) => Promise<TOut>,
) {
  const repository = useWorkspace();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(repository, input),
    onSuccess: async () => {
      // Board membership of any project may have changed (move); invalidating every board list is
      // simpler and cheaper than tracking which project ids are affected.
      await client.invalidateQueries({ queryKey: ['workspace', 'boards'] });
    },
  });
}

export const useRenameBoard = () =>
  useBoardMutation<{ boardId: string; title: string }, WorkspaceBoard>((r, i) => r.renameBoard(i));
export const useMoveBoard = () =>
  useBoardMutation<{ boardId: string; projectId: string }, WorkspaceBoard>((r, i) =>
    r.moveBoard(i),
  );
export const useArchiveBoard = () =>
  useBoardMutation<{ boardId: string }, WorkspaceBoard>((r, i) => r.archiveBoard(i));
export const useRestoreBoard = () =>
  useBoardMutation<{ boardId: string }, WorkspaceBoard>((r, i) => r.restoreBoard(i));
export const useDeleteBoard = () =>
  useBoardMutation<{ boardId: string }, { ok: true }>((r, i) => r.deleteBoard(i));
export const useDuplicateBoard = () =>
  useBoardMutation<{ boardId: string; title?: string }, WorkspaceBoard>((r, i) =>
    r.duplicateBoard(i),
  );
export const useSaveBoardAsTemplate = () =>
  useBoardMutation<{ boardId: string }, WorkspaceBoard>((r, i) => r.saveBoardAsTemplate(i));

/** Fire-and-forget: no loading/error UI, just an invalidation once it settles. */
export function useTouchBoardOpened() {
  const repository = useWorkspace();
  return (boardId: string): void => {
    void repository.touchBoardOpened({ boardId });
  };
}

export function useReportBoardCounts() {
  const repository = useWorkspace();
  return (boardId: string, nodeCount: number, edgeCount: number): void => {
    void repository.reportBoardCounts({ boardId, nodeCount, edgeCount });
  };
}
