/**
 * The single read path for stored credentials (15_SECURITY.md §8.2). Two callers are allowed to
 * use it — runner scheduling and worker direct API calls — and both receive the plaintext through
 * `useCredential`, which zeroes the buffer as soon as the callback returns.
 *
 * There is deliberately no `getCredentialPlaintext()`: a function that hands out a string leaves an
 * unerasable copy on the heap, and it would be one refactor away from a tRPC response.
 */

import { prisma } from '@nexus/db';

import { CredentialCryptoError, masterKey, open } from './envelope.ts';

export interface CredentialRef {
  readonly orgId: string;
  readonly credentialId: string;
}

/** Selects by integration instead of by id, for callers that know "the GitHub key of this org". */
export interface CredentialLookup {
  readonly orgId: string;
  readonly integrationId: string;
  readonly projectId?: string | null;
}

interface SealedRow {
  id: string;
  encDek: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  keyVersion: number;
  expiresAt: Date | null;
}

const SEALED_SELECT = {
  id: true,
  encDek: true,
  nonce: true,
  ciphertext: true,
  keyVersion: true,
  expiresAt: true,
} as const;

async function loadById(ref: CredentialRef): Promise<SealedRow | null> {
  return await prisma.integrationCredential.findFirst({
    where: { id: ref.credentialId, orgId: ref.orgId },
    select: SEALED_SELECT,
  });
}

/**
 * Project-scoped credential first, org-wide second — the narrower grant wins, and an org-wide key
 * never overrides a key a project deliberately set for itself (N4).
 */
async function loadByIntegration(lookup: CredentialLookup): Promise<SealedRow | null> {
  const rows = (await prisma.integrationCredential.findMany({
    where: {
      orgId: lookup.orgId,
      integrationId: lookup.integrationId,
      ...(lookup.projectId === undefined || lookup.projectId === null
        ? { projectId: null }
        : { OR: [{ projectId: lookup.projectId }, { projectId: null }] }),
    },
    orderBy: [{ projectId: 'desc' }, { createdAt: 'desc' }],
    select: SEALED_SELECT,
    take: 1,
  })) as SealedRow[];
  return rows[0] ?? null;
}

async function decryptRow(row: SealedRow, orgId: string): Promise<Buffer> {
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    throw new CredentialCryptoError('That credential has expired. Store a new one to continue.');
  }
  const plaintext = open(row, { orgId, credentialId: row.id }, masterKey());
  await prisma.integrationCredential.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  });
  return plaintext;
}

/**
 * Run `use` with the decrypted secret and wipe it afterwards, whatever the callback does.
 * Returns undefined — without calling `use` — when the credential does not exist for this org,
 * so callers can degrade honestly instead of treating "missing" as "empty key" (U5).
 */
export async function useCredential<T>(
  target: CredentialRef | CredentialLookup,
  use: (secret: Buffer) => Promise<T> | T,
): Promise<T | undefined> {
  const row = 'credentialId' in target ? await loadById(target) : await loadByIntegration(target);
  if (row === null) return undefined;
  const plaintext = await decryptRow(row, target.orgId);
  try {
    return await use(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/** True when the org has a usable (non-expired) credential for an integration. */
export async function hasCredential(lookup: CredentialLookup): Promise<boolean> {
  const row = await loadByIntegration(lookup);
  return row !== null && (row.expiresAt === null || row.expiresAt.getTime() > Date.now());
}
