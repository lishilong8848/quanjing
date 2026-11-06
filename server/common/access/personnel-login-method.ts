export type PersonnelLoginMethod = 'feishu' | 'password' | 'unknown';

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const DUTY_LABEL = '值班账号';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A multi-select must never become one invented account nature by concatenation. */
function singleText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts = value.map(item => singleTextItem(item));
    if (parts.some(part => part === null)) return null;
    const values = [...new Set(parts.filter((part): part is string => !!part))];
    return values.length <= 1 ? values[0] || '' : null;
  }
  return singleTextItem(value);
}

function singleTextItem(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (!object(value)) return null;
  const keys = ['text', 'name'].filter(key => Object.hasOwn(value, key));
  if (!keys.length || keys.some(key => typeof value[key] !== 'string')) return null;
  const values = [...new Set(keys.map(key => (value[key] as string).trim()).filter(Boolean))];
  return values.length <= 1 ? values[0] || '' : null;
}

function hasTrustedDutyIdentity(fields: Readonly<Record<string, unknown>>, trusted: ReadonlySet<string>): boolean {
  const matches = (value: unknown) => typeof value === 'string' && OPEN_ID.test(value.trim()) && trusted.has(value.trim());
  for (const key of ['员工姓名', '员工', '人员']) {
    const value = fields[key];
    const users = Array.isArray(value) ? value : [value];
    if (users.some(user => object(user) && ['id', 'open_id', 'openId'].some(name => matches(user[name])))) return true;
  }
  return ['飞书 open_id', 'open_id', 'Open ID'].some(key => matches(singleText(fields[key])));
}

/** Classification only: this grants no login, account status, or business authority. */
export function resolvePersonnelLoginMethod(
  fields: Readonly<Record<string, unknown>> | null | undefined,
  trustedDutyOpenIds: ReadonlySet<string> = new Set(),
): PersonnelLoginMethod {
  if (!object(fields)) return 'unknown';
  if (singleText(fields.人员类型) === DUTY_LABEL || singleText(fields.岗位) === DUTY_LABEL ||
    hasTrustedDutyIdentity(fields, trustedDutyOpenIds)) return 'feishu';
  const nature = singleText(fields.账号性质);
  if (!nature) return 'unknown';
  return nature.toUpperCase() === 'VNET' ? 'feishu' : 'password';
}
