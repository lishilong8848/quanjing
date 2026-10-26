const NON_PERSONNEL_DUTY_STAFF_NAMES = new Set(['无需替班', '无须替班']);

export function normalizeDutyStaffDisplayName(value: unknown): string {
  const name = String(value || '').trim();
  if (!name) return '';

  const comparableName = name.replace(/\s+/g, '');
  return NON_PERSONNEL_DUTY_STAFF_NAMES.has(comparableName) ? '' : name;
}
