import { PersonnelAccountController } from '../../server/common/access/personnel-account.controller';

describe('personal archive HTTP boundary', () => {
  const person = { role: 'guest', accountId: 'local-external-' + 'a'.repeat(64), authorizationVersion: 3, displayName: '合成人员', purchaseBuilding: null };
  let archive: any, access: any, configuration: any, controller: PersonnelAccountController;
  const request = (query = {}) => ({ headers: {}, query } as any);
  const response = () => { const res: any = { setHeader: jest.fn(), send: jest.fn(), status: jest.fn() }; res.status.mockReturnValue(res); return res; };
  beforeEach(() => {
    access = { cookieName: 'vnet_access_session', readSessionIdentity: jest.fn(() => ({ principal: person, expiresAt: Date.now() + 10000, principalFingerprint: 'synthetic' })) };
    configuration = { currentPrincipal: jest.fn(() => person) };
    archive = { read: jest.fn(async () => ({ status: 'ready', profile: { name: '合成人员' }, snapshotAt: '2026-10-29T00:00:00Z' })), photo: jest.fn(async () => ({ buffer: Buffer.from([137,80,78,71,13,10,26,10]), contentType: 'image/png' })) };
    controller = new PersonnelAccountController(access, configuration, {} as any, {} as any, archive);
  });
  it('lets an authenticated person with no business grants read only their own archive', async () => {
    expect(await controller.archive(request())).toMatchObject({ profile: { name: '合成人员' } });
    expect(archive.read).toHaveBeenCalledWith(person);
  });
  it.each(['recordId','accountId','name','file_token','url','scope'])('rejects the %s selector instead of allowing cross-person reads', async key => {
    expect(() => controller.archive(request({ [key]: 'other-person' }))).toThrow('当前登录人员');
    await expect(controller.archivePhoto(request({ [key]: 'other-person' }), response())).rejects.toThrow('当前登录人员');
    expect(archive.read).not.toHaveBeenCalled(); expect(archive.photo).not.toHaveBeenCalled();
  });
  it('does not admit anonymous, revoked or initial-password sessions', async () => {
    configuration.currentPrincipal.mockReturnValue(undefined);
    expect(() => controller.archive(request())).toThrow('请先登录');
    await expect(controller.archivePhoto(request(), response())).rejects.toThrow('请先登录');
    configuration.currentPrincipal.mockReturnValue(person);
    access.readSessionIdentity.mockReturnValue({ principal: { ...person, requiresPasswordChange: true }, expiresAt: Date.now() + 10000, principalFingerprint: 'synthetic' });
    expect(() => controller.archive(request())).toThrow('初始密码');
    expect(archive.read).not.toHaveBeenCalled(); expect(archive.photo).not.toHaveBeenCalled();
  });
  it('preserves the impersonation target for read-only archive resolution', async () => {
    const target = { ...person, impersonation: { actorAccountId: 'admin', targetName: '合成人员', actorName: '管理员', expiresAt: Date.now()+10000 } };
    access.readSessionIdentity.mockReturnValue({ principal: target, expiresAt: Date.now()+10000, principalFingerprint: 'synthetic-target' });
    await controller.archive(request()); expect(archive.read).toHaveBeenCalledWith(target);
  });
  it('serves only the resolved photo with private non-storing headers', async () => {
    const res = response(); await controller.archivePhoto(request(), res);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control','private, no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Vary','Cookie');
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options','nosniff');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type','image/png');
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    expect(archive.photo).toHaveBeenCalledWith(person);
  });
  it('handles missing photos without a broken JSON payload or cached replacement', async () => {
    archive.photo.mockResolvedValue(null);
    const res = response(); await controller.archivePhoto(request(), res);
    expect(res.status).toHaveBeenCalledWith(404); expect(res.send).toHaveBeenCalledWith('暂无个人照片');
  });
});
