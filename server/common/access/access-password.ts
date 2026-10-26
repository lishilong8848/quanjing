import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { parsePersonnelPasswordHash, verifyPersonnelPassword } from './personnel-password';
export function validAccessPasswordHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('pbkdf2_sha256$')) return parsePersonnelPasswordHash(value) !== null;
  const parts = value.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  return [parts[1], parts[2]].every((part, index) => /^[A-Za-z0-9+/]+={0,2}$/.test(part) && Buffer.from(part, 'base64').toString('base64') === part &&
    (index === 0 ? Buffer.from(part, 'base64').length >= 16 : Buffer.from(part, 'base64').length === 32));
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, (error, key) => error ? reject(error) : resolve(key)));
}
export async function createAccessPasswordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`;
}
export async function matchesAccessPassword(password: string, hash: string): Promise<boolean> {
  if (!validAccessPasswordHash(hash)) return false;
  if (hash.startsWith('pbkdf2_sha256$')) return verifyPersonnelPassword(password, hash);
  const [, salt, expected] = hash.split('$');
  return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64')), Buffer.from(expected, 'base64'));
}
