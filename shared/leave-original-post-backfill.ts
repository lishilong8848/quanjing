import { createLeaveRequestShiftGroups, parseShanghaiLocalDateTime, type LeaveRequestShiftGroup } from './leave-request-impact';

export interface LeaveOriginalPostBackfill {
  group: LeaveRequestShiftGroup;
  substitutePersonRecordId: string;
  substituteName: string;
  substituteOpenId: string;
}

export interface OriginalPostBackfillMetadata {
  originalPostBackfills?: LeaveOriginalPostBackfill[];
  backfillPersonRecordId?: string;
  originalPostSignature?: string;
}

export function readOriginalPostBackfillMetadata(value: unknown): OriginalPostBackfillMetadata {
  const text = Array.isArray(value)
    ? value.map((item) => {
        if (!item || typeof item.text !== 'string') throw new Error('原岗补位字段格式无效');
        return item.text;
      }).join('')
    : value;
  if (text === undefined || text === null || text === '') return {};
  if (typeof text !== 'string' || text.length > 64 * 1024) throw new Error('原岗补位字段格式无效');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('原岗补位字段内容无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1) throw new Error('原岗补位字段版本无效');
  return normalizeMetadata(parsed as OriginalPostBackfillMetadata);
}

export function writeOriginalPostBackfillMetadata(value: OriginalPostBackfillMetadata): string {
  const normalized = normalizeMetadata(value);
  return normalized.originalPostBackfills?.length ? JSON.stringify({ version: 1, ...normalized }) : '';
}

function normalizeMetadata(value: OriginalPostBackfillMetadata): OriginalPostBackfillMetadata {
  const rows = value.originalPostBackfills || [];
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('原岗补位数量无效');
  if (!rows.length) {
    if (value.backfillPersonRecordId || value.originalPostSignature) throw new Error('原岗补位安排不完整');
    return {};
  }
  const backfillPersonRecordId = recordId(value.backfillPersonRecordId);
  const signature = value.originalPostSignature;
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/u.test(signature)) throw new Error('原岗补位签名无效');
  const originalPostBackfills = rows.map((row): LeaveOriginalPostBackfill => {
    const source = row.group;
    if (!source || !Array.isArray(source.scheduleRecordIds) || !source.scheduleRecordIds.length || !['white', 'night', 'long_white', 'station_110_white', 'station_110_night'].includes(source.kind)) throw new Error('原岗补位班次无效');
    const start = parseShanghaiLocalDateTime(source.startAt);
    const end = parseShanghaiLocalDateTime(source.endAt);
    if (!start || !end || end.epochMs <= start.epochMs || source.shiftKey !== `${source.startAt}__${source.endAt}` || source.scheduleDate !== source.startAt.slice(0, 10) || !Number.isFinite(source.leaveHours) || source.leaveHours < 0) throw new Error('原岗补位时间无效');
    const expected = createLeaveRequestShiftGroups([{ recordId: source.scheduleRecordIds[0], date: source.scheduleDate, building: '', team: '', shift: source.shift, kind: source.kind, scheduledHours: 0, leaveHours: 0, countedHours: 0 }])[0];
    if (expected.shiftKey !== source.shiftKey) throw new Error('原岗补位时间与班次不一致');
    const substitutePersonRecordId = recordId(row.substitutePersonRecordId);
    const substituteOpenId = row.substituteOpenId;
    if (substitutePersonRecordId !== backfillPersonRecordId || typeof substituteOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(substituteOpenId)) throw new Error('原岗补位人员无效');
    return {
      group: { shiftKey: source.shiftKey, scheduleDate: source.scheduleDate, startAt: source.startAt, endAt: source.endAt, kind: source.kind, shift: text(source.shift), buildings: textArray(source.buildings), teams: textArray(source.teams), scheduleRecordIds: [...new Set(source.scheduleRecordIds.map(recordId))].sort(), leaveHours: source.leaveHours },
      substitutePersonRecordId,
      substituteName: text(row.substituteName),
      substituteOpenId,
    };
  }).sort((left, right) => left.group.shiftKey.localeCompare(right.group.shiftKey));
  if (new Set(originalPostBackfills.map((row) => row.group.shiftKey)).size !== originalPostBackfills.length) throw new Error('原岗补位班次重复');
  return { originalPostBackfills, backfillPersonRecordId, originalPostSignature: signature };
}

function recordId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new Error('原岗补位记录标识无效');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('原岗补位文本无效');
  return value.trim();
}
function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('原岗补位列表无效');
  return [...new Set(value.map(text))].sort();
}
