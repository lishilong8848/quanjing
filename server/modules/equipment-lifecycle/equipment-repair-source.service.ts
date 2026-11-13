import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createBitableBackgroundRefresh, type BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  fetchEquipmentRepairRecords,
  persistRepairSnapshot,
  readPersistedRepairSnapshot,
} from './equipment-repair-source.reader';
export { EQUIPMENT_REPAIR_FIELDS } from './equipment-repair-source.reader';

const TTL = 5 * 60 * 1000;
const FAILURE_BACKOFF = 30000;
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
export class EquipmentRepairSourceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EquipmentRepairSourceService.name);
  private snapshot: RepairSourceSnapshot | null = null;
  private inFlight: Promise<void> | null = null;
  private warm: Promise<void> | null = null;
  private lastFailureAt = 0;
  private destroyed = false;
  private readonly background = createBitableBackgroundRefresh({
    name: EquipmentRepairSourceService.name,
    intervalMs: TTL,
    warm: () => this.syncInBackground(false),
    refresh: () => this.syncInBackground(true),
  });
  constructor(private readonly http: HttpService) {}

  onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, () => {
      if (!this.destroyed) this.background.start();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.background.stop();
    await cancelHotfixInitialization(this);
  }

  private async syncInBackground(refresh: boolean): Promise<void> {
    await this.getState(refresh);
    await this.inFlight;
  }

  async getState(refresh = false): Promise<RepairSourceState> {
    if (!this.snapshot) {
      this.warm ??= this.warmSnapshot();
      await this.warm;
    }
    if (
      !this.destroyed &&
      !this.inFlight &&
      (refresh ||
        !this.snapshot ||
        this.lastFailureAt > 0 ||
        Date.now() - this.snapshot.fetchedAt >= TTL) &&
      (refresh || Date.now() - this.lastFailureAt >= FAILURE_BACKOFF)
    ) {
      this.inFlight = this.read().finally(() => {
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
  private async read(): Promise<void> {
    try {
      const records = await fetchEquipmentRepairRecords(this.http);
      if (this.destroyed) return;
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
