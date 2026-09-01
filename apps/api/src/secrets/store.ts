/**
 * Credential storage (15_SECURITY.md §8.2). Write-only by construction: nothing here returns a
 * plaintext — that lives in `decrypt.ts`, the single read path.
 *
 * Every query is org-scoped, so a credential id from another tenant simply does not exist.
 */

import { prisma } from '@nexus/db';
import { newId } from '@nexus/domain';

import { masterKey, seal } from './envelope.ts';

export interface CredentialSummary {
  readonly id: string;
  readonly integrationId: string;
  readonly projectId: string | null;
  readonly label: string;
  readonly fingerprint: string;
  readonly lastFour: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date | null;
}

interface CredentialRow {
  id: string;
  integrationId: string;
  projectId: string | null;
  label: string;
  fingerprint: string;
  lastFour: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  expiresAt: Date | null;
}

const summary = (row: CredentialRow): CredentialSummary => ({
  id: row.id,
  integrationId: row.integrationId,
  projectId: row.projectId,
  label: row.label,
  fingerprint: row.fingerprint,
  lastFour: row.lastFour,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  rotatedAt: row.rotatedAt,
  expiresAt: row.expiresAt,
});

/** Columns safe to return anywhere: no ciphertext, no wrapped key. */
const SAFE_SELECT = {
  id: true,
  integrationId: true,
  projectId: true,
  label: true,
  fingerprint: true,
  lastFour: true,
  createdAt: true,
  lastUsedAt: true,
  rotatedAt: true,
  expiresAt: true,
} as const;

export async function listCredentials(
  orgId: string,
  integrationId?: string,
): Promise<CredentialSummary[]> {
  const rows = (await prisma.integrationCredential.findMany({
    where: { orgId, ...(integrationId === undefined ? {} : { integrationId }) },
    orderBy: { createdAt: 'desc' },
    select: SAFE_SELECT,
    take: 200,
  })) as CredentialRow[];
  return rows.map(summary);
}

export interface CreateCredentialInput {
  readonly orgId: string;
  readonly createdBy: string;
  readonly integrationId: string;
  readonly projectId?: string | null;
  readonly label: string;
  readonly secret: string;
  readonly expiresAt?: Date | null;
}

/** Store a new credential. The id is minted first because it is part of the AAD. */
export async function createCredential(input: CreateCredentialInput): Promise<CredentialSummary> {
  const id = newId.credential();
  const sealed = seal(input.secret, { orgId: input.orgId, credentialId: id }, masterKey());
  const row = await prisma.integrationCredential.create({
    data: {
      id,
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      integrationId: input.integrationId,
      label: input.label,
      encDek: sealed.encDek,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      fingerprint: sealed.fingerprint,
      lastFour: sealed.lastFour,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    },
    select: SAFE_SELECT,
  });
  return summary(row);
}

/**
 * Replace the secret of an existing credential, keeping its id — so anything referencing the
 * credential keeps working across a rotation. Returns undefined when the org has no such record.
 */
export async function rotateCredential(
  orgId: string,
  credentialId: string,
  secret: string,
): Promise<CredentialSummary | undefined> {
  const existing = await prisma.integrationCredential.findFirst({
    where: { id: credentialId, orgId },
    select: { id: true },
  });
  if (existing === null) return undefined;
  const sealed = seal(secret, { orgId, credentialId }, masterKey());
  const row = await prisma.integrationCredential.update({
    where: { id: credentialId },
    data: {
      encDek: sealed.encDek,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      fingerprint: sealed.fingerprint,
      lastFour: sealed.lastFour,
      rotatedAt: new Date(),
    },
    select: SAFE_SELECT,
  });
  return summary(row);
}

/** True when a row was deleted; false when the org has no such credential. */
export async function deleteCredential(orgId: string, credentialId: string): Promise<boolean> {
  const { count } = await prisma.integrationCredential.deleteMany({
    where: { id: credentialId, orgId },
  });
  return count > 0;
}
