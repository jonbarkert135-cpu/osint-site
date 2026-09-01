/**
 * Settings → AI (14_AI_AGENT.md §2.1–2.5).
 *
 * Raven ships no key and no default endpoint, so this screen is the entire configuration story:
 * point Raven at an OpenAI-compatible `/v1` (Ollama on localhost, LM Studio, a gateway), optionally
 * store a key, and test it. "Test connection" is a real `GET /v1/models` call, and its failure is
 * shown with the reason — a wrong URL, a rejected key and an unreachable host are three different
 * fixes (U5). The key is write-only: it goes out once and only its last four characters come back.
 */

import { useEffect, useState } from 'react';
import { Banner, Button, Field } from '@nexus/ui';

import { trpc } from '../lib/trpc.tsx';

export interface AiSettingsFormState {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  embedModel: string;
}

const SOURCE_NOTE: Record<string, string> = {
  env: 'Currently taken from this deployment’s environment file. Saving here overrides it.',
  org: 'Configured for this workspace.',
  none: 'No endpoint yet. AI features stay visible but disabled until one answers.',
};

export function AiSettingsSection() {
  const utils = trpc.useUtils();
  const query = trpc.aiSettings.get.useQuery(undefined, { retry: false });
  const [form, setForm] = useState<AiSettingsFormState | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [probe, setProbe] = useState<
    { ok: true; models: readonly string[] } | { ok: false; message: string } | null
  >(null);
  const [saved, setSaved] = useState(false);

  const data = query.data;
  useEffect(() => {
    if (data === undefined) return;
    setForm({
      enabled: data.settings.enabled,
      baseUrl: data.settings.baseUrl ?? '',
      chatModel: data.settings.chatModel,
      embedModel: data.settings.embedModel,
    });
  }, [data]);

  const invalidate = async () => {
    await utils.aiSettings.get.invalidate();
  };

  const update = trpc.aiSettings.update.useMutation({
    onSuccess: async () => {
      setSaved(true);
      await invalidate();
    },
  });
  const setKey = trpc.aiSettings.setKey.useMutation({
    onSuccess: async () => {
      setKeyDraft('');
      await invalidate();
    },
  });
  const clearKey = trpc.aiSettings.clearKey.useMutation({ onSuccess: invalidate });
  const testConnection = trpc.aiSettings.probe.useMutation({
    onSuccess: (result) => {
      setProbe(
        result.ok ? { ok: true, models: result.models } : { ok: false, message: result.message },
      );
    },
  });

  if (query.isError) {
    return (
      <Banner kind="warn" title="AI settings are admin-only">
        Ask a workspace admin to configure the AI endpoint.
      </Banner>
    );
  }
  if (data === undefined || form === null) return <p className="nx-muted">Loading AI settings…</p>;

  const set = (patch: Partial<AiSettingsFormState>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };

  return (
    <section className="nx-stack" aria-labelledby="ai-settings-heading">
      <h3 id="ai-settings-heading">AI endpoint</h3>
      <p className="nx-muted">
        Raven talks to one OpenAI-compatible endpoint that you choose — a local runtime such as
        Ollama on <code>http://localhost:11434/v1</code> keeps every request on this machine.{' '}
        {SOURCE_NOTE[data.effective.source] ?? ''}
      </p>

      <Field
        label="Base URL"
        placeholder="http://localhost:11434/v1"
        value={form.baseUrl}
        onChange={(event) => {
          set({ baseUrl: event.target.value });
        }}
        description="Must end in /v1 for most servers. Leave empty to forget the endpoint."
      />
      <Field
        label="Chat model"
        placeholder="llama3.1:8b"
        value={form.chatModel}
        onChange={(event) => {
          set({ chatModel: event.target.value });
        }}
      />
      <Field
        label="Embedding model"
        placeholder="nomic-embed-text"
        value={form.embedModel}
        onChange={(event) => {
          set({ embedModel: event.target.value });
        }}
        description="Used for semantic search. Without it, search stays keyword-only."
      />

      <label className="nx-field-label">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => {
            set({ enabled: event.target.checked });
          }}
        />{' '}
        Enable AI features for this workspace
      </label>

      <div className="nx-row">
        <Button
          onClick={() => {
            update.mutate({
              enabled: form.enabled,
              baseUrl: form.baseUrl.trim() === '' ? null : form.baseUrl.trim(),
              chatModel: form.chatModel,
              embedModel: form.embedModel,
            });
          }}
          disabled={update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setProbe(null);
            const baseUrl = form.baseUrl.trim();
            testConnection.mutate(baseUrl === '' ? {} : { baseUrl });
          }}
          disabled={testConnection.isPending}
        >
          {testConnection.isPending ? 'Testing…' : 'Test connection'}
        </Button>
      </div>

      {update.error ? (
        <Banner kind="danger" title="That change was not saved">
          {update.error.message}
        </Banner>
      ) : null}
      {saved && !update.isPending ? (
        <Banner kind="success" title="AI settings saved">
          New runs use this endpoint immediately.
        </Banner>
      ) : null}
      {probe?.ok === true ? (
        <Banner kind="success" title="The endpoint answered">
          {probe.models.length === 0
            ? 'It reports no models yet — pull one on the server, then test again.'
            : `Models available: ${probe.models.slice(0, 12).join(', ')}`}
        </Banner>
      ) : null}
      {probe?.ok === false ? (
        <Banner kind="danger" title="The endpoint did not answer">
          {probe.message}
        </Banner>
      ) : null}

      <h3>API key</h3>
      <p className="nx-muted">
        {data.key.present
          ? `A key ending in ${data.key.lastFour ?? '••••'} is stored, encrypted. It is never shown again.`
          : 'No key stored. Local runtimes usually need none; hosted gateways do.'}
      </p>
      <Field
        label="New key"
        type="password"
        autoComplete="off"
        placeholder="sk-…"
        value={keyDraft}
        onChange={(event) => {
          setKeyDraft(event.target.value);
        }}
      />
      <div className="nx-row">
        <Button
          onClick={() => {
            setKey.mutate({ secret: keyDraft });
          }}
          disabled={keyDraft.trim() === '' || setKey.isPending}
        >
          {data.key.present ? 'Replace key' : 'Store key'}
        </Button>
        {data.key.present ? (
          <Button
            variant="ghost"
            onClick={() => {
              clearKey.mutate();
            }}
            disabled={clearKey.isPending}
          >
            Remove key
          </Button>
        ) : null}
      </div>
    </section>
  );
}
