import { createHash } from 'node:crypto';
import { join, parse } from 'node:path';

export interface ReadonlyCardTarget { name: string; openId: string }

/** Extra recipients are explicitly configured identities, never inferred from a role or a name. */
export function additionalReadonlyCardTargets(raw: string | undefined): ReadonlyCardTarget[] {
  if (!raw?.trim()) return [];
  if (raw.length > 8192) throw new Error('CARD_COPY_ADDITIONAL_TARGETS_INVALID');
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 10) throw new Error('CARD_COPY_ADDITIONAL_TARGETS_INVALID');
  const targets = new Map<string, ReadonlyCardTarget>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'name,openId' ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(row.name) ||
      typeof row.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(row.openId.trim())) {
      throw new Error('CARD_COPY_ADDITIONAL_TARGETS_INVALID');
    }
    const target = { name: row.name.trim(), openId: row.openId.trim() };
    if (targets.has(target.openId) && targets.get(target.openId)!.name !== target.name) throw new Error('CARD_COPY_ADDITIONAL_TARGETS_AMBIGUOUS');
    targets.set(target.openId, target);
  }
  return [...targets.values()];
}

/** Keep the original recipient's existing file byte-for-byte; each added person owns a separate ledger. */
export function additionalReadonlyCardLedger(base: string, appId: string, openId: string): string {
  const file = parse(base);
  const identity = createHash('sha256').update(`${appId}\0${openId}`).digest('hex');
  return join(file.dir, `${file.name}.${identity}${file.ext || '.json'}`);
}
