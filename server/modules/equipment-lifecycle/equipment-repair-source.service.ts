import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  fetchEquipmentRepairRecords,
  persistRepairSnapshot,
  readPersistedRepairSnapshot,
} from './equipment-repair-source.reader';
export { EQUIPMENT_REPAIR_FIELDS } from './equipment-repair-source.reader';

const TTL = 4 * 60 * 60 * 1000;
export interface RepairSourceSnapshot {
  records: BitableRecordItem[];
  version: string;
  fetchedAt: number;
}
export interface RepairSourceState {
  snapshot: RepairSourceSnapshot | null;
  refreshing: boolean;
  error: string;
  stale: boolean;
}

@Injectable()
export class EquipmentRepairSourceService {
  private readonly logger = new Logger(EquipmentRepairSourceService.name);
  private snapshot: RepairSourceSnapshot | null = null;
  private inFlight: Promise<void> | null = null;
  private warm: Promise<void> | null = null;
  private lastFailureAt = 0;
  constructor(private readonly http: HttpService) {}

  async getState(refresh = false): Promise<RepairSourceState> {
    if (!this.snapshot) {
      this.warm ??= this.warmSnapshot();
      await this.warm;
    }
    if (
      !this.inFlight &&
      (refresh ||
        !this.snapshot ||
        Date.now() - this.snapshot.fetchedAt >= TTL) &&
      (refresh || Date.now() - this.lastFailureAt >= 30000)
    ) {
      this.inFlight = this.read(refresh).finally(() => {
        this.inFlight = null;
      });
    }
    return {
      snapshot: this.snapshot,
      refreshing: Boolean(this.inFlight),
      error: this.lastFailureAt ? '维修记录更新失败，请重试' : '',
      stale: Boolean(
        this.lastFailureAt ||
        (this.snapshot && Date.now() - this.snapshot.fetchedAt >= TTL),
      ),
    };
  }
  private set(records: BitableRecordItem[], fetchedAt: number): void {
    this.snapshot = {
      records,
      fetchedAt,
      version: createHash('sha256')
        .update(JSON.stringify(records))
        .digest('hex'),
    };
  }
  private async warmSnapshot(): Promise<void> {
    try {
      const cached = await readPersistedRepairSnapshot();
      if (cached) this.set(cached.records, cached.fetchedAt);
    } catch {
      this.logger.warn('维修记录缓存不可用');
    }
  }
  private async read(refresh: boolean): Promise<void> {
    try {
      const records = await fetchEquipmentRepairRecords(this.http);
      this.set(records, Date.now());
      this.lastFailureAt = 0;
      try {
        await persistRepairSnapshot(records, this.snapshot!.fetchedAt);
      } catch {
        this.logger.warn('维修记录缓存写入失败');
      }
    } catch {
      this.lastFailureAt = Date.now();
      this.logger.warn('维修记录读取失败');
    }
  }
}
