import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  StocktakeGeneration,
  StocktakeGenerationRequest,
} from '../../../shared/inventory-stocktake.interface';
import {
  createProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../../common/process-lock-owner';
import {
  nextStocktakeGenerationAt,
  stocktakeBuildings,
  stocktakeGenerationDueAt,
  stocktakeMonth,
  validateStocktakeMonth,
} from './inventory-stocktake.rules';
import { InventoryStocktakeService } from './inventory-stocktake.service';
import { InventoryStocktakeSource } from './inventory-stocktake.source';
import {
  InventoryStocktakeStore,
  type StocktakeGenerationJob,
} from './inventory-stocktake.store';

const MAX_ATTEMPTS = 3;
const SYSTEM = { role: 'admin', purchaseBuilding: null } as AccessPrincipal;

@Injectable()
export class InventoryStocktakeGenerationService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    InventoryStocktakeGenerationService.name,
  );
  private readonly timers = new Set<NodeJS.Timeout>();
  private started = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: InventoryStocktakeStore,
    private readonly source: InventoryStocktakeSource,
    private readonly sheets: InventoryStocktakeService,
  ) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (this.started) return;
      this.started = true;
      this.monthlyTick();
      const recover = () => {
        if (!this.started) return;
        this.wake();
        this.later(recover, 30_000);
      };
      this.later(recover, 30_000);
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.started = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  request(
    request: StocktakeGenerationRequest,
    principal: AccessPrincipal,
    actor: string,
  ): StocktakeGeneration {
    validateStocktakeMonth(request?.month);
    if (request.month !== stocktakeMonth())
      throw new BadRequestException('仅可生成本月盘点');
    if (
      !actor ||
      typeof request.clientMutationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(request.clientMutationId)
    )
      throw new BadRequestException('缺少有效变更号');
    const scope = stocktakeBuildings(principal);
    const fp = createHash('sha256')
      .update(JSON.stringify(['generation', actor, request, scope]))
      .digest('hex');
    const id = this.store.mutate(request.clientMutationId, fp, (state) => {
      const missing = scope.filter(
        (building) =>
          !state.sheets.some(
            (s) =>
              s.month === request.month &&
              s.building === building &&
              Boolean(s.review),
          ),
      );
      const active = state.generationJobs.find(
        (job) =>
          job.month === request.month &&
          ['queued', 'running'].includes(job.status) &&
          missing.length > 0 &&
          missing.every((building) =>
            job.buildings.some((b) => b.building === building),
          ),
      );
      if (active) return active.id;
      const now = new Date().toISOString();
      const job: StocktakeGenerationJob = {
        id: randomUUID(),
        month: request.month,
        status: missing.length ? 'queued' : 'success',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        retryAt: null,
        owner: null,
        buildings: scope.map((building) => ({
          building,
          status: missing.includes(building) ? 'pending' : 'done',
          error: '',
        })),
      };
      state.generationJobs.push(job);
      return job.id;
    });
    const job = this.store.read().generationJobs.find((j) => j.id === id)!;
    this.wake();
    return this.publicJob(job, principal);
  }

  status(
    month: string,
    principal: AccessPrincipal,
  ): StocktakeGeneration | null {
    const scope = stocktakeBuildings(principal);
    const state = this.store.read();
    const jobs = state.generationJobs.filter(
      (job) =>
        job.month === month &&
        job.buildings.some((b) => scope.includes(b.building)),
    );
    if (!jobs.length) return null;
    const latest = [...jobs].reverse();
    const buildings = scope.flatMap((building) => {
      const entry = latest
        .find((job) => job.buildings.some((b) => b.building === building))
        ?.buildings.find((b) => b.building === building);
      if (!entry) return [];
      return [
        {
          ...entry,
          ...(state.sheets.some(
            (s) =>
              s.month === month && s.building === building && Boolean(s.review),
          )
            ? { status: 'done' as const, error: '' }
            : {}),
        },
      ];
    });
    const active = jobs.find(
      (job) => job.status === 'queued' || job.status === 'running',
    );
    const job = active || jobs.at(-1);
    const view = this.publicJob(job!, principal);
    return {
      ...view,
      buildings,
      status: buildings.every((b) => b.status === 'done')
        ? 'success'
        : active
          ? active.status
          : buildings.some((b) => b.status === 'error')
            ? 'error'
            : view.status,
    };
  }
  runPending(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private publicJob(
    job: StocktakeGenerationJob,
    principal: AccessPrincipal,
  ): StocktakeGeneration {
    const scope = stocktakeBuildings(principal);
    const { owner: _owner, ...view } = job;
    const buildings = view.buildings.filter((b) => scope.includes(b.building));
    return {
      ...view,
      buildings,
      status: buildings.every((b) => b.status === 'done')
        ? 'success'
        : view.status,
    };
  }
  private claim(): StocktakeGenerationJob | null {
    const jobs = this.store.read().generationJobs;
    if (
      jobs.some(
        (j) =>
          j.status === 'running' &&
          j.owner &&
          processLockOwnerMayBeAlive(j.owner, Date.parse(j.updatedAt)),
      )
    )
      return null;
    const candidate = jobs.find(
      (j) =>
        j.month === stocktakeMonth() &&
        (j.status === 'queued' ||
          j.status === 'running' ||
          (j.status === 'error' &&
            j.attempts < MAX_ATTEMPTS &&
            j.retryAt &&
            Date.parse(j.retryAt) <= Date.now())),
    );
    if (!candidate) return null;
    return this.store.update((state) => {
      if (
        state.generationJobs.some(
          (j) =>
            j.status === 'running' &&
            j.owner &&
            processLockOwnerMayBeAlive(j.owner, Date.parse(j.updatedAt)),
        )
      )
        return null;
      const job = state.generationJobs.find((j) => j.id === candidate.id)!;
      if (
        job.status === 'success' ||
        (job.status === 'error' &&
          (!job.retryAt || Date.parse(job.retryAt) > Date.now()))
      )
        return null;
      job.status = 'running';
      job.attempts++;
      job.updatedAt = new Date().toISOString();
      job.owner = createProcessLockOwner(randomUUID());
      job.retryAt = null;
      return job;
    });
  }
  private async drain(): Promise<void> {
    const expired = this.store
      .read()
      .generationJobs.filter(
        (j) =>
          j.month < stocktakeMonth() &&
          (j.status === 'queued' ||
            (j.status === 'running' &&
              j.owner &&
              !processLockOwnerMayBeAlive(j.owner, Date.parse(j.updatedAt)))),
      );
    if (expired.length)
      this.store.update((state) => {
        for (const job of state.generationJobs.filter((j) =>
          expired.some((e) => e.id === j.id),
        )) {
          job.status = 'error';
          job.retryAt = null;
          job.owner = null;
          job.updatedAt = new Date().toISOString();
          for (const b of job.buildings.filter((b) => b.status !== 'done')) {
            b.status = 'error';
            b.error = '月份已结束，无法补生成历史盘点';
          }
        }
        return true;
      });
    let job: StocktakeGenerationJob | null;
    while ((job = this.claim())) {
      const currentJob = job;
      try {
        const state = this.store.read();
        const missing = job.buildings.filter(
          (b) =>
            !state.sheets.some(
              (s) =>
                s.month === job!.month &&
                s.building === b.building &&
                Boolean(s.review),
            ),
        );
        const snapshot = missing.length ? await this.source.snapshot() : null;
        for (const entry of job.buildings) {
          try {
            if (snapshot)
              this.sheets.generateMissing(job.month, entry.building, snapshot);
            this.updateBuilding(currentJob, entry.building, 'done', '');
          } catch (error) {
            this.updateBuilding(
              currentJob,
              entry.building,
              'error',
              safeGenerationError(error),
            );
          }
        }
      } catch (error) {
        for (const entry of job.buildings.filter((b) => b.status !== 'done'))
          this.updateBuilding(
            currentJob,
            entry.building,
            'error',
            safeGenerationError(error),
          );
      }
      this.store.update((state) => {
        const latest = state.generationJobs.find(
          (j) => j.id === currentJob.id,
        )!;
        if (latest.owner?.token !== currentJob.owner?.token)
          throw new Error('盘点生成任务所有权已变化');
        latest.status = latest.buildings.every((b) => b.status === 'done')
          ? 'success'
          : 'error';
        latest.retryAt =
          latest.status === 'error' &&
          latest.attempts < MAX_ATTEMPTS &&
          latest.month === stocktakeMonth()
            ? new Date(Date.now() + 60_000 * latest.attempts).toISOString()
            : null;
        latest.updatedAt = new Date().toISOString();
        latest.owner = null;
        return true;
      });
    }
  }
  private updateBuilding(
    job: StocktakeGenerationJob,
    building: StocktakeGenerationJob['buildings'][number]['building'],
    status: 'done' | 'error',
    error: string,
  ): void {
    this.store.update((state) => {
      const latest = state.generationJobs.find((j) => j.id === job.id)!;
      if (latest.owner?.token !== job.owner?.token)
        throw new Error('盘点生成任务所有权已变化');
      const entry = latest.buildings.find((b) => b.building === building)!;
      entry.status = status;
      entry.error = error;
      latest.updatedAt = new Date().toISOString();
      return true;
    });
  }
  private monthlyTick(): void {
    if (!this.started) return;
    let acceptanceFailed = false;
    try {
      const month = stocktakeMonth();
      if (Date.now() >= stocktakeGenerationDueAt(month).getTime())
        this.request(
          { month, clientMutationId: `auto-stocktake-v2-${month}` },
          SYSTEM,
          'stocktake-scheduler',
        );
    } catch {
      acceptanceFailed = true;
      this.logger.error('盘点自动生成受理失败，将在下次调度重试');
    }
    this.wake();
    const next = nextStocktakeGenerationAt();
    this.later(
      () => this.monthlyTick(),
      acceptanceFailed
        ? 30_000
        : Math.min(24 * 3600_000, Math.max(1, next.getTime() - Date.now())),
    );
  }
  private wake(): void {
    if (!this.started) return;
    this.later(() => {
      void this.runPending().catch(() =>
        this.logger.error('盘点生成任务处理失败，保留任务等待恢复'),
      );
    }, 0);
  }
  private later(callback: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.started) callback();
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }
}

function safeGenerationError(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : (response as { message?: unknown }).message;
    if (typeof message === 'string') return message.slice(0, 300);
  }
  if (
    ['ETIMEDOUT', 'ECONNABORTED'].includes(
      String((error as { code?: unknown } | null)?.code),
    )
  )
    return '读取库存与出入库记录超时，请重试生成';
  return '读取库存或出入库记录失败，请稍后重试';
}
