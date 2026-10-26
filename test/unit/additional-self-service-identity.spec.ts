import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
import { SystemMonthlyReportController } from '../../server/modules/system-monthly-report/system-monthly-report.controller';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { createHash } from 'node:crypto';
import { PurchaseApplicationService } from '../../server/modules/purchase-inventory/purchase-application.service';
import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { SystemMonthlyReportIdentityService } from '../../server/modules/system-monthly-report/system-monthly-report-identity.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

const accounts: AccessPrincipal[] = [
  { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: '本人甲' },
  { role: 'purchase_applicant', purchaseBuilding: 'H楼', accountId: 'local-external-' + 'b'.repeat(64), displayName: '本人甲' },
];
const own = { recordId: 'recOwn', openId: 'ou_own', name: '本人甲', building: 'H楼' };
const other = { recordId: 'recOther', openId: 'ou_other', name: '他人乙', building: 'H楼' };
const fingerprint = 'c'.repeat(43);
const request = (principal: AccessPrincipal) => ({ accessPrincipal: principal, accessRole: principal.role, accessPrincipalFingerprint: fingerprint, cookies: {} }) as any;

describe('采购、变更总结、月报复用登录本人', () => {
  it.each(accounts)('采购姓名查询只返回 $accountId 本人', async principal => {
    const resolveCurrentApplicant = jest.fn().mockResolvedValue(own);
    const controller = Object.assign(Object.create(PurchaseInventoryController.prototype), {
      accessPolicy: { assertRequestedBuilding: () => 'H楼', requireApplicantBuilding: () => 'H楼' },
      applicationService: { resolveCurrentApplicant, searchApplicants: jest.fn().mockResolvedValue([other, own]) },
    });
    expect(await controller.searchApplicants(request(principal), 'H楼', '他人乙', '30', 'true')).toEqual([own]);
    expect(resolveCurrentApplicant).toHaveBeenCalledWith(principal, 'H楼');
  });

  it('签收等普通人员搜索仍保留示例人员004员候选', async () => {
    const controller = Object.assign(Object.create(PurchaseInventoryController.prototype), {
      accessPolicy: { assertRequestedBuilding: () => 'H楼' },
      applicationService: { resolveCurrentApplicant: jest.fn().mockResolvedValue(own), searchApplicants: jest.fn().mockResolvedValue([other, own]) },
    });
    expect(await controller.searchApplicants(request(accounts[0]), 'H楼', '', '30')).toEqual([other, own]);
  });

  it.each(accounts)('采购不能从他人旧草稿提交 $accountId', async principal => {
    const accepted = jest.fn().mockReturnValue({ status: 'accepted' });
    const controller = Object.assign(Object.create(PurchaseInventoryController.prototype), {
      accessPolicy: { assertRequestedBuilding: () => 'H楼' },
      applicationService: { resolveCurrentApplicant: jest.fn().mockResolvedValue(own), findAcceptedApplication: accepted, acceptApplications: accepted },
    });
    const payload = JSON.stringify({ shared: { building: 'H楼', specialty: '其他', applicantRecordId: other.recordId, applicantOpenId: other.openId, applicantName: other.name }, items: [] });
    await expect(controller.submitApplications(request(principal), payload, [], 'purchase-fixture-123', 'c'.repeat(64))).rejects.toThrow('当前登录本人');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('变更总结拒绝改成其他提交人，并且不进入受理台账', async () => {
    const create = jest.fn();
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), { dutyScheduleService: { createChangeSummaryReport: create } });
    await expect(controller.createChangeSummaryReport({ submitterName: '他人乙' } as any, request(accounts[0]))).rejects.toThrow('当前登录本人');
    expect(create).not.toHaveBeenCalled();
  });

  it('变更总结空姓名自动补齐，并传递服务端稳定身份', async () => {
    const create = jest.fn().mockResolvedValue({ success: true });
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), { dutyScheduleService: { createChangeSummaryReport: create } });
    await controller.createChangeSummaryReport({ submitterName: '' } as any, request(accounts[0]));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ submitterName: '本人甲' }), fingerprint, accounts[0]);
  });

  it('月报忽略示例人员004员遗留 cookie，直接使用登录本人', async () => {
    const principal = { ...accounts[1], role: 'guest' } as AccessPrincipal;
    const subject = { kind: 'person', person: { id: 'person_own', name: '本人甲', openId: 'ou_own' }, principalFingerprint: 'own-fingerprint' };
    const identity = { resolvePrincipal: jest.fn().mockResolvedValue(subject), resolve: jest.fn().mockReturnValue({ ...subject, person: { id: 'person_other', name: '他人乙' } }) };
    const controller = new SystemMonthlyReportController({ getDashboard: jest.fn().mockResolvedValue({}) } as any, identity as any);
    const req = { ...request(principal), cookies: { vnet_system_monthly_report_identity: 'other-cookie' } };
    expect(await controller.getIdentitySession(req)).toMatchObject({ selected: true, person: { id: 'person_own', name: '本人甲' } });
  });

  it('月报登录后不能借人员选择接口切换为他人', async () => {
    const principal = { ...accounts[1], role: 'guest' } as AccessPrincipal;
    const identity = { resolvePrincipal: jest.fn().mockResolvedValue({ kind: 'person', person: { id: 'person_own', name: '本人甲' } }), select: jest.fn().mockReturnValue({ token: 'other', expiresAt: Date.now(), person: { id: 'person_other', name: '他人乙' } }) };
    const response = { cookie: jest.fn() };
    const controller = new SystemMonthlyReportController({ getDashboard: jest.fn().mockResolvedValue({}) } as any, identity as any);
    await expect(controller.selectIdentity(request(principal), response as any, { personId: 'person_other' })).rejects.toThrow('当前登录本人');
    expect(identity.select).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });
});

describe('同名人员按稳定身份匹配', () => {
  const source = { appId: 'cli_identity_fixture', appToken: 'fixtureAppToken', tableId: 'tblFixture' };
  const feishu: AccessPrincipal = { ...accounts[0], accountId: `feishu-${feishuIdentityFingerprint(source.appId, own.openId)}` };
  const external: AccessPrincipal = { ...accounts[1], accountId: `local-external-${createHash('sha256').update(JSON.stringify([source.appId, source.appToken, source.tableId, own.recordId])).digest('hex')}` };
  const dashboard = { rooms: [{ submitters: [own, { ...other, name: own.name }], leaders: [] }], schedule: [] } as any;
  const records = [own, { ...other, name: own.name }].map(person => ({ record_id: person.recordId, fields: { 姓名: person.name, 员工姓名: [{ id: person.openId, name: person.name }] } }));
  let originalAppId: string | undefined;
  beforeEach(() => { originalAppId = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = source.appId; });
  afterEach(() => { if (originalAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalAppId; });

  const purchase = (people = [own, { ...other, name: own.name }]) => Object.assign(Object.create(PurchaseApplicationService.prototype), {
    readActiveApplicants: jest.fn().mockResolvedValue(people), resolveApplicantSource: () => source,
    resolveApplicantAppToken: jest.fn().mockResolvedValue(source.appToken),
  });
  const monthly = () => new SystemMonthlyReportIdentityService({ resolve: () => null } as any, {
    loadLoginPersonnel: jest.fn().mockResolvedValue({ ...source, records }),
  } as any);

  it.each([feishu, external])('采购同名时仍匹配 $accountId 的人员 ID', async principal => {
    expect(await purchase().resolveCurrentApplicant(principal, 'H楼')).toEqual(own);
  });
  it('采购本人楼栋不符时明确拒绝', async () => {
    await expect(purchase().resolveCurrentApplicant(feishu, 'A楼')).rejects.toThrow('不属于申请楼栋');
    await expect(purchase().resolveCurrentApplicant(feishu, 'A楼')).rejects.toMatchObject({ status: 400 });
  });
  it('采购稳定身份重复时拒绝猜测', async () => {
    await expect(purchase([own, own]).resolveCurrentApplicant(feishu, 'H楼')).rejects.toThrow('未唯一匹配');
    await expect(purchase([own, own]).resolveCurrentApplicant(feishu, 'H楼')).rejects.toMatchObject({ status: 400 });
  });
  it.each([feishu, external])('月报同名时仍匹配 $accountId 本人', async principal => {
    expect(await monthly().resolvePrincipal(principal, dashboard)).toMatchObject({ kind: 'person', person: { openId: own.openId, name: own.name } });
  });
  it('月报人员范围没有本人时拒绝同名替代', async () => {
    await expect(monthly().resolvePrincipal(feishu, { rooms: [{ submitters: [{ ...other, name: own.name }], leaders: [] }], schedule: [] } as any)).rejects.toThrow('未唯一匹配');
    await expect(monthly().resolvePrincipal(feishu, { rooms: [], schedule: [] } as any)).rejects.toMatchObject({ status: 400 });
  });
  it('变更总结在持久受理前校验登录账号对应人员', async () => {
    const resolveLeaveRequestStaff = jest.fn().mockRejectedValue(new Error('稳定身份不匹配'));
    const enqueue = jest.fn();
    const service = Object.assign(Object.create(DutyScheduleService.prototype), { resolveLeaveRequestStaff, changeSummaryReportService: { enqueue } });
    await expect(service.createChangeSummaryReport({ submitterName: own.name } as any, fingerprint, feishu)).rejects.toThrow('稳定身份不匹配');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
