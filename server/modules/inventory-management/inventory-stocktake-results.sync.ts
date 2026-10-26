import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canManageProfessionalRecord } from '../../../shared/professional-access';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  StocktakeLine,
  StocktakeScope,
  StocktakeSyncSummary,
} from '../../../shared/inventory-stocktake.interface';
import {
  createProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../../common/process-lock-owner';
import {
  InventoryStocktakeStore,
  type StocktakeLedger,
} from './inventory-stocktake.store';
import { InventoryStocktakeResultsGateway } from './inventory-stocktake-results.gateway';
import {
  STOCKTAKE_RESULTS_START,
  queueStocktakeResult,
  stocktakeResultFields,
} from './inventory-stocktake-results.model';

function entries(state: StocktakeLedger) {
  return state.sheets
    .filter((s) => s.month >= STOCKTAKE_RESULTS_START)
    .sort((a, b) => a.month.localeCompare(b.month))
    .flatMap((s) =>
      (['sample', 'review'] as const).flatMap((scope) =>
        (scope === 'sample' ? s.lines : s.review?.lines || []).map((line) => ({
          month: s.month,
          building: s.building,
          scope,
          line,
        })),
      ),
    );
}
type Entry = ReturnType<typeof entries>[number];
function matches(entry: Entry, selected: Entry) {
  return (
    entry.month === selected.month &&
    entry.building === selected.building &&
    entry.scope === selected.scope &&
    entry.line.inventory.recordId === selected.line.inventory.recordId
  );
}
@Injectable()
export class InventoryStocktakeResultsSync
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryStocktakeResultsSync.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly store: InventoryStocktakeStore,
    private readonly gateway: InventoryStocktakeResultsGateway,
  ) {}
  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.timer = setInterval(() => this.kick(), 10000);
      this.timer.unref();
      this.kick();
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  kick() {
    if (this.running || this.stopped) return;
    this.running = this.drain()
      .catch(() =>
        this.logger.warn('盘点同步任务未执行，请检查本地台账或目标表权限'),
      )
      .finally(() => {
        this.running = null;
      });
  }
  summary(
    month: string,
    building: string,
    scope: StocktakeScope,
    principal?: AccessPrincipal,
  ): StocktakeSyncSummary {
    const result: StocktakeSyncSummary = {
      pending: 0,
      syncing: 0,
      success: 0,
      error: 0,
      message: '',
    };
    for (const { line } of entries(this.store.read()).filter(
      (e) => e.month === month && e.building === building && e.scope === scope && (!isProfessionalBusinessPrincipal(principal) || canManageProfessionalRecord(principal, e.line.inventory.specialty, e.line.inventory.building)),
    )) {
      const status =
        line.sync?.version === line.version ? line.sync.status : 'pending';
      result[status]++;
      if (status === 'error' && !result.message)
        result.message = line.sync?.error || '飞书同步失败';
    }
    return result;
  }
  retry(month: string, building: string, scope: StocktakeScope) {
    this.store.update((state) => {
      for (const { line } of entries(state).filter(
        (e) =>
          e.month === month && e.building === building && e.scope === scope,
      ))
        if (line.sync?.status === 'error') queueStocktakeResult(line);
      return true;
    });
    this.kick();
    return this.summary(month, building, scope);
  }
  async drain() {
    if (
      !entries(this.store.read()).some(
        ({ line }) =>
          !line.sync ||
          (line.sync.status !== 'success' &&
            line.sync.attempts < 3 &&
            (!line.sync.retryAt ||
              Date.parse(line.sync.retryAt) <= Date.now())),
      )
    )
      return;
    const owner = createProcessLockOwner(randomUUID());
    const acquired = this.store.update((state) => {
      if (
        state.resultSyncOwner &&
        processLockOwnerMayBeAlive(
          state.resultSyncOwner,
          Date.parse(state.resultSyncOwner.acquiredAt || '') || Date.now(),
        )
      )
        return false;
      state.resultSyncOwner = owner;
      for (const { line } of entries(state)) {
        if (!line.sync || line.sync.version !== line.version)
          queueStocktakeResult(line);
        else if (line.sync.status === 'syncing') line.sync.status = 'pending';
      }
      return true;
    });
    if (!acquired) return;
    try {
      for (let round = 0; round < 5 && !this.stopped; round++) {
        const selected = this.store.update((state) => {
          const used = new Set<string>();
          const batch = entries(state)
            .filter(({ line }) => {
              const sync = line.sync!;
              if (
                used.has(line.inventory.recordId) ||
                sync.status === 'success' ||
                sync.attempts >= 3 ||
                (sync.retryAt && Date.parse(sync.retryAt) > Date.now())
              )
                return false;
              used.add(line.inventory.recordId);
              return true;
            })
            .slice(0, 100);
          for (const { line } of batch) {
            line.sync!.status = 'syncing';
            line.sync!.attempts++;
          }
          return batch;
        });
        if (!selected.length) break;
        try {
          await this.gateway.ensureSchema(selected.map((e) => e.month));
          let state = this.store.read();
          const missing = selected
            .map((e) => e.line.inventory.recordId)
            .filter((id) => !state.resultRecords?.[id]);
          if (missing.length || state.resultCreation) {
            let index = await this.gateway.index();
            this.store.update((s) => {
              s.resultRecords = Object.fromEntries(index);
              return true;
            });
            state = this.store.read();
            let creation = state.resultCreation;
            if (creation && creation.ids.every((id) => index.has(id))) {
              this.store.update((s) => {
                s.resultCreation = null;
                return true;
              });
              creation = null;
            }
            if (!creation) {
              const ids = missing.filter((id) => !index.has(id));
              if (ids.length)
                creation = this.store.update((s) => {
                  s.resultCreation = {
                    token: randomUUID(),
                    ids,
                    startedAt: new Date().toISOString(),
                    uncertain: false,
                  };
                  return s.resultCreation;
                });
            }
            if (creation) {
              if (creation.ids.some((id) => index.has(id)))
                throw new Error('创建结果不完整，请核查飞书记录后重试');
              // An old uncertain intent is never blindly recreated after idempotency protection may expire.
              if (
                creation.uncertain &&
                Date.now() - Date.parse(creation.startedAt) > 23 * 3600000
              )
                throw new Error('创建结果待人工核对，未重复新增记录');
              this.store.update((s) => {
                s.resultCreation!.uncertain = true;
                return true;
              });
              await this.gateway.create(creation.ids, creation.token);
              index = await this.gateway.index();
              if (!creation.ids.every((id) => index.has(id)))
                throw new Error('创建结果待核对');
              this.store.update((s) => {
                s.resultRecords = Object.fromEntries(index);
                s.resultCreation = null;
                return true;
              });
            }
          }
          state = this.store.read();
          const latest = new Map<string, string>();
          for (const e of entries(state))
            latest.set(e.line.inventory.recordId, e.month);
          await this.gateway.update(
            selected.map((e) => {
              const id = state.resultRecords?.[e.line.inventory.recordId];
              if (!id) throw new Error('飞书记录映射缺失');
              return {
                record_id: id,
                fields: stocktakeResultFields(
                  e.month,
                  e.scope,
                  e.line,
                  latest.get(e.line.inventory.recordId) === e.month,
                ),
              };
            }),
          );
          this.finish(selected, '');
        } catch (error) {
          const message =
            error instanceof Error ? error.message : '飞书同步失败';
          this.finish(selected, message);
          break;
        }
      }
    } finally {
      this.store.update((s) => {
        if (s.resultSyncOwner?.token === owner.token) s.resultSyncOwner = null;
        return true;
      });
    }
  }
  private finish(selected: Entry[], error: string) {
    this.store.update((state) => {
      const current = entries(state);
      for (const previous of selected) {
        const line = current.find((e) => matches(e, previous))?.line;
        if (
          !line ||
          line.version !== previous.line.version ||
          line.sync?.version !== previous.line.version
        )
          continue;
        const sync = line.sync;
        sync.status = error ? 'error' : 'success';
        sync.error = error.slice(0, 200);
        sync.syncedAt = error ? null : new Date().toISOString();
        sync.retryAt =
          error && sync.attempts < 3
            ? new Date(Date.now() + sync.attempts * 30000).toISOString()
            : null;
      }
      return true;
    });
  }
}
