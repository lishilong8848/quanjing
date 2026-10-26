import type { Request, Response } from 'express';
import { clearAccessCookie, readStrictCookie, writeAccessCookie } from '../../server/common/access/unified-access.guard';

describe('access session cookie migration', () => {
  const session = { token: 'synthetic-session', principal: { role: 'editor' as const, purchaseBuilding: null },
    expiresAt: 2000, principalFingerprint: 'synthetic-fingerprint' };
  const request = (secure: boolean) => ({ secure, protocol: secure ? 'https' : 'http', headers: {}, socket: {} }) as Request;
  const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });
  it('expires the unpartitioned HTTPS predecessor before writing the partitioned session', () => {
    const res = response();
    writeAccessCookie(res as unknown as Response, request(true), 'vnet_access_session', session, 1000);
    expect(res.clearCookie).toHaveBeenCalledWith('vnet_access_session', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    expect(res.cookie).toHaveBeenCalledWith('vnet_access_session', session.token,
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'none', path: '/', partitioned: true }));
    expect(res.clearCookie.mock.invocationCallOrder[0]).toBeLessThan(res.cookie.mock.invocationCallOrder[0]);
  });
  it('clears both HTTPS storage variants when explicitly clearing the identity', () => {
    const res = response();
    clearAccessCookie(res as unknown as Response, request(true), 'vnet_access_session');
    expect(res.clearCookie.mock.calls).toEqual([
      ['vnet_access_session', { httpOnly: true, secure: true, sameSite: 'none', path: '/' }],
      ['vnet_access_session', { httpOnly: true, secure: true, sameSite: 'none', path: '/', partitioned: true }],
    ]);
    expect(res.cookie).toHaveBeenCalledWith('__Host-vnet_access_session', 'logged-out',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 1000 }));
  });
  it('preserves the non-TLS cookie policy without unrelated clearing writes', () => {
    const res = response();
    writeAccessCookie(res as unknown as Response, request(false), 'vnet_access_session', session, 1000);
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith('vnet_access_session', session.token,
      { httpOnly: true, sameSite: 'strict', path: '/', secure: false, expires: new Date(2000), maxAge: 1000 });
    clearAccessCookie(res as unknown as Response, request(false), 'vnet_access_session');
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
  });
  it.each(['vnet_access_session=old; vnet_access_session=new', 'vnet_access_session=new; vnet_access_session=old'])('still rejects ambiguous session cookies: %s', header => {
    expect(readStrictCookie(header, 'vnet_access_session')).toEqual({ present: true });
  });
});
