import { Reflector } from '@nestjs/core';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PersonalPermissionRule } from '../../shared/business-permissions';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { SystemMonthlyReportController } from '../../server/modules/system-monthly-report/system-monthly-report.controller';

const ownSubject = { kind: 'person', person: { id: 'person_own', name: '本人甲', openId: 'ou_own' }, principalFingerprint: 'own-fixture' };
const actor: AccessPrincipal = { role: 'professional_engineer', purchaseBuilding: 'B楼', buildings: ['B楼'], specialties: ['电气'], accountId: `feishu-${'a'.repeat(64)}`, displayName: '本人甲' };
const rule = (module: PersonalPermissionRule['module'], effect: PersonalPermissionRule['effect'], actions: PersonalPermissionRule['actions']): PersonalPermissionRule => ({ id: `${module}-${effect}`, module, effect, actions, buildings: null, specialties: null });
const payload = { clientMutationId: 'release-monthly-fixture', room: 'B楼', stage: 'initial', reportYear: 2026, reportMonth: 10, currentRecordId: 'record_fixture' };
const file = { originalname: 'fixture.docx', mimetype: 'application/octet-stream', size: 1, buffer: Buffer.from('x') };

function fixture(principal: AccessPrincipal) {
  const service = { getDashboard: jest.fn().mockResolvedValue({}), acceptSubmission: jest.fn().mockReturnValue({ status: 'accepted' }), acceptSubmissionDeletion: jest.fn().mockReturnValue({ status: 'accepted' }) };
  const identity = { resolvePrincipal: jest.fn().mockResolvedValue(ownSubject), resolve: jest.fn().mockReturnValue({ ...ownSubject, person: { id: 'person_other', name: '他人乙' } }) };
  const controller = new SystemMonthlyReportController(service as never, identity as never);
  const guard = new UnifiedAccessGuard(new Reflector(), { cookieName: 'fixture', isAccessControlEnabled: () => true, renew: () => ({ principal: { ...principal }, principalFingerprint: 'release-fixture-fingerprint' }) } as never);
  const request: any = { method: 'POST', originalUrl: '', url: '', query: {}, headers: {}, protocol: 'http', cookies: { vnet_system_monthly_report_identity: 'other-cookie' } };
  const authorize = (operation: 'submitStage' | 'deleteStage') => {
    request.originalUrl = request.url = `/api/system-monthly-report/submissions${operation === 'deleteStage' ? '/delete' : ''}`;
    return guard.canActivate({ getClass: () => SystemMonthlyReportController, getHandler: () => SystemMonthlyReportController.prototype[operation], switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ cookie: jest.fn() }) }) } as never);
  };
  const perform = (operation: 'submitStage' | 'deleteStage') => operation === 'submitStage' ? controller.submitStage(request, JSON.stringify(payload), file) : controller.deleteStage(request, payload);
  const accepted = (operation: 'submitStage' | 'deleteStage') => operation === 'submitStage' ? service.acceptSubmission : service.acceptSubmissionDeletion;
  return { service, identity, request, authorize, perform, accepted };
}

describe('最终工程师规则与月报写入主体整合', () => {
  it.each(['submitStage', 'deleteStage'] as const)('工程师默认知识权限保留管理主体：%s', async operation => {
    const f = fixture(actor);
    expect(f.authorize(operation)).toBe(true);
    expect(f.request.accessPrincipal.permissionContext).toEqual({ module: 'system_reports', action: operation === 'submitStage' ? 'create' : 'delete' });
    await f.perform(operation);
    expect(f.accepted(operation)).toHaveBeenCalledWith(expect.anything(), ...(operation === 'submitStage' ? [expect.anything()] : []), expect.objectContaining({ kind: 'privileged', role: 'professional_engineer', principalFingerprint: 'release-fixture-fingerprint' }));
    expect(f.identity.resolvePrincipal).not.toHaveBeenCalled();
  });
  it.each(['submitStage', 'deleteStage'] as const)('个人限制经真实guard阻止持久受理：%s', operation => {
    const f = fixture({ ...actor, personalRules: [rule('system_reports', 'deny', ['create', 'delete'])] });
    expect(f.authorize(operation)).toBe(false);
    expect(f.accepted(operation)).not.toHaveBeenCalled();
  });
  it.each(['submitStage', 'deleteStage'] as const)('无关模块规则不把登录本人提升为月报管理主体：%s', async operation => {
    const f = fixture({ ...actor, role: 'purchase_applicant', personalRules: [rule('knowledge', 'allow', ['read'])] });
    expect(f.authorize(operation)).toBe(true);
    await f.perform(operation);
    expect(f.accepted(operation)).toHaveBeenCalledWith(expect.anything(), ...(operation === 'submitStage' ? [expect.anything()] : []), ownSubject);
    expect(f.identity.resolvePrincipal).toHaveBeenCalledWith(expect.objectContaining({ accountId: actor.accountId, permissionContext: { module: 'system_reports', action: operation === 'submitStage' ? 'create' : 'delete' } }), {}, 'other-cookie');
    expect(f.identity.resolve).not.toHaveBeenCalled();
  });
  it.each(['submitStage', 'deleteStage'] as const)('明确月报操作授权只按当前模块上下文生效：%s', async operation => {
    const f = fixture({ ...actor, role: 'purchase_applicant', personalRules: [rule('system_reports', 'allow', ['read', 'create', 'delete'])] });
    expect(f.authorize(operation)).toBe(true);
    await f.perform(operation);
    expect(f.accepted(operation)).toHaveBeenCalledWith(expect.anything(), ...(operation === 'submitStage' ? [expect.anything()] : []), expect.objectContaining({ kind: 'privileged', role: 'purchase_applicant' }));
    expect(f.identity.resolvePrincipal).not.toHaveBeenCalled();
  });
  it.each(['submitStage', 'deleteStage'] as const)('仅授予月报读取不能借本人提交端点写入：%s', operation => {
    const f = fixture({ ...actor, role: 'purchase_applicant', personalRules: [rule('system_reports', 'allow', ['read'])] });
    expect(f.authorize(operation)).toBe(false);
    expect(f.accepted(operation)).not.toHaveBeenCalled();
  });
});
