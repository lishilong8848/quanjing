import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { extractDisplayText, fetchBitableRecords, pickField, readLatestPersistedBitableRecordSnapshot, resolveBitableAppToken, type PersistedBitableRecordSnapshot } from '@server/common/feishu/bitable-direct-read';
import { ATTACHED_BANK, getAttachedBankDisplayType, scoreAttachedBank, type BankAnswer, type BankVersion } from '../../../shared/mbti-attached-bank-model';
import { DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, DEFAULT_ACTIVE_PERSONNEL_VIEW_ID, buildActivePersonnelDirectory, isInactivePersonnelRecord, searchActivePersonnelCandidates } from './active-personnel-directory';
import { readEmployeeOnboardingConfig } from './employee-onboarding.config';
import { EmployeeOnboardingGateway } from './employee-onboarding.gateway';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { isPersonalAccessAccount, resolveSelfServiceApplicant } from '@shared/self-service-applicant';
import { bindSelfServiceApplicant, resolveSelfServicePersonnelRecord } from '@server/common/access/self-service-applicant';
import { readEnv } from '@server/common/config/external-services.config';

interface Submission {
  actor?: AccessPrincipal;
  payloadHash: string;
  recordId: string;
  name: string;
  version: BankVersion;
  answers?: BankAnswer[];
  type: string;
  state: 'accepted' | 'success' | 'error';
  error?: string;
  updatedAt: string;
}
interface Ticket { recordId: string; name: string; expiresAt: number }
interface Ledger { version: 1; submissions: Record<string, Submission>; tickets: Record<string, Ticket> }
interface SubmitRequest {
  clientMutationId: string;
  audience: 'active' | 'new';
  recordId?: string;
  name?: string;
  ticket?: string;
  version: BankVersion;
  answers: BankAnswer[];
  sourceSha256: string;
}

const MUTATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RECORD_ID = /^rec[A-Za-z0-9]+$/u;
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TICKET_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class MbtiAssessmentService {
  private readonly logger = new Logger(MbtiAssessmentService.name);
  private readonly ledgerPath = resolve(process.env.MBTI_ASSESSMENT_LEDGER_PATH || '../nantong-schedule-state/mbti-assessment-ledger.json');
  private operation: Promise<unknown> = Promise.resolve();
  private readonly processing = new Set<string>();
  private readonly reschedule = new Set<string>();
  private readonly recordQueues = new Map<string, Promise<void>>();
  private cachedSnapshot: PersistedBitableRecordSnapshot | null = null;
  private refreshPromise: Promise<PersistedBitableRecordSnapshot> | null = null;

  constructor(private readonly gateway: EmployeeOnboardingGateway, private readonly http: HttpService) {
    setImmediate(() => { void this.resumePending().catch(() => this.logger.error('MBTI 待同步记录恢复失败')); });
  }

  async searchPeople(query: unknown) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 40) {
      throw new BadRequestException('请输入至少两个字查找在职员工');
    }
    const normalized = query.trim();
    const snapshot = this.cachedSnapshot || await readLatestPersistedBitableRecordSnapshot({
      tableId: DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, viewId: DEFAULT_ACTIVE_PERSONNEL_VIEW_ID, tableName: '在职人员',
    });
    const initial = snapshot && buildActivePersonnelDirectory(snapshot);
    if (initial) {
      const people = searchActivePersonnelCandidates(initial, normalized);
      if (people.length) return { people, stale: initial.snapshot.stale };
    }
    try {
      const fresh = buildActivePersonnelDirectory(await this.refreshPeople());
      return { people: searchActivePersonnelCandidates(fresh, normalized), stale: false };
    } catch {
      if (initial) return { people: [], stale: true };
      throw new ServiceUnavailableException('在职员工名单暂时无法加载');
    }
  }

  async issueOnboardingTicket(recordId: string, name: string): Promise<string> {
    if (!RECORD_ID.test(recordId) || !name.trim()) throw new BadRequestException('新员工记录无效');
    const ticket = randomUUID();
    await this.serialize(async () => {
      const ledger = await this.readLedger();
      ledger.tickets[ticket] = { recordId, name: name.trim(), expiresAt: Date.now() + TICKET_LIFETIME_MS };
      await this.writeLedger(ledger);
    });
    return ticket;
  }

  async onboardingContext(ticket: unknown) {
    if (typeof ticket !== 'string' || !TICKET_ID.test(ticket)) throw new BadRequestException('测试链接无效');
    const ledger = await this.serialize(() => this.readLedger());
    const entry = ledger.tickets[ticket];
    if (!entry || entry.expiresAt <= Date.now()) throw new NotFoundException('测试链接已失效，请从入职登记重新进入');
    return { recordId: entry.recordId, name: entry.name };
  }

  async currentPerson(principal: AccessPrincipal | undefined, authenticated: boolean) {
    bindSelfServiceApplicant('', principal, authenticated, '开始 MBTI 测试');
    if (resolveSelfServiceApplicant(principal, authenticated).mode !== 'automatic') throw new BadRequestException('当前账号需要从名单中选择人员');
    const config = readEmployeeOnboardingConfig();
    if (config.tableId !== DEFAULT_ACTIVE_PERSONNEL_TABLE_ID) throw new ServiceUnavailableException('示例人员016数据源与登录人员资料不一致，请联系管理员核对');
    const appToken = await resolveBitableAppToken(this.http, { appToken: config.appToken, wikiToken: config.wikiToken, tableName: config.tableName, requestTimeoutMs: () => 8_000 });
    let snapshot = this.cachedSnapshot || await readLatestPersistedBitableRecordSnapshot({ appToken, tableId: DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, viewId: DEFAULT_ACTIVE_PERSONNEL_VIEW_ID, tableName: '在职人员' });
    if (!snapshot || snapshot.expiresAt <= Date.now()) snapshot = await this.refreshPeople();
    this.cachedSnapshot = snapshot;
    const record = resolveSelfServicePersonnelRecord(principal!, { appId: readEnv('FEISHU_APP_ID'), appToken, tableId: DEFAULT_ACTIVE_PERSONNEL_TABLE_ID }, snapshot.records.filter(record => !isInactivePersonnelRecord(record.fields || {})));
    const person = buildActivePersonnelDirectory({ ...snapshot, records: [record] }).selectablePersonnel?.[0];
    if (!person) throw new ForbiddenException('登录人员资料无效，请联系管理员核对');
    return { recordId: person.recordId, name: person.name, position: person.position, buildings: person.buildings };
  }

  async submit(raw: unknown, principal?: AccessPrincipal) {
    const request = this.parseSubmission(raw);
    if (request.audience === 'active' && isPersonalAccessAccount(principal)) {
      const person = await this.currentPerson(principal, true);
      if (request.recordId !== person.recordId || request.name?.trim() !== person.name) throw new ForbiddenException('示例人员016必须为当前登录本人');
    }
    const result = scoreAttachedBank(request.version, request.answers);
    const type = getAttachedBankDisplayType(result);
    const context = request.audience === 'new'
      ? await this.onboardingContext(request.ticket)
      : { recordId: request.recordId!, name: request.name!.trim() };
    const payloadHash = createHash('sha256').update(JSON.stringify({ context, version: request.version, answers: request.answers, source: request.sourceSha256 })).digest('hex');
    const existing = await this.serialize(async () => {
      const ledger = await this.readLedger();
      const previous = ledger.submissions[request.clientMutationId];
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new ConflictException('本次提交标识与已有答案不一致');
        if (previous.state === 'error') {
          const ordered = Object.entries(ledger.submissions);
          const previousIndex = ordered.findIndex(([id]) => id === request.clientMutationId);
          if (ordered.slice(previousIndex + 1).some(([, item]) => item.recordId === previous.recordId)) {
            throw new ConflictException('该员工已有更新的测试结果，请返回最新测试');
          }
          previous.state = 'accepted';
          previous.error = undefined;
          previous.updatedAt = new Date().toISOString();
          await this.writeLedger(ledger);
        }
        return previous;
      }
      const entry: Submission = {
        ...(request.audience === 'active' && isPersonalAccessAccount(principal) ? { actor: { role: principal!.role, purchaseBuilding: null, accountId: principal!.accountId, displayName: principal!.displayName } } : {}),
        payloadHash, recordId: context.recordId, name: context.name, version: request.version,
        answers: request.answers, type, state: 'accepted', updatedAt: new Date().toISOString(),
      };
      ledger.submissions[request.clientMutationId] = entry;
      await this.writeLedger(ledger);
      return entry;
    });
    if (existing.state === 'accepted') this.scheduleSync(request.clientMutationId, existing.recordId);
    return { clientMutationId: request.clientMutationId, recordId: existing.recordId, type: existing.type, syncState: existing.state, message: existing.error };
  }

  async status(mutationId: unknown) {
    if (typeof mutationId !== 'string' || !MUTATION_ID.test(mutationId)) throw new BadRequestException('提交标识无效');
    const ledger = await this.serialize(() => this.readLedger());
    const entry = ledger.submissions[mutationId];
    if (!entry) throw new NotFoundException('未找到该次测试提交');
    return { clientMutationId: mutationId, recordId: entry.recordId, type: entry.type, syncState: entry.state, message: entry.error };
  }

  private parseSubmission(raw: unknown): SubmitRequest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('提交内容无效');
    const value = raw as Record<string, unknown>;
    if (typeof value.clientMutationId !== 'string' || !MUTATION_ID.test(value.clientMutationId) ||
      (value.audience !== 'active' && value.audience !== 'new') ||
      (value.version !== 'short' && value.version !== 'full') || value.sourceSha256 !== ATTACHED_BANK.sourceSha256 ||
      !Array.isArray(value.answers) ||
      (value.audience === 'active' && (!RECORD_ID.test(String(value.recordId || '')) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 40)) ||
      (value.audience === 'new' && (typeof value.ticket !== 'string' || !TICKET_ID.test(value.ticket)))) {
      throw new BadRequestException('提交信息无效，请返回重新选择');
    }
    try { scoreAttachedBank(value.version, value.answers as BankAnswer[]); }
    catch { throw new BadRequestException('题目尚未完整作答'); }
    return value as unknown as SubmitRequest;
  }

  private scheduleSync(mutationId: string, recordId: string): void {
    if (this.processing.has(mutationId)) { this.reschedule.add(mutationId); return; }
    this.processing.add(mutationId);
    const previous = this.recordQueues.get(recordId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.performSync(mutationId));
    this.recordQueues.set(recordId, next);
    void next
        .catch(() => this.logger.error('MBTI 后台同步任务未能完成'))
        .finally(() => {
          if (this.recordQueues.get(recordId) === next) this.recordQueues.delete(recordId);
          this.processing.delete(mutationId);
          if (this.reschedule.delete(mutationId)) this.scheduleSync(mutationId, recordId);
        });
  }

  private async performSync(mutationId: string): Promise<void> {
    const ledger = await this.serialize(() => this.readLedger());
    const entry = ledger.submissions[mutationId];
    if (!entry || entry.state !== 'accepted') return;
    try {
      const fields = await this.gateway.readRecord(entry.recordId);
      if (!fields || isInactivePersonnelRecord(fields) ||
        extractDisplayText(pickField(fields, ['姓名', '员工姓名']), ' ').trim() !== entry.name) {
        throw new Error('员工记录已变更，请重新选择姓名');
      }
      if (entry.actor) {
        const config = readEmployeeOnboardingConfig();
        const appToken = await resolveBitableAppToken(this.http, { appToken: config.appToken, wikiToken: config.wikiToken, tableName: config.tableName, requestTimeoutMs: () => 8_000 });
        if (config.tableId !== DEFAULT_ACTIVE_PERSONNEL_TABLE_ID) throw new ForbiddenException('示例人员016数据源已变更，请联系管理员核对');
        resolveSelfServicePersonnelRecord(entry.actor, { appId: readEnv('FEISHU_APP_ID'), appToken, tableId: config.tableId }, [{ record_id: entry.recordId, fields }]);
      }
      await this.gateway.updateMbti(entry.recordId, entry.type);
      await this.serialize(async () => {
        const updated = await this.readLedger();
        const current = updated.submissions[mutationId];
        if (!current || current.payloadHash !== entry.payloadHash) return;
        current.state = 'success'; current.error = undefined; current.answers = undefined;
        current.updatedAt = new Date().toISOString();
        await this.writeLedger(updated);
      });
    } catch (error) {
      await this.serialize(async () => {
        const updated = await this.readLedger();
        const current = updated.submissions[mutationId];
        if (!current || current.payloadHash !== entry.payloadHash) return;
        current.state = 'error';
        current.error = error instanceof ForbiddenException || (error instanceof Error && error.message === '员工记录已变更，请重新选择姓名')
          ? error.message : '飞书同步暂时失败，请重试';
        current.updatedAt = new Date().toISOString();
        await this.writeLedger(updated);
      });
    }
  }

  private async resumePending(): Promise<void> {
    const ledger = await this.serialize(() => this.readLedger());
    Object.entries(ledger.submissions).forEach(([id, entry]) => { if (entry.state === 'accepted') this.scheduleSync(id, entry.recordId); });
  }

  private async refreshPeople(): Promise<PersistedBitableRecordSnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const config = readEmployeeOnboardingConfig();
      const appToken = await resolveBitableAppToken(this.http, {
        appToken: config.appToken, wikiToken: config.wikiToken, tableName: config.tableName,
        requestTimeoutMs: () => 8_000,
      });
      const records = await fetchBitableRecords(this.http, {
        appToken, tableId: DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, viewId: DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
        tableName: '在职人员', forceRefresh: true, allowStale: false, strict: true,
      });
      this.cachedSnapshot = { records, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 };
      return this.cachedSnapshot;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operation.then(work, work);
    this.operation = next.catch(() => undefined);
    return next;
  }
  private async readLedger(): Promise<Ledger> {
    try {
      const value = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as Ledger;
      if (value.version !== 1 || !value.submissions || !value.tickets) throw new Error('invalid ledger');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, submissions: {}, tickets: {} };
      throw new ServiceUnavailableException('测试同步记录暂时不可用');
    }
  }
  private async writeLedger(ledger: Ledger): Promise<void> {
    try {
      await mkdir(dirname(this.ledgerPath), { recursive: true });
      const temporary = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(ledger), 'utf8');
      await rename(temporary, this.ledgerPath);
    } catch { throw new ServiceUnavailableException('测试提交暂时无法保存，请稍后重试'); }
  }
}
