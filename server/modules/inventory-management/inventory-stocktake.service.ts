import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { assertProfessionalRecordScope, filterProfessionalRecords } from '../../common/access/professional-record-scope';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { WarehouseBuilding } from '../../../shared/inventory-management.interface';
import type {
  StocktakeCompleteRequest,
  StocktakeLine,
  StocktakeLineRequest,
  StocktakeOverview,
  StocktakeSheet,
  StocktakeWriteRequest,
  StocktakeScope,
  StocktakeBulkRequest,
  StocktakeProgress,
  StocktakeUndoRequest,
} from '../../../shared/inventory-stocktake.interface';
import { PurchaseApplicationService } from '../purchase-inventory/purchase-application.service';
import {
  assertStocktakeScope,
  selectStocktakeItems,
  stocktakeBuildings,
  stocktakeFingerprint,
  stocktakeMonth,
  validateStocktakeDraft,
  validateStocktakeMonth,
} from './inventory-stocktake.rules';
import { InventoryStocktakeSource } from './inventory-stocktake.source';
import { queueStocktakeResult } from './inventory-stocktake-results.model';
import type { InventoryStocktakeResultsSync } from './inventory-stocktake-results.sync';
import {
  InventoryStocktakeStore,
  type StocktakeLedger,
} from './inventory-stocktake.store';

export interface StocktakeLineResult {
  line: StocktakeLine;
  sheetVersion: number;
}

@Injectable()
export class InventoryStocktakeService {
  constructor(
    private readonly store: InventoryStocktakeStore,
    private readonly source: InventoryStocktakeSource,
    private readonly people: PurchaseApplicationService,
  ) {}

  overview(month: string, principal: AccessPrincipal): StocktakeOverview {
    validateStocktakeMonth(month);
    const state = this.store.read();
    return {
      month,
      historyStartedAt: state.historyStartedAt,
      buildings: stocktakeBuildings(principal).map((building) => {
        const sheet = state.sheets.find(
          (s) => s.month === month && s.building === building,
        );
        return {
          building,
          ...this.progress(this.scopedView(sheet, principal)),
          review: this.progress(this.scopedView(sheet?.review, principal)),
        };
      }),
    };
  }
  get(
    month: string,
    building: WarehouseBuilding,
    principal: AccessPrincipal,
    scope: StocktakeScope = 'sample',
  ): StocktakeSheet | null {
    validateStocktakeMonth(month);
    assertStocktakeScope(principal, building);
    this.validateScope(scope);
    const state = this.store.read();
    const sheet = state.sheets.find(
      (s) => s.month === month && s.building === building,
    );
    if (!sheet || (scope === 'review' && !sheet.review)) return null;
    const { review, ...sample } = sheet;
    const result = { ...sample, ...(scope === 'review' ? review : {}), scope };
    const job =
      scope === 'review'
        ? state.bulkJobs
            ?.slice()
            .reverse()
            .find(
              (j) =>
                j.month === month &&
                j.building === building &&
                j.status !== 'success' && (!isProfessionalBusinessPrincipal(principal) || (j.principal.accountId === principal.accountId && JSON.stringify(j.principal.specialties) === JSON.stringify(principal.specialties))),
            )
        : undefined;
    if (job && job.request?.expectedVersion === result.version) {
      const { id, status, count, attempts, createdAt, updatedAt, error } = job;
      result.bulkTask = {
        id,
        month,
        building,
        status,
        count,
        attempts,
        createdAt,
        updatedAt,
        error,
        confirmer: job.request.confirmer,
      };
      const overrides = new Map(job.request.lines.map((l) => [l.recordId, l]));
      result.lines = result.lines.map((line) => {
        const draft = overrides.get(line.inventory.recordId);
        return line.status === 'draft' &&
          draft?.expectedVersion === line.version
          ? {
              ...line,
              actualQuantity: draft.actualQuantity ?? line.actualQuantity,
              confirmer: draft.confirmer || line.confirmer,
              note: draft.note,
            }
          : line;
      });
    }
    return this.scopedView(result, principal)!;
  }
  async start(
    request: StocktakeWriteRequest,
    principal: AccessPrincipal,
    actor: string,
  ): Promise<StocktakeSheet> {
    this.validateWrite(request, principal);
    const fp = this.fingerprint('start', request, actor);
    const replay = this.store.replay<StocktakeSheet>(
      request.clientMutationId,
      fp,
    );
    if (replay) return this.scopedView(replay, principal)!;
    const existing = this.get(
      request.month,
      request.building,
      principal,
      request.scope,
    );
    if (existing) return existing;
    const snapshot = await this.source.snapshot(request.building);
    this.createSheet(request, snapshot, request.clientMutationId, fp);
    return this.get(request.month, request.building, principal, request.scope)!;
  }

  generateMissing(
    month: string,
    building: WarehouseBuilding,
    snapshot: Awaited<ReturnType<InventoryStocktakeSource['snapshot']>>,
  ): StocktakeSheet {
    const request = {
      month,
      building,
      clientMutationId: `generated-v2-${month}-${building}`,
    };
    validateStocktakeMonth(month);
    if (month !== stocktakeMonth())
      throw new BadRequestException('仅可生成本月盘点');
    return this.createSheet(
      request,
      snapshot,
      request.clientMutationId,
      this.fingerprint('generate', { month, building }, 'system'),
    );
  }

  private createSheet(
    request: StocktakeWriteRequest,
    snapshot: Awaited<ReturnType<InventoryStocktakeSource['snapshot']>>,
    key: string,
    fp: string,
  ): StocktakeSheet {
    const items = snapshot.items.filter((i) => i.building === request.building);
    if (new Set(items.map((i) => i.recordId)).size !== items.length)
      throw new BadRequestException('库存清单存在重复条目，请核对台账');
    return this.store.mutate(key, fp, (state) => {
      const current = state.sheets.find(
        (s) => s.month === request.month && s.building === request.building,
      );
      if (current?.review) return current;
      const now = new Date().toISOString(),
        seed = randomUUID();
      const review = (sample: StocktakeSheet) => {
        const selected = new Set(sample.lines.map((l) => l.inventory.recordId));
        return {
          status: 'open' as const,
          version: 1,
          createdAt: now,
          completedAt: null,
          lines: snapshot.items
            .filter(
              (i) =>
                i.building === request.building && !selected.has(i.recordId),
            )
            .map((inventory) => ({
              inventory,
              reasons: [],
              movementIds: [],
              stockFingerprint: stocktakeFingerprint(inventory),
              version: 1,
              status: 'draft' as const,
              updatedAt: now,
              confirmedAt: null,
              operatorFingerprint: null,
              actualQuantity: null,
              confirmer: null,
              note: '',
            })),
        };
      };
      if (current) {
        current.review = review(current);
        current.review.lines.forEach((line) => queueStocktakeResult(line, key));
        return current;
      }
      const selection = selectStocktakeItems({
        ...request,
        ...snapshot,
        seed,
        history: state.sheets.map((s) => ({
          month: s.month,
          building: s.building,
          recordIds: s.lines.map((l) => l.inventory.recordId),
        })),
      });
      state.historyStartedAt ||= now;
      const sheet: StocktakeSheet = {
        month: request.month,
        building: request.building,
        status: 'open',
        version: 1,
        createdAt: now,
        completedAt: null,
        historyStartedAt: state.historyStartedAt,
        seed,
        algorithm: 'sha256-rank-v1',
        inventoryCount: snapshot.items.filter(
          (i) => i.building === request.building,
        ).length,
        randomTarget: selection.randomTarget,
        shortfall: selection.shortfall,
        excludedRecordIds: selection.excludedRecordIds,
        lines: selection.selected.map((s) => ({
          inventory: s.item,
          reasons: s.reasons,
          movementIds: s.movementIds,
          stockFingerprint: stocktakeFingerprint(s.item),
          version: 1,
          status: 'draft',
          updatedAt: now,
          confirmedAt: null,
          operatorFingerprint: null,
          actualQuantity: null,
          confirmer: null,
          note: '',
        })),
      };
      sheet.review = review(sheet);
      [...sheet.lines, ...sheet.review.lines].forEach((line) =>
        queueStocktakeResult(line, key),
      );
      state.sheets.push(sheet);
      return sheet;
    });
  }
  async confirmReview(
    request: StocktakeBulkRequest,
    principal: AccessPrincipal,
    actor: string,
  ): Promise<StocktakeSheet> {
    this.validateWrite(request, principal);
    if (request.scope !== 'review')
      throw new BadRequestException('仅库存核盘支持一键确认');
    if (!request.confirmer?.recordId || !request.confirmer.openId)
      throw new BadRequestException('请从在职员工中选择批量确认人');
    const fp = this.fingerprint('bulk-confirm', request, actor);
    const replay = this.store.replay<StocktakeSheet>(
      request.clientMutationId,
      fp,
    );
    if (replay) return this.scopedView(replay, principal)!;
    const pending = this.assertReviewRequest(request, principal);
    const overrides = new Map(request.lines.map((l) => [l.recordId, l]));
    const people = new Map<
      string,
      Awaited<
        ReturnType<PurchaseApplicationService['resolveApplicantForBuilding']>
      >
    >();
    const values = [];
    const bulkPerson = await this.reviewDependency('人员', () => this.people.resolveApplicantForBuilding(
      request.confirmer,
      true,
    ));
    if (!bulkPerson)
      throw new BadRequestException('批量确认人已失效，请重新选择在职员工');
    people.set(`${bulkPerson.recordId}:${bulkPerson.openId}`, bulkPerson);
    for (const line of pending) {
      const override = overrides.get(line.inventory.recordId)!;
      const person = override.confirmer || line.confirmer || request.confirmer;
      if (!person?.recordId || !person.openId)
        throw new BadRequestException('请从在职员工中选择确认人');
      const key = `${person.recordId}:${person.openId}`;
      if (!people.has(key))
        people.set(
          key,
          await this.reviewDependency('人员', () => this.people.resolveApplicantForBuilding(person, true)),
        );
      const canonical = people.get(key);
      if (!canonical)
        throw new BadRequestException('确认人已失效，请重新选择在职员工');
      const value = {
        actualQuantity:
          override.actualQuantity ??
          line.actualQuantity ??
          line.inventory.quantity,
        confirmer: canonical,
        note: override.note,
      };
      try {
        validateStocktakeDraft({
          ...value,
          bookQuantity: line.inventory.quantity,
        });
      } catch (error) {
        throw new BadRequestException(
          `${line.inventory.name}：${(error as Error).message}`,
        );
      }
      values.push({ line, value });
    }
    const stocks = await this.reviewDependency('库存', () => this.source.currentMany(
      pending.map((l) => l.inventory),
      ...(isProfessionalBusinessPrincipal(principal) ? [principal] : []),
    ));
    const current = new Map(stocks.map((i) => [i.recordId, i]));
    for (const line of pending) {
      const stock = current.get(line.inventory.recordId);
      if (!stock || stocktakeFingerprint(stock) !== line.stockFingerprint)
        throw new ConflictException(
          `${line.inventory.name}库存已变化，请更新台账数量并重新核查`,
        );
    }
    return this.store.mutate(request.clientMutationId, fp, (state) => {
      const sheet = this.findSheet(state, request);
      if (
        sheet.version !== request.expectedVersion ||
        sheet.status === 'completed'
      )
        throw new ConflictException('核盘记录已更新，请刷新后重试');
      const now = new Date().toISOString();
      const batch = {
        id: randomUUID(),
        month: request.month,
        building: request.building,
        count: values.length,
        confirmer: bulkPerson,
        confirmedAt: now,
        status: 'confirmed' as const,
        undoneAt: null,
        actor,
        undoneBy: null,
        before: values.map(({ line }) => {
          const override = overrides.get(line.inventory.recordId)!;
          return {
            recordId: line.inventory.recordId,
            confirmedVersion: line.version + 1,
            actualQuantity: override.actualQuantity ?? line.actualQuantity,
            confirmer: override.confirmer || line.confirmer,
            note: override.note,
          };
        }),
      };
      for (const { line: previous, value } of values) {
        const line = sheet.lines.find(
          (l) => l.inventory.recordId === previous.inventory.recordId,
        )!;
        if (
          !line ||
          line.status !== 'draft' ||
          line.version !== previous.version
        )
          throw new ConflictException('核盘清单已变化，请刷新后重试');
        Object.assign(line, value, {
          note: value.note.trim(),
          status: 'confirmed',
          confirmedAt: now,
          updatedAt: now,
          operatorFingerprint: actor,
          version: line.version + 1,
        });
        queueStocktakeResult(line, request.clientMutationId);
      }
      (state.bulkBatches ||= []).push(batch);
      sheet.latestBulk = this.bulkSummary(batch);
      sheet.version++;
      const base = state.sheets.find(
        (s) => s.month === request.month && s.building === request.building,
      )!;
      const { review, ...sample } = base;
      return this.scopedView({ ...sample, ...review!, scope: 'review' as const }, principal)!;
    });
  }
  reviewFingerprint(request: StocktakeBulkRequest, actor: string) {
    return this.fingerprint('bulk-confirm', request, actor);
  }
  private async reviewDependency<T>(stage: '人员' | '库存', operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      const reason = code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? '超时' : '暂不可用';
      throw new ServiceUnavailableException(`${stage}核查${reason}，未确认任何条目，请保留草稿并重试`);
    }
  }
  assertReviewRequest(
    request: StocktakeBulkRequest,
    principal: AccessPrincipal,
    state = this.store.read(),
  ) {
    this.validateWrite(request, principal);
    if (request.scope !== 'review')
      throw new BadRequestException('仅库存核盘支持一键确认');
    if (!request.confirmer?.recordId || !request.confirmer.openId)
      throw new BadRequestException('请从在职员工中选择批量确认人');
    const sheet = this.findSheet(state, request);
    const pending = this.ownedLines(sheet.lines, principal).filter(l => l.status === 'draft');
    if (
      sheet.status === 'completed' ||
      sheet.version !== request.expectedVersion
    )
      throw new ConflictException('核盘记录已更新，请刷新后重试');
    if (
      !Array.isArray(request.lines) ||
      !pending.length ||
      request.lines.length !== pending.length ||
      request.lines.some((l) => !l || typeof l.recordId !== 'string') ||
      new Set(request.lines.map((l) => l.recordId)).size !== pending.length
    )
      throw new BadRequestException('核盘清单已变化，请刷新后重试');
    const overrides = new Map(request.lines.map((l) => [l.recordId, l]));
    for (const line of pending) {
      const value = overrides.get(line.inventory.recordId);
      if (!value || value.expectedVersion !== line.version)
        throw new ConflictException('核盘清单已变化，请刷新后重试');
      try {
        validateStocktakeDraft({
          actualQuantity:
            value.actualQuantity ??
            line.actualQuantity ??
            line.inventory.quantity,
          confirmer: value.confirmer || line.confirmer || request.confirmer,
          note: value.note,
          bookQuantity: line.inventory.quantity,
        });
      } catch (error) {
        throw new BadRequestException(
          `${line.inventory.name}：${(error as Error).message}`,
        );
      }
    }
    return pending;
  }

  undoReview(
    request: StocktakeUndoRequest,
    principal: AccessPrincipal,
    actor: string,
  ): StocktakeSheet | Promise<StocktakeSheet> {
    this.validateWrite(request, principal);
    this.assertNoPendingBulk(request);
    if (request.scope !== 'review' || typeof request.batchId !== 'string')
      throw new BadRequestException('撤销批次无效');
    const fp = this.fingerprint('bulk-undo', request, actor);
    const apply = () => this.store.mutate(request.clientMutationId, fp, (state) => {
      const sheet = this.findSheet(state, request);
      const batch = state.bulkBatches?.find(
        (b) =>
          b.id === request.batchId &&
          b.month === request.month &&
          b.building === request.building,
      );
      if (
        !batch ||
        sheet.latestBulk?.id !== batch.id ||
        batch.status !== 'confirmed' ||
        sheet.version !== request.expectedVersion
      )
        throw new ConflictException('仅可撤销最近一次批量确认，请刷新后重试');
      const now = new Date().toISOString();
      for (const before of batch.before) {
        const line = sheet.lines.find(
          (l) => l.inventory.recordId === before.recordId,
        );
        if (
          !line ||
          line.status !== 'confirmed' ||
          line.version !== before.confirmedVersion
        )
          throw new ConflictException('批次条目已变化，未执行撤销');
        assertProfessionalRecordScope(principal, line.inventory.specialty, line.inventory.building);
        Object.assign(line, {
          actualQuantity: before.actualQuantity,
          confirmer: before.confirmer,
          note: before.note,
          status: 'draft',
          confirmedAt: null,
          operatorFingerprint: null,
          updatedAt: now,
          lastUndoneAt: now,
          version: line.version + 1,
        });
        queueStocktakeResult(line, request.clientMutationId);
      }
      batch.status = 'undone';
      batch.undoneAt = now;
      batch.undoneBy = actor;
      sheet.latestBulk = this.bulkSummary(batch);
      sheet.status = 'open';
      sheet.completedAt = null;
      sheet.version++;
      const base = state.sheets.find(
        (s) => s.month === request.month && s.building === request.building,
      )!;
      const { review, ...sample } = base;
      return this.scopedView({ ...sample, ...review!, scope: 'review' as const }, principal)!;
    });
    if (!isProfessionalBusinessPrincipal(principal)) return apply();
    const state = this.store.read(), sheet = this.findSheet(state, request);
    const batch = state.bulkBatches?.find(item => item.id === request.batchId && item.month === request.month && item.building === request.building);
    const inventory = (batch?.before || []).map(before => sheet.lines.find(line => line.inventory.recordId === before.recordId)?.inventory);
    if (!inventory.length || inventory.some(item => !item)) throw new ConflictException('批次条目已变化，未执行撤销');
    for (const item of inventory) assertProfessionalRecordScope(principal, item?.specialty, item?.building);
    return this.source.currentMany(inventory as NonNullable<typeof inventory[number]>[], principal).then(apply);
  }

  private bulkSummary(
    batch: NonNullable<StocktakeLedger['bulkBatches']>[number],
  ) {
    const { id, count, confirmer, confirmedAt, status, undoneAt } = batch;
    return { id, count, confirmer, confirmedAt, status, undoneAt };
  }
  retrySync(
    request: StocktakeWriteRequest,
    principal: AccessPrincipal,
    actor: string,
    sync?: InventoryStocktakeResultsSync,
  ) {
    this.validateWrite(request, principal, true);
    if (!sync) throw new BadRequestException('盘点同步服务不可用');
    const fp = this.fingerprint('retry-sync', request, actor);
    this.store.mutate(request.clientMutationId, fp, (state) => {
      const sheet = this.findSheet(state, request);
      for (const line of this.ownedLines(sheet.lines, principal))
        if (line.sync?.status === 'error')
          queueStocktakeResult(line, request.clientMutationId);
      return { accepted: true };
    });
    sync.kick();
    return sync.summary(
      request.month,
      request.building,
      request.scope || 'sample',
      principal,
    );
  }

  async writeLine(
    request: StocktakeLineRequest,
    principal: AccessPrincipal,
    actor: string,
    mode: 'draft' | 'confirm' | 'refresh',
  ): Promise<StocktakeLineResult> {
    this.validateWrite(request, principal);
    this.assertNoPendingBulk(request);
    if (!request.recordId || !Number.isSafeInteger(request.expectedVersion))
      throw new BadRequestException('盘点条目或版本无效');
    const fp = this.fingerprint(mode, request, actor);
    const replay = this.store.replay<StocktakeLineResult>(
      request.clientMutationId,
      fp,
    );
    if (replay) return replay;
    const initial = this.findLine(this.store.read(), request);
    assertProfessionalRecordScope(principal, initial.line.inventory.specialty, initial.line.inventory.building);
    let canonicalPerson = request.confirmer;
    let current = initial.line.inventory;
    if (mode !== 'refresh') {
      if (
        request.actualQuantity !== null &&
        (typeof request.actualQuantity !== 'number' ||
          !Number.isFinite(request.actualQuantity) ||
          request.actualQuantity < 0 ||
          request.actualQuantity > 1e12 ||
          Math.abs(
            request.actualQuantity * 1000 -
              Math.round(request.actualQuantity * 1000),
          ) > 0.00001)
      )
        throw new BadRequestException('实际数量须为非负数，最多三位小数');
      if (typeof request.note !== 'string' || request.note.length > 1000)
        throw new BadRequestException('差异说明最多1000字');
      if (request.confirmer) {
        canonicalPerson = await this.people.resolveApplicantForBuilding(
          request.confirmer,
          mode === 'confirm',
        );
        if (!canonicalPerson)
          throw new BadRequestException('确认人已失效，请重新选择在职员工');
      }
    }
    if (mode === 'confirm')
      validateStocktakeDraft({
        ...request,
        confirmer: canonicalPerson,
        bookQuantity: initial.line.inventory.quantity,
      });
    if (mode === 'confirm' || mode === 'refresh' || isProfessionalBusinessPrincipal(principal))
      current = await this.source.current(initial.line.inventory, ...(isProfessionalBusinessPrincipal(principal) ? [principal] : []));
    assertProfessionalRecordScope(principal, current.specialty, current.building);
    if (
      mode === 'confirm' &&
      stocktakeFingerprint(current) !== initial.line.stockFingerprint
    )
      throw new ConflictException('库存已变化，请更新台账数量并重新核查');
    return this.store.mutate(request.clientMutationId, fp, (state) => {
      const { sheet, line } = this.findLine(state, request);
      const now = new Date().toISOString();
      if (mode === 'refresh') {
        line.inventory = current;
        line.stockFingerprint = stocktakeFingerprint(current);
      } else {
        line.actualQuantity = request.actualQuantity;
        line.confirmer = canonicalPerson;
        line.note = request.note.trim();
      }
      line.version++;
      line.updatedAt = now;
      sheet.version++;
      if (mode === 'confirm') {
        line.status = 'confirmed';
        line.confirmedAt = now;
        line.operatorFingerprint = actor;
      }
      queueStocktakeResult(line, request.clientMutationId);
      return { line, sheetVersion: sheet.version };
    });
  }
  async complete(
    request: StocktakeCompleteRequest,
    principal: AccessPrincipal,
    actor: string,
  ) {
    this.validateWrite(request, principal);
    this.assertNoPendingBulk(request);
    if (isProfessionalBusinessPrincipal(principal)) {
      const owned = this.ownedLines(this.findSheet(this.store.read(), request).lines, principal);
      await this.source.currentMany(owned.map(line => line.inventory), principal);
    }
    const fp = this.fingerprint('complete', request, actor);
    return this.store.mutate(request.clientMutationId, fp, (state) => {
      const sheet = this.findSheet(state, request);
      if (sheet.version !== request.expectedVersion)
        throw new ConflictException('盘点记录已更新，请重新加载');
      const owned = this.ownedLines(sheet.lines, principal);
      if (!owned.length || owned.some(l => l.status !== 'confirmed'))
        throw new BadRequestException('仍有未确认条目');
      if (sheet.status === 'completed')
        return {
          status: sheet.status,
          version: sheet.version,
          completedAt: sheet.completedAt,
        };
      if (isProfessionalBusinessPrincipal(principal) && sheet.lines.some(l => l.status !== 'confirmed')) return { status: 'completed' as const, version: sheet.version, completedAt: new Date().toISOString() };
      sheet.status = 'completed';
      sheet.completedAt = new Date().toISOString();
      sheet.version++;
      return {
        status: sheet.status,
        version: sheet.version,
        completedAt: sheet.completedAt,
      };
    });
  }
  private ownedLines(lines: StocktakeLine[], principal: AccessPrincipal) {
    return filterProfessionalRecords(principal, lines, line => line.inventory.specialty);
  }
  private scopedView<T extends { lines: StocktakeLine[]; status: 'open' | 'completed' }>(sheet: T | undefined, principal: AccessPrincipal): T | undefined {
    if (!sheet || !isProfessionalBusinessPrincipal(principal)) return sheet;
    const lines = this.ownedLines(sheet.lines, principal);
    const result = { ...sheet, lines, shortfall: 0, status: lines.length > 0 && lines.every(line => line.status === 'confirmed') ? 'completed' as const : 'open' as const };
    delete (result as { latestBulk?: unknown }).latestBulk;
    return result;
  }
  private findSheet(state: StocktakeLedger, request: StocktakeWriteRequest) {
    const sheet = state.sheets.find(
      (s) => s.month === request.month && s.building === request.building,
    );
    if (!sheet) throw new NotFoundException('本月盘点清单尚未生成');
    if (request.scope === 'review') {
      if (!sheet.review)
        throw new NotFoundException('本月库存核盘清单尚未生成');
      return sheet.review;
    }
    return sheet;
  }
  private findLine(state: StocktakeLedger, request: StocktakeLineRequest) {
    const sheet = this.findSheet(state, request);
    if (sheet.status === 'completed')
      throw new ConflictException('本楼盘点已完成');
    const line = sheet.lines.find(
      (l) => l.inventory.recordId === request.recordId,
    );
    if (!line) throw new NotFoundException('盘点条目不存在');
    if (line.version !== request.expectedVersion || line.status === 'confirmed')
      throw new ConflictException('该条目已更新，请重新加载后核对');
    return { sheet, line };
  }
  private validateWrite(
    request: StocktakeWriteRequest,
    principal: AccessPrincipal,
    allowHistoricalSync = false,
  ) {
    if (!request || typeof request !== 'object')
      throw new BadRequestException('盘点请求无效');
    assertStocktakeScope(principal, request.building);
    this.validateScope(request.scope);
    validateStocktakeMonth(request.month);
    if (!allowHistoricalSync && request.month !== stocktakeMonth())
      throw new BadRequestException('仅可操作本月盘点');
    if (
      typeof request.clientMutationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(request.clientMutationId)
    )
      throw new BadRequestException('缺少有效变更号');
  }
  private validateScope(scope: unknown) {
    if (scope !== undefined && scope !== 'sample' && scope !== 'review')
      throw new BadRequestException('盘点类型无效');
  }
  private progress(sheet?: {
    lines: StocktakeLine[];
    status: 'open' | 'completed';
    shortfall?: number;
  }): StocktakeProgress {
    const confirmed =
      sheet?.lines.filter((l) => l.status === 'confirmed') || [];
    const surplus = confirmed.filter(
      (l) =>
        l.actualQuantity !== null &&
        l.actualQuantity - l.inventory.quantity > 0.000001,
    ).length;
    const shortage = confirmed.filter(
      (l) =>
        l.actualQuantity !== null &&
        l.inventory.quantity - l.actualQuantity > 0.000001,
    ).length;
    return {
      total: sheet?.lines.length || 0,
      confirmed: confirmed.length,
      differences: surplus + shortage,
      surplus,
      shortage,
      matched: confirmed.length - surplus - shortage,
      status: sheet?.status || 'not_started',
      shortfall: sheet?.shortfall || 0,
    };
  }
  private assertNoPendingBulk(request: StocktakeWriteRequest) {
    if (
      request.scope === 'review' &&
      this.store
        .read()
        .bulkJobs?.some(
          (job) =>
            job.month === request.month &&
            job.building === request.building &&
            ['queued', 'running'].includes(job.status),
        )
    )
      throw new ConflictException('本楼批量确认处理中，请先查询处理结果');
  }
  private fingerprint(action: string, request: unknown, actor: string) {
    if (!actor) throw new BadRequestException('登录身份已失效');
    return createHash('sha256')
      .update(JSON.stringify([action, actor, request]))
      .digest('hex');
  }
}
