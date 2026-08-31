/** Integrations tab (Part 2 §55) and the discovery feed (§56) on screen. */

import type { DiscoveryFinding } from '@nexus/query-engine';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { IntegrationsCatalog } from './IntegrationsCatalog.tsx';

const finding = (over: Partial<DiscoveryFinding> = {}): DiscoveryFinding => ({
  candidate: {
    id: 'github:acme/finder',
    name: 'finder',
    version: '2.0.0',
    capability: 'profile-discovery',
    runtime: 'python',
    url: 'https://github.com/acme/finder',
    seenAt: '2026-08-01T00:00:00.000Z',
  },
  kind: 'alternative',
  replaces: 'sherlock',
  headline: 'A supported alternative to sherlock was found: finder.',
  actions: ['review', 'install', 'ignore'],
  ...over,
});

describe('IntegrationsCatalog', () => {
  it('lists the catalogue with a state per engine and filters by state', async () => {
    const user = userEvent.setup();
    render(<IntegrationsCatalog installed={new Set(['sherlock'])} />);

    expect(screen.getByTestId('catalog-sherlock')).toHaveTextContent('installed');
    const all = screen.getAllByRole('listitem').length;

    await user.click(screen.getByRole('button', { name: /^installed/ }));
    expect(screen.getAllByRole('listitem').length).toBeLessThan(all);
    expect(screen.getByTestId('catalog-sherlock')).toBeInTheDocument();
  });

  it('says no scan has run when nothing was discovered', () => {
    render(<IntegrationsCatalog installed={new Set()} />);

    expect(screen.getByTestId('discovery-empty')).toHaveTextContent('No tool scan has run');
  });

  it('offers Review, an inert Install and Ignore for a finding', async () => {
    const user = userEvent.setup();
    render(<IntegrationsCatalog installed={new Set()} findings={[finding()]} />);

    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      'https://github.com/acme/finder',
    );
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();

    await user.click(screen.getByTestId('discovery-ignore-github:acme/finder'));
    expect(screen.getByTestId('discovery-empty')).toHaveTextContent('has been ignored');
  });

  it('hides Install for a runtime this host cannot run', () => {
    render(
      <IntegrationsCatalog
        installed={new Set()}
        findings={[finding({ actions: ['review', 'ignore'] })]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('stops asking for credentials once the provider is configured', () => {
    const { rerender } = render(<IntegrationsCatalog installed={new Set()} />);
    const asking = screen.getAllByText(/Needs .* credentials\./);
    expect(asking.length).toBeGreaterThan(0);
    const provider = /Needs (.*) credentials\./.exec(asking[0]?.textContent ?? '')?.[1] ?? '';

    rerender(
      <IntegrationsCatalog installed={new Set()} configuredProviders={new Set([provider])} />,
    );
    expect(screen.getAllByText(/Needs .* credentials\./).length).toBeLessThan(asking.length);
  });
});
