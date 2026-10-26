jest.mock('../../server/runtime-env', () => ({}));
jest.mock('../../server/app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('@lark-apaas/fullstack-nestjs-core', () => ({ configureApp: jest.fn() }));

import { FIRST_PARTY_CSRF_COOKIE_NAME as FIRST, createApiCsrfValidationMiddleware, createStandaloneCsrfSeedMiddleware } from '../../server/main';

describe('first-party CSRF compatibility', () => {
  const saved = { ...process.env };
  const token = 'a'.repeat(43);
  const other = 'b'.repeat(43);
  const legacy = 'suda-csrf-token';
  beforeEach(() => { delete process.env.LOCAL_ACCESS_COOKIE_SECURE; delete process.env.LOCAL_ACCESS_TRUST_PROXY; });
  afterEach(() => { process.env = { ...saved }; });
  function response() {
    const result = { locals: {}, cookie: jest.fn(), clearCookie: jest.fn(), status: jest.fn(), send: jest.fn() };
    result.status.mockReturnValue(result);
    return result;
  }
  function run(cookie: string, headerToken?: string, method = 'POST') {
    const request = { cookies: { [legacy]: other }, secure: true, method, path: '/protected',
      headers: { cookie, ...(headerToken === undefined ? {} : { 'x-suda-csrf-token': headerToken }) } };
    const res = response();
    const next = jest.fn();
    createStandaloneCsrfSeedMiddleware()(request as never, res as never, jest.fn());
    createApiCsrfValidationMiddleware()(request as never, res as never, next);
    return { request, res, next };
  }

  it.each([true, false])('seeds both HTTPS storage forms for HTML with standalone mode %s', standalone => {
    const request = { cookies: {}, headers: { cookie: '', accept: 'text/html' }, secure: true, method: 'GET' };
    const res = response();
    createStandaloneCsrfSeedMiddleware(standalone)(request as never, res as never, jest.fn());
    expect(res.cookie).toHaveBeenCalledTimes(2);
    const seeded = res.cookie.mock.calls[0][1];
    expect(res.cookie).toHaveBeenCalledWith(FIRST, seeded,
      { httpOnly: false, secure: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 });
    expect(res.cookie).toHaveBeenCalledWith(legacy, seeded, expect.objectContaining({ partitioned: true, sameSite: 'none' }));
  });

  it.each(['first-party', 'legacy iframe', 'both'])('accepts protected POST with %s storage', mode => {
    const cookie = [mode === 'legacy iframe' ? '' : `${FIRST}=${token}`, mode === 'first-party' ? '' : `${legacy}=${token}`].filter(Boolean).join('; ');
    const result = run(cookie, token);
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.request.cookies[legacy]).toBe(token);
    expect(result.res.status).not.toHaveBeenCalled();
  });

  it('requires the first-party value when legacy and first-party differ', () => {
    expect(run(`${FIRST}=${token}; ${legacy}=${other}`, token).next).toHaveBeenCalledTimes(1);
    expect(run(`${FIRST}=${token}; ${legacy}=${other}`, other).res.status).toHaveBeenCalledWith(403);
  });

  it.each(['', '%E0%A4%A', '"bad"', 'invalid', `${token}; ${FIRST}=${token}`])('rejects malformed/duplicate first-party on POST without falling back (%s)', value => {
    const result = run(`${FIRST}=${value}; ${legacy}=${token}`, token);
    expect(result.res.status).toHaveBeenCalledWith(403);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.res.cookie).not.toHaveBeenCalled();
  });

  it('rejects duplicate legacy cookies when first-party is absent', () => {
    expect(run(`${legacy}=${token}; ${legacy}=${token}`, token).res.status).toHaveBeenCalledWith(403);
  });

  it.each([undefined, other])('does not supply or replace a missing/mismatched POST header', sent => {
    const result = run(`${FIRST}=${token}`, sent);
    expect(result.res.status).toHaveBeenCalledWith(403);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.request.headers['x-suda-csrf-token']).toBe(sent);
  });

  it('does not allow parsed req.cookies to bypass an explicitly empty raw cookie header', () => {
    const result = run('', other);
    expect(result.res.status).toHaveBeenCalledWith(403);
    expect(result.next).not.toHaveBeenCalled();
  });

  it('keeps safe GET bridging while never bridging an unsafe request', () => {
    expect(run('', undefined, 'GET').next).toHaveBeenCalledTimes(1);
    expect(run('', undefined, 'POST').res.status).toHaveBeenCalledWith(403);
  });

  it.each([false, true])('writes first-party cookies behind a proxy only when trusted (%s)', trusted => {
    process.env.LOCAL_ACCESS_TRUST_PROXY = String(trusted);
    const request = { cookies: {}, headers: { cookie: '', accept: 'text/html', 'x-forwarded-proto': 'https' }, protocol: 'http', method: 'GET' };
    const res = response();
    createStandaloneCsrfSeedMiddleware()(request as never, res as never, jest.fn());
    expect(res.cookie.mock.calls.some(([name]) => name === FIRST)).toBe(trusted);
  });
});
