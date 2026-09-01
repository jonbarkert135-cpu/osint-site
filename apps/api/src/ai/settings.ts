/**
 * Where an org's AI endpoint configuration lives (14_AI_AGENT.md §2.3, §2.5).
 *
 * The non-secret half (base URL, model names, on/off) is a `workspace_settings` row — org-scoped
 * JSON, editable by an admin at runtime, no deploy needed. The key half never lands here: it goes
 * to the credential store (`15_SECURITY.md` §8.2) under the `ai` integration id, so this module can
 * be read by anything without a secret ever passing through it.
 *
 * Env (`AI_BASE_URL`, `AI_API_KEY`, `AI_EMBED_MODEL`) stays as a fallback for self-hosters who
 * configure by file, but a saved org setting always wins — otherwise the settings screen would lie.
 */

import { prisma } from '@nexus/db';
import {
  DEFAULT_AI_SETTINGS,
  normalizeBaseUrl,
  parseAiSettings,
  type AiEndpointSettings,
} from '@nexus/ai';

import { loadServerEnvFromProcess } from '../env.ts';
import { hasCredential, useCredential } from '../secrets/decrypt.ts';

/** The integration id the AI endpoint key is stored under. */
export const AI_CREDENTIAL_INTEGRATION = 'ai';

export const AI_SETTINGS_KEY = 'ai';

export async function loadAiSettings(orgId: string): Promise<AiEndpointSettings> {
  const row = await prisma.workspaceSetting.findUnique({
    where: { orgId_key: { orgId, key: AI_SETTINGS_KEY } },
    select: { value: true },
  });
  return row === null ? DEFAULT_AI_SETTINGS : parseAiSettings(row.value);
}

export async function saveAiSettings(
  orgId: string,
  updatedBy: string,
  settings: AiEndpointSettings,
): Promise<AiEndpointSettings> {
  const value: AiEndpointSettings = {
    ...settings,
    baseUrl: settings.baseUrl === null ? null : normalizeBaseUrl(settings.baseUrl),
  };
  // Prisma's Json input wants an index signature; the row is exactly these four fields.
  const json = { ...value };
  await prisma.workspaceSetting.upsert({
    where: { orgId_key: { orgId, key: AI_SETTINGS_KEY } },
    create: { orgId, key: AI_SETTINGS_KEY, value: json, updatedBy },
    update: { value: json, updatedBy },
  });
  return value;
}

export interface ResolvedAiEndpoint {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly chatModel: string;
  readonly embedModel: string;
  /** True when a key is stored for this org; the key itself is never returned. */
  readonly hasKey: boolean;
  /** "org" when the row decides, "env" when the deployment does, "none" when nothing is set. */
  readonly source: 'org' | 'env' | 'none';
}

/**
 * The one place that answers "what endpoint should this org's AI calls use?". Org row first, env
 * second — and `configured` is false unless there is both an endpoint and someone turned it on.
 */
export async function resolveAiEndpoint(orgId: string): Promise<ResolvedAiEndpoint> {
  const settings = await loadAiSettings(orgId);
  const env = loadServerEnvFromProcess();
  const envBaseUrl =
    env.AI_PROVIDER === 'openai-compatible' && env.AI_BASE_URL !== undefined
      ? normalizeBaseUrl(env.AI_BASE_URL)
      : null;

  const fromOrg = settings.baseUrl !== null && settings.baseUrl !== '';
  const baseUrl = fromOrg ? settings.baseUrl : envBaseUrl;
  const source: ResolvedAiEndpoint['source'] = baseUrl === null ? 'none' : fromOrg ? 'org' : 'env';

  const stored = await hasCredential({ orgId, integrationId: AI_CREDENTIAL_INTEGRATION });
  return {
    configured: baseUrl !== null && (source === 'env' || settings.enabled),
    enabled: source === 'env' ? true : settings.enabled,
    baseUrl,
    chatModel: settings.chatModel,
    embedModel: settings.embedModel === '' ? env.AI_EMBED_MODEL : settings.embedModel,
    hasKey: stored || (source === 'env' && env.AI_API_KEY !== undefined),
    source,
  };
}

/**
 * Runs `use` with the org's AI key, or with `undefined` when there is none. The stored key is
 * decrypted for the duration of the callback only; the env key is used only when nothing is stored.
 */
export async function withAiKey<T>(
  orgId: string,
  use: (apiKey: string | undefined) => Promise<T>,
): Promise<T> {
  // Boxed, so a callback that legitimately returns undefined is not mistaken for "no key stored".
  const boxed = await useCredential(
    { orgId, integrationId: AI_CREDENTIAL_INTEGRATION },
    async (secret) => ({ value: await use(secret.toString('utf8')) }),
  );
  if (boxed !== undefined) return boxed.value;
  return await use(loadServerEnvFromProcess().AI_API_KEY);
}
