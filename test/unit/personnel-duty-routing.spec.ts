import { resolvePersonnelDutyMembers, validPersonnelDutyAssignments } from '../../server/common/access/personnel-duty-routing';
import type { PersonnelDutyAssignment } from '../../shared/personnel-duty-routing';
const appId = 'cli_synthetic_duty_routing';
const assignment = (changes: Partial<PersonnelDutyAssignment> = {}): PersonnelDutyAssignment => ({ appId, dutyRecordId: 'recDutyC', kind: 'warehouse_approver', buildings: ['C楼'], specialties: null,
  startsAt: 0, endsAt: null, version: 3, confirmedBatchId: 'eb761f03-468f-4a86-b971-1f074fa695cc',
  members: [{ personId: `local-external-${'a'.repeat(64)}`, recordId: 'recPersonA', openId: 'ou_current_a', name: '合成现任甲' }], ...changes });

describe('统一岗位人员解析', () => {
  it('无确认配置时允许调用方沿用原来源，已有明确配置按楼栋和职责隔离', () => {
    expect(resolvePersonnelDutyMembers(undefined, appId, 'warehouse_approver', { building: 'C楼' })).toBeNull();
    const routes = { recDutyC: assignment() };
    expect(validPersonnelDutyAssignments(routes)).toBe(true);
    expect(resolvePersonnelDutyMembers(routes, appId, 'warehouse_approver', { building: 'C楼' })).toEqual([{ openId: 'ou_current_a', name: '合成现任甲' }]);
    expect(resolvePersonnelDutyMembers(routes, appId, 'warehouse_approver', { building: 'A楼' })).toBeNull();
    expect(resolvePersonnelDutyMembers(routes, appId, 'warehouse_notify', { building: 'C楼' })).toBeNull();
  });
  it('同岗其他任职保留并按稳定ID去重，不改写其他角色身份', () => {
    const first = assignment(), second = assignment({ dutyRecordId: 'recDutySecond', members: [...first.members, { personId: `local-external-${'b'.repeat(64)}`, recordId: 'recPersonB', openId: 'ou_current_b', name: '合成现任乙' }] });
    const result = resolvePersonnelDutyMembers({ recDutyC: first, recDutySecond: second }, appId, 'warehouse_approver', { building: 'C楼' });
    expect(result?.map(person => person.openId)).toEqual(['ou_current_a', 'ou_current_b']);
    result![0].name = 'modified'; expect(first.members[0].name).toBe('合成现任甲');
  });
  it('专业与楼栋按每条职责的交集匹配，不把两条范围做笛卡尔积', () => {
    const routes = { recDutyC: assignment({ specialties: ['电气'] }), recDutyA: assignment({ dutyRecordId: 'recDutyA', buildings: ['A楼'], specialties: ['暖通'] }) };
    expect(resolvePersonnelDutyMembers(routes, appId, 'warehouse_approver', { building: 'C楼', specialty: '电气' })).toHaveLength(1);
    expect(resolvePersonnelDutyMembers(routes, appId, 'warehouse_approver', { building: 'C楼', specialty: '暖通' })).toBeNull();
    expect(() => resolvePersonnelDutyMembers(routes, appId, 'warehouse_approver', { building: 'C楼' })).toThrow('专业');
    expect(() => resolvePersonnelDutyMembers(routes, appId, 'warehouse_approver', {})).toThrow('楼栋');
  });
  it('配置损坏、跨应用和稳定身份冲突拒绝，不静默使用旧权限', () => {
    const foreign = { recDutyC: assignment({ appId: 'cli_foreign' }) }; expect(() => resolvePersonnelDutyMembers(foreign, appId, 'warehouse_approver', { building: 'C楼' })).toThrow();
    const invalid = { recDutyC: { ...assignment(), kind: 'admin' } }; expect(validPersonnelDutyAssignments(invalid)).toBe(false); expect(() => resolvePersonnelDutyMembers(invalid as never, appId, 'warehouse_approver', { building: 'C楼' })).toThrow();
    const first = assignment(), second = assignment({ dutyRecordId: 'recDutySecond', members: [{ ...first.members[0], recordId: 'recConflictingPerson' }] }); expect(validPersonnelDutyAssignments({ recDutyC: first, recDutySecond: second })).toBe(false);
  });
  it('确认后到期或明确清空岗位不复活旧来源，未知楼栋和专业不能扩大范围', () => {
    expect(resolvePersonnelDutyMembers({ recDutyC: assignment({ endsAt: 1000 }) }, appId, 'warehouse_approver', { building: 'C楼' }, 1001)).toEqual([]);
    expect(resolvePersonnelDutyMembers({ recDutyC: assignment({ members: [] }) }, appId, 'warehouse_approver', { building: 'C楼' })).toEqual([]);
    expect(() => resolvePersonnelDutyMembers({ recDutyC: assignment() }, appId, 'warehouse_approver', { building: '未知楼' })).toThrow();
  });
});
