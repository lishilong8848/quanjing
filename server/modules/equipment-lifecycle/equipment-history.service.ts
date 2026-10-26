import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  EquipmentHistoryState,
  EquipmentRepairHistory,
  EquipmentHistoryDevicesState,
} from '../../../shared/equipment-history.interface';
import type { HistoryLedgerAsset } from './equipment-history.model';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { EquipmentLedgerService } from './equipment-ledger.service';
import { EquipmentRepairSourceService } from './equipment-repair-source.service';
import {
  mapEquipmentRepair,
  matchEquipmentRepair,
} from './equipment-history.model';

@Injectable()
export class EquipmentHistoryService {
  private cache: {
    key: string;
    items: Map<string, EquipmentRepairHistory[]>;
  } | null = null;
  constructor(
    private readonly ledger: EquipmentLedgerService,
    private readonly repairs: EquipmentRepairSourceService,
  ) {}

  async getDevices(
    building: string | null,
    refresh = false,
    principal?: AccessPrincipal,
  ): Promise<EquipmentHistoryDevicesState> {
    const empty: EquipmentHistoryDevicesState = {
      status: 'loading',
      refreshing: false,
      stale: false,
      updatedAt: null,
      devices: [],
      error: '',
    };
    const state = await this.ledger.getDashboardState(false, principal);
    if (!state.dashboard || state.dashboard.stale)
      return {
        ...empty,
        status: state.refreshing ? 'loading' : 'error',
        refreshing: state.refreshing,
        error: state.refreshing ? '' : '设备身份暂时无法确认，请刷新重试',
      };
    const ledger = await this.ledger.getHistoryAssets(principal);
    if (ledger.stale)
      return {
        ...empty,
        status: 'error',
        stale: true,
        error: '设备身份暂时无法确认，请刷新重试',
      };
    const source = await this.repairs.getState(refresh);
    if (!source.snapshot)
      return {
        ...empty,
        status: source.refreshing ? 'loading' : 'error',
        refreshing: source.refreshing,
        error: source.error,
      };
    const items = this.index(
      `${ledger.snapshotId}|${source.snapshot.version}`,
      ledger.assets,
      source.snapshot.records,
    );
    return {
      ...empty,
      status: 'ready',
      refreshing: source.refreshing,
      stale: source.stale,
      error: source.error,
      updatedAt: new Date(source.snapshot.fetchedAt).toISOString(),
      devices: ledger.assets
        .filter(
          (a) => (!building || a.building === building) && items.has(a.id),
        )
        .map((asset) => {
          const records = items.get(asset.id)!;
          return {
            asset,
            count: records.length,
            completed: records.filter((r) => r.status === '维修完成').length,
            pending: records.filter((r) => r.status !== '维修完成').length,
            lastFaultAt: records[0].faultAt,
            latestFault: records[0].fault,
          };
        })
        .sort(
          (a, b) =>
            b.count - a.count ||
            (b.lastFaultAt || '').localeCompare(a.lastFaultAt || '') ||
            a.asset.code.localeCompare(b.asset.code),
        ),
    };
  }
  async getState(
    assetId: string,
    building: string | null,
    refresh = false,
    principal?: AccessPrincipal,
  ): Promise<EquipmentHistoryState> {
    const empty: EquipmentHistoryState = {
      assetId,
      status: 'loading',
      refreshing: false,
      stale: false,
      updatedAt: null,
      items: [],
      error: '',
    };
    // Authorize the requested device before consulting any repair records.
    const page = await this.ledger.getItems({
      id: assetId,
      ...(building ? { building } : {}),
      pageSize: 1,
    }, principal);
    if (!page.items.length)
      throw new NotFoundException('设备不存在或无查看权限');
    const ledgerState = await this.ledger.getDashboardState(refresh, principal);
    if (ledgerState.refreshing && (refresh || ledgerState.dashboard?.stale))
      return { ...empty, refreshing: true };
    if (!ledgerState.dashboard || ledgerState.dashboard.stale)
      return {
        ...empty,
        status: 'error',
        stale: true,
        error: '设备身份暂时无法确认，请刷新重试',
      };
    const ledger = await this.ledger.getHistoryAssets(principal);
    const authorized = ledger.assets.find(
      (a) => a.id === assetId && (!building || a.building === building),
    );
    if (!authorized) throw new NotFoundException('设备不存在或无查看权限');
    if (ledger.stale)
      return {
        ...empty,
        status: 'error',
        stale: true,
        error: '设备身份暂时无法确认，请刷新重试',
      };
    const source = await this.repairs.getState(refresh);
    if (!source.snapshot)
      return {
        ...empty,
        status: source.refreshing ? 'loading' : 'error',
        refreshing: source.refreshing,
        error: source.error,
      };
    const key = `${ledger.snapshotId}|${source.snapshot.version}`;
    const items = this.index(key, ledger.assets, source.snapshot.records);
    return {
      ...empty,
      status: 'ready',
      refreshing: source.refreshing,
      stale: source.stale,
      error: source.error,
      updatedAt: new Date(source.snapshot.fetchedAt).toISOString(),
      items: items.get(assetId) || [],
    };
  }

  private index(
    key: string,
    assets: readonly HistoryLedgerAsset[],
    records: readonly BitableRecordItem[],
  ) {
    if (this.cache?.key !== key) {
      const matches = matchEquipmentRepair(assets, records);
      const items = new Map<string, EquipmentRepairHistory[]>();
      for (const record of records) {
        const history = mapEquipmentRepair(record);
        const id = matches.get(history.id)?.assetId;
        if (id) items.set(id, [...(items.get(id) || []), history]);
      }
      for (const list of items.values())
        list.sort(
          (a, b) =>
            (b.faultAt || b.startedAt || '').localeCompare(
              a.faultAt || a.startedAt || '',
            ) || b.repairNumber.localeCompare(a.repairNumber),
        );
      this.cache = { key, items };
    }
    return this.cache.items;
  }
}
