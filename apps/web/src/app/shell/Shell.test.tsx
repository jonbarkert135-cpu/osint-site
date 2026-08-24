import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WorkspaceProvider } from '../../data/workspace/context';
import { fakeWorkspaceRepository } from '../../data/workspace/testFakes';
import { Shell } from './Shell';

function renderShell(props: Partial<Parameters<typeof Shell>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WorkspaceProvider repository={fakeWorkspaceRepository()}>
          <Shell {...props}>
            <p>board</p>
          </Shell>
        </WorkspaceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Shell', () => {
  it('renders skeletons instead of a blank page while loading', () => {
    renderShell({ loading: true });
    expect(screen.getByLabelText('Loading projects')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading board')).toBeInTheDocument();
    expect(screen.queryByText('board')).not.toBeInTheDocument();
  });

  it('teaches the user what to do when there are no projects', () => {
    renderShell({ projects: [] });
    expect(screen.getByRole('button', { name: 'Create your first project' })).toBeInTheDocument();
  });

  it('shows the mapped error copy with a retry action', () => {
    renderShell({ error: 'The server took too long to answer.', onRetry: () => {} });
    expect(screen.getByText("Couldn't load your projects")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('puts skip-to-content first in tab order', () => {
    renderShell({ projects: [{ id: 'p1', name: 'Alpha' }] });
    const focusable = screen.getByRole('link', { name: /skip to content/i });
    expect(focusable).toBeInTheDocument();
  });

  it('shows the brand lockup with a decorative (non-announced) mark', () => {
    renderShell({ projects: [{ id: 'p1', name: 'Alpha' }], boardTitle: 'Case 12' });
    const lockup = screen.getByTestId('brand-lockup');
    expect(lockup).toHaveTextContent('Raven OSINT');
    // The mark is decorative: the board title stays the only heading in the chrome.
    expect(lockup.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.getByRole('heading', { name: 'Case 12' })).toBeInTheDocument();
  });
});
