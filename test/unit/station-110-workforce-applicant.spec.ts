import type { AccessPrincipal } from '../../shared/access-control.interface';
import { resolveSelfServiceApplicant } from '../../shared/self-service-applicant';
import { canSelectWorkforcePerson, resolveWorkforceRequestApplicant } from '../../shared/workforce-request-applicant';
import { assertStation110WorkforceIdentity, bindWorkforceRequestApplicant } from '../../server/common/access/workforce-request-applicant';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';

const appId = 'cli_station_fixture';
const principal: AccessPrincipal = { role: 'guest', purchaseBuilding: null,
  accountId: `feishu-${feishuIdentityFingerprint(appId, 'ou_station_shared')}`,
  displayName: '南通基地-110kV变电站值班' };
const station: BitableRecordItem = { record_id: 'recStation', fields: { 姓名: '站内人员甲', '机楼/专业': ['110站'],
  员工姓名: [{ id: 'ou_station_shared', name: principal.displayName }] } };
const other: BitableRecordItem = { record_id: 'recOther', fields: { 姓名: '其他楼人员', '机楼/专业': ['B楼'] } };

describe('110站公共账号申请边界', () => {
  it('请休假、差旅和加班使用可选择模式，其他业务继续本人绑定', () => {
    for (const action of ['提交请休假或差旅申请', '提交加班申请']) {
      expect(resolveWorkforceRequestApplicant(principal, true, action)).toEqual({ mode: 'manual' });
      expect(bindWorkforceRequestApplicant('站内人员甲', principal, true, action)).toBe('站内人员甲');
    }
    expect(resolveSelfServiceApplicant(principal, true, '提交变更申请')).toEqual({ mode: 'automatic', name: principal.displayName });
  });
  it('只展示110站候选，个人账号及管理员既有选择范围不变', () => {
    expect(canSelectWorkforcePerson(principal, ['110站'])).toBe(true);
    expect(canSelectWorkforcePerson(principal, ['B楼'])).toBe(false);
    expect(canSelectWorkforcePerson(principal, [])).toBe(false);
    expect(canSelectWorkforcePerson({ ...principal, displayName: '实名人员' }, ['B楼'])).toBe(true);
  });
  it('合法公共账号可以申请站内其他无个人飞书账号人员，仍使用真实人员记录', () => {
    const selected = { record_id: 'recStationOther', fields: { 姓名: '站内人员乙', '机楼/专业': ['110站'] } };
    expect(() => assertStation110WorkforceIdentity(principal, appId, [station, selected], selected)).not.toThrow();
  });
  it('即使伪造请求绕过下拉框，也不能选择其他楼栋人员', () => {
    expect(() => assertStation110WorkforceIdentity(principal, appId, [station, other], other)).toThrow('110站');
  });
  it('显示名相同但Open ID、应用或人员关联不符，不能获得权限', () => {
    for (const actor of [principal, { ...principal, accountId: `feishu-${'d'.repeat(64)}` }]) {
      expect(() => assertStation110WorkforceIdentity(actor, 'cli_other', [station], station)).toThrow('110站');
    }
    expect(() => assertStation110WorkforceIdentity(principal, appId, [], station)).toThrow('110站');
    const personal = { ...station, fields: { ...station.fields, 员工姓名: [{ id: 'ou_station_shared', name: '站内人员甲' }] } };
    expect(() => assertStation110WorkforceIdentity(principal, appId, [personal], personal)).toThrow('110站');
  });
  it('公共账号关联跨楼栋、离职人员、无记录身份均明确拒绝', () => {
    const cross = { ...other, fields: { ...other.fields, 员工姓名: station.fields.员工姓名 } };
    expect(() => assertStation110WorkforceIdentity(principal, appId, [station, cross], station)).toThrow('110站');
    const inactive = { ...station, fields: { ...station.fields, '离职/异动情况': '已离职' } };
    expect(() => assertStation110WorkforceIdentity(principal, appId, [station], inactive)).toThrow('110站');
    expect(() => assertStation110WorkforceIdentity(principal, appId, [station], { fields: station.fields })).toThrow('110站');
  });
  it('未登录不能申请，普通个人账号不可代他人申请', () => {
    expect(() => bindWorkforceRequestApplicant('站内人员甲', principal, false, '提交申请')).toThrow('请先登录');
    expect(() => bindWorkforceRequestApplicant('他人', { ...principal, displayName: '本人' }, true, '提交申请')).toThrow('当前登录本人');
  });
});
