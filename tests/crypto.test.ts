import { describe, expect, it } from 'bun:test';
import { decryptSecret, encryptSecret, isEncrypted, safeEqual } from '../src/utils/crypto.js';

describe('crypto', () => {
  it('roundtrips a secret', () => {
    const enc = encryptSecret('my-password', 'master-key');
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc, 'master-key')).toBe('my-password');
  });

  it('returns null for a wrong key', () => {
    const enc = encryptSecret('my-password', 'master-key');
    expect(decryptSecret(enc, 'wrong-key')).toBeNull();
  });

  it('is idempotent for already-encrypted values', () => {
    const enc = encryptSecret('pw', 'k');
    expect(encryptSecret(enc, 'k')).toBe(enc);
  });

  it('passes legacy plaintext through', () => {
    expect(decryptSecret('plain', 'k')).toBe('plain');
  });

  it('safeEqual compares in constant time semantics', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});
