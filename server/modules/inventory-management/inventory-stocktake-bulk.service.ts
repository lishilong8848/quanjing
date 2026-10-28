import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { businessAuthorizationIdentityKey, businessAuthorizationSnapshot, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { WarehouseBuilding } from '../../../shared/inventory-management.interface';
import type {
  StocktakeBulkRequest,
  StocktakeBulkTask,
} from '../../../shared/inventory-stocktake.interface';
import {
  createProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../../common/process-lock-owner';
import { InventoryStocktakeService } from './inventory-stocktake.service';
import {
  InventoryStocktakeStore,
  type StocktakeBulkJob,
} from './inventory-stocktake.store';

function summary(job: StocktakeBulkJob): StocktakeBulkTask {
  const {
    id,
    month,
    building,
    status,
    count,
    attempts,
    createdAt,
    updatedAt,
    error,
  } = job;
  return {
    id,
    month,
    building,
    status,
    count,
    attempts,
    createdAt,
    updatedAt,
    error,
    confirmer: job.request?.confirmer,
  };
}
@Injectable()
export class InventoryStocktakeBulkService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryStocktakeBulkService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly store: InventoryStocktakeStore,
    private readonly sheets: InventoryStocktakeService,
  ) {}
  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.timer = setInterval(() => this.wake(), 5000);
      this.timer.unref();
      this.wake();
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  request(
    request: StocktakeBulkRequest,
    principal: AccessPrincipal,
    actor: string,
  ): StocktakeBulkTask {
    if (
      !request ||
      typeof request.clientMutationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(request.clientMutationId)
    )
      throw new BadRequestException('缺少有效变更号');
    this.sheets.get(request.month, request.building, principal, 'review');
    const fingerprint = this.sheets.reviewFingerprint(request, actor);
    const job = this.store.update((state) => {
      const jobs = (state.bulkJobs ||= []);
      const existing = jobs.find((j) => j.id === request.clientMutationId);
      if (existing) {
        if ((principal.accountId || existing.principal.accountId || isProfessionalBusinessPrincipal(principal) || isProfessionalBusinessPrincipal(existing.principal)) && businessAuthorizationIdentityKey(existing.principal) !== businessAuthorizationIdentityKey(principal)) throw new ConflictException('任务授权已变化，请重新提交');
        if (existing.fingerprint !== fingerprint)
          throw new ConflictException('重复变更号对应的内容不同，请重新提交');
        if (existing.status !== 'error') return existing;
        if (
          jobs.some(
            (j) =>
              j.id !== existing.id &&
              j.month === request.month &&
              j.building === request.building &&
              ['queued', 'running'].includes(j.status),
          )
        )
          throw new ConflictException('本楼批量确认正在处理，请先查询处理结果');
        this.sheets.assertReviewRequest(request, principal, state);
        existing.status = 'queued';
        existing.error = '';
        existing.updatedAt = new Date().toISOString();
        return existing;
      }
      const receipt = state.receipts.find(
        (r) => r.key === request.clientMutationId,
      );
      if (receipt && receipt.fingerprint !== fingerprint)
        throw new ConflictException('重复变更号对应的内容不同，请重新提交');
      if (!receipt) {
        if (
          jobs.some(
            (j) =>
              j.month === request.month &&
              j.building === request.building &&
              ['queued', 'running'].includes(j.status),
          )
        )
          throw new ConflictException('本楼批量确认正在处理，请先查询处理结果');
        this.sheets.assertReviewRequest(request, principal, state);
      }
      const now = new Date().toISOString();
      const created: StocktakeBulkJob = {
        id: request.clientMutationId,
        fingerprint,
        month: request.month,
        building: request.building,
        count: request.lines.length,
        status: receipt ? 'success' : 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        error: '',
        actor,
        principal: businessAuthorizationSnapshot(principal),
        request: receipt ? null : structuredClone(request),
        owner: null,
      };
      jobs.push(created);
      return created;
    });
    // The durable acceptance returns before any external personnel/inventory read.
    return summary(job);
  }
  status(
    month: string,
    building: WarehouseBuilding,
    id: string,
    principal: AccessPrincipal,
  ) {
    const job = this.store
      .read()
      .bulkJobs?.find(
        (j) => j.id === id && j.month === month && j.building === building,
      );
    if (!job) throw new NotFoundException('未找到批量确认任务，请用原请求重试');
    if ((principal.accountId || job.principal.accountId || isProfessionalBusinessPrincipal(principal) || isProfessionalBusinessPrincipal(job.principal)) && businessAuthorizationIdentityKey(job.principal) !== businessAuthorizationIdentityKey(principal)) throw new NotFoundException('未找到本专业的批量确认任务');
    // Check the same accepted confirmation scope, not an unrelated list-read action.
    this.sheets.get(month, building, { ...principal, permissionContext: job.principal.permissionContext, permissionRequirements: job.principal.permissionRequirements }, 'review');
    return summary(job);
  }
  private wake() {
    if (this.stopped || this.running) return;
    this.running = this.drain()
      .catch(() => this.logger.warn('批量盘点任务未执行，请核查本地台账'))
      .finally(() => {
        this.running = null;
      });
  }
  private claim(): StocktakeBulkJob | null {
    const jobs = this.store.read().bulkJobs || [];
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'running'))
      return null;
    return this.store.update((state) => {
      const jobs = state.bulkJobs || [];
      if (
        jobs.some(
          (j) =>
            j.status === 'running' &&
            j.owner &&
            processLockOwnerMayBeAlive(j.owner, Date.parse(j.updatedAt)),
        )
      )
        return null;
      const job = jobs.find(
        (j) => j.status === 'queued' || j.status === 'running',
      );
      if (!job) return null;
      job.status = 'running';
      job.attempts++;
      job.updatedAt = new Date().toISOString();
      job.owner = createProcessLockOwner(randomUUID());
      return job;
    });
  }
  async drain() {
    let job: StocktakeBulkJob | null;
    while (!this.stopped && (job = this.claim())) {
      const current = job;
      let error = '';
      try {
        if (this.store.replay(current.id, current.fingerprint) === undefined)
          await this.sheets.confirmReview(
            current.request!,
            current.principal,
            current.actor,
          );
      } catch (caught) {
        error =
          caught instanceof HttpException
            ? caught.message
            : '人员或库存核查未完成，请保留草稿并重试';
      }
      if (
        error &&
        this.store.replay(current.id, current.fingerprint) !== undefined
      )
        error = '';
      this.store.update((state) => {
        const stored = state.bulkJobs?.find((j) => j.id === current.id);
        if (!stored || stored.owner?.token !== current.owner?.token)
          throw new ConflictException('批量任务所有权已变化');
        stored.status = error ? 'error' : 'success';
        stored.error = error;
        stored.owner = null;
        stored.updatedAt = new Date().toISOString();
        if (!error) stored.request = null;
        return true;
      });
    }
  }
}
