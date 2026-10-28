import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings } from '../../../shared/building-access';
import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  LedgerDashboard,
  LedgerLifecycle,
  LedgerQuery,
} from '../../../shared/equipment-ledger.interface';
import { summarizeLedger } from './equipment-ledger.model';

export function ledgerAccessBuilding(
  principal?: AccessPrincipal,
  pageRead = false,
): string | null {
  // The service evaluates each record against personal and inherited business scope.
  if (isProfessionalBusinessPrincipal(principal)) return null;
  if (pageRead && principal) {
    const scope = accessBuildings(principal);
    if (scope === null) return null;
    if (!scope.length) throw new ForbiddenException('未配置管理楼栋');
    return scope.length === 1 ? scope[0] : null;
  }
  if (principal?.role === 'admin' || principal?.role === 'editor' || isProfessionalBusinessPrincipal(principal)) return null;
  if (principal?.role === 'building_admin') {
    const scope = accessBuildings(principal)?.filter(value => ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].includes(value));
    if (scope?.length) return scope.length === 1 ? scope[0] : null;
  }
  throw new ForbiddenException('无设备台账访问权限');
}

export function scopedLedgerSnapshotId(
  id: string,
  building: string | null,
): string {
  return building ? `${id}:${building}` : id;
}

export function scopeLedgerDashboard(
  dashboard: LedgerDashboard,
  building: string | null,
): LedgerDashboard {
  if (!building) return dashboard;
  const summary = dashboard.buildings.find(
    (item) => item.building === building,
  );
  return {
    ...dashboard,
    snapshotId: scopedLedgerSnapshotId(dashboard.snapshotId, building),
    overview: summary || summarizeLedger([], building),
    buildings: summary ? [summary] : [],
  };
}

export function scopeLedgerQuery(
  query: LedgerQuery,
  building: string | null,
): LedgerQuery {
  if (!building) return query;
  if (query.building && query.building !== building)
    throw new ForbiddenException('仅可查看所属楼栋设备');
  return { ...query, building };
}

export function scopeLedgerLifecycle(
  view: LedgerLifecycle,
  building: string | null,
): LedgerLifecycle {
  if (!building) return view;
  return {
    ...view,
    assets: view.assets.filter((row) => row.building === building),
    longTermMaintenance: view.longTermMaintenance.filter(
      (row) => row.building === building,
    ),
    keyParts: view.keyParts.filter((row) => row.building === building),
    maintenanceContracts: view.maintenanceContracts.filter(
      (row) => row.building === building,
    ),
  };
}
