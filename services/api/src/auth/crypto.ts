import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const createToken = () => `rh_${randomBytes(32).toString('base64url')}`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
export const fingerprint = (value: unknown) =>
  tokenDigest(JSON.stringify(canonical(value)) ?? 'null');

function key(secret: string, purpose: string) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), purpose, 32));
}
export function seal(value: string, secret: string, purpose: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, purpose), nonce);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, ciphertext, cipher.getAuthTag()]
    .map((part) => part.toString('base64url'))
    .join('.');
}
export function unseal(value: string, secret: string, purpose: string): string {
  const parts = value.split('.');
  const [nonce, ciphertext, tag] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (
    parts.length !== 3 ||
    !nonce ||
    nonce.length !== 12 ||
    !ciphertext ||
    !tag ||
    tag.length !== 16
  )
    throw new Error('Invalid sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, purpose), nonce);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
