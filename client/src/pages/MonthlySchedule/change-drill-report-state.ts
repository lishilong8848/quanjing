import type { ChangeInfo } from '@shared/api.interface';
import {
  createEmptyChangeDrillReportDraft,
  type ChangeDrillReportDraft,
} from '@shared/change-drill-report';
import {
  CHANGE_REQUEST_BUILDINGS,
  type ChangeRequestBuilding,
} from '@shared/change-request';
import { listAdjustableChanges } from './change-adjustment-state';

const DRILL_REPORT_LEVELS = new Set(['中', '高']);
const PENDING_CHANGE_ID_PREFIX = 'change-request-pending-';

export function listChangeDrillReportCandidates(
  changes: readonly ChangeInfo[],
  now = new Date(),
): ChangeInfo[] {
  return listAdjustableChanges(changes, now).filter(
    (change) =>
      Boolean(change.bitableRecordId.trim()) &&
      !change.id.startsWith(PENDING_CHANGE_ID_PREFIX) &&
      !change.progress?.includes('同步中') &&
      DRILL_REPORT_LEVELS.has(change.level?.trim() || ''),
  );
}

export function createChangeDrillReportDraftForRecord(
  change: ChangeInfo,
): ChangeDrillReportDraft {
  const empty = createEmptyChangeDrillReportDraft();
  const buildings = change.buildings.filter(
    (building, index, source): building is ChangeRequestBuilding =>
      CHANGE_REQUEST_BUILDINGS.includes(building as ChangeRequestBuilding) &&
      source.indexOf(building) === index,
  );

  return {
    ...empty,
    changeRecordId: change.bitableRecordId.trim(),
    buildings,
  };
}
