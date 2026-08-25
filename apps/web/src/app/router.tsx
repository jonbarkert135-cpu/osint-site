import { lazy, Suspense, type ReactElement } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
import { Skeleton, VisuallyHidden } from '@nexus/ui';
import { useSession } from '../lib/auth';
import { capabilities } from '../mode/appMode';
import { Shell } from './shell/Shell';
import { ShellContainer } from './shell/ShellContainer';

const LoginPage = lazy(() => import('./auth/LoginPage'));
const SignupPage = lazy(() => import('./auth/SignupPage'));
const ProjectPage = lazy(() => import('./pages/ProjectPage'));
const BoardPage = lazy(() => import('./pages/BoardPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SystemPage = lazy(() => import('../system/SystemPage'));

/**
 * Shown while a route chunk loads. It is a real landmark with a heading on purpose: the axe sweep
 * can catch this frame between `goto` and hydration, and a bare `aria-label`ed `div` is both an
 * `aria-prohibited-attr` violation and a page with no `main`/`h1` (e2e/a11y/axe-sweep.spec.ts).
 */
function RouteFallback() {
  return (
    <main className="nx-stack" aria-busy="true">
      <VisuallyHidden>
        <h1>Loading</h1>
      </VisuallyHidden>
      <div role="status">
        <VisuallyHidden>Loading</VisuallyHidden>
      </div>
      <Skeleton height="lg" />
      <Skeleton height="lg" />
      <Skeleton height="lg" />
    </main>
  );
}

/**
 * Renders the shell skeleton while the session resolves: no flash of unauthenticated UI.
 *
 * With `auth` disabled (APP_MODE=local) there is no session to resolve and no server to ask, so the
 * guard is not merely bypassed — `useSession()` is never called, which is what lets the local bundle
 * boot with the API unreachable.
 */
function RequireAuth({ children }: { children: ReactElement }) {
  if (!capabilities.auth) return children;
  return <RequireSession>{children}</RequireSession>;
}

function RequireSession({ children }: { children: ReactElement }) {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) return <Shell loading>{null}</Shell>;
  if (!session.data) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}

/**
 * Already signed in on an auth route → go where the user was headed. With auth disabled the auth
 * routes do not exist at all; `/login` becomes a normal unknown path and lands on the board.
 */
function RedirectIfAuthed({ children }: { children: ReactElement }) {
  const session = useSession();
  const [params] = useSearchParams();

  if (session.isPending) return <RouteFallback />;
  if (session.data) {
    const next = params.get('next');
    return <Navigate to={next && next.startsWith('/') ? next : '/'} replace />;
  }
  return children;
}

export function AppRoutes() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {capabilities.auth ? (
            <>
              <Route
                path="/login"
                element={
                  <RedirectIfAuthed>
                    <LoginPage />
                  </RedirectIfAuthed>
                }
              />
              <Route
                path="/signup"
                element={
                  <RedirectIfAuthed>
                    <SignupPage />
                  </RedirectIfAuthed>
                }
              />
            </>
          ) : null}
          <Route
            path="/"
            element={
              <RequireAuth>
                <ShellContainer>
                  <BoardPage />
                </ShellContainer>
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId"
            element={
              <RequireAuth>
                <ShellContainer>
                  <ProjectPage />
                </ShellContainer>
              </RequireAuth>
            }
          />
          <Route
            path="/b/:boardId"
            element={
              <RequireAuth>
                <ShellContainer>
                  <BoardPage />
                </ShellContainer>
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <ShellContainer>
                  <SettingsPage />
                </ShellContainer>
              </RequireAuth>
            }
          />
          <Route
            path="/system"
            element={
              <RequireAuth>
                <ShellContainer>
                  <SystemPage />
                </ShellContainer>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
