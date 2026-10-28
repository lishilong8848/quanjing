import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertCurrentContractMutation } from './contract-current-authority';
import { assertContractSelectorAccess, CONTRACT_PAYMENT_SELECTOR_ACTIONS } from './contract-selector-access';
import type {
  ContractCreateNotificationResult,
  ContractCreatePersonOption,
  ContractNoPaymentRequiredRequest,
  ContractNoPaymentRequiredResponse,
  ContractPaymentFollowUpAction,
  ContractPaymentFollowUpActionResponse,
  ContractPaymentFollowUpOptionsResponse,
  ContractPaymentPlanAdjustRequest,
  ContractPaymentPlanConfirmRequest,
  ContractPaymentPlanCreateRequest,
  ContractPaymentPlanOption,
} from '../../../shared/contract-management.interface';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { ContractCreationGateway } from './contract-creation.gateway';
import type { BitableFieldMeta } from './contract-creation.rules';
import {
  buildPaymentAdjustFields,
  buildPaymentConfirmFields,
  buildPaymentCreateFields,
  buildPaymentFieldSchema,
  FIXED_PAYMENT_FIELDS,
} from './contract-payment-follow-up.rules';
import { assertKnownPersonOpenId } from './contract-person-validation';
import { ContractWorkflowService } from './contract-workflow.service';
import { ContractExpiryDispositionGateway } from './contract-expiry-disposition.gateway';
import { ContractManagementService } from './contract-management.service';

const DISPLAY_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DISPLAY_CACHE_CONTRACTS = 100;
const PAYMENT_FIELD_SCHEMA = buildPaymentFieldSchema(FIXED_PAYMENT_FIELDS);

interface PaymentNotificationInput {
  action: ContractPaymentFollowUpAction;
  contractRecordId: string;
  contractCode: string;
  contractName: string;
  paymentRecordId: string;
  paymentLabel: string;
  period: string;
  plannedAmount: number;
  actualAmount: number;
  plannedPaymentDate: string;
  paymentDate: string;
  ownerOpenIds: string[];
  ownerNames: string[];
}

interface PaymentNotifier {
  notifyPaymentFollowUpChanged(
    input: PaymentNotificationInput,
  ): Promise<ContractCreateNotificationResult>;
}

interface PaymentContext {
  record: BitableRecordItem;
  options: ContractPaymentFollowUpOptionsResponse;
  fields: BitableFieldMeta[];
}

interface DisplayRecordsSnapshot {
  paymentRecords: BitableRecordItem[];
  organizationRecords: BitableRecordItem[];
}

interface DisplayOptionsCacheEntry {
  expiresAt: number;
  options: ContractPaymentFollowUpOptionsResponse;
}

@Injectable()
export class ContractPaymentFollowUpService {
  private readonly displayOptionsCache = new Map<
    string,
    DisplayOptionsCacheEntry
  >();
  private readonly displayOptionsInFlight = new Map<
    string,
    Promise<ContractPaymentFollowUpOptionsResponse>
  >();
  private displayRecordsSnapshot:
    | (DisplayRecordsSnapshot & { expiresAt: number })
    | null = null;
  private displayRecordsInFlight: Promise<DisplayRecordsSnapshot> | null = null;
  private displayCacheGeneration = 0;

  constructor(
    private readonly gateway: ContractCreationGateway,
    private readonly workflow: ContractWorkflowService,
    private readonly dispositionGateway: ContractExpiryDispositionGateway,
    private readonly dashboardService: ContractManagementService,
    private readonly accessConfiguration: AccessConfigurationService,
  ) {}

  async getOptions(
    contractRecordId: string,
    principal?:AccessPrincipal,
  ): Promise<ContractPaymentFollowUpOptionsResponse> {
    const cleanContractId = recordId(contractRecordId, '合同');
    const current=principal ? await this.gateway.getRecord('execution',cleanContractId) : undefined;
    if(principal) assertContractSelectorAccess(principal,current,CONTRACT_PAYMENT_SELECTOR_ACTIONS);
    const cached = this.getCachedDisplayOptions(cleanContractId);
    if (cached) return cached;
    const existing = this.displayOptionsInFlight.get(cleanContractId);
    if (existing) return existing;

    const generation = this.displayCacheGeneration;
    const pending = this.loadDisplayOptions(cleanContractId,current).then((options) => {
      if (generation === this.displayCacheGeneration) {
        this.cacheDisplayOptions(cleanContractId, options);
      }
      return options;
    });
    this.displayOptionsInFlight.set(cleanContractId, pending);
    try {
      return await pending;
    } finally {
      if (this.displayOptionsInFlight.get(cleanContractId) === pending) {
        this.displayOptionsInFlight.delete(cleanContractId);
      }
    }
  }

  async createPlan(
    contractRecordId: string,
    request: ContractPaymentPlanCreateRequest,
    principal?: AccessPrincipal,
  ): Promise<ContractPaymentFollowUpActionResponse> {
    assertUuid(request?.idempotencyKey);
    const context = await this.loadMutationContext(contractRecordId, principal);
    assertKnownPersonOpenId(
      request.ownerOpenId,
      context.options.people.map((person) => person.openId),
    );
    const fields = wrapValidation(() =>
      buildPaymentCreateFields(context.fields, request, contractRecordId),
    );
    this.assertCurrentMutation(principal, context.record, 'create');
    const paymentRecordId = await this.gateway.createRecord(
      'payment',
      fields,
      request.idempotencyKey,
    );
    this.clearDisplayCaches();
    return this.completeAction('create', paymentRecordId, context.options, {
      label: [context.options.contract.code, request.period]
        .filter(Boolean)
        .join(' '),
      period: request.period,
      plannedAmount: request.plannedAmount,
      actualAmount: 0,
      plannedPaymentDate: request.plannedPaymentDate,
      paymentDate: '',
      ownerOpenId: request.ownerOpenId,
    });
  }

  async adjustPlan(
    contractRecordId: string,
    paymentRecordId: string,
    request: ContractPaymentPlanAdjustRequest,
    principal?: AccessPrincipal,
  ): Promise<ContractPaymentFollowUpActionResponse> {
    const [context, payment] = await Promise.all([
      this.loadMutationContext(contractRecordId, principal),
      this.requireLinkedPayment(contractRecordId, paymentRecordId),
    ]);
    assertKnownPersonOpenId(
      request.ownerOpenId,
      context.options.people.map((person) => person.openId),
    );
    const fields = wrapValidation(() =>
      buildPaymentAdjustFields(context.fields, request),
    );
    this.assertCurrentMutation(principal, context.record, 'update');
    await this.gateway.updateRecord('payment', paymentRecordId, fields);
    this.clearDisplayCaches();
    return this.completeAction('adjust', paymentRecordId, context.options, {
      label: payment.label,
      period: request.period,
      plannedAmount: request.plannedAmount,
      actualAmount: payment.actualAmount,
      plannedPaymentDate: request.plannedPaymentDate,
      paymentDate: payment.paymentDate || '',
      ownerOpenId: request.ownerOpenId,
    });
  }

  async confirmPlan(
    contractRecordId: string,
    paymentRecordId: string,
    request: ContractPaymentPlanConfirmRequest,
    principal?: AccessPrincipal,
  ): Promise<ContractPaymentFollowUpActionResponse> {
    const [context, payment] = await Promise.all([
      this.loadMutationContext(contractRecordId, principal),
      this.requireLinkedPayment(contractRecordId, paymentRecordId),
    ]);
    if (payment.status === '已付款') {
      throw new BadRequestException('该付款计划已经完成付款确认');
    }
    const fields = wrapValidation(() =>
      buildPaymentConfirmFields(context.fields, request),
    );
    this.assertCurrentMutation(principal, context.record, 'confirm');
    await this.gateway.updateRecord('payment', paymentRecordId, fields);
    this.clearDisplayCaches();
    return this.completeAction('confirm', paymentRecordId, context.options, {
      label: payment.label,
      period: payment.period,
      plannedAmount: payment.plannedAmount,
      actualAmount: request.actualAmount,
      plannedPaymentDate: payment.plannedPaymentDate || '',
      paymentDate: request.paymentDate,
      ownerOpenId: payment.ownerOpenId,
    });
  }

  async markNoPaymentRequired(
    contractRecordId: string,
    request: ContractNoPaymentRequiredRequest,
    principal?: AccessPrincipal,
  ): Promise<ContractNoPaymentRequiredResponse> {
    assertUuid(request?.idempotencyKey);
    const cleanContractId = recordId(contractRecordId, '合同');
    const contract = await this.gateway.getRecord('execution', cleanContractId);
    const existingDisposition = displayText(contract.fields?.['付款跟进处置']);

    if (!existingDisposition.includes('无需付款')) {
      const paymentRecords = await this.gateway.listRecords('payment');
      if (
        paymentRecords.some((payment) =>
          linkedRecordIds(payment.fields?.['合同编号']).includes(
            cleanContractId,
          ),
        )
      ) {
        throw new BadRequestException(
          '该合同已存在付款计划，不能标记为无需付款',
        );
      }
      this.assertCurrentMutation(principal, contract, 'update');
      await this.dispositionGateway.updateTextField(
        cleanContractId,
        '付款跟进处置',
        '无需付款',
      );
    }
    this.clearDisplayCaches();
    this.dashboardService.invalidateDashboardCache();

    return {
      ok: true,
      action: 'no_payment_required',
      contractRecordId: cleanContractId,
      disposition: '无需付款',
      message: '已标记为无需付款',
    };
  }

  private async loadDisplayOptions(
    cleanContractId: string,
    current?:BitableRecordItem,
  ): Promise<ContractPaymentFollowUpOptionsResponse> {
    const [contract, records] = await Promise.all([
      current ? Promise.resolve(current) : this.gateway.getRecord('execution', cleanContractId),
      this.loadDisplayRecordsSnapshot(),
    ]);
    return this.buildContext(
      cleanContractId,
      contract,
      records.paymentRecords,
      records.organizationRecords,
    ).options;
  }

  private assertCurrentMutation(
    principal: AccessPrincipal | undefined,
    record: BitableRecordItem,
    action: 'create' | 'update' | 'confirm',
  ): void {
    assertCurrentContractMutation(this.accessConfiguration, principal, action, record);
  }

  private async loadMutationContext(
    contractRecordId: string,
    principal?: AccessPrincipal,
  ): Promise<PaymentContext> {
    const cleanContractId = recordId(contractRecordId, '合同');
    const [contract, paymentRecords, organizationRecords] = await Promise.all([
      this.gateway.getRecord('execution', cleanContractId),
      this.gateway.listRecords('payment'),
      this.gateway.listRecords('organization'),
    ]);
    assertProfessionalBitableRecord(principal, contract);
    return this.buildContext(
      cleanContractId,
      contract,
      paymentRecords,
      organizationRecords,
    );
  }

  private buildContext(
    cleanContractId: string,
    contract: BitableRecordItem,
    paymentRecords: BitableRecordItem[],
    organizationRecords: BitableRecordItem[],
  ): PaymentContext {
    const linkedPlans = paymentRecords
      .filter((item) =>
        linkedRecordIds(item.fields?.['合同编号']).includes(cleanContractId),
      )
      .map(mapPaymentPlan)
      .sort(comparePlans);
    const people = collectPeople([
      ...organizationRecords,
      contract,
      ...paymentRecords,
    ]);
    const contractOwner = firstPerson(contract.fields?.['跟进人']);
    return {
      record: contract,
      fields: FIXED_PAYMENT_FIELDS,
      options: {
        contract: {
          recordId: cleanContractId,
          code: displayText(contract.fields?.['合同编号']),
          name: displayText(contract.fields?.['合同名称']),
          ownerOpenId: contractOwner?.openId || '',
          ownerName: contractOwner?.name || '',
        },
        periods: [...PAYMENT_FIELD_SCHEMA.periods],
        statuses: [...PAYMENT_FIELD_SCHEMA.statuses],
        people,
        plans: linkedPlans,
      },
    };
  }

  private async loadDisplayRecordsSnapshot(): Promise<DisplayRecordsSnapshot> {
    const snapshot = this.displayRecordsSnapshot;
    if (snapshot && snapshot.expiresAt > Date.now()) {
      return snapshot;
    }
    if (snapshot) this.displayRecordsSnapshot = null;
    if (this.displayRecordsInFlight) return this.displayRecordsInFlight;

    const generation = this.displayCacheGeneration;
    const pending = Promise.all([
      this.gateway.listRecords('payment'),
      this.gateway.listRecords('organization'),
    ]).then(([paymentRecords, organizationRecords]) => {
      const records = { paymentRecords, organizationRecords };
      if (generation === this.displayCacheGeneration) {
        this.displayRecordsSnapshot = {
          ...records,
          expiresAt: Date.now() + DISPLAY_CACHE_TTL_MS,
        };
      }
      return records;
    });
    this.displayRecordsInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.displayRecordsInFlight === pending) {
        this.displayRecordsInFlight = null;
      }
    }
  }

  private getCachedDisplayOptions(
    contractRecordId: string,
  ): ContractPaymentFollowUpOptionsResponse | null {
    const cached = this.displayOptionsCache.get(contractRecordId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.displayOptionsCache.delete(contractRecordId);
      return null;
    }
    this.displayOptionsCache.delete(contractRecordId);
    this.displayOptionsCache.set(contractRecordId, cached);
    return cached.options;
  }

  private cacheDisplayOptions(
    contractRecordId: string,
    options: ContractPaymentFollowUpOptionsResponse,
  ): void {
    this.removeExpiredDisplayOptions();
    this.displayOptionsCache.delete(contractRecordId);
    while (this.displayOptionsCache.size >= MAX_DISPLAY_CACHE_CONTRACTS) {
      const oldest = this.displayOptionsCache.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.displayOptionsCache.delete(oldest);
    }
    this.displayOptionsCache.set(contractRecordId, {
      expiresAt: Date.now() + DISPLAY_CACHE_TTL_MS,
      options,
    });
  }

  private removeExpiredDisplayOptions(): void {
    const now = Date.now();
    for (const [contractRecordId, cached] of this.displayOptionsCache) {
      if (cached.expiresAt <= now) {
        this.displayOptionsCache.delete(contractRecordId);
      }
    }
  }

  private clearDisplayCaches(): void {
    this.displayCacheGeneration += 1;
    this.displayOptionsCache.clear();
    this.displayOptionsInFlight.clear();
    this.displayRecordsSnapshot = null;
    this.displayRecordsInFlight = null;
  }

  private async requireLinkedPayment(
    contractRecordId: string,
    paymentRecordId: string,
  ): Promise<ContractPaymentPlanOption> {
    const cleanPaymentId = recordId(paymentRecordId, '付款计划');
    const payment = await this.gateway.getRecord('payment', cleanPaymentId);
    if (
      !linkedRecordIds(payment.fields?.['合同编号']).includes(contractRecordId)
    ) {
      throw new BadRequestException('付款计划不属于当前合同');
    }
    return mapPaymentPlan(payment);
  }

  private async completeAction(
    action: ContractPaymentFollowUpAction,
    paymentRecordId: string,
    options: ContractPaymentFollowUpOptionsResponse,
    payment: {
      label: string;
      period: string;
      plannedAmount: number;
      actualAmount: number;
      plannedPaymentDate: string;
      paymentDate: string;
      ownerOpenId: string;
    },
  ): Promise<ContractPaymentFollowUpActionResponse> {
    const owner = options.people.find(
      (person) => person.openId === payment.ownerOpenId,
    );
    const notification = await this.notifySafely({
      action,
      contractRecordId: options.contract.recordId,
      contractCode: options.contract.code,
      contractName: options.contract.name,
      paymentRecordId,
      paymentLabel: payment.label,
      period: payment.period,
      plannedAmount: payment.plannedAmount,
      actualAmount: payment.actualAmount,
      plannedPaymentDate: payment.plannedPaymentDate,
      paymentDate: payment.paymentDate,
      ownerOpenIds: payment.ownerOpenId ? [payment.ownerOpenId] : [],
      ownerNames: owner ? [owner.name] : [],
    });
    return {
      ok: true,
      action,
      paymentRecordId,
      notification,
      message: notification.failed
        ? `付款计划已更新；${notification.message}`
        : `付款计划已${actionLabel(action)}，通知流程已执行`,
    };
  }

  private async notifySafely(
    input: PaymentNotificationInput,
  ): Promise<ContractCreateNotificationResult> {
    try {
      return await (
        this.workflow as unknown as PaymentNotifier
      ).notifyPaymentFollowUpChanged(input);
    } catch (error) {
      return {
        attempted: true,
        recipients: 0,
        sent: 0,
        failed: 1,
        message: `付款计划已更新，但通知流程失败：${safeMessage(error)}`,
      };
    }
  }
}

function mapPaymentPlan(record: BitableRecordItem): ContractPaymentPlanOption {
  const fields = record.fields || {};
  const owner = firstPerson(fields['跟进人']);
  return {
    recordId: recordItemId(record),
    label:
      displayText(fields['付款计划']) ||
      displayText(fields['合同编号']) ||
      '付款计划',
    period: displayText(fields['付款周期']),
    plannedAmount: numberValue(fields['计划付款金额']) || 0,
    actualAmount: numberValue(fields['实际付款金额']) || 0,
    plannedPaymentDate: dateKey(fields['计划付款日期']),
    paymentDate: dateKey(fields['付款日期']),
    status: displayText(fields['付款状态']) || '未付款',
    ownerOpenId: owner?.openId || '',
    ownerName: owner?.name || '',
  };
}

function collectPeople(
  records: BitableRecordItem[],
): ContractCreatePersonOption[] {
  const people = new Map<string, string>();
  for (const record of records) collectPeopleFromValue(record.fields, people);
  return [...people]
    .map(([openId, name]) => ({ openId, name }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function collectPeopleFromValue(
  value: unknown,
  people: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPeopleFromValue(item, people);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  const id = [item.id, item.open_id]
    .map(clean)
    .find((entry) => /^ou_/.test(entry));
  const name = clean(item.name) || clean(item.en_name);
  if (id) people.set(id, name || id);
  for (const entry of Object.values(item))
    collectPeopleFromValue(entry, people);
}

function firstPerson(value: unknown): { openId: string; name: string } | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const openId = clean(item.id) || clean(item.open_id);
    if (/^ou_[A-Za-z0-9]+$/.test(openId)) {
      return {
        openId,
        name: clean(item.name) || clean(item.en_name) || openId,
      };
    }
  }
  return null;
}

function linkedRecordIds(value: unknown): string[] {
  const ids = new Set<string>();
  collectLinkedRecordIds(value, ids);
  return [...ids];
}

function collectLinkedRecordIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedRecordIds(item, ids);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  for (const candidate of [item.record_id, item.id]) {
    const id = clean(candidate);
    if (/^rec[A-Za-z0-9_]+$/.test(id)) ids.add(id);
  }
  if (Array.isArray(item.record_ids)) {
    for (const candidate of item.record_ids) {
      const id = clean(candidate);
      if (/^rec[A-Za-z0-9_]+$/.test(id)) ids.add(id);
    }
  }
  for (const entry of Object.values(item)) collectLinkedRecordIds(entry, ids);
}

function dateKey(value: unknown): string | null {
  const raw = displayText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const timestamp = Number(raw || value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function comparePlans(
  left: ContractPaymentPlanOption,
  right: ContractPaymentPlanOption,
): number {
  return (left.plannedPaymentDate || '9999-12-31').localeCompare(
    right.plannedPaymentDate || '9999-12-31',
  );
}

function assertUuid(value: unknown): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      clean(value),
    )
  ) {
    throw new BadRequestException('付款计划幂等标识无效');
  }
}

function recordId(value: unknown, label: string): string {
  const id = clean(value);
  if (!/^rec[A-Za-z0-9_]+$/.test(id)) {
    throw new BadRequestException(`${label}记录标识无效`);
  }
  return id;
}

function wrapValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(safeMessage(error));
  }
}

function actionLabel(action: ContractPaymentFollowUpAction): string {
  if (action === 'create') return '新增';
  if (action === 'adjust') return '调整';
  return '确认付款';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(displayText).filter(Boolean).join('、');
  }
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'name', 'en_name']) {
    const text = displayText(item[key]);
    if (text) return text;
  }
  if (Array.isArray(item.text_arr)) {
    return item.text_arr.map(displayText).filter(Boolean).join('、');
  }
  return '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(displayText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function recordItemId(record: BitableRecordItem): string {
  const id = clean(record.record_id) || clean(record.id);
  if (!id) throw new Error('付款计划记录缺少 record_id');
  return id;
}
