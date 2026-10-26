import { validCardRule } from '../../server/common/access/access-configuration.validation';
import { AUTHORITY_DUTY_CATALOG } from '@shared/personnel-authority.interface';
import type { CardRoleCode, CardRoleRule, ConfigurationPerson } from '@shared/access-configuration.interface';

const APP_ID = 'cli_synthetic_app';
const managerA: ConfigurationPerson = { openId: 'ou_synthetic_manager_a', name: '合成经理甲' };
const managerB: ConfigurationPerson = { openId: 'ou_synthetic_manager_b', name: '合成经理乙' };
const oldManager: ConfigurationPerson = { openId: 'ou_synthetic_manager_old', name: '合成经理原任' };
const executorA: ConfigurationPerson = { openId: 'ou_synthetic_executor_a', name: '合成执行甲' };
const executorB: ConfigurationPerson = { openId: 'ou_synthetic_executor_b', name: '合成执行乙' };

function rule(code: CardRoleCode, members: ConfigurationPerson[], building: CardRoleRule['building'] = null): CardRoleRule {
  return { appId: APP_ID, code, building, members, version: 1 };
}

describe('purchase_manager multiple members', () => {
  it('accepts two distinct purchase managers', () => {
    expect(validCardRule(rule('purchase_manager', [managerA, managerB]))).toBe(true);
  });

  it('still accepts a single purchase manager (old manager stays valid)', () => {
    expect(validCardRule(rule('purchase_manager', [oldManager]))).toBe(true);
  });

  it('rejects an empty purchase_manager entry', () => {
    expect(validCardRule(rule('purchase_manager', []))).toBe(false);
  });

  it('rejects duplicate purchase manager Open IDs', () => {
    expect(validCardRule(rule('purchase_manager', [managerA, { ...managerB, openId: managerA.openId }]))).toBe(false);
  });

  it('rejects purchase manager entries with an invalid Open ID', () => {
    expect(validCardRule(rule('purchase_manager', [managerA, { openId: 'synthetic-invalid-id', name: '合成经理丙' }]))).toBe(false);
  });

  it('rejects purchase manager entries with an invalid name', () => {
    expect(validCardRule(rule('purchase_manager', [managerA, { openId: 'ou_synthetic_manager_c', name: ' 合成经理丙 ' }]))).toBe(false);
  });

  it('keeps the existing member limit for purchase_manager', () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ openId: `ou_synthetic_bulk_${index}`, name: `合成批量${index}` }));
    expect(validCardRule(rule('purchase_manager', many.slice(0, 100)))).toBe(true);
    expect(validCardRule(rule('purchase_manager', many))).toBe(false);
  });

  it('keeps purchase_executor restricted to a single member', () => {
    expect(validCardRule(rule('purchase_executor', [executorA]))).toBe(true);
    expect(validCardRule(rule('purchase_executor', [executorA, executorB]))).toBe(false);
    expect(validCardRule(rule('purchase_executor', []))).toBe(false);
  });

  it('keeps building_executor restricted to a single member', () => {
    expect(validCardRule(rule('building_executor', [executorA], 'A楼'))).toBe(true);
    expect(validCardRule(rule('building_executor', [executorA, executorB], 'A楼'))).toBe(false);
    expect(validCardRule(rule('building_executor', [], 'A楼'))).toBe(false);
  });
});

describe('personnel authority catalog', () => {
  it('marks only purchase_manager as newly multi-holder among previously single-holder roles', () => {
    const multi = AUTHORITY_DUTY_CATALOG.filter(entry => entry.singleHolder === false).map(entry => entry.id);
    expect(multi).toContain('purchase_manager');
    expect(AUTHORITY_DUTY_CATALOG.find(entry => entry.id === 'purchase_manager')?.singleHolder).toBe(false);
    for (const id of ['purchase_executor', 'building_executor', 'building_supervisor', 'leave_supervisor', 'overtime_supervisor']) {
      expect(AUTHORITY_DUTY_CATALOG.find(entry => entry.id === id)?.singleHolder).toBe(true);
    }
  });
});
