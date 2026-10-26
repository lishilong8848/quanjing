import {
  extractDisplayText,
  extractDisplayValues,
  getRecordId,
  pickField,
  type BitableRecordItem,
  type PersistedBitableRecordSnapshot,
} from '@server/common/feishu/bitable-direct-read';

export const DEFAULT_ACTIVE_PERSONNEL_TABLE_ID = 'PUBLIC_EXAMPLE_FEISHU_ORG_TABLE_ID';
export const DEFAULT_ACTIVE_PERSONNEL_VIEW_ID = 'PUBLIC_EXAMPLE_FEISHU_ORG_VIEW_ID';

export const ACTIVE_PERSONNEL_BUILDINGS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'H',
  '110',
] as const;

export type ActivePersonnelBuilding =
  (typeof ACTIVE_PERSONNEL_BUILDINGS)[number];

export interface ActivePersonnelDirectoryEntry {
  recordId: string;
  name: string;
  openId: string;
  employeeNo: string | null;
  position: string;
  systemPosition: string;
  buildings: ActivePersonnelBuilding[];
  supervisorNames: string[];
}

export interface ActivePersonnelDirectoryQuality {
  sourceRecordCount: number;
  activeRecordCount: number;
  inactiveRecordCount: number;
  usablePersonnelCount: number;
  managerCount: number;
  missingNameCount: number;
  missingOpenIdCount: number;
  duplicateOpenIdCount: number;
  missingBuildingCount: number;
}

export interface ActivePersonnelDirectory {
  personnel: ActivePersonnelDirectoryEntry[];
  selectablePersonnel?: ActivePersonnelDirectoryEntry[];
  managers: ActivePersonnelDirectoryEntry[];
  snapshot: {
    fetchedAt: number;
    expiresAt: number;
    stale: boolean;
  };
  quality: ActivePersonnelDirectoryQuality;
}

export function searchActivePersonnelCandidates(
  directory: ActivePersonnelDirectory,
  query: string,
  limit = 12,
): Array<Pick<ActivePersonnelDirectoryEntry, 'recordId' | 'name' | 'position' | 'buildings'>> {
  return (directory.selectablePersonnel ?? directory.personnel)
    .filter((person) => person.recordId && person.name.includes(query))
    .slice(0, limit)
    .map(({ recordId, name, position, buildings }) => ({ recordId, name, position, buildings }));
}

export function buildActivePersonnelDirectory(
  snapshot: PersistedBitableRecordSnapshot,
  now = Date.now(),
): ActivePersonnelDirectory {
  const personnel: ActivePersonnelDirectoryEntry[] = [];
  const selectablePersonnel: ActivePersonnelDirectoryEntry[] = [];
  const seenOpenIds = new Set<string>();
  let activeRecordCount = 0;
  let inactiveRecordCount = 0;
  let missingNameCount = 0;
  let missingOpenIdCount = 0;
  let duplicateOpenIdCount = 0;
  let missingBuildingCount = 0;

  snapshot.records.forEach((record) => {
    const fields = record.fields ?? {};
    if (isInactivePersonnelRecord(fields)) {
      inactiveRecordCount += 1;
      return;
    }
    activeRecordCount += 1;

    const employeeField = pickField(fields, ['员工姓名', '员工', '人员']);
    const name =
      extractDisplayText(pickField(fields, ['姓名']), ' ').trim() ||
      extractDisplayText(employeeField, ' ').trim();
    const openId = extractFeishuUserIds(employeeField)[0] ?? '';
    if (!name) {
      missingNameCount += 1;
    }
    if (!openId) {
      missingOpenIdCount += 1;
    }
    if (!name) {
      return;
    }
    const buildings = extractActivePersonnelBuildings(
      pickField(fields, ['机楼/专业', '机楼专业']),
    );
    const entry: ActivePersonnelDirectoryEntry = {
      recordId: getRecordId(record) || openId || `person-${name}`,
      name,
      openId,
      employeeNo:
        extractDisplayText(
          pickField(fields, ['员工工号', '员工工号（统计）']),
          '',
        ).trim() || null,
      position: extractDisplayText(pickField(fields, ['岗位']), ' ').trim(),
      systemPosition: extractDisplayText(
        pickField(fields, ['体系岗位']),
        ' ',
      ).trim(),
      buildings,
      supervisorNames: [
        ...new Set(
          extractDisplayValues(pickField(fields, ['示例人员001']))
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ],
    };
    selectablePersonnel.push(entry);
    if (!openId) {
      return;
    }
    if (seenOpenIds.has(openId)) {
      duplicateOpenIdCount += 1;
      return;
    }
    seenOpenIds.add(openId);

    if (buildings.length === 0) {
      missingBuildingCount += 1;
    }

    personnel.push(entry);
  });

  personnel.sort(comparePersonnel);
  selectablePersonnel.sort(comparePersonnel);
  const managers = personnel.filter(isMachineRoomManager);

  return {
    personnel,
    selectablePersonnel,
    managers,
    snapshot: {
      fetchedAt: snapshot.fetchedAt,
      expiresAt: snapshot.expiresAt,
      stale: snapshot.expiresAt <= now,
    },
    quality: {
      sourceRecordCount: snapshot.records.length,
      activeRecordCount,
      inactiveRecordCount,
      usablePersonnelCount: personnel.length,
      managerCount: managers.length,
      missingNameCount,
      missingOpenIdCount,
      duplicateOpenIdCount,
      missingBuildingCount,
    },
  };
}

export function extractActivePersonnelBuildings(
  field: unknown,
): ActivePersonnelBuilding[] {
  const text = extractDisplayValues(field).join('、').toUpperCase();
  if (!text) {
    return [];
  }
  return ACTIVE_PERSONNEL_BUILDINGS.filter((building) =>
    buildingPattern(building).test(text),
  );
}

export function isInactivePersonnelRecord(fields: Record<string, unknown>): boolean {
  const field = pickField(fields, ['离职/异动情况']);
  if (field === true || field === 1) {
    return true;
  }
  const values = extractDisplayValues(field).map((value) =>
    value.trim().toLowerCase(),
  );
  return values.some(
    (value) =>
      value === 'true' ||
      value === '1' ||
      value === '是' ||
      value === '离职' ||
      value === '异动' ||
      value === '已离职' ||
      value === '已异动',
  );
}

function extractFeishuUserIds(field: unknown): string[] {
  const ids: string[] = [];
  collectFeishuUserIds(field, ids);
  return [...new Set(ids)];
}

function collectFeishuUserIds(field: unknown, ids: string[]): void {
  if (Array.isArray(field)) {
    field.forEach((item) => collectFeishuUserIds(item, ids));
    return;
  }
  if (!field || typeof field !== 'object') {
    return;
  }
  const object = field as Record<string, unknown>;
  for (const key of ['id', 'open_id', 'openId', 'user_id']) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) {
      ids.push(value.trim());
      break;
    }
  }
  if (Array.isArray(object.users)) {
    object.users.forEach((item) => collectFeishuUserIds(item, ids));
  }
}

function buildingPattern(building: ActivePersonnelBuilding): RegExp {
  if (building === '110') {
    return /(?:^|[^0-9])110(?:\s*(?:号楼|机楼|楼|栋|站))?(?:$|[^0-9])/;
  }
  return new RegExp(
    `(?:^|[^A-Z0-9])${building}(?:\\s*(?:号楼|机楼|楼|栋))?(?:$|[^A-Z0-9])`,
  );
}

function isMachineRoomManager(person: ActivePersonnelDirectoryEntry): boolean {
  const position = normalizeRole(person.position);
  const systemPosition = normalizeRole(person.systemPosition);
  return (
    position === '设施运维经理' ||
    position === '设施运维副经理' ||
    systemPosition === '运维经理'
  );
}

function normalizeRole(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function comparePersonnel(
  left: ActivePersonnelDirectoryEntry,
  right: ActivePersonnelDirectoryEntry,
): number {
  return (
    left.name.localeCompare(right.name, 'zh-CN') ||
    left.openId.localeCompare(right.openId)
  );
}
