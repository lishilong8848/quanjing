import type { ProfessionalSpecialty } from '../../../shared/professional-access';

export const PROFESSIONAL_DEFAULTS: ReadonlyArray<{ name: string; openId: string; specialties: ProfessionalSpecialty[] }> = [
  { name: '示例人员006', openId: 'ou_33a6d4d900133eef61cd752407740274', specialties: ['电气'] },
  { name: '示例人员018', openId: 'ou_b6fda0276813fd816a3aeffda0c86f9b', specialties: ['暖通'] },
  { name: '示例人员011', openId: 'PUBLIC_EXAMPLE_FEISHU_ACCESS_INVENTORY_ADMIN_H_OPEN_IDS', specialties: ['弱电'] },
  { name: '示例人员021', openId: 'ou_d22c6190a18a9d6df49fa72565e120f7', specialties: ['消防', 'EHS'] },
  { name: '示例人员010', openId: 'PUBLIC_EXAMPLE_FEISHU_ACCESS_CONSTRUCTION_ADMIN_OPEN_IDS', specialties: ['消防', 'EHS'] },
];
