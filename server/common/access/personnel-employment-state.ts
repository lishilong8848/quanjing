import { extractDisplayValues, pickField } from '../feishu/bitable-direct-read';

export type PersonnelAuthorizationState = 'active' | 'inactive' | 'unknown';

export function readPersonnelAuthorizationState(fields: Record<string, unknown>): PersonnelAuthorizationState {
  const value = pickField(fields, ['离职/异动情况']);
  // The checkbox revokes application permissions regardless of the personnel reason.
  if (value === true || value === 1) return 'inactive';
  if (value === false || value === 0) return 'active';
  const labels = extractDisplayValues(value).map(label => label.trim());
  const inactive = labels.some(label => ['true', '1', '是', '离职', '已离职', '异动', '已异动'].includes(label));
  const active = labels.some(label => ['false', '0', '否', '在职', '在岗'].includes(label));
  return inactive === active ? 'unknown' : inactive ? 'inactive' : 'active';
}
