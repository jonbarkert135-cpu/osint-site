import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CredentialCryptoError,
  KEY_VERSION,
  fingerprint,
  masterKey,
  open,
  seal,
} from '../src/secrets/envelope.ts';

const KEK = randomBytes(32);
const IDENTITY = { orgId: 'o1', credentialId: 'c1' };
const SECRET = 'ghp_averyrealisticlookingtoken';

describe('envelope encryption (15 §8.2)', () => {
  it('round-trips a secret and keeps the plaintext out of the stored bytes', () => {
    const sealed = seal(SECRET, IDENTITY, KEK);

    expect(sealed.keyVersion).toBe(KEY_VERSION);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('ghp_');
    expect(sealed.encDek.toString('utf8')).not.toContain('ghp_');
    expect(open(sealed, IDENTITY, KEK).toString('utf8')).toBe(SECRET);
  });

  it('exposes only a fingerprint and the last four characters for display', () => {
    const sealed = seal(SECRET, IDENTITY, KEK);

    expect(sealed.lastFour).toBe('oken');
    expect(sealed.fingerprint).toBe(fingerprint(SECRET));
    expect(sealed.fingerprint).toHaveLength(16);
    // A short secret would leak most of itself through `lastFour`, so it gets none.
    expect(seal('abc', IDENTITY, KEK).lastFour).toBeNull();
  });

  it('gives a different ciphertext for the same secret each time', () => {
    const a = seal(SECRET, IDENTITY, KEK);
    const b = seal(SECRET, IDENTITY, KEK);

    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.encDek.equals(b.encDek)).toBe(false);
    // …but the fingerprint still says "this is the same key".
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('refuses a ciphertext replayed into another organization or another row', () => {
    const sealed = seal(SECRET, IDENTITY, KEK);

    expect(() => open(sealed, { orgId: 'other-org', credentialId: 'c1' }, KEK)).toThrow();
    expect(() => open(sealed, { orgId: 'o1', credentialId: 'c2' }, KEK)).toThrow();
  });

  it('refuses tampered bytes and a wrong master key', () => {
    const sealed = seal(SECRET, IDENTITY, KEK);
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;

    expect(() => open(tampered, IDENTITY, KEK)).toThrow();
    expect(() => open(sealed, IDENTITY, randomBytes(32))).toThrow();
  });

  it('reports malformed records instead of throwing a crypto error', () => {
    const sealed = seal(SECRET, IDENTITY, KEK);

    expect(() => open({ ...sealed, ciphertext: Buffer.alloc(4) }, IDENTITY, KEK)).toThrow(
      CredentialCryptoError,
    );
    expect(() => open({ ...sealed, encDek: Buffer.alloc(4) }, IDENTITY, KEK)).toThrow(
      CredentialCryptoError,
    );
    expect(() => seal('', IDENTITY, KEK)).toThrow(CredentialCryptoError);
  });

  it('refuses to work without a correctly sized master key', () => {
    expect(() => masterKey({})).toThrow(/CREDENTIALS_MASTER_KEY is missing/);
    expect(() => masterKey({ CREDENTIALS_MASTER_KEY: '' })).toThrow(/missing/);
    expect(() =>
      masterKey({ CREDENTIALS_MASTER_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/must decode to 32 bytes/);
    expect(masterKey({ CREDENTIALS_MASTER_KEY: KEK.toString('base64') }).equals(KEK)).toBe(true);
  });
});
