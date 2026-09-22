/**
 * Password encryption for stored accounts (AES-256-GCM, key derived from the
 * master key via scrypt). Works identically under Bun and Node.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const PREFIX = 'enc:v1:';

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LEN) as Buffer;
}

/** Encrypt a plaintext secret. Output: enc:v1:<salt>:<iv>:<tag>:<ciphertext> (hex). */
export function encryptSecret(plaintext: string, masterKey: string): string {
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(masterKey, salt);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** Decrypt a secret produced by encryptSecret. Returns null on failure (wrong key / tampered). */
export function decryptSecret(ciphertext: string, masterKey: string): string | null {
  if (!ciphertext.startsWith(PREFIX)) return ciphertext; // legacy plaintext
  try {
    const [, , saltHex, ivHex, tagHex, dataHex] = ciphertext.split(':');
    const salt = Buffer.from(saltHex!, 'hex');
    const iv = Buffer.from(ivHex!, 'hex');
    const tag = Buffer.from(tagHex!, 'hex');
    const data = Buffer.from(dataHex!, 'hex');
    const key = deriveKey(masterKey, salt);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Constant-time string comparison for keys. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
