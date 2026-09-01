/**
 * Settings → AI: the screen must show what is actually configured, never echo the key, and report
 * a failed probe with its reason instead of a generic error (14 §2.2, §2.5, U5).
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getQuery = vi.fn<(...args: never[]) => unknown>();
const updateMutate = vi.fn();
const setKeyMutate = vi.fn();
const clearKeyMutate = vi.fn();
const probeMutate = vi.fn();
const invalidate = vi.fn();
let probeOnSuccess: ((result: unknown) => void) | undefined;

const mutation = (mutate: ReturnType<typeof vi.fn>, isPending = false) => ({
  mutate,
  isPending,
  error: null,
});

vi.mock('../lib/trpc.tsx', () => ({
  trpc: {
    useUtils: () => ({ aiSettings: { get: { invalidate } } }),
    aiSettings: {
      get: { useQuery: (...a: never[]) => getQuery(...a) },
      update: { useMutation: () => mutation(updateMutate) },
      setKey: { useMutation: () => mutation(setKeyMutate) },
      clearKey: { useMutation: () => mutation(clearKeyMutate) },
      probe: {
        useMutation: (opts?: { onSuccess?: (result: unknown) => void }) => {
          probeOnSuccess = opts?.onSuccess;
          return mutation(probeMutate);
        },
      },
    },
  },
}));

const { AiSettingsSection } = await import('./AiSettingsSection.tsx');

const settings = (over: Record<string, unknown> = {}) => ({
  data: {
    settings: {
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'llama3.1:8b',
      embedModel: 'nomic-embed-text',
    },
    key: { present: false, lastFour: null, fingerprint: null },
    effective: {
      configured: true,
      baseUrl: 'http://localhost:11434/v1',
      embedModel: 'nomic-embed-text',
      source: 'org',
    },
    ...over,
  },
  isError: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  probeOnSuccess = undefined;
  getQuery.mockReturnValue(settings());
});

describe('AiSettingsSection', () => {
  it('shows the saved endpoint in the form', async () => {
    render(<AiSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:11434/v1');
    });
    expect(screen.getByLabelText('Chat model')).toHaveValue('llama3.1:8b');
    expect(screen.getByLabelText('Embedding model')).toHaveValue('nomic-embed-text');
  });

  it('explains that an unconfigured workspace has AI disabled', () => {
    getQuery.mockReturnValue(
      settings({
        settings: { enabled: false, baseUrl: null, chatModel: '', embedModel: '' },
        effective: { configured: false, baseUrl: null, embedModel: '', source: 'none' },
      }),
    );

    render(<AiSettingsSection />);

    expect(screen.getByText(/No endpoint yet/)).toBeInTheDocument();
  });

  it('says the endpoint comes from the deployment env when no org row exists', () => {
    getQuery.mockReturnValue(
      settings({
        settings: { enabled: false, baseUrl: null, chatModel: '', embedModel: '' },
        effective: {
          configured: true,
          baseUrl: 'http://env.local/v1',
          embedModel: 'embed-env',
          source: 'env',
        },
      }),
    );

    render(<AiSettingsSection />);

    expect(screen.getByText(/environment file/)).toBeInTheDocument();
  });

  it('tells a non-admin who to ask instead of showing an empty form', () => {
    getQuery.mockReturnValue({ data: undefined, isError: true });

    render(<AiSettingsSection />);

    expect(screen.getByText('AI settings are admin-only')).toBeInTheDocument();
  });

  it('saves an edited URL, sending null when the field is cleared', async () => {
    const user = userEvent.setup();
    render(<AiSettingsSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:11434/v1');
    });

    await user.clear(screen.getByLabelText('Base URL'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: null, chatModel: 'llama3.1:8b' }),
    );
  });

  it('probes the URL currently in the field, not only the saved one', async () => {
    const user = userEvent.setup();
    render(<AiSettingsSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:11434/v1');
    });

    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'http://other.local/v1');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(probeMutate).toHaveBeenCalledWith({ baseUrl: 'http://other.local/v1' });
  });

  it('lists the models a successful probe reported', async () => {
    const user = userEvent.setup();
    render(<AiSettingsSection />);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    act(() => {
      probeOnSuccess?.({ ok: true, models: ['llama3.1:8b', 'nomic-embed-text'] });
    });

    expect(await screen.findByText(/llama3.1:8b, nomic-embed-text/)).toBeInTheDocument();
  });

  it('shows the probe failure reason, not a generic error', async () => {
    const user = userEvent.setup();
    render(<AiSettingsSection />);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    act(() => {
      probeOnSuccess?.({
        ok: false,
        code: 'auth',
        message: 'The AI provider rejected the key. Check the key in Settings → AI.',
        models: [],
      });
    });

    expect(await screen.findByText(/rejected the key/)).toBeInTheDocument();
  });

  it('stores a key and never renders it back', async () => {
    const user = userEvent.setup();
    render(<AiSettingsSection />);

    await user.type(screen.getByLabelText('New key'), 'sk-secret-value');
    await user.click(screen.getByRole('button', { name: 'Store key' }));

    expect(setKeyMutate).toHaveBeenCalledWith({ secret: 'sk-secret-value' });
    expect(screen.queryByText('sk-secret-value')).toBeNull();
  });

  it('offers replace and remove once a key is stored, showing only its last four', async () => {
    const user = userEvent.setup();
    getQuery.mockReturnValue(
      settings({ key: { present: true, lastFour: '1234', fingerprint: 'abcd' } }),
    );

    render(<AiSettingsSection />);

    expect(screen.getByText(/ending in 1234/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(clearKeyMutate).toHaveBeenCalled();
  });

  it('keeps the store button disabled until a key is typed', () => {
    render(<AiSettingsSection />);
    expect(screen.getByRole('button', { name: 'Store key' })).toBeDisabled();
  });
});
