import { HttpService } from '@nestjs/axios';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import type { InventoryLedgerDeletionRequest, InventoryLedgerDeletionTask } from '../../../shared/inventory-ledger-deletion.interface';
import { canPerformBusinessAction, hasBusinessPermissionSomewhere } from '../../../shared/business-permissions';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { readEnv, parseFeishuBitableLink } from '../../common/config/external-services.config';
import { resolveBitableAppToken } from '../../common/feishu/bitable-direct-read';
import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { buildStableInventoryMutationFingerprint } from './inventory-idempotency-fingerprint';
import { scopedInventoryItem } from './inventory-management.mapper';
import { InventoryManagementService } from './inventory-management.service';
import { InventoryWorkflowGateway, InventoryWorkflowRecordDefinitelyNotDeletedError } from './inventory-workflow.gateway';
import { canRetryPreparedDeletion, InventoryLedgerDeletionStore, isTemporaryLedgerDeletionReadFailure, type LedgerDeletionEntry } from './inventory-ledger-deletion.store';

const RETRY_DELAYS_MS = [1000, 3000] as const;
const STAGE_LABELS: Record<NonNullable<InventoryLedgerDeletionTask['stage']>, string> = {
  'validating-source': '核对删除数据源', 'reading-record': '读取待删除台账', 'reading-catalog': '核对物品类别与权限',
  'checking-latest': '删除前复核台账', deleting: '删除台账', reconciling: '核对删除结果', completed: '删除完成',
};

@Injectable()
export class InventoryLedgerDeletionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryLedgerDeletionService.name);
  private readonly active = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly store: InventoryLedgerDeletionStore, private readonly gateway: InventoryWorkflowGateway,
    private readonly http: HttpService, private readonly management: InventoryManagementService,
    @Optional() private readonly access?: AccessConfigurationService) {}

  async onModuleInit() {
    await runHotfixInitialization(this, async () => {
      const recover = () => void this.store.recoverableDeletions().then(rows => rows.forEach(row => this.schedule(row.request.clientMutationId))).catch(() => this.logger.warn('台账删除任务恢复暂不可用，将稍后重试'));
      recover(); this.timer = setInterval(recover, 60000); this.timer.unref?.();
    });
  }
  async onModuleDestroy() {
    this.stopped = true; await cancelHotfixInitialization(this);
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.allSettled(this.active.values());
  }

  async accept(value: InventoryLedgerDeletionRequest, principal: AccessPrincipal, actor: string): Promise<InventoryLedgerDeletionTask> {
    const request = normalizeRequest(value);
    if (!actor || actor.length > 512 || !hasBusinessPermissionSomewhere(principal, { module: 'inventory', action: 'delete' })) throw new ForbiddenException('没有库存台账删除权限');
    const requestFingerprint = buildStableInventoryMutationFingerprint({ actor, request });
    const entry = await this.store.reserveDeletion({ principal: structuredClone(principal), principalFingerprint: actor, requestFingerprint,
      request, phase: 'prepared', task: { clientMutationId: request.clientMutationId, recordId: request.recordId, status: 'pending', stage: 'validating-source', retryCount: 0,
        definitelyNotDeleted: true, retryable: false, message: '删除申请已受理，正在核对台账', updatedAt: new Date().toISOString() } }, true);
    this.schedule(request.clientMutationId);
    return this.publicTask(entry);
  }

  async status(id: string, actor: string): Promise<InventoryLedgerDeletionTask> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new BadRequestException('删除申请标识无效');
    const entry = await this.store.findDeletion(id);
    if (!entry) throw new NotFoundException('尚未查到删除受理记录，可使用原申请安全重试');
    if (entry.principalFingerprint !== actor) throw new ForbiddenException('无权查看该删除任务');
    if (['pending', 'running', 'uncertain'].includes(entry.task.status)) this.schedule(id);
    return this.publicTask(entry);
  }

  private publicTask(entry: LedgerDeletionEntry): InventoryLedgerDeletionTask {
    return { ...entry.task, retryable: canRetryPreparedDeletion(entry),
      definitelyNotDeleted: entry.task.status !== 'completed' && (entry.phase === 'prepared' || entry.task.definitelyNotDeleted === true),
      ...(canRetryPreparedDeletion(entry) && entry.task.retryable === undefined
        ? { message: '删除前读取超时，删除尚未执行，可使用原申请安全重试' } : {}) };
  }

  private schedule(id: string) {
    if (this.stopped || this.active.has(id) || this.retryTimers.has(id)) return;
    const run = Promise.resolve().then(() => this.execute(id)).catch(() => this.logger.warn('台账删除结果待核对，已保留原申请')).finally(() => this.active.delete(id));
    this.active.set(id, run);
  }
  async waitForIdle() { await Promise.allSettled(this.active.values()); }

  private defer(id: string, nextAttemptAt: string) {
    if (this.stopped || this.retryTimers.has(id)) return;
    const timer = setTimeout(() => { this.retryTimers.delete(id); this.schedule(id); }, Math.min(60000, Math.max(1, Date.parse(nextAttemptAt) - Date.now())));
    timer.unref?.(); this.retryTimers.set(id, timer);
  }

  private async progress(entry: LedgerDeletionEntry, stage: NonNullable<InventoryLedgerDeletionTask['stage']>) {
    entry.task = { ...entry.task, status: 'running', stage, nextAttemptAt: undefined, retryable: false,
      definitelyNotDeleted: entry.phase === 'prepared', message: `${STAGE_LABELS[stage]}中…`, updatedAt: new Date().toISOString() };
    await this.store.saveDeletion(entry);
  }

  private async execute(id: string) {
    const entry = await this.store.findDeletion(id);
    if (!entry || ['completed', 'failed'].includes(entry.task.status)) return;
    if (entry.phase === 'prepared' && entry.task.nextAttemptAt && Date.parse(entry.task.nextAttemptAt) > Date.now()) {
      this.defer(id, entry.task.nextAttemptAt); return;
    }
    let deleting = entry.phase === 'deleting';
    try {
      // Reconcile an already issued DELETE against its pinned source. Never replay it.
      if (deleting) {
        await this.progress(entry, 'reconciling');
        const remaining = await this.gateway.tryGetRecord(entry.source!.appToken, entry.source!.tableId, entry.request.recordId, '库存台账');
        await this.finish(entry, remaining ? 'failed' : 'completed', remaining ? '已核对记录仍存在，本次删除未完成；请刷新台账后重新确认' : '已核对多维表，库存台账删除成功', { definitelyNotDeleted: !!remaining });
        return;
      }
      await this.progress(entry, 'validating-source');
      const principal = entry.principal.accountId && this.access
        ? this.access.currentPrincipal(entry.principal.accountId, entry.principal.authorizationVersion) : entry.principal;
      if (!principal) throw new ForbiddenException('账号权限已变化，请重新登录后操作');
      const source = parseFeishuBitableLink(readEnv('FEISHU_WAREHOUSE_SOURCE_URL'));
      const tableId = readEnv('FEISHU_WAREHOUSE_INVENTORY_TABLE_ID');
      const catalogId = readEnv('FEISHU_WAREHOUSE_CATALOG_TABLE_ID');
      if (!tableId || !catalogId) throw new BadRequestException('库存台账或物品类别数据源未配置');
      const appToken = await resolveBitableAppToken(this.http, { appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || source.appToken, wikiToken: source.wikiToken, tableName: '库存台账' });
      if (entry.source && (entry.source.appToken !== appToken || entry.source.tableId !== tableId))
        throw new ConflictException('库存台账数据源已变化，请刷新后重新确认删除');
      entry.source = { appToken, tableId };
      await this.progress(entry, 'reading-record');
      const record = await this.gateway.tryGetRecord(appToken, tableId, entry.request.recordId, '库存台账');
      if (!record) { await this.finish(entry, 'completed', '库存台账已不存在，无需重复删除'); return; }
      await this.progress(entry, 'reading-catalog');
      const catalog = await this.gateway.listRecords({ appToken, tableId: catalogId, tableName: '物品类别',
        searchFilter: { conjunction: 'and', conditions: [{ field_name: '物品类别号', operator: 'is', value: [entry.request.expected.sku] }] } });
      const item = scopedInventoryItem(record, catalog, { ...principal, permissionContext: { module: 'inventory', action: 'delete' } });
      if (!item || !canPerformBusinessAction(principal, { module: 'inventory', action: 'delete', building: item.building, specialty: item.specialty })) throw new ForbiddenException('这条库存台账超出删除权限范围');
      if (item.building !== entry.request.building || item.sku !== entry.request.expected.sku || item.quantity !== entry.request.expected.quantity || item.location !== entry.request.expected.location)
        throw new ConflictException('台账楼栋、物品、库存或库位已变化，请刷新后重新确认删除');
      // Refresh immediately before the destructive call; do not delete a row changed during catalog lookup.
      await this.progress(entry, 'checking-latest');
      const latest = await this.gateway.tryGetRecord(appToken, tableId, entry.request.recordId, '库存台账');
      if (!latest) { await this.finish(entry, 'completed', '库存台账已不存在，无需重复删除'); return; }
      if (buildStableInventoryMutationFingerprint(latest.fields) !== buildStableInventoryMutationFingerprint(record.fields)) throw new ConflictException('库存台账正在变更，请刷新后重新确认删除');
      if (entry.principal.accountId && this.access) {
        const current = this.access.currentPrincipal(entry.principal.accountId, entry.principal.authorizationVersion);
        if (!current || !canPerformBusinessAction(current, { module: 'inventory', action: 'delete', building: item.building, specialty: item.specialty }))
          throw new ForbiddenException('账号权限已变化，请重新登录后操作');
      }
      entry.phase = 'deleting';
      await this.progress(entry, 'deleting'); deleting = true;
      await this.gateway.deleteRecordAndConfirmAbsent(appToken, tableId, entry.request.recordId, '库存台账');
      await this.finish(entry, 'completed', '库存台账及多维表对应记录已删除');
    } catch (error) {
      if (!deleting && entry.phase === 'prepared' &&
        !(error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) &&
        isTemporaryLedgerDeletionReadFailure(error)) {
        const retryCount = entry.task.retryCount ?? 0;
        const message = `${STAGE_LABELS[entry.task.stage || 'validating-source']}暂时失败，删除尚未执行`;
        if (retryCount < RETRY_DELAYS_MS.length) {
          const nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_MS[retryCount]).toISOString();
          entry.task = { ...entry.task, status: 'pending', retryCount: retryCount + 1, nextAttemptAt, retryable: false,
            definitelyNotDeleted: true, message: `${message}；稍后自动重试（${retryCount + 1}/2）`, updatedAt: new Date().toISOString() };
          await this.store.saveDeletion(entry); this.defer(id, nextAttemptAt);
        } else await this.finish(entry, 'failed', `${message}；自动重试已达上限，可使用原申请安全重试`, { retryable: true, definitelyNotDeleted: true });
        return;
      }
      const definite = !deleting || error instanceof InventoryWorkflowRecordDefinitelyNotDeletedError;
      await this.finish(entry, definite ? 'failed' : 'uncertain', definite
        ? `${deleting ? '' : '删除尚未执行：'}${error instanceof Error ? error.message : '删除未执行，请刷新后重试'}`
        : '删除结果待核对，请核对原申请；系统不会重复删除', { definitelyNotDeleted: definite });
    }
  }
  private async finish(entry: LedgerDeletionEntry, status: InventoryLedgerDeletionTask['status'], message: string,
    flags: Pick<InventoryLedgerDeletionTask, 'retryable' | 'definitelyNotDeleted'> = {}) {
    entry.task = { ...entry.task, status, message, retryable: false, nextAttemptAt: undefined,
      ...(status === 'completed' ? { stage: 'completed' as const, definitelyNotDeleted: false } : {}), ...flags, updatedAt: new Date().toISOString() };
    await this.store.saveDeletion(entry);
    try {
      if (entry.source && (entry.phase === 'deleting' || status === 'completed')) this.gateway.invalidateRecordsCache(entry.source.appToken, entry.source.tableId);
      if (status === 'completed' || status === 'uncertain') this.management.invalidateCache();
    } catch { this.logger.warn('台账删除状态已保存，列表将于下次刷新更新'); }
  }
}

export function normalizeRequest(value: InventoryLedgerDeletionRequest): InventoryLedgerDeletionRequest {
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value.clientMutationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.recordId) ||
    !WAREHOUSE_BUILDINGS.includes(value.building) || !value.expected || typeof value.expected.sku !== 'string' ||
    typeof value.expected.location !== 'string' || value.expected.sku.length > 256 || value.expected.location.length > 512 || !Number.isFinite(value.expected.quantity))
    throw new BadRequestException('台账删除参数无效，请刷新后重试');
  return { clientMutationId: value.clientMutationId, recordId: value.recordId, building: value.building, expected: { sku: value.expected.sku, quantity: value.expected.quantity, location: value.expected.location } };
}
