export type PersonProfileScope = 'leave' | 'travel';
export type PersonProfilePhotoScope = PersonProfileScope | 'organization';

export interface PersonProfileReadPlan {
  tableId: string;
  viewId?: string;
  tableName: string;
  fieldNames: readonly string[];
  cacheTtlMs: number;
  strict: true;
  allowStale: false;
}

export interface PersonProfileReadPlanOptions {
  leaveTableId?: string;
  travelTableId?: string;
  travelViewId?: string;
}

export const DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID = 'tblATnYxuleJpyVl';
export const DEFAULT_LEAVE_PERSON_PROFILE_WIKI_TOKEN =
  'G7oUwGdwaiTmimk8i2ecGTWOn4d';
export const PERSON_PROFILE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
export const PERSON_PROFILE_FIELD_NAMES = [
  '姓名',
  '员工姓名',
  '机楼/专业',
  '班组',
  '岗位',
  '班次',
] as const;
export const PERSON_PROFILE_DETAIL_FIELD_NAMES = [
  ...PERSON_PROFILE_FIELD_NAMES,
  '联系方式',
  '照片',
] as const;

export function parsePersonProfileScope(scope: unknown): PersonProfileScope {
  const normalized = String(scope ?? '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized === 'leave') return 'leave';
  if (normalized === 'travel') return 'travel';
  throw new Error('人员资料范围无效');
}

export function parsePersonProfilePhotoScope(
  scope: unknown,
): PersonProfilePhotoScope {
  const normalized = String(scope ?? '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized === 'organization') return 'organization';
  return parsePersonProfileScope(normalized);
}

export function resolvePersonProfileReadPlan(
  scope: PersonProfileScope,
  options: PersonProfileReadPlanOptions = {},
): PersonProfileReadPlan {
  if (scope === 'leave') {
    return {
      tableId:
        options.leaveTableId?.trim() || DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID,
      viewId: undefined,
      tableName: '请休假人员资料',
      fieldNames: PERSON_PROFILE_FIELD_NAMES,
      cacheTtlMs: PERSON_PROFILE_CACHE_TTL_MS,
      strict: true,
      allowStale: false,
    };
  }

  const tableId = options.travelTableId?.trim();
  const viewId = options.travelViewId?.trim();
  if (!tableId) throw new Error('差旅人员表未配置');
  if (!viewId) throw new Error('差旅人员视图未配置');

  return {
    tableId,
    viewId,
    tableName: '差旅人员资料',
    fieldNames: PERSON_PROFILE_FIELD_NAMES,
    cacheTtlMs: PERSON_PROFILE_CACHE_TTL_MS,
    strict: true,
    allowStale: false,
  };
}

export function resolvePersonProfileDetailReadPlan(
  scope: PersonProfileScope,
  options: PersonProfileReadPlanOptions = {},
): PersonProfileReadPlan {
  return {
    ...resolvePersonProfileReadPlan(scope, options),
    fieldNames: PERSON_PROFILE_DETAIL_FIELD_NAMES,
  };
}
