import { resolveCurrentPersonnelDutyMembers } from '../../server/common/access/personnel-duty-current';

const appId = 'cli_source_synthetic';
const person = (suffix: string) => ({ personId: `local-external-${suffix.repeat(64)}`, recordId: `recPerson${suffix}`, openId: `ou_source_${suffix}`, name: `合成人员${suffix}` });
const route = (suffix = 'a', changes = {}) => ({ appId, dutyRecordId: 'recDuty', kind: 'warehouse_approver', buildings: ['C楼'], specialties: null,
  startsAt: 0, endsAt: null, version: 1, confirmedBatchId: 'eb761f03-468f-4a86-b971-1f074fa695cc', members: [person(suffix)], ...changes });
const state = (changes = {}) => ({ cardRules: { 'warehouse_responsible:C楼': { appId, code: 'warehouse_responsible', building: 'C楼', version: 1, members: [{ openId: 'ou_legacy', name: '旧配置人员' }] } },
  personnelDutyAssignments: { recDuty: route('b') }, personnelSource: { status: 'active', source: { appId, appToken: 'syntheticBase', tableId: 'tblPeople', dutyTableId: 'tblDuties' },
    directoryVersion: 'a'.repeat(64), activatedAt: Date.now(), lastSuccessAt: Date.now(), routes: { recDuty: route() }, pending: [], ...changes } });

describe('第四阶段正式源路由边界', () => {
  it('启用后只从统一来源读取，不让旧本地名单继续覆盖', () => {
    expect(resolveCurrentPersonnelDutyMembers(state() as never, appId, 'warehouse_approver', { building: 'C楼' })).toEqual([{ openId: 'ou_source_a', name: '合成人员a' }]);
  });
  it('已接管职责从源中缺失时拒绝，未接管职责保持原规则', () => {
    const value = state({ status: 'pending', pending: [{ dutyRecordId: 'recDuty', name: 'C楼岗位', reason: '职责已移除，请核对交接' }] });
    expect(() => resolveCurrentPersonnelDutyMembers(value as never, appId, 'warehouse_approver', { building: 'C楼' })).toThrow(/岗位|职责|交接/);
    expect(resolveCurrentPersonnelDutyMembers(state() as never, appId, 'warehouse_notify', { building: 'C楼' })).toBeNull();
    expect(resolveCurrentPersonnelDutyMembers(state() as never, appId, 'warehouse_approver', { building: 'A楼' })).toBeNull();
  });
  it('超过26小时未核对或跨应用拒绝新路由', () => {
    expect(() => resolveCurrentPersonnelDutyMembers(state({ lastSuccessAt: Date.now() - 26 * 3600_000 - 1 }) as never, appId, 'warehouse_approver', { building: 'C楼' })).toThrow();
    expect(() => resolveCurrentPersonnelDutyMembers(state() as never, 'cli_other', 'warehouse_approver', { building: 'C楼' })).toThrow();
  });
  it('待交接阻止原范围和新范围的办理，但不阻止其他职责', () => {
    const value = state({ status: 'pending', routes: { recDuty: route(), recSafe: route('b', { dutyRecordId: 'recSafe', buildings: ['B楼'] }) },
      pending: [{ dutyRecordId: 'recDuty', name: '合成C楼岗位', reason: '岗位人员已变化，请完成岗位交接', candidate: route('b', { buildings: ['A楼'] }) }] });
    for (const building of ['C楼', 'A楼']) expect(() => resolveCurrentPersonnelDutyMembers(value as never, appId, 'warehouse_approver', { building })).toThrow(/交接/);
    expect(resolveCurrentPersonnelDutyMembers(value as never, appId, 'warehouse_approver', { building: 'B楼' })).toEqual([{ openId: 'ou_source_b', name: '合成人员b' }]);
  });
  it('暂停不会恢复旧人员；读取失败在有效期内仍使用原确认路由', () => {
    expect(() => resolveCurrentPersonnelDutyMembers(state({ status: 'paused' }) as never, appId, 'warehouse_approver', { building: 'C楼' })).toThrow(/暂停/);
    expect(resolveCurrentPersonnelDutyMembers(state({ status: 'error', error: '来源暂不可用' }) as never, appId, 'warehouse_approver', { building: 'C楼' })).toEqual([{ openId: 'ou_source_a', name: '合成人员a' }]);
  });
  it('未启用继续保持第三阶段既有路由', () => {
    const { personnelSource: _unused, ...legacy } = state();
    expect(resolveCurrentPersonnelDutyMembers(legacy as never, appId, 'warehouse_approver', { building: 'C楼' })).toEqual([{ openId: 'ou_source_b', name: '合成人员b' }]);
  });
  it('混合范围不能丢弃未覆盖或无效楼栋后仅授予部分人员', () => {
    expect(() => resolveCurrentPersonnelDutyMembers(state() as never, appId, 'warehouse_approver', { building: ['C楼', 'A楼'] })).toThrow(/范围/);
    expect(() => resolveCurrentPersonnelDutyMembers(state() as never, appId, 'warehouse_approver', { building: ['C楼', 'invalid'] })).toThrow(/楼栋|范围/);
  });
});
