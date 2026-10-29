import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readEnv } from '../../common/config/external-services.config';
import { resolveDutyDailyReportStateFilePath } from '../duty-schedule/duty-daily-report-state-path';
import type { TodayOperationsFollowUpRecord } from './today-operations-anomaly.types';
import { followUpRecordFingerprint, type FollowUpCardBatch, type FollowUpCardCommand, type FollowUpCardMessage, type FollowUpCardRecord, type FollowUpCardSnapshot, type FollowUpCardView } from './today-operations-follow-up-card.types';

export const FOLLOW_UP_CARD_LEDGER_PATH = Symbol('FOLLOW_UP_CARD_LEDGER_PATH');

interface Ledger {
  version: 1;
  batches: Record<string, FollowUpCardBatch>;
  records: Record<string, FollowUpCardRecord>;
  messages: Record<string, FollowUpCardMessage>;
  commands: Record<string, FollowUpCardCommand>;
}

interface ClaimInput {
  batchId: string;
  messageId: string;
  index: number;
  revision: number;
  acknowledged: boolean;
  completed: boolean;
  treatmentMeasure: string;
  actorOpenId: string;
  actorName: string;
}

@Injectable()
export class TodayOperationsFollowUpCardStore {
  private readonly ledgerPath: string;
  // Serializes this singleton only; this is not a distributed or cross-process lock.
  private operation: Promise<unknown> = Promise.resolve();

  constructor(@Optional() @Inject(FOLLOW_UP_CARD_LEDGER_PATH) ledgerPath?: string) {
    this.ledgerPath = resolveDutyDailyReportStateFilePath({
      fileName: 'today-operations-follow-up-card-ledger.json',
      explicitPath: ledgerPath || readEnv('TODAY_OPERATIONS_FOLLOW_UP_CARD_LEDGER_PATH'),
    });
  }

  prepareBatch(id: string, appId: string, records: TodayOperationsFollowUpRecord[]): Promise<FollowUpCardSnapshot> {
    assertBatchId(id);
    if (!/^cli_[A-Za-z0-9_-]{1,128}$/u.test(appId) || !Array.isArray(records)) throw new BadRequestException('异常跟进批次无效');
    records = structuredClone(records);
    records.forEach(assertRecord);
    const ids = records.map(record => record.recordId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('异常记录重复');
    return this.run(async ledger => {
      const batch = ledger.batches[id];
      if (batch && (batch.appId !== appId || batch.recordIds.length !== ids.length || ids.some(recordId => !batch.recordIds.includes(recordId)))) {
        throw new ConflictException('批次记录范围已固定，请创建新批次');
      }
      let changed = !batch;
      if (!batch) ledger.batches[id] = { id, appId, recordIds: ids, createdAt: new Date().toISOString() };
      for (const record of records) changed = refresh(ledger, record) || changed;
      if (changed) await this.write(ledger);
      return snapshot(ledger, id);
    });
  }

  bindMessage(batchId: string, messageId: string, summaryCard: Record<string, unknown>): Promise<void> {
    assertMessageId(messageId);
    const summary = structuredClone(summaryCard);
    if (!isObject(summary)) throw new BadRequestException('巡视摘要卡片无效');
    return this.run(async ledger => {
      snapshot(ledger, batchId);
      const old = ledger.messages[messageId];
      if (old?.batchId === batchId && JSON.stringify(old.summary) === JSON.stringify(summary)) return;
      ledger.messages[messageId] = { batchId, summary, view: old?.batchId === batchId ? old.view : { kind: 'summary' } };
      for (const command of Object.values(ledger.commands)) {
        if (command.stage !== 'completed' && command.patchedMessageIds.includes(messageId)) {
          command.patchedMessageIds = command.patchedMessageIds.filter(id => id !== messageId);
          command.nextAttemptAt = Date.now();
        }
      }
      await this.write(ledger);
    });
  }

  getSnapshot(batchId: string, messageId?: string): Promise<FollowUpCardSnapshot> {
    return this.run(ledger => snapshot(ledger, batchId, messageId));
  }

  setView(batchId: string, messageId: string, view: FollowUpCardView): Promise<void> {
    view = structuredClone(view);
    return this.run(async ledger => {
      const current = snapshot(ledger, batchId, messageId);
      assertView(view, current.records.length);
      if (JSON.stringify(current.message!.view) === JSON.stringify(view)) return;
      ledger.messages[messageId].view = view;
      await this.write(ledger);
    });
  }

  refreshRecord(batchId: string, messageId: string, record: TodayOperationsFollowUpRecord): Promise<FollowUpCardSnapshot> {
    record = structuredClone(record);
    assertRecord(record);
    return this.run(async ledger => {
      const current = snapshot(ledger, batchId, messageId);
      if (!current.batch.recordIds.includes(record.recordId)) throw new BadRequestException('记录不属于当前批次');
      if (refresh(ledger, record)) await this.write(ledger);
      return snapshot(ledger, batchId, messageId);
    });
  }

  claim(input: ClaimInput): Promise<{ claimed: boolean; command: FollowUpCardCommand; snapshot: FollowUpCardSnapshot }> {
    input = structuredClone(input);
    if (!Number.isSafeInteger(input.index) || input.index < 0 || !positiveInteger(input.revision) ||
        typeof input.acknowledged !== 'boolean' || typeof input.completed !== 'boolean' ||
        typeof input.treatmentMeasure !== 'string' || Array.from(input.treatmentMeasure).length > 500 ||
        !/^ou_[A-Za-z0-9_-]{1,128}$/u.test(input.actorOpenId) || typeof input.actorName !== 'string' ||
        !input.actorName.trim() || input.actorName.length > 100) throw new BadRequestException('异常跟进提交参数无效');
    input.treatmentMeasure = input.treatmentMeasure.trim();
    input.actorName = input.actorName.trim();
    if (input.completed && Array.from(input.treatmentMeasure).length < 2) throw new BadRequestException('完成前请填写处理措施');
    return this.run(async ledger => {
      const current = snapshot(ledger, input.batchId, input.messageId);
      const recordId = current.batch.recordIds[input.index];
      if (!recordId) throw new BadRequestException('异常记录位置无效');
      const entry = ledger.records[recordId];
      if (input.revision > entry.revision) throw new ConflictException('卡片记录版本无效');
      const id = commandId(recordId, input.revision);
      let existing = ledger.commands[id] || (entry.pendingCommandId ? ledger.commands[entry.pendingCommandId] : undefined);
      if (!existing && (input.revision !== entry.revision || entry.record.completed)) {
        existing = Object.values(ledger.commands).filter(command => command.recordId === recordId).sort((a, b) => b.revision - a.revision)[0];
      }
      if (existing) return { claimed: false, command: existing, snapshot: current };
      if (entry.record.completed) throw new ConflictException('该异常已处理完成');
      if (input.revision !== entry.revision) throw new ConflictException('记录已更新，请重新查看卡片');
      if (current.message?.view.kind !== 'edit' || current.message.view.index !== input.index) {
        throw new ConflictException('卡片页面已切换，请重新打开该记录后提交');
      }
      const command: FollowUpCardCommand = {
        id, batchId: input.batchId, sourceMessageId: input.messageId, recordId, revision: entry.revision,
        expected: structuredClone(entry.record),
        update: { recordId, acknowledged: input.acknowledged || input.completed, completed: input.completed,
          treatmentMeasure: input.treatmentMeasure, handlerName: input.actorName, clientMutationId: `followup-card-${id}` },
        actorOpenId: input.actorOpenId, actorName: input.actorName, stage: 'pending', patchedMessageIds: [],
        attempts: 0, nextAttemptAt: 0, lastError: '', createdAt: new Date().toISOString(),
      };
      ledger.commands[id] = command;
      entry.pendingCommandId = id;
      await this.write(ledger);
      return { claimed: true, command, snapshot: snapshot(ledger, input.batchId, input.messageId) };
    });
  }

  pendingCommands(now = Date.now()): Promise<FollowUpCardCommand[]> {
    if (!Number.isFinite(now)) throw new BadRequestException('重试时间无效');
    return this.run(ledger => Object.values(ledger.commands).filter(command => command.stage !== 'completed' && command.nextAttemptAt <= now));
  }

  markWritten(id: string, record: TodayOperationsFollowUpRecord): Promise<void> {
    return this.markResult(id, record, 'written', '');
  }

  markConflict(id: string, record: TodayOperationsFollowUpRecord, error: unknown): Promise<void> {
    return this.markResult(id, record, 'conflict', errorText(error));
  }

  messagesForRecord(recordId: string): Promise<Array<{ messageId: string; snapshot: FollowUpCardSnapshot }>> {
    assertRecordId(recordId);
    return this.run(ledger => Object.entries(ledger.messages)
      .filter(([, message]) => ledger.batches[message.batchId].recordIds.includes(recordId))
      .map(([messageId, message]) => ({ messageId, snapshot: snapshot(ledger, message.batchId, messageId) })));
  }

  markPatched(id: string, messageId: string): Promise<void> {
    assertMessageId(messageId);
    return this.run(async ledger => {
      const command = requireCommand(ledger, id);
      if (command.stage === 'completed') return;
      if (command.stage === 'pending') throw new ConflictException('业务结果尚未确认');
      const message = ledger.messages[messageId];
      if (!message || !ledger.batches[message.batchId].recordIds.includes(command.recordId)) throw new ConflictException('卡片绑定已变化');
      if (command.patchedMessageIds.includes(messageId)) return;
      command.patchedMessageIds.push(messageId);
      await this.write(ledger);
    });
  }

  complete(id: string): Promise<void> {
    return this.run(async ledger => {
      const command = requireCommand(ledger, id);
      if (command.stage === 'completed') return;
      if (command.stage === 'pending') throw new ConflictException('业务结果尚未确认');
      if (Object.entries(ledger.messages).some(([messageId, message]) =>
        ledger.batches[message.batchId].recordIds.includes(command.recordId) && !command.patchedMessageIds.includes(messageId))) {
        throw new ConflictException('仍有卡片等待同步');
      }
      command.stage = 'completed';
      delete ledger.records[command.recordId].pendingCommandId;
      await this.write(ledger);
    });
  }

  recordFailure(id: string, error: unknown): Promise<void> {
    const message = errorText(error);
    return this.run(async ledger => {
      const command = requireCommand(ledger, id);
      if (command.stage === 'completed') return;
      command.attempts += 1;
      command.nextAttemptAt = Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(command.attempts - 1, 9));
      command.lastError = message;
      await this.write(ledger);
    });
  }

  private markResult(id: string, record: TodayOperationsFollowUpRecord, stage: 'written' | 'conflict', error: string): Promise<void> {
    record = structuredClone(record);
    assertRecord(record);
    return this.run(async ledger => {
      const command = requireCommand(ledger, id);
      if (record.recordId !== command.recordId) throw new BadRequestException('业务结果记录不匹配');
      if (command.stage !== 'pending') {
        if (command.result && followUpRecordFingerprint(command.result) === followUpRecordFingerprint(record) &&
            (command.stage === stage || command.stage === 'completed')) return;
        throw new ConflictException('业务结果已经确定');
      }
      const entry = ledger.records[command.recordId];
      entry.record = record;
      entry.revision += 1;
      command.result = structuredClone(record);
      command.stage = stage;
      command.lastError = error;
      command.nextAttemptAt = 0;
      await this.write(ledger);
    });
  }

  private run<T>(action: (ledger: Ledger) => T | Promise<T>): Promise<T> {
    const result = this.operation.then(async () => structuredClone(await action(await this.read())));
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<Ledger> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.ledgerPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, batches: {}, records: {}, messages: {}, commands: {} };
      throw error;
    }
    assertLedger(value);
    return value;
  }

  private async write(ledger: Ledger): Promise<void> {
    assertLedger(ledger);
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const temporary = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.ledgerPath);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

function snapshot(ledger: Ledger, batchId: string, messageId?: string): FollowUpCardSnapshot {
  assertBatchId(batchId);
  const batch = ledger.batches[batchId];
  if (!batch) throw new NotFoundException('未找到异常跟进批次');
  const message = messageId === undefined ? undefined : ledger.messages[messageId];
  if (messageId !== undefined) {
    assertMessageId(messageId);
    if (!message || message.batchId !== batchId) throw new ConflictException('卡片与批次不匹配');
  }
  const records = batch.recordIds.map(id => ledger.records[id]);
  const pendingCommands = records.flatMap(row => {
    const command = row.pendingCommandId ? ledger.commands[row.pendingCommandId] : undefined;
    return command ? [{ id: command.id, stage: command.stage, update: command.update }] : [];
  });
  return { batch, records, ...(message ? { message } : {}), ...(pendingCommands.length ? { pendingCommands } : {}) };
}

function refresh(ledger: Ledger, record: TodayOperationsFollowUpRecord): boolean {
  const current = ledger.records[record.recordId];
  if (!current) { ledger.records[record.recordId] = { record, revision: 1 }; return true; }
  if (current.pendingCommandId || followUpRecordFingerprint(current.record) === followUpRecordFingerprint(record)) return false;
  current.record = record;
  current.revision += 1;
  return true;
}

function commandId(recordId: string, revision: number): string {
  return createHash('sha256').update(JSON.stringify(['followup-card-v1', recordId, revision])).digest('hex');
}

function requireCommand(ledger: Ledger, id: string): FollowUpCardCommand {
  if (!/^[a-f0-9]{64}$/u.test(id) || !ledger.commands[id]) throw new NotFoundException('未找到异常跟进操作');
  return ledger.commands[id];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function assertBatchId(id: string): void { if (!/^[a-f0-9]{32}$/u.test(id)) throw new BadRequestException('异常跟进批次无效'); }
function assertMessageId(id: string): void { if (!/^om_[A-Za-z0-9_-]{1,252}$/u.test(id)) throw new BadRequestException('异常跟进消息无效'); }
function assertRecordId(id: string): void { if (!/^rec[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new BadRequestException('异常记录标识无效'); }
function assertRecord(value: unknown): asserts value is TodayOperationsFollowUpRecord {
  if (!isObject(value) || typeof value.recordId !== 'string') throw new BadRequestException('异常记录格式无效');
  assertRecordId(value.recordId);
  for (const key of ['issueKey', 'date', 'source', 'item', 'description', 'building', 'treatmentMeasure', 'handlerName', 'handledAt']) {
    if (typeof value[key] !== 'string') throw new BadRequestException('异常记录字段无效');
  }
  if (typeof value.acknowledged !== 'boolean' || typeof value.completed !== 'boolean') throw new BadRequestException('异常记录状态无效');
}
function assertView(view: unknown, count: number): asserts view is FollowUpCardView {
  if (!isObject(view) || !(view.kind === 'summary' ||
      (view.kind === 'list' && Number.isSafeInteger(view.page) && Number(view.page) >= 0 && Number(view.page) <= Math.max(0, count - 1)) ||
      (view.kind === 'edit' && Number.isSafeInteger(view.index) && Number(view.index) >= 0 && Number(view.index) < count))) {
    throw new BadRequestException('异常跟进视图无效');
  }
}
function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error || '处理失败')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/giu, '$1=[redacted]').slice(0, 500);
}

function assertLedger(value: unknown): asserts value is Ledger {
  try {
    if (!isObject(value) || value.version !== 1 || Object.keys(value).sort().join(',') !== 'batches,commands,messages,records,version') throw new Error();
    for (const key of ['batches', 'records', 'messages', 'commands']) if (!isObject(value[key])) throw new Error();
    const ledger = value as unknown as Ledger;
    for (const [id, entry] of Object.entries(ledger.records)) {
      assertRecordId(id); assertRecord(entry.record);
      if (entry.record.recordId !== id || !positiveInteger(entry.revision)) throw new Error();
      if (entry.pendingCommandId !== undefined && (typeof entry.pendingCommandId !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.pendingCommandId))) throw new Error();
    }
    for (const [id, batch] of Object.entries(ledger.batches)) {
      assertBatchId(id);
      if (batch.id !== id || !/^cli_[A-Za-z0-9_-]{1,128}$/u.test(batch.appId) || !Array.isArray(batch.recordIds) ||
          new Set(batch.recordIds).size !== batch.recordIds.length || typeof batch.createdAt !== 'string' || !Number.isFinite(Date.parse(batch.createdAt)) ||
          batch.recordIds.some(recordId => !Object.hasOwn(ledger.records, recordId))) throw new Error();
    }
    for (const [id, message] of Object.entries(ledger.messages)) {
      assertMessageId(id);
      if (!Object.hasOwn(ledger.batches, message.batchId) || !isObject(message.summary)) throw new Error();
      assertView(message.view, ledger.batches[message.batchId].recordIds.length);
    }
    for (const [id, command] of Object.entries(ledger.commands)) {
      if (id !== commandId(command.recordId, command.revision) || command.id !== id || !positiveInteger(command.revision) ||
          !Object.hasOwn(ledger.batches, command.batchId) || !ledger.batches[command.batchId].recordIds.includes(command.recordId) ||
          !['pending', 'written', 'conflict', 'completed'].includes(command.stage) ||
          !Number.isSafeInteger(command.attempts) || command.attempts < 0 || !Number.isFinite(command.nextAttemptAt) || command.nextAttemptAt < 0 ||
          typeof command.lastError !== 'string' || typeof command.createdAt !== 'string' || !Number.isFinite(Date.parse(command.createdAt)) ||
          !/^ou_[A-Za-z0-9_-]{1,128}$/u.test(command.actorOpenId) || typeof command.actorName !== 'string' || !command.actorName.trim() || command.actorName.length > 100 ||
          !Array.isArray(command.patchedMessageIds) || new Set(command.patchedMessageIds).size !== command.patchedMessageIds.length) throw new Error();
      assertMessageId(command.sourceMessageId); command.patchedMessageIds.forEach(assertMessageId); assertRecord(command.expected);
      if (command.expected.recordId !== command.recordId || command.update.recordId !== command.recordId ||
          command.update.clientMutationId !== `followup-card-${id}` || typeof command.update.acknowledged !== 'boolean' ||
          typeof command.update.completed !== 'boolean' || typeof command.update.treatmentMeasure !== 'string' || Array.from(command.update.treatmentMeasure).length > 500 ||
          command.update.handlerName !== command.actorName || (command.update.completed && (!command.update.acknowledged || Array.from(command.update.treatmentMeasure.trim()).length < 2))) throw new Error();
      if (command.stage === 'pending' && (command.result !== undefined || command.patchedMessageIds.length)) throw new Error();
      if (command.stage !== 'pending') { assertRecord(command.result); if (command.result.recordId !== command.recordId) throw new Error(); }
      if (command.stage !== 'completed') {
        const entry = ledger.records[command.recordId];
        if (entry.pendingCommandId !== id || entry.revision !== command.revision + (command.stage === 'pending' ? 0 : 1) ||
            followUpRecordFingerprint(entry.record) !== followUpRecordFingerprint(command.stage === 'pending' ? command.expected : command.result!)) throw new Error();
      }
    }
    for (const [recordId, entry] of Object.entries(ledger.records)) {
      if (entry.pendingCommandId && (!Object.hasOwn(ledger.commands, entry.pendingCommandId) ||
          ledger.commands[entry.pendingCommandId].recordId !== recordId || ledger.commands[entry.pendingCommandId].stage === 'completed')) throw new Error();
    }
  } catch { throw new Error('异常跟进卡片台账损坏，已停止处理'); }
}
