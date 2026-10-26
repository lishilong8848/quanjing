import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ThresholdStore } from './threshold.store';
import { ThresholdBitableGateway } from './threshold-bitable.gateway';
import { randomUUID } from 'node:crypto';
import type { ThresholdSourceSync } from '../../../shared/threshold-management.interface';

@Injectable()
export class ThresholdSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ThresholdSyncService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private readonly owner = randomUUID();
  private source: ThresholdSourceSync = { state: 'loading' };
  private refreshing = false;
  private draining?: Promise<void>;
  private pulling?: Promise<void>;
  private scheduled?: NodeJS.Immediate;
  private checkedAt = 0;
  sourceStatus() {
    return { ...this.source };
  }
  async acceptCloud(id: string, actor: string) {
    const job = this.store.conflictJob(id, actor);
    const record = await this.gateway.readRecord(
      job.before!.profession,
      job.result.id,
    );
    return this.store.acceptCloud(id, actor, record);
  }
  refreshSource(force = false) {
    if (
      this.refreshing ||
      this.stopped ||
      (!force && Date.now() - this.checkedAt < 60000)
    )
      return;
    this.refreshing = true;
    this.source = { ...this.source, state: 'loading', error: undefined };
    this.pulling = this.pullSource();
  }
  private async pullSource() {
    try {
      const revision = this.store.list().revision;
      const records = await this.gateway.readSnapshot();
      if (this.stopped) return;
      if (!this.store.adoptCloud(records, revision)) {
        this.checkedAt = Date.now();
        this.source = {
          state: 'error',
          error: '读取期间阈值已变化，请刷新重试',
        };
        return;
      }
      this.source = { state: 'ready', checkedAt: new Date().toISOString() };
      this.checkedAt = Date.now();
    } catch (error) {
      this.source = {
        state: 'error',
        error:
          error instanceof Error ? error.message : '多维表读取失败，请刷新重试',
      };
      this.checkedAt = Date.now();
    } finally {
      this.refreshing = false;
    }
  }
  constructor(
    private readonly store: ThresholdStore,
    private readonly gateway: ThresholdBitableGateway,
  ) {}
  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.timer = setInterval(() => this.kick(), 2000);
      this.timer.unref();
      this.kick();
      this.refreshSource();
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearImmediate(this.scheduled);
    await Promise.all([this.draining, this.pulling]);
  }
  kick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      if (this.stopped) {
        this.running = false;
        return;
      }
      this.draining = this.drain();
    });
  }
  private async drain() {
    this.running = true;
    try {
      for (const job of this.store.pendingSync()) {
        if (this.stopped) break;
        if (!this.store.claimSync(job.result.clientMutationId, this.owner))
          continue;
        try {
          await this.gateway.sync(job, (tableId, recordId) =>
            this.store.bindSync(
              job.result.clientMutationId,
              this.owner,
              tableId,
              recordId,
            ),
          );
          this.store.finishSync(
            job.result.clientMutationId,
            { state: 'success' },
            this.owner,
          );
        } catch (error) {
          const attempts = job.result.sync?.attempts || 0;
          const message =
            error instanceof Error ? error.message : '同步失败，请重试';
          const retryable = message === '飞书暂时不可用，请重试同步';
          this.store.finishSync(
            job.result.clientMutationId,
            {
              state: retryable && attempts < 2 ? 'pending' : 'error',
              error: message,
              ...(retryable && attempts < 2
                ? {
                    nextAttemptAt: new Date(
                      Date.now() + 2000 * 2 ** attempts,
                    ).toISOString(),
                  }
                : {}),
            },
            this.owner,
          );
        }
      }
    } catch {
      this.logger.error('阈值同步台账处理失败，保留任务等待恢复');
    } finally {
      this.running = false;
    }
  }
}
