import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { normalizeThresholdEquipment } from '../../../shared/threshold-equipment';
import {
  THRESHOLD_BITABLE_SCHEMA,
  thresholdContentFingerprint,
} from '../../../shared/threshold-bitable';
import {
  THRESHOLD_KINDS,
  type ThresholdCommand,
  type ThresholdInput,
  type ThresholdMutationResult,
  type ThresholdRecord,
  type ThresholdSnapshot,
  type ThresholdSyncJob,
  type ThresholdSyncState,
} from '../../../shared/threshold-management.interface';

export type ThresholdMutationScopeCheck = (records: readonly ThresholdRecord[]) => void;

interface Ledger extends ThresholdSnapshot {
  schema: 1;
  importedSeeds?: string[];
  mutations: Record<
    string,
    {
      fingerprint: string;
      result: ThresholdMutationResult;
      actor?: string;
      before?: ThresholdRecord | null;
    }
  >;
}
function mutationScopeRecords(ledger: Ledger, id: string): ThresholdRecord[] {
  const receipt = ledger.mutations[id];
  if (!receipt) throw new NotFoundException('同步任务不存在');
  return structuredClone([receipt.before, receipt.result.record, ledger.records.find(record => record.id === receipt.result.id)]
    .filter((record): record is ThresholdRecord => !!record));
}
export class ThresholdStore {
  private readonly path: string;
  constructor(
    path: string,
    private readonly seed: ThresholdRecord[],
    private readonly additions: {
      key: string;
      records: ThresholdRecord[];
    }[] = [],
    private readonly syncEnabled = false,
  ) {
    this.path = resolve(path);
  }
  list(): ThresholdSnapshot {
    let ledger = this.read();
    if (this.hasPendingSeeds(ledger))
      ledger = this.withLock(() => {
        const current = this.read();
        this.importSeeds(current);
        return current;
      });
    const { records, revision, updatedAt } = ledger;
    return {
      records: records.map(normalizeThresholdEquipment),
      revision,
      updatedAt,
      ...(this.syncEnabled
        ? {
            syncResults: Object.values(ledger.mutations)
              .map((m) => m.result)
              .filter(
                (r) => r.sync && ['pending', 'error'].includes(r.sync.state),
              ),
          }
        : {}),
    };
  }
  pendingSync(): ThresholdSyncJob[] {
    return Object.values(this.read().mutations)
      .filter(
        (m) =>
          m.result.sync?.state === 'pending' &&
          (!m.result.sync.nextAttemptAt ||
            Date.parse(m.result.sync.nextAttemptAt) <= Date.now()) &&
          (!m.result.sync.leaseExpiresAt ||
            Date.parse(m.result.sync.leaseExpiresAt) <= Date.now()),
      )
      .map((m) => ({
        actor: m.actor || '',
        before: m.before || null,
        result: structuredClone(m.result),
      }));
  }
  claimSync(id: string, owner: string): boolean {
    return this.withLock(() => {
      const ledger = this.read();
      const state = ledger.mutations[id]?.result.sync;
      if (
        !state ||
        state.state !== 'pending' ||
        (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) ||
        (state.leaseExpiresAt && Date.parse(state.leaseExpiresAt) > Date.now())
      )
        return false;
      state.leaseOwner = owner;
      state.leaseExpiresAt = new Date(Date.now() + 120000).toISOString();
      this.write(ledger);
      return true;
    });
  }
  bindSync(id: string, owner: string, tableId: string, recordId: string) {
    this.withLock(() => {
      const ledger = this.read();
      const sync = ledger.mutations[id]?.result.sync;
      if (!sync || sync.leaseOwner !== owner)
        throw new ConflictException('同步任务租约已变化');
      sync.cloudRecords = { ...sync.cloudRecords, [tableId]: recordId };
      this.write(ledger);
    });
  }
  adoptCloud(records: ThresholdRecord[], expectedRevision: number): boolean {
    const ids = new Set<string>();
    for (const record of records) {
      validateInput(record);
      if (
        !record.id ||
        ids.has(record.id) ||
        !Number.isSafeInteger(record.version) ||
        record.version < 1
      )
        throw new BadRequestException('多维表记录标识或版本无效');
      ids.add(record.id);
    }
    return this.withLock(() => {
      const ledger = this.read();
      if (ledger.revision !== expectedRevision) return false;
      const protectedIds = new Set(
        Object.values(ledger.mutations)
          .filter(
            (m) =>
              m.result.sync &&
              ['pending', 'error'].includes(m.result.sync.state),
          )
          .map((m) => m.result.id),
      );
      const next = [
        ...records.filter((r) => !protectedIds.has(r.id)),
        ...ledger.records.filter((r) => protectedIds.has(r.id)),
      ];
      const canonical = (rows: ThresholdRecord[]) =>
        JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
      if (canonical(next) !== canonical(ledger.records)) {
        ledger.records = next;
        ledger.revision += 1;
        ledger.updatedAt = new Date().toISOString();
        this.write(ledger);
      }
      return true;
    });
  }
  syncResults(ids: string[], authorize?: ThresholdMutationScopeCheck): ThresholdMutationResult[] {
    const ledger = this.read();
    return ids.map((id) => {
      const receipt = ledger.mutations[id];
      if (!receipt) throw new NotFoundException('同步任务不存在');
      authorize?.(mutationScopeRecords(ledger, id));
      return structuredClone(receipt.result);
    });
  }
  finishSync(
    id: string,
    state: Pick<ThresholdSyncState, 'state' | 'error' | 'nextAttemptAt'>,
    owner?: string,
  ) {
    this.withLock(() => {
      const ledger = this.read();
      const receipt = ledger.mutations[id];
      if (
        !receipt?.result.sync ||
        ['success', 'cancelled'].includes(receipt.result.sync.state)
      )
        return;
      if (owner && receipt.result.sync.leaseOwner !== owner) return;
      receipt.result.sync = {
        ...state,
        attempts: receipt.result.sync.attempts + 1,
        ...(receipt.result.sync.cloudRecords
          ? { cloudRecords: receipt.result.sync.cloudRecords }
          : {}),
        ...(state.state === 'success'
          ? { finishedAt: new Date().toISOString() }
          : {}),
      };
      ledger.revision += 1;
      ledger.updatedAt = new Date().toISOString();
      this.write(ledger);
    });
  }
  retrySync(id: string, actor: string, authorize?: ThresholdMutationScopeCheck): ThresholdMutationResult {
    return this.withLock(() => {
      const ledger = this.read();
      const receipt = ledger.mutations[id];
      if (!receipt?.result.sync) throw new NotFoundException('同步任务不存在');
      if (receipt.actor !== actor && !actor.startsWith('admin:'))
        throw new ForbiddenException('无权重试该同步任务');
      authorize?.(mutationScopeRecords(ledger, id));
      if (
        receipt.result.sync.leaseExpiresAt &&
        Date.parse(receipt.result.sync.leaseExpiresAt) > Date.now()
      )
        return structuredClone(receipt.result);
      if (!['success', 'cancelled'].includes(receipt.result.sync.state))
        receipt.result.sync = {
          ...receipt.result.sync,
          state: 'pending',
          error: undefined,
          nextAttemptAt: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
        };
      this.write(ledger);
      return structuredClone(receipt.result);
    });
  }
  conflictJob(id: string, actor: string, authorize?: ThresholdMutationScopeCheck): ThresholdSyncJob {
    const ledger = this.read();
    const receipt = ledger.mutations[id];
    if (
      !receipt?.before ||
      receipt.result.sync?.state !== 'error' ||
      !receipt.result.sync.error?.startsWith('多维表记录已')
    )
      throw new ConflictException('该任务没有可恢复的云端冲突');
    if (receipt.actor !== actor && !actor.startsWith('admin:'))
      throw new ForbiddenException('无权处理该同步任务');
    authorize?.(mutationScopeRecords(ledger, id));
    return {
      actor: receipt.actor || '',
      before: receipt.before,
      result: structuredClone(receipt.result),
    };
  }
  acceptCloud(
    id: string,
    actor: string,
    record: ThresholdRecord | null,
    authorize?: ThresholdMutationScopeCheck,
  ): ThresholdMutationResult {
    if (record) validateInput(record);
    return this.withLock(() => {
      const job = this.conflictJob(id, actor, authorize);
      const ledger = this.read();
      if (record && record.id !== job.result.id)
        throw new ConflictException('云端记录标识不符');
      authorize?.([...mutationScopeRecords(ledger, id), ...(record ? [structuredClone(record)] : [])]);
      ledger.records = ledger.records.filter((r) => r.id !== job.result.id);
      if (record) ledger.records.unshift(record);
      ledger.revision += 1;
      ledger.updatedAt = new Date().toISOString();
      const receipt = ledger.mutations[id];
      receipt.result.sync = {
        ...receipt.result.sync!,
        state: 'cancelled',
        finishedAt: ledger.updatedAt,
      };
      this.write(ledger);
      return {
        ...receipt.result,
        record,
        revision: ledger.revision,
        updatedAt: ledger.updatedAt,
      };
    });
  }
  mutate(command: ThresholdCommand, actor: string): ThresholdMutationResult {
    if (
      !command ||
      !['create', 'update', 'delete'].includes(command.operation) ||
      typeof command.clientMutationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,160}$/.test(command.clientMutationId)
    )
      throw new BadRequestException('提交标识或操作无效');
    const record =
      command.operation === 'delete'
        ? undefined
        : validateInput(command.record);
    if (
      this.syncEnabled &&
      record &&
      !(record.profession in THRESHOLD_BITABLE_SCHEMA.tables)
    )
      throw new BadRequestException('该专业尚未接入多维表');
    if (
      command.operation !== 'create' &&
      (typeof command.id !== 'string' ||
        !Number.isSafeInteger(command.expectedVersion) ||
        command.expectedVersion! < 1)
    )
      throw new BadRequestException('记录版本无效');
    const normalized = {
      operation: command.operation,
      id: command.id || '',
      expectedVersion: command.expectedVersion || 0,
      record,
      ...(command.expectedContent !== undefined
        ? { expectedContent: command.expectedContent }
        : {}),
    };
    if (
      command.expectedContent !== undefined &&
      (typeof command.expectedContent !== 'string' ||
        command.expectedContent.length > 24000)
    )
      throw new BadRequestException('原阈值内容无效');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ actor, ...normalized }))
      .digest('hex');
    return this.withLock(() => {
      const ledger = this.read();
      this.importSeeds(ledger);
      const previous = ledger.mutations[command.clientMutationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException('提交标识已用于其他内容或账号');
        return previous.result;
      }
      const now = new Date().toISOString();
      const index = ledger.records.findIndex((item) => item.id === command.id);
      if (
        command.operation !== 'create' &&
        Object.values(ledger.mutations).some(
          (m) =>
            m.result.id === command.id &&
            m.result.sync &&
            ['pending', 'error'].includes(m.result.sync.state),
        )
      )
        throw new ConflictException('该阈值尚未完成同步，请先重试');
      if (command.operation !== 'create') {
        if (index < 0) throw new NotFoundException('阈值已删除，请刷新列表');
        if (ledger.records[index].version !== command.expectedVersion)
          throw new ConflictException('阈值已被修改，请刷新后重新编辑');
        if (
          command.expectedContent !== undefined &&
          command.expectedContent !==
            thresholdContentFingerprint(ledger.records[index])
        )
          throw new ConflictException('阈值已变化，请刷新后重新编辑');
      }
      let next: ThresholdRecord | null = null;
      const before = index >= 0 ? structuredClone(ledger.records[index]) : null;
      const id =
        command.operation === 'create'
          ? `threshold-${randomUUID()}`
          : command.id!;
      if (command.operation === 'delete') ledger.records.splice(index, 1);
      else {
        const range =
          record!.range ??
          (command.operation === 'update'
            ? ledger.records[index].range
            : undefined);
        next = {
          ...record!,
          ...(range === undefined ? {} : { range }),
          id,
          version:
            command.operation === 'create'
              ? 1
              : ledger.records[index].version + 1,
          updatedAt: now,
          source:
            command.operation === 'create'
              ? null
              : ledger.records[index].source,
        };
        if (command.operation === 'create') ledger.records.unshift(next);
        else ledger.records[index] = next;
      }
      ledger.revision += 1;
      ledger.updatedAt = now;
      const result: ThresholdMutationResult = {
        clientMutationId: command.clientMutationId,
        operation: command.operation,
        id,
        record: next,
        revision: ledger.revision,
        updatedAt: now,
        ...(this.syncEnabled
          ? { sync: { state: 'pending' as const, attempts: 0 } }
          : {}),
      };
      ledger.mutations[command.clientMutationId] = {
        fingerprint,
        result,
        ...(this.syncEnabled ? { actor, before } : {}),
      };
      this.write(ledger);
      return result;
    });
  }
  private hasPendingSeeds(ledger: Ledger) {
    return this.additions.some(
      (batch) => !ledger.importedSeeds?.includes(batch.key),
    );
  }
  private importSeeds(ledger: Ledger) {
    if (!this.hasPendingSeeds(ledger)) return;
    const known = new Set(ledger.records.map((record) => record.id));
    // Receipts also retain deleted IDs, so earlier edits/deletes survive a batch adoption.
    for (const receipt of Object.values(ledger.mutations))
      known.add(receipt.result.id);
    const imported = new Set(ledger.importedSeeds || []);
    for (const batch of this.additions) {
      if (imported.has(batch.key)) continue;
      for (const record of batch.records) {
        validateInput(record);
        if (known.has(record.id)) continue;
        ledger.records.push(structuredClone(record));
        known.add(record.id);
      }
      imported.add(batch.key);
    }
    ledger.importedSeeds = [...imported];
    ledger.revision += 1;
    ledger.updatedAt = new Date().toISOString();
    this.write(ledger);
  }
  private withLock<T>(action: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lock, 'wx', 0o600);
    } catch {
      throw new ServiceUnavailableException('阈值正在写入，请稍后重试');
    }
    try {
      return action();
    } finally {
      closeSync(descriptor);
      rmSync(lock, { force: true });
    }
  }
  private read(): Ledger {
    if (!existsSync(this.path))
      return {
        schema: 1,
        records: structuredClone([
          ...this.seed,
          ...this.additions.flatMap((batch) => batch.records),
        ]),
        importedSeeds: this.additions.map((batch) => batch.key),
        revision: 0,
        updatedAt: '',
        mutations: Object.create(null),
      };
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger;
      if (
        value.schema !== 1 ||
        !Array.isArray(value.records) ||
        !Number.isSafeInteger(value.revision) ||
        !value.mutations ||
        typeof value.mutations !== 'object' ||
        Array.isArray(value.mutations) ||
        (value.importedSeeds !== undefined &&
          (!Array.isArray(value.importedSeeds) ||
            value.importedSeeds.some((key) => typeof key !== 'string')))
      )
        throw new Error('invalid ledger');
      const ids = new Set<string>();
      for (const record of value.records) {
        validateInput(record);
        if (
          !record.id ||
          ids.has(record.id) ||
          !Number.isSafeInteger(record.version) ||
          record.version < 1
        )
          throw new Error('invalid record');
        ids.add(record.id);
      }
      for (const receipt of Object.values(value.mutations)) {
        if (
          !receipt ||
          typeof receipt.fingerprint !== 'string' ||
          !receipt.result ||
          typeof receipt.result.id !== 'string'
        )
          throw new Error('invalid mutation receipt');
      }
      value.mutations = Object.assign(Object.create(null), value.mutations);
      return value;
    } catch {
      throw new ServiceUnavailableException(
        '阈值台账读取失败，请联系管理员检查，原数据已保留',
      );
    }
  }
  private write(ledger: Ledger) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(ledger));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
    } catch {
      throw new ServiceUnavailableException('阈值保存失败，请重试');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }
}
function validateInput(value: unknown): ThresholdInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('阈值内容无效');
  const input = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of [
    'profession',
    'device',
    'section',
    'parameter',
    'building',
    'location',
    'value',
    'unit',
    'kind',
    'enabled',
    'note',
  ]) {
    if (
      typeof input[field] !== 'string' ||
      (input[field] as string).length >
        (['value', 'note'].includes(field) ? 4000 : 160)
    )
      throw new BadRequestException(`阈值字段 ${field} 无效`);
    result[field] = (input[field] as string).trim();
  }
  if (!result.profession || !result.device || !result.parameter)
    throw new BadRequestException('专业、设备和参数不能为空');
  for (const field of ['range', 'model', 'brand'])
    if (input[field] !== undefined) {
      if (
        typeof input[field] !== 'string' ||
        (input[field] as string).length > 160
      )
        throw new BadRequestException(
          `${({ range: '运行范围', model: '设备型号', brand: '品牌' } as Record<string, string>)[field]}无效`,
        );
      result[field] = (input[field] as string).trim();
    }
  if (
    /密码|口令|密钥|secret|password|token/i.test(
      `${result.parameter} ${result.section} ${result.note} ${result.range || ''}`,
    )
  )
    throw new BadRequestException('口令和密钥不能保存到阈值台账');
  if (!(THRESHOLD_KINDS as readonly string[]).includes(result.kind))
    throw new BadRequestException('参数类型无效');
  return result as unknown as ThresholdInput;
}
