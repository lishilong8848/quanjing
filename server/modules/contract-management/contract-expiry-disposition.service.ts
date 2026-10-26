import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  ContractCreatePaymentPlanInput,
  ContractCreateNotificationResult,
  ContractExpiryDispositionRequest,
  ContractExpiryDispositionResponse,
  ContractExpiryDispositionSubmissionResponse,
  ContractExpiryDispositionTask,
  ContractExpiryDispositionTaskStatusResponse,
} from '../../../shared/contract-management.interface';
import {
  extractDateValue,
  extractDisplayText,
  extractNumberValue,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { ContractExpiryDispositionGateway } from './contract-expiry-disposition.gateway';
import { ContractCreationGateway } from './contract-creation.gateway';
import {
  buildPaymentCreateFields,
  FIXED_PAYMENT_FIELDS,
} from './contract-payment-follow-up.rules';
import {
  assertKnownPersonOpenId,
  collectKnownPersonOpenIds,
} from './contract-person-validation';
import { ContractWorkflowService } from './contract-workflow.service';
import { ContractWorkflowStore, contractDispositionRecoveryVersion, type ContractDispositionTaskEntry } from './contract-workflow.store';
import { extractLinkedRecordIds } from './contract-management.mapper';
import type { PersonnelRecoveryActor, PersonnelRecoveryPreview, PersonnelRecoveryRequest, PersonnelRecoveryResult, PersonnelRecoveryTask } from '../../../shared/personnel-task-recovery.interface';
import { assertRecoveryRequest } from '../../common/access/personnel-task-recovery.validation';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { hasBusinessPermissionSomewhere } from '../../../shared/business-permissions';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ContractExpiryDispositionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractExpiryDispositionService.name);
  private readonly queued = new Set<string>();
  private work = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly gateway: ContractExpiryDispositionGateway,
    private readonly creationGateway: ContractCreationGateway,
    private readonly workflow: ContractWorkflowService,
    private readonly store: ContractWorkflowStore,
    private readonly accessConfiguration: AccessConfigurationService,
  ) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      for (const entry of await this.store.recoverDispositionTasks()) this.launch(entry.task.id);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    await this.work;
  }

  async submit(
    recordIdValue: string,
    request: ContractExpiryDispositionRequest,
    now = new Date(),
    principal?: AccessPrincipal,
  ): Promise<ContractExpiryDispositionSubmissionResponse> {
    const recordId = validateSubmissionRequest(recordIdValue, request);
    if (!principal?.accountId || !Number.isSafeInteger(principal.authorizationVersion)) throw new ForbiddenException('需要有效的合同处置登录身份');
    const entry = await this.store.acceptDispositionTask({recordId,request,now:now.toISOString(),principal},()=>{
      const current=this.accessConfiguration.currentPrincipal(principal.accountId,principal.authorizationVersion);
      return !!current && current.role===principal.role && hasBusinessPermissionSomewhere(current, { module: 'contracts', action: 'update' });
    });
    this.launch(entry.task.id);
    return this.toSubmissionResponse(entry.task);
  }

  async getTaskStatus(taskIdValue: string): Promise<ContractExpiryDispositionTaskStatusResponse> {
    const taskId = String(taskIdValue || '').trim();
    const task = taskId ? (await this.store.getDispositionTask(taskId))?.task : undefined;
    if (!task) {
      return {
        success: false,
        message: '合同到期处置后台任务不存在或已过期',
      };
    }
    return { success: true, task: { ...task } };
  }

  async listRecoveryTasks(): Promise<PersonnelRecoveryTask[]> {
    return (await this.store.listDispositionTasks()).filter(entry => entry.uncertain || entry.recoveries?.length).map(dispositionRecoverySummary);
  }

  async previewRecoveryTask(input: PersonnelRecoveryRequest): Promise<PersonnelRecoveryPreview> {
    return (await this.readRecoveryEvidence(input)).preview;
  }

  async recoverTask(input: PersonnelRecoveryRequest, actor: PersonnelRecoveryActor, authorize: () => void): Promise<PersonnelRecoveryResult> {
    assertRecoveryRequest(input); authorize();
    const original = await this.recoveryEntry(input);
    const prior = original.recoveries?.find(row => row.clientMutationId === input.clientMutationId);
    if (prior) {
      if (original.task.status !== 'completed' || prior.previousVersion !== input.expectedVersion || prior.actorId !== actor.id || prior.authorizationVersion !== actor.authorizationVersion || JSON.stringify(prior.evidence?.recordIds) !== JSON.stringify(input.selections || [])) throw new ConflictException('合同恢复重复请求内容已变化');
      authorize(); return { status: 'completed', message: original.task.message };
    }
    const { entry, preview, fields, endDate, evidenceHash, nativeVersion } = await this.readRecoveryEvidence(input);
    authorize();
    if (!preview.canConfirm || preview.version !== input.expectedVersion) throw new ConflictException(preview.message || '合同或付款计划已变化，请重新核对');
    const selections = input.selections || [];
    if (selections.length !== preview.choices.length || preview.choices.some((choice, index) => !choice.options.some(option => option.value === selections[index]))) throw new BadRequestException('请逐条选择并核对本次续期的付款计划');
    const key = `contract-lifecycle:${entry.task.recordId}:${entry.request.action}:${endDate}`;
    const notification = await this.store.getRoleNotification(key);
    if (notification && (notification.appId !== entry.appId || notification.kind !== 'card')) throw new ConflictException('原合同通知身份已变化，请核对原任务');
    if (!notification) await this.startLifecycleNotification({ action: entry.request.action, recordId: entry.task.recordId, fields, endDate }, authorize);
    await this.store.confirmDispositionRecovery(input, nativeVersion, actor, { hash: evidenceHash, recordIds: selections }, authorize);
    return { status: 'completed', message: '合同处置结果已核对，通知按原任务继续处理' };
  }

  private async recoveryEntry(input: PersonnelRecoveryRequest): Promise<ContractDispositionTaskEntry> {
    assertRecoveryRequest(input);
    const entry = await this.store.getDispositionTask(input.taskId);
    if (input.module !== 'contracts' || !entry || entry.appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('原合同任务或应用身份已变化');
    return entry;
  }

  private async readRecoveryEvidence(input: PersonnelRecoveryRequest) {
    const entry = await this.recoveryEntry(input), task = dispositionRecoverySummary(entry);
    const nativeVersion = contractDispositionRecoveryVersion(entry);
    const record = await this.gateway.getContract(entry.task.recordId);
    if ((record.record_id || record.id) !== entry.task.recordId) throw new ConflictException('合同记录身份不一致，请重新核对');
    const fields = record.fields || {}, endDate = extractDateValue(fields['合同结束日期']) || '';
    const disposition = extractDisplayText(fields['合同到期处置']);
    const plans = entry.request.action === 'renew' ? validateRenewalPaymentPlans(entry.request) : [];
    if (plans.length > 200) throw new ConflictException('原付款计划过多，请核对原合同任务');
    const expectedEndDate = entry.request.action === 'renew' ? normalizeDate(entry.request.renewalEndDate) : endDate;
    const targetMatches = entry.request.action === 'renew'
      ? endDate === expectedEndDate && disposition === `已续期至 ${expectedEndDate}`
      : !!endDate && disposition === '到期作废';
    const records = plans.length ? await this.creationGateway.listRecords('payment') : [];
    const normalized = records.map(normalizedRecoveryPayment);
    const candidates = plans.map(plan => normalized.filter(row => recoveryPaymentMatches(row, plan, entry.task.recordId)).sort((a, b) => a.id.localeCompare(b.id)));
    const evidenceHash = createHash('sha256').update(JSON.stringify({ id: entry.task.recordId, endDate, disposition,
      name: extractDisplayText(fields['合同名称']), code: extractDisplayText(fields['合同编号']),
      specialty: recordProfessionalSpecialty(record), owners: extractOpenIds(fields['跟进人']).sort(), candidates })).digest('hex');
    const version = createHash('sha256').update(JSON.stringify([nativeVersion, evidenceHash])).digest('hex');
    const canConfirm = task.available && entry.task.status === 'failed' && entry.uncertain === true && targetMatches && candidates.every(rows => rows.length > 0);
    const preview: PersonnelRecoveryPreview = { task, version,
      facts: [{ label: '合同', value: extractDisplayText(fields['合同名称']) || '未填写合同名称' }, { label: '合同编号', value: extractDisplayText(fields['合同编号']) || '未填写' },
        { label: '当前截止日期', value: endDate || '未填写' }, { label: '当前处置状态', value: disposition || '未填写' }],
      choices: candidates.map((rows, index) => ({ label: `付款计划${index + 1} · ${plans[index].period} · ${plans[index].plannedAmount}元 · ${plans[index].plannedPaymentDate}`,
        options: rows.map(row => ({ value: row.id, label: `${row.period} · ${row.amount}元 · ${row.date} · ${row.ownerNames || '未填写跟进人姓名'} · ${row.id.slice(-8)}` })) })),
      canConfirm, ...(!canConfirm ? { message: entry.task.status === 'completed' ? '原合同任务已完成' : !targetMatches ? '合同当前结果与原处置不一致，请先核对合同' : candidates.some(rows => !rows.length) ? '部分付款计划缺失或内容不符，请先核对付款计划' : '当前任务不可恢复，请核对原任务' } : {}),
      acknowledgement: plans.length ? '我已核对所选付款计划属于本次续期，确认原处置已完成' : '我已核对合同，确认原到期作废已完成' };
    return { entry, preview, fields, endDate, evidenceHash, nativeVersion };
  }

  async execute(
    recordIdValue: string,
    request: ContractExpiryDispositionRequest,
    now = new Date(),
    principal?: AccessPrincipal,
  ): Promise<ContractExpiryDispositionResponse> {
    const recordId = validateSubmissionRequest(recordIdValue, request);

    const record = await this.gateway.getContract(recordId);
    if (!record) throw new NotFoundException('未找到合同记录');
    assertProfessionalBitableRecord(principal, record);
    const fields = record.fields || {};
    const currentEndDate = extractDateValue(fields['合同结束日期']);
    if (!currentEndDate) {
      throw new ConflictException('合同截止日期缺失，无法执行到期处置');
    }
    const daysRemaining = differenceFromToday(currentEndDate, now);
    if (daysRemaining < -30 || daysRemaining > 60) {
      throw new ConflictException(
        '仅支持处理即将到期 60 天内或已到期 30 天内的合同',
      );
    }
    if (extractDisplayText(fields['合同到期处置']).includes('到期作废')) {
      throw new ConflictException('该合同已确认到期作废');
    }

    if (request.action === 'void') {
      await this.gateway.updateContract(recordId, {
        合同到期处置: '到期作废',
      });
      const notification = await this.startLifecycleNotification({
        action: 'void',
        recordId,
        fields,
        endDate: currentEndDate,
      });
      return {
        recordId,
        action: 'void',
        endDate: currentEndDate,
        notification,
        message: '合同已确认到期作废，通知正在后台发送',
      };
    }

    const renewalEndDate = normalizeDate(request.renewalEndDate);
    if (!renewalEndDate) {
      throw new BadRequestException('请选择有效的续期截止时间');
    }
    if (dateTimestamp(renewalEndDate) <= dateTimestamp(currentEndDate)) {
      throw new BadRequestException('续期截止时间必须晚于当前合同截止时间');
    }

    const paymentPlans = validateRenewalPaymentPlans(request);
    const [paymentRecords, organizationRecords] = await Promise.all([
      this.creationGateway.listRecords('payment'),
      this.creationGateway.listRecords('organization'),
    ]);
    const allowedOpenIds = collectKnownPersonOpenIds([
      fields,
      ...paymentRecords.map((item) => item.fields),
      ...organizationRecords.map((item) => item.fields),
    ]);
    for (const paymentPlan of paymentPlans) {
      assertKnownPersonOpenId(
        paymentPlan.ownerOpenId,
        allowedOpenIds,
        '付款计划跟进人',
      );
    }
    const createdPaymentRecordIds: string[] = [];
    try {
      for (const [index, paymentPlan] of paymentPlans.entries()) {
        const paymentRecordId = await this.creationGateway.createRecord(
          'payment',
          buildPaymentCreateFields(FIXED_PAYMENT_FIELDS, paymentPlan, recordId),
          derivedUuid(request.idempotencyKey!, `renewal-payment:${index}`),
        );
        createdPaymentRecordIds.push(paymentRecordId);
      }
      await this.gateway.updateContract(recordId, {
        合同结束日期: dateTimestamp(renewalEndDate),
        合同到期处置: `已续期至 ${renewalEndDate}`,
      });
    } catch (error) {
      const cleanupFailures: string[] = [];
      for (const paymentRecordId of [...createdPaymentRecordIds].reverse()) {
        try {
          await this.creationGateway.deleteRecord('payment', paymentRecordId);
        } catch (cleanupError) {
          cleanupFailures.push(safeMessage(cleanupError));
        }
      }
      if (cleanupFailures.length) {
        throw new BadGatewayException(
          `合同续期失败，且本次付款计划清理失败：${cleanupFailures.join('；')}`,
        );
      }
      throw error;
    }
    const notification = await this.startLifecycleNotification({
      action: 'renew',
      recordId,
      fields,
      endDate: renewalEndDate,
    });
    return {
      recordId,
      action: 'renew',
      endDate: renewalEndDate,
      notification,
      message: `合同已续期至 ${renewalEndDate}，通知正在后台发送`,
    };
  }

  private toSubmissionResponse(
    task: ContractExpiryDispositionTask,
  ): ContractExpiryDispositionSubmissionResponse {
    return {
      recordId: task.recordId,
      action: task.action,
      pending: true,
      taskId: task.id,
      message: task.message,
    };
  }

  private launch(taskId: string): void {
    if (this.stopped || this.queued.has(taskId)) return;
    this.queued.add(taskId);
    this.work=this.work.then(async()=>{
      if(!this.stopped)await this.executeTask(taskId);
    }).catch(()=>{this.logger.error(`合同处置任务未完成，请核对原任务：${taskId}`);}).finally(()=>{this.queued.delete(taskId);});
  }

  private async executeTask(taskId: string): Promise<void> {
    const entry = await this.store.claimDispositionTask(taskId);
    if (!entry) return;
    let outcome: {status:'completed'|'failed';message:string;uncertain?:boolean};
    try {
      const result = await this.execute(entry.task.recordId, entry.request, new Date(entry.now), entry.principal);
      outcome={status:'completed',message:result.message};
    } catch (error) {
      outcome={status:'failed',message:backgroundTaskErrorMessage(error),uncertain:!(error instanceof HttpException && error.getStatus() < 500)};
      this.logger.error(
        `合同到期处置后台同步失败: task=${entry.task.id}, record=${entry.task.recordId}`,
      );
    }
    await this.store.settleDispositionTask(taskId,entry.claimToken!,outcome);
  }

  private async startLifecycleNotification(input: {
    action: 'renew' | 'void';
    recordId: string;
    fields: Record<string, unknown>;
    endDate: string;
  }, authorize?: () => void): Promise<ContractCreateNotificationResult> {
      return this.workflow.enqueueContractLifecycleChanged({
        action: input.action,
        recordId: input.recordId,
        name: extractDisplayText(input.fields['合同名称']),
        code: extractDisplayText(input.fields['合同编号']),
        endDate: input.endDate,
        ownerNames: extractNames(input.fields['跟进人']),
        ownerOpenIds: extractOpenIds(input.fields['跟进人']),
        specialty:recordProfessionalSpecialty({record_id:input.recordId,fields:input.fields}),
      }, authorize);
  }
}

function dispositionRecoverySummary(entry: ContractDispositionTaskEntry): PersonnelRecoveryTask {
  return { module: 'contracts', id: entry.task.id, recordId: entry.task.recordId, title: entry.request.action === 'renew' ? '合同续期' : '合同到期作废',
    actorName: entry.principal?.displayName || '原经办人', createdAt: entry.task.createdAt, status: entry.task.status,
    message: entry.task.message, version: contractDispositionRecoveryVersion(entry), actionLabel: '核对处置结果',
    available: entry.appId === process.env.FEISHU_APP_ID?.trim() && (entry.recoveries?.length || 0) < 20,
    hint: '核对实际合同与付款计划后确认；不会重新续期或重复创建付款计划。' };
}

function normalizedRecoveryPayment(record: BitableRecordItem) {
  const fields = record.fields || {};
  return { id: record.record_id || record.id || '', contracts: extractLinkedRecordIds(fields['合同编号']).sort(),
    period: extractDisplayText(fields['付款周期']), amount: extractNumberValue(fields['计划付款金额']), date: extractDateValue(fields['计划付款日期']),
    owners: extractOpenIds(fields['跟进人']).sort(), ownerNames: extractNames(fields['跟进人']).join('、') };
}
function recoveryPaymentMatches(row: ReturnType<typeof normalizedRecoveryPayment>, plan: ContractCreatePaymentPlanInput, contractId: string): boolean {
  const expected = buildPaymentCreateFields(FIXED_PAYMENT_FIELDS, plan, contractId);
  return /^[A-Za-z0-9_-]{1,128}$/.test(row.id) && row.contracts.length === 1 && row.contracts[0] === contractId && row.period === extractDisplayText(expected['付款周期']) &&
    row.amount === extractNumberValue(expected['计划付款金额']) && row.date === extractDateValue(expected['计划付款日期']) && JSON.stringify(row.owners) === JSON.stringify(extractOpenIds(expected['跟进人']).sort());
}

function validateSubmissionRequest(
  recordIdValue: string,
  request: ContractExpiryDispositionRequest,
): string {
  const recordId = String(recordIdValue || '').trim();
  if (!recordId || recordId.length > 128) {
    throw new BadRequestException('合同记录 ID 无效');
  }
  if (request?.action !== 'renew' && request?.action !== 'void') {
    throw new BadRequestException('请选择合同续期或到期作废');
  }
  if (request.action === 'renew') {
    if (!normalizeDate(request.renewalEndDate)) {
      throw new BadRequestException('请选择有效的续期截止时间');
    }
    validateRenewalPaymentPlans(request);
  }
  return recordId;
}

function backgroundTaskErrorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (
      response &&
      typeof response === 'object' &&
      typeof (response as { message?: unknown }).message === 'string'
    ) {
      return (response as { message: string }).message;
    }
  }
  return '合同到期处置后台同步失败，请稍后重试';
}

function validateRenewalPaymentPlans(
  request: ContractExpiryDispositionRequest,
): ContractCreatePaymentPlanInput[] {
  if (!isUuid(request.idempotencyKey)) {
    throw new BadRequestException('续期请求标识无效，请重新打开后重试');
  }
  if (!Array.isArray(request.paymentPlans) || !request.paymentPlans.length) {
    throw new BadRequestException('请至少录入一条付款计划');
  }
  request.paymentPlans.forEach((paymentPlan, index) => {
    try {
      buildPaymentCreateFields(
        FIXED_PAYMENT_FIELDS,
        paymentPlan,
        'recValidation',
      );
    } catch (error) {
      throw new BadRequestException(
        `第 ${index + 1} 条付款计划：${safeMessage(error)}`,
      );
    }
  });
  return request.paymentPlans;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

function derivedUuid(seed: string, scope: string): string {
  const hash = createHash('sha256').update(`${seed}:${scope}`).digest('hex');
  const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function extractOpenIds(value: unknown): string[] {
  if (Array.isArray(value)) return dedupe(value.flatMap(extractOpenIds));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const direct = Object.values(item).filter(
    (entry): entry is string =>
      typeof entry === 'string' && /^ou_[A-Za-z0-9]+$/.test(entry),
  );
  return dedupe([...direct, ...Object.values(item).flatMap(extractOpenIds)]);
}

function extractNames(value: unknown): string[] {
  if (Array.isArray(value)) return dedupe(value.flatMap(extractNames));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  return dedupe([name, ...Object.values(item).flatMap(extractNames)]);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function differenceFromToday(value: string, now: Date): number {
  return Math.round(
    (dateTimestamp(value) - dateTimestamp(shanghaiDateKey(now))) / DAY_MS,
  );
}

function dateTimestamp(value: string): number {
  return Date.parse(`${value}T00:00:00+08:00`);
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const timestamp = dateTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  return shanghaiDateKey(new Date(timestamp)) === value ? value : null;
}

function shanghaiDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
