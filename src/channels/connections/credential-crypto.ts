import crypto from 'node:crypto';
import type { StoredCredential } from './contracts';

const ALGORITHM = 'aes-256-gcm';

function encryptionKey(): Buffer {
  const encoded = String(process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('channel_credential_encryption_key_invalid');
  }
  return key;
}

export function credentialKeyId(): string {
  return String(process.env.CHANNEL_CREDENTIAL_KEY_ID || 'v1').trim() || 'v1';
}

export function encryptCredential(credential: StoredCredential): string {
  if (!credential.accessToken?.trim()) throw new Error('channel_access_token_required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(credential), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCredential(envelope: string): StoredCredential {
  const [version, ivPart, tagPart, ciphertextPart] = String(envelope || '').split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error('channel_credential_envelope_invalid');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (!parsed?.accessToken || typeof parsed.accessToken !== 'string') {
    throw new Error('channel_credential_payload_invalid');
  }
  return parsed as StoredCredential;
}
