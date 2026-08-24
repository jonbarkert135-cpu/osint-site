import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Banner, Button, Menu, MenuItem, Skeleton, SkipToContent } from '@nexus/ui';
import { CommandPalette } from '../commands/palette';
import { useRegisterCommands } from '../commands/useRegisterCommands';
import type { Command } from '../commands/registry';
import { useBoardStatus } from './boardStatus';
import { capabilities } from '../../mode/appMode';
import { PluginNotices } from '../../plugins/PluginNotices';

export type ShellProject = { id: string; name: string; archivedAt?: string | null };

export type ShellProps = {
  children: ReactNode;
  /** Session or project list still resolving — the shell renders skeletons, never a blank page. */
  loading?: boolean | undefined;
  /** User-facing copy already mapped through lib/trpc errorMessage(). */
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  projects?: ShellProject[] | undefined;
  /** Opens the "New project" dialog. Absent while the shell renders without a session. */
  onCreateProject?: (() => void) | undefined;
  /** Viewers cannot rename/archive/delete projects (P7 §12) — every row menu item stays disabled. */
  canMutateProjects?: boolean | undefined;
  onRenameProject?: ((project: ShellProject) => void) | undefined;
  onArchiveProject?: ((project: ShellProject) => void) | undefined;
  onDeleteProject?: ((project: ShellProject) => void) | undefined;
  boardTitle?: string | undefined;
  orgName?: string | undefined;
  userName?: string | undefined;
  /**
   * Account UI (sign out, org switcher) only makes sense where accounts exist. Defaults to the
   * deployment's `auth` capability; passed explicitly by the visual tests.
   */
  authEnabled?: boolean | undefined;
};

function ProjectRailRow({
  project,
  canMutate,
  onRename,
  onArchive,
  onDelete,
}: {
  project: ShellProject;
  canMutate: boolean;
  onRename?: (project: ShellProject) => void;
  onArchive?: (project: ShellProject) => void;
  onDelete?: (project: ShellProject) => void;
}) {
  const rename = () => onRename?.(project);
  const archive = () => onArchive?.(project);
  const remove = () => onDelete?.(project);

  // Same rule as BoardCard: the palette command is the exact handler the menu item calls.
  const commands: Command[] = canMutate
    ? [
        {
          id: `project:${project.id}:rename`,
          title: `Rename project "${project.name}"`,
          group: 'project',
          keywords: ['rename', 'project', project.name],
          run: rename,
        },
        {
          id: `project:${project.id}:archive`,
          title: `Archive project "${project.name}"`,
          group: 'project',
          keywords: ['archive', 'project', project.name],
          run: archive,
        },
        {
          id: `project:${project.id}:delete`,
          title: `Delete project "${project.name}"`,
          group: 'project',
          keywords: ['delete', 'remove', 'project', project.name],
          run: remove,
        },
      ]
    : [];
  useRegisterCommands(commands);

  return (
    <li className="nx-rail-item">
      <NavLink className="nx-rail-row" to={`/p/${project.id}`}>
        {project.name}
      </NavLink>
      <Menu
        trigger={
          <Button variant="ghost" size="sm" aria-label={`${project.name} actions`}>
            ⋯
          </Button>
        }
        align="end"
      >
        <MenuItem disabled={!canMutate} onSelect={rename}>
          Rename
        </MenuItem>
        <MenuItem disabled={!canMutate} onSelect={archive}>
          Archive
        </MenuItem>
        <MenuItem kind="danger" disabled={!canMutate} onSelect={remove}>
          Delete
        </MenuItem>
      </Menu>
    </li>
  );
}

function ProjectRail({
  loading,
  error,
  onRetry,
  projects,
  onCreateProject,
  canMutateProjects = true,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
}: Omit<ShellProps, 'children'>) {
  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading projects" className="nx-stack">
        <Skeleton height="var(--nx-space-6)" />
        <Skeleton height="var(--nx-space-6)" />
        <Skeleton height="var(--nx-space-6)" />
      </div>
    );
  }

  if (error) {
    return (
      <Banner kind="danger" title="Couldn't load your projects">
        {error}
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </Banner>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="nx-stack">
        <p className="nx-muted">A project holds the boards, runs and files of one investigation.</p>
        <Button onClick={onCreateProject}>Create your first project</Button>
      </div>
    );
  }

  return (
    <div className="nx-stack">
      <ul className="nx-stack">
        {projects.map((project) => (
          <ProjectRailRow
            key={project.id}
            project={project}
            canMutate={canMutateProjects}
            {...(onRenameProject ? { onRename: onRenameProject } : {})}
            {...(onArchiveProject ? { onArchive: onArchiveProject } : {})}
            {...(onDeleteProject ? { onDelete: onDeleteProject } : {})}
          />
        ))}
      </ul>
      <Button variant="ghost" onClick={onCreateProject}>
        New project
      </Button>
    </div>
  );
}

function StatusBar() {
  const { counts, persistence } = useBoardStatus();
  return (
    <footer className="nx-statusbar">
      <span aria-live="polite">{persistence}</span>
      {counts === null ? (
        <span className="nx-muted">No board open</span>
      ) : (
        <>
          <span>
            {String(counts.nodes)} {counts.nodes === 1 ? 'node' : 'nodes'}
          </span>
          <span>
            {String(counts.edges)} {counts.edges === 1 ? 'connection' : 'connections'}
          </span>
        </>
      )}
    </footer>
  );
}

export function Shell({
  children,
  loading = false,
  error,
  onRetry,
  projects,
  onCreateProject,
  canMutateProjects,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  boardTitle = 'Untitled board',
  orgName = 'Personal',
  userName = 'Account',
  authEnabled = capabilities.auth,
}: ShellProps) {
  return (
    <div className="nx-app">
      <SkipToContent targetId="nx-main">Skip to content</SkipToContent>
      <header className="nx-topbar">
        <span className="nx-brand" data-testid="brand-lockup">
          <img
            className="nx-brand-mark"
            src={`${import.meta.env.BASE_URL}brand/raven-mark-64.png`}
            alt=""
            width={28}
            height={28}
            decoding="async"
          />
          {/* The product name is decorative next to the mark; the board title stays the h1. */}
          <span className="nx-brand-word">
            Raven <span className="nx-brand-word-soft">OSINT</span>
          </span>
        </span>
        <Menu trigger={<Button variant="ghost">{orgName}</Button>}>
          <MenuItem>{orgName}</MenuItem>
        </Menu>
        <h1 className="nx-topbar-title">{boardTitle}</h1>
        <div className="nx-topbar-spacer" />
        <Menu trigger={<Button variant="ghost">{userName}</Button>} align="end">
          <MenuItem>Settings</MenuItem>
          {authEnabled ? <MenuItem>Sign out</MenuItem> : null}
        </Menu>
      </header>

      <div className="nx-body">
        <nav className="nx-rail" aria-label="Projects">
          <ProjectRail
            {...{
              loading,
              error,
              onRetry,
              projects,
              onCreateProject,
              canMutateProjects,
              onRenameProject,
              onArchiveProject,
              onDeleteProject,
            }}
          />
        </nav>

        <main id="nx-main" className="nx-surface" tabIndex={-1}>
          {loading ? (
            <div className="nx-stack" aria-busy="true" aria-label="Loading board">
              <Skeleton height="var(--nx-space-9)" />
              <Skeleton height="var(--nx-space-9)" />
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      <StatusBar />

      <PluginNotices />
      <CommandPalette />
    </div>
  );
}
