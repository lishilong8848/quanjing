import { normalizeProfessionalScope, canManageProfessionalRecord, professionalScopeIsValid } from '../../shared/professional-access';

describe('专业示例人员001范围', () => {
  const principal = { role: 'professional_admin' as const, purchaseBuilding: null, specialties: ['暖通'] as const };
  it('标准化去重且不把其他或标题猜成专业', () => {
    expect(normalizeProfessionalScope(['消防', 'EHS', '消防'])).toEqual(['消防', 'EHS']);
    expect(normalizeProfessionalScope('暖通')).toEqual(['暖通']);
    expect(normalizeProfessionalScope('暖通设备维修')).toEqual([]);
    expect(normalizeProfessionalScope('其他')).toEqual([]);
  });
  it('只允许本专业，未知和混合专业拒绝', () => {
    expect(canManageProfessionalRecord(principal, '暖通')).toBe(true);
    expect(canManageProfessionalRecord(principal, '电气')).toBe(false);
    expect(canManageProfessionalRecord(principal, undefined)).toBe(false);
    expect(canManageProfessionalRecord(principal, ['暖通', '电气'])).toBe(false);
  });
  it('严格验证授权范围，不能悄悄忽略错误项', () => {
    expect(professionalScopeIsValid(['暖通'])).toBe(true);
    expect(professionalScopeIsValid([])).toBe(false);
    expect(professionalScopeIsValid(['暖通', '*'])).toBe(false);
    expect(professionalScopeIsValid(['暖通', '暖通'])).toBe(false);
  });
});
