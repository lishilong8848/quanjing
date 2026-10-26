import { getCurrentCsrfToken } from '../../client/src/api/csrf-token';

const first = '__Host-suda-csrf-token';
const legacy = 'suda-csrf-token';
const fresh = 'a'.repeat(43), old = 'b'.repeat(43), stale = 'c'.repeat(43);
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
function state(cookie: string, fallback: unknown = stale) {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie } });
  const value = { csrfToken: fallback };
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
  return value;
}
afterEach(() => {
  for (const [name, descriptor] of [['document', originalDocument], ['window', originalWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

describe('current browser CSRF token', () => {
  it('prefers first-party over different legacy and window values and updates the SDK source', () => {
    const view = state(`${legacy}=${old}; ${first}=${fresh}`);
    expect(getCurrentCsrfToken()).toBe(fresh);
    expect(view.csrfToken).toBe(fresh);
  });
  it.each(['', '%E0%A4%A', 'not-a-token', `${fresh}%20`, `${fresh}; ${first}=${fresh}`])('fails closed on a present invalid/duplicate first-party value %s', value => {
    const view = state(`${first}=${value}; ${legacy}=${old}`);
    expect(getCurrentCsrfToken()).toBe('');
    expect(view.csrfToken).toBe('');
  });
  it('treats a missing equals sign as a malformed present first-party cookie', () => {
    const view = state(`${first}; ${legacy}=${old}`);
    expect(getCurrentCsrfToken()).toBe('');
    expect(view.csrfToken).toBe('');
  });
  it('uses a strict legacy cookie only when first-party is absent', () => {
    const view = state(`${legacy}=${old}`);
    expect(getCurrentCsrfToken()).toBe(old);
    expect(view.csrfToken).toBe(old);
  });
  it.each(['', '%E0%A4%A', 'invalid', `${old}; ${legacy}=${old}`])('does not restore stale window after an invalid legacy value %s', value => {
    const view = state(`${legacy}=${value}`);
    expect(getCurrentCsrfToken()).toBe('');
    expect(view.csrfToken).toBe('');
  });
  it('allows a valid server-seeded window value only while both cookies are absent', () => {
    state('theme=light');
    expect(getCurrentCsrfToken()).toBe(stale);
    const view = state('', 'not-valid');
    expect(getCurrentCsrfToken()).toBe('');
    expect(view.csrfToken).toBe('');
  });
  it('accepts the existing framework token format', () => {
    const framework = 'f'.repeat(40) + '-1234567890';
    state(`${first}=${framework}`);
    expect(getCurrentCsrfToken()).toBe(framework);
  });
  it('reads cookies again for every request after rotation', () => {
    const view = state(`${first}=${fresh}`);
    expect(getCurrentCsrfToken()).toBe(fresh);
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: `${first}=${old}` } });
    expect(getCurrentCsrfToken()).toBe(old);
    expect(view.csrfToken).toBe(old);
  });
});
