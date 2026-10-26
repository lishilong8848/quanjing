import { pbkdf2, timingSafeEqual } from 'node:crypto';

function decode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(standard, 'base64');
  return bytes.toString('base64') === standard ? bytes : null;
}

export function parsePersonnelPasswordHash(value: unknown): { salt: Buffer; derived: Buffer } | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const parts = value.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256' || parts[1] !== '600000') return null;
  const salt = decode(parts[2]), derived = decode(parts[3]);
  return salt?.length === 16 && derived?.length === 32 ? { salt, derived } : null;
}

export async function verifyPersonnelPassword(password: unknown, stored: unknown): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 256 ||
    Array.from(password).length < 1 || Array.from(password).length > 128 ||
    Buffer.from(password, 'utf8').toString('utf8') !== password) return false;
  const parsed = parsePersonnelPasswordHash(stored);
  if (!parsed) return false;
  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      pbkdf2(password, parsed.salt, 600000, 32, 'sha256', (error, key) => error ? reject(error) : resolve(key));
    });
    return timingSafeEqual(actual, parsed.derived);
  } catch { return false; }
}
