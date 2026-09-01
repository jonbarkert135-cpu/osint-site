/**
 * Envelope encryption for stored credentials (15_SECURITY.md §8.2).
 *
 * A per-record DEK (32 random bytes) encrypts the secret with AES-256-GCM; the KEK wraps the DEK.
 * The AAD binds a record to its org and id, so a ciphertext moved to another row — or another
 * organization — fails to open instead of decrypting into the wrong tenant.
 *
 * ponytail: the KEK is a 32-byte master key from the orchestrator's secret store
 * (`CREDENTIALS_MASTER_KEY`, base64). The spec's KMS-backed variant has the same interface
 * (`wrapDek`/`unwrapDek`), so swapping it later touches this file only.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Bumped when the wrapping scheme changes; stored per record so old rows stay readable. */
export const KEY_VERSION = 1;

const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const DEK_BYTES = 32;
const TAG_BYTES = 16;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

export interface SealedSecret {
  readonly encDek: Buffer;
  readonly nonce: Buffer;
  /** GCM ciphertext with its 16-byte auth tag appended. */
  readonly ciphertext: Buffer;
  readonly keyVersion: number;
  readonly fingerprint: string;
  readonly lastFour: string | null;
}

export interface SecretIdentity {
  readonly orgId: string;
  readonly credentialId: string;
}

/** `orgId|credentialId|version` — the exact AAD from §8.2. */
function aad(identity: SecretIdentity, keyVersion: number): Buffer {
  return Buffer.from(`${identity.orgId}|${identity.credentialId}|${String(keyVersion)}`, 'utf8');
}

/**
 * The master key, decoded once per call so a rotated env var is picked up on the next request
 * rather than at boot. Missing or wrong-sized keys are refused loudly: a silent fallback would
 * mean storing credentials under a key nobody controls.
 */
export function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CREDENTIALS_MASTER_KEY;
  if (raw === undefined || raw === '') {
    throw new CredentialCryptoError(
      'Credential storage is not configured: CREDENTIALS_MASTER_KEY is missing.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== DEK_BYTES) {
    throw new CredentialCryptoError(
      `CREDENTIALS_MASTER_KEY must decode to ${String(DEK_BYTES)} bytes, got ${String(key.byteLength)}.`,
    );
  }
  return key;
}

function wrapDek(dek: Buffer, kek: Buffer, identity: SecretIdentity): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, kek, nonce);
  cipher.setAAD(aad(identity, KEY_VERSION));
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  // The DEK nonce travels with the wrapped DEK; the record's `nonce` column belongs to the payload.
  return Buffer.concat([nonce, wrapped]);
}

function unwrapDek(
  encDek: Uint8Array,
  kek: Buffer,
  identity: SecretIdentity,
  keyVersion: number,
): Buffer {
  if (encDek.byteLength <= NONCE_BYTES + TAG_BYTES) {
    throw new CredentialCryptoError('Stored credential is malformed: wrapped key is too short.');
  }
  const nonce = encDek.subarray(0, NONCE_BYTES);
  const body = encDek.subarray(NONCE_BYTES, encDek.byteLength - TAG_BYTES);
  const tag = encDek.subarray(encDek.byteLength - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, kek, nonce);
  decipher.setAAD(aad(identity, keyVersion));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** sha256(plaintext) prefix — enough to answer "is this the same key?", useless as a key oracle. */
export function fingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 16);
}

/** Encrypt a secret for storage. The plaintext is never returned or logged from here. */
export function seal(plaintext: string, identity: SecretIdentity, kek: Buffer): SealedSecret {
  if (plaintext === '') {
    throw new CredentialCryptoError('An empty credential cannot be stored.');
  }
  const dek = randomBytes(DEK_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, dek, nonce);
  cipher.setAAD(aad(identity, KEY_VERSION));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed: SealedSecret = {
    encDek: wrapDek(dek, kek, identity),
    nonce,
    ciphertext,
    keyVersion: KEY_VERSION,
    fingerprint: fingerprint(plaintext),
    lastFour: plaintext.length >= 8 ? plaintext.slice(-4) : null,
  };
  dek.fill(0);
  return sealed;
}

/** Prisma hands `Bytes` back as `Uint8Array`, so the read path accepts the wider type. */
export interface SealedRecord {
  readonly encDek: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
}

/**
 * Decrypt into a Buffer the caller is expected to zero after use. Returning a Buffer rather than a
 * string keeps the plaintext out of the interned-string heap where it cannot be erased (§8.2).
 */
export function open(record: SealedRecord, identity: SecretIdentity, kek: Buffer): Buffer {
  if (record.ciphertext.byteLength <= TAG_BYTES) {
    throw new CredentialCryptoError('Stored credential is malformed: ciphertext is too short.');
  }
  const dek = unwrapDek(record.encDek, kek, identity, record.keyVersion);
  try {
    const body = record.ciphertext.subarray(0, record.ciphertext.byteLength - TAG_BYTES);
    const tag = record.ciphertext.subarray(record.ciphertext.byteLength - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, dek, record.nonce);
    decipher.setAAD(aad(identity, record.keyVersion));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}
