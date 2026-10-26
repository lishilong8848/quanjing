import type { InternalAxiosRequestConfig } from 'axios';

const FIRST_PARTY_CSRF_COOKIE = '__Host-suda-csrf-token';
const LEGACY_CSRF_COOKIE = 'suda-csrf-token';

function isCsrfToken(value: unknown): value is string {
  return typeof value === 'string' && (/^[A-Za-z0-9_-]{43}$/.test(value) || /^[a-f0-9]{40}-\d{10}$/.test(value));
}

function readCookie(name: string): { present: boolean; value: string } {
  const cookie = typeof document === 'undefined' ? '' : document.cookie;
  const matches = cookie.split(';').map(part => part.trim()).filter(part => part === name || part.startsWith(`${name}=`));
  if (matches.length !== 1) return { present: matches.length > 0, value: '' };
  try {
    const value = decodeURIComponent(matches[0].slice(name.length + 1));
    return { present: true, value: isCsrfToken(value) ? value : '' };
  } catch {
    return { present: true, value: '' };
  }
}

export function getCurrentCsrfToken(): string {
  const firstParty = readCookie(FIRST_PARTY_CSRF_COOKIE);
  const legacy = firstParty.present ? firstParty : readCookie(LEGACY_CSRF_COOKIE);
  const windowToken = typeof window === 'undefined' ? undefined : window.csrfToken;
  // A present but invalid cookie must never fall back to a stale token.
  const token = legacy.present ? legacy.value : isCsrfToken(windowToken) ? windowToken : '';
  if (typeof window !== 'undefined') window.csrfToken = token;
  return token;
}

export function applyCurrentCsrfToken(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const token = getCurrentCsrfToken();
  if (token) config.headers.set('X-Suda-Csrf-Token', token);
  else config.headers.delete('X-Suda-Csrf-Token');
  return config;
}
