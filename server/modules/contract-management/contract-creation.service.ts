import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  CONTRACT_PAYMENT_PERIODS,
  createFixedContractOptions,
} from '../../../shared/contract-field-config';
import type {
  ContractCreateFieldDefinition,
  ContractCreateFrameworkOption,
  ContractCreateKind,
  ContractCreateNotificationResult,
  ContractCreateOptionsResponse,
  ContractCreatePersonOption,
  ContractCreateRequest,
  ContractCreateResponse,
  ContractCreateSelfTestResponse,
  ContractCreateSupplierOption,
  ContractCreateValue,
} from '../../../shared/contract-management.interface';
import { ContractAttachmentStorageService } from './contract-attachment-storage.service';
import {
  ContractCreateIndeterminateError,
  ContractCreationGateway,
  type ContractCreateTableKind,
  type ContractCreateUploadFile,
} from './contract-creation.gateway';
import {
  buildContractRecordFields,
  buildSupplierRecordFields,
} from './contract-creation.rules';
import {
  buildPaymentCreateFields,
  FIXED_PAYMENT_FIELDS,
} from './contract-payment-follow-up.rules';
import {
  assertKnownPersonFieldValues,
  assertKnownPersonOpenId,
} from './contract-person-validation';
import { ContractWorkflowService } from './contract-workflow.service';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertCurrentContractMutation } from './contract-current-authority';

const MAX_FILES = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const DISPLAY_RECORD_CACHE_TTL_MS = 5 * 60 * 1_000;

interface CreateContext {
  selfTest?: boolean;
  principal?: AccessPrincipal;
}

interface RecordItem {
  record_id?: string;
  id?: string;
  fields?: Record<string, unknown>;
}

interface DynamicRecordSnapshot {
  frameworkRecords: RecordItem[];
  supplierRecords: RecordItem[];
  executionRecords: RecordItem[];
  organizationRecords: RecordItem[];
}

interface DynamicRecordCacheEntry {
  expiresAt: number;
  value: DynamicRecordSnapshot;
}

interface SelfTestResidueCleanupResult {
  deletedPayments: number;
  deletedContracts: number;
  deletedSuppliers: number;
  residualPayments: number;
  residualContracts: number;
  residualSuppliers: number;
}

const SELF_TEST_MARKER_PREFIX = 'CODEX-SELFTEST-';

@Injectable()
export class ContractCreationService {
  private displayRecordCache: DynamicRecordCacheEntry | null = null;
  private displayRecordPromise: Promise<DynamicRecordSnapshot> | null = null;
  private displayRecordGeneration = 0;

  constructor(
    private readonly gateway: ContractCreationGateway,
    private readonly storage: ContractAttachmentStorageService,
    private readonly workflow: ContractWorkflowService,
    private readonly accessConfiguration: AccessConfigurationService,
  ) {}

  async getOptions(
    kind: ContractCreateKind,
    now = new Date(),
  ): Promise<ContractCreateOptionsResponse> {
    assertKind(kind);
    return this.buildOptions(kind, now, await this.getDisplayRecordSnapshot());
  }

  private buildOptions(
    kind: ContractCreateKind,
    now: Date,
    snapshot: DynamicRecordSnapshot,
  ): ContractCreateOptionsResponse {
    const fixed = createFixedContractOptions(kind);
    return {
      ...fixed,
      frameworks: activeFrameworks(snapshot.frameworkRecords, now),
      suppliers: mapSuppliers(snapshot.supplierRecords),
      people: collectPeople([
        ...snapshot.supplierRecords,
        ...snapshot.executionRecords,
        ...snapshot.organizationRecords,
      ]),
    };
  }

  private async getDisplayRecordSnapshot(): Promise<DynamicRecordSnapshot> {
    const now = Date.now();
    if (this.displayRecordCache?.expiresAt > now) {
      return this.displayRecordCache.value;
    }
    if (this.displayRecordPromise) return this.displayRecordPromise;

    this.displayRecordCache = null;
    const generation = this.displayRecordGeneration;
    const request = this.readDynamicRecords();
    this.displayRecordPromise = request;
    try {
      const value = await request;
      if (generation === this.displayRecordGeneration) {
        this.displayRecordCache = {
          expiresAt: Date.now() + DISPLAY_RECORD_CACHE_TTL_MS,
          value,
        };
      }
      return value;
    } finally {
      if (this.displayRecordPromise === request) {
        this.displayRecordPromise = null;
      }
    }
  }

  private async readDynamicRecords(): Promise<DynamicRecordSnapshot> {
    const [
      frameworkRecords,
      supplierRecords,
      executionRecords,
      organizationRecords,
    ] = await Promise.all([
      this.gateway.listRecords('framework'),
      this.gateway.listRecords('supplier'),
      this.gateway.listRecords('execution'),
      this.gateway.listRecords('organization'),
    ]);
    return {
      frameworkRecords,
      supplierRecords,
      executionRecords,
      organizationRecords,
    };
  }

  private clearDisplayRecordCache(): void {
    this.displayRecordGeneration += 1;
    this.displayRecordCache = null;
    this.displayRecordPromise = null;
  }

  async create(
    request: ContractCreateRequest,
    files: ContractCreateUploadFile[],
    context: CreateContext = {},
  ): Promise<ContractCreateResponse> {
    validateCreateRequest(request, files);
    const options = this.buildOptions(
      request.kind,
      new Date(),
      await this.readDynamicRecords(),
    );
    const framework = resolveFramework(request, options.frameworks);
    let supplierRecordId: string | null = null;
    let supplierCreated = false;
    let supplierName = '';
    let pendingSupplierFields: Record<string, unknown> | null = null;
    let contractRecordId = '';
    const paymentRecordIds: string[] = [];
    const tableKind: ContractCreateTableKind = request.kind;
    const allowedOpenIds = options.people.map((person) => person.openId);
    let validationFields: Record<string, unknown>;

    try {
      assertKnownPersonFieldValues(
        request.fields,
        options.fields,
        allowedOpenIds,
      );
      for (const paymentPlan of request.paymentPlans || []) {
        assertKnownPersonOpenId(
          paymentPlan.ownerOpenId,
          allowedOpenIds,
          '付款计划跟进人',
        );
      }
      if (request.kind === 'execution') {
        const supplierInput = request.supplier;
        if (!supplierInput) throw new BadRequestException('供应商不能为空');
        if (supplierInput.mode === 'existing') {
          const supplier = options.suppliers.find(
            (item) => item.recordId === supplierInput.recordId,
          );
          if (!supplier) throw new BadRequestException('请选择有效的供应商');
          supplierRecordId = supplier.recordId;
          supplierName = supplier.name;
        } else {
          assertKnownPersonFieldValues(
            supplierInput.fields,
            options.supplierFields,
            allowedOpenIds,
          );
          pendingSupplierFields = buildSupplierRecordFields(
            supplierInput.fields,
            options.supplierFields,
          );
          supplierName = displayText(pendingSupplierFields['公司单位']);
        }
      }

      validationFields = buildContractRecordFields(request, options.fields, {
        supplierRecordId:
          supplierRecordId ||
          (pendingSupplierFields ? 'recValidationSupplier' : undefined),
        frameworkRecordId: framework?.recordId,
        frameworkLabel: framework
          ? [framework.code, framework.name].filter(Boolean).join(' · ')
          : undefined,
        attachmentTokens: ['boxValidationAttachment'],
      });
    } catch (error) {
      throw normalizeCreateValidationError(error);
    }

    assertCurrentContractMutation(this.accessConfiguration, context.principal, 'create', { record_id: '', fields: validationFields });

    try {
      if (pendingSupplierFields) {
        supplierRecordId = await this.gateway.createRecord(
          'supplier',
          pendingSupplierFields,
          derivedUuid(request.idempotencyKey, 'supplier'),
        );
        supplierCreated = true;
      }

      const attachmentTokens: string[] = [];
      for (const file of files) {
        attachmentTokens.push(await this.gateway.uploadPdf(file));
      }
      const recordFields = buildContractRecordFields(request, options.fields, {
        supplierRecordId: supplierRecordId || undefined,
        frameworkRecordId: framework?.recordId,
        frameworkLabel: framework
          ? [framework.code, framework.name].filter(Boolean).join(' · ')
          : undefined,
        attachmentTokens,
      });
      contractRecordId = await this.gateway.createRecord(
        tableKind,
        recordFields,
        request.idempotencyKey,
      );
      for (const [index, paymentPlan] of (
        request.paymentPlans || []
      ).entries()) {
        const paymentRecordId = await this.gateway.createRecord(
          'payment',
          buildPaymentCreateFields(
            FIXED_PAYMENT_FIELDS,
            paymentPlan,
            contractRecordId,
          ),
          derivedUuid(request.idempotencyKey, `payment:${index}`),
        );
        paymentRecordIds.push(paymentRecordId);
      }
      const createdRecord = await this.gateway.getRecord(
        tableKind,
        contractRecordId,
      );
      const attachments = await this.storage.syncContractRecordAttachments(
        contractRecordId,
        createdRecord.fields?.['合同附件'],
      );

      const notification = await this.notifyCreatedContract(
        request,
        options.fields,
        options.people,
        contractRecordId,
        supplierName,
        Boolean(context.selfTest),
      );
      const createdSummary =
        request.kind === 'execution'
          ? `合同及 ${paymentRecordIds.length} 条付款计划`
          : '合同';
      this.clearDisplayRecordCache();
      return {
        kind: request.kind,
        recordId: contractRecordId,
        supplierRecordId,
        supplierCreated,
        paymentRecordIds,
        attachments,
        notification,
        message: notification.failed
          ? `${createdSummary}已创建并完成附件安全存储；${notification.message}`
          : `${createdSummary}已创建，附件已安全存储，通知流程已执行`,
      };
    } catch (error) {
      if (error instanceof ContractCreateIndeterminateError) {
        this.clearDisplayRecordCache();
        const target =
          error.kind === 'supplier'
            ? '供应商'
            : error.kind === 'payment'
              ? '付款计划'
              : '合同';
        throw new BadGatewayException(
          `新增合同提交状态无法确认：${target}创建请求在重试后仍未获得确认（请求标识：${error.clientToken}）。已保留已知关联数据，请核对对应多维表后再处理，勿重复提交。`,
        );
      }
      const compensationErrors: string[] = [];
      let paymentCleanupFailed = false;
      if (paymentRecordIds.length) {
        for (const paymentRecordId of [...paymentRecordIds].reverse()) {
          try {
            await this.gateway.deleteRecord('payment', paymentRecordId);
          } catch (cleanupError) {
            paymentCleanupFailed = true;
            compensationErrors.push(
              `付款计划 ${paymentRecordId} 删除失败：${safeMessage(cleanupError)}`,
            );
          }
        }
      }

      let contractCleanupFailed = false;
      if (contractRecordId) {
        try {
          await this.storage.removeContractRecordAttachments(contractRecordId);
        } catch (cleanupError) {
          compensationErrors.push(
            `安全附件删除失败：${safeMessage(cleanupError)}`,
          );
        }
        if (!paymentCleanupFailed) {
          try {
            await this.gateway.deleteRecord(tableKind, contractRecordId);
          } catch (cleanupError) {
            contractCleanupFailed = true;
            compensationErrors.push(
              `合同 ${contractRecordId} 删除失败：${safeMessage(cleanupError)}`,
            );
          }
        }
      }

      const canDeleteSupplier =
        !contractRecordId || (!paymentCleanupFailed && !contractCleanupFailed);
      if (supplierCreated && supplierRecordId && canDeleteSupplier) {
        try {
          await this.gateway.deleteRecord('supplier', supplierRecordId);
        } catch (cleanupError) {
          compensationErrors.push(
            `供应商 ${supplierRecordId} 删除失败：${safeMessage(cleanupError)}`,
          );
        }
      }

      if (compensationErrors.length) {
        const preservationNote = paymentCleanupFailed
          ? '；父合同与新供应商已保留，避免产生断链'
          : contractCleanupFailed
            ? '；新供应商已保留，避免产生断链'
            : '';
        throw new BadGatewayException(
          `新增合同失败：${safeMessage(error)}；自动回滚未完全完成：${compensationErrors.join('；')}${preservationNote}`,
        );
      }
      throw normalizeCreateError(error);
    }
  }

  async runRealSelfTest(
    file: ContractCreateUploadFile,
    principal?: AccessPrincipal,
  ): Promise<ContractCreateSelfTestResponse> {
    assertCurrentContractMutation(this.accessConfiguration, principal, 'create', { record_id: '', fields: {} });
    await this.cleanupMarkedSelfTestResidue();
    const options = await this.getOptions('execution');
    const person = options.people[0];
    if (!person) {
      throw new BadRequestException('真实自测无法执行：未解析到合同跟进人');
    }
    const marker = `CODEX-SELFTEST-${Date.now()}`;
    const fields: Record<string, ContractCreateValue> = {};
    assignSelfTestField(options.fields, fields, '合同编号', marker);
    assignSelfTestField(
      options.fields,
      fields,
      '合同名称',
      `${marker} 合同创建自测（自动清理）`,
    );
    assignSelfTestField(options.fields, fields, '跟进人', person.openId);
    assignFirstOption(options.fields, fields, '合同类型');
    assignSelfTestField(options.fields, fields, '合同金额', 0.01);
    assignSelfTestField(
      options.fields,
      fields,
      '合同开始日期',
      dateKey(new Date()),
    );
    assignSelfTestField(
      options.fields,
      fields,
      '合同结束日期',
      dateKey(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000)),
    );
    assignFirstOption(options.fields, fields, '专业类别');

    const existingSupplier = options.suppliers[0];
    const supplierFields: Record<string, ContractCreateValue> = {};
    if (!existingSupplier) {
      assignSelfTestField(
        options.supplierFields,
        supplierFields,
        '公司单位',
        `${marker} 临时供应商`,
      );
    }
    const framework = options.frameworks[0];
    const request: ContractCreateRequest = {
      kind: 'execution',
      idempotencyKey: derivedUuid(marker, 'contract'),
      fields,
      supplier: existingSupplier
        ? { mode: 'existing', recordId: existingSupplier.recordId }
        : { mode: 'create', fields: supplierFields },
      linkFramework: Boolean(framework),
      frameworkRecordId: framework?.recordId,
      paymentPlans: [
        {
          period: CONTRACT_PAYMENT_PERIODS[0],
          plannedAmount: 0.01,
          plannedPaymentDate: dateKey(
            new Date(Date.now() + 24 * 60 * 60 * 1_000),
          ),
          ownerOpenId: person.openId,
        },
      ],
    };

    let created: ContractCreateResponse | null = null;
    let cleanup: ContractCreateSelfTestResponse['cleanup'] | null = null;
    try {
      created = await this.create(request, [file], { selfTest: true, principal });
      const baseRecord = await this.gateway.getRecord(
        'execution',
        created.recordId,
      );
      if (displayText(baseRecord.fields?.['合同编号']) !== marker) {
        throw new BadGatewayException('真实自测失败：多维表回读记录不一致');
      }
      if (
        !created.attachments.length ||
        created.attachments.some((item) => item.previewStatus !== 'ready')
      ) {
        throw new BadGatewayException('真实自测失败：合同附件 COS 同步未完成');
      }
      if (!created.notification.attempted || created.notification.sent < 1) {
        throw new BadGatewayException(
          `真实自测失败：${created.notification.message}`,
        );
      }
    } finally {
      if (created) {
        cleanup = await this.cleanupSelfTestRecord(
          created.recordId,
          created.attachments.map((item) => item.accessId),
          created.paymentRecordIds,
          created.supplierCreated ? created.supplierRecordId : null,
        );
      }
    }

    if (!created || !cleanup) {
      throw new BadGatewayException('真实自测未生成可验证的合同记录');
    }
    return {
      ok: true,
      recordId: created.recordId,
      baseVerified: true,
      cosReady: true,
      notification: created.notification,
      cleanup,
    };
  }

  async cleanupMarkedSelfTestResidue(): Promise<SelfTestResidueCleanupResult> {
    const [contractRecords, supplierRecords, paymentRecords] =
      await Promise.all([
        this.gateway.listRecords('execution'),
        this.gateway.listRecords('supplier'),
        this.gateway.listRecords('payment'),
      ]);
    const markedContracts = contractRecords.filter(isMarkedSelfTestContract);
    const markedSuppliers = supplierRecords.filter(isMarkedSelfTestSupplier);
    const markedContractIds = new Set(
      markedContracts.map(getRecordId).filter(Boolean),
    );
    const markedPayments = paymentRecords.filter((record) =>
      isLinkedToMarkedContract(record, markedContractIds),
    );

    let deletedPayments = 0;
    for (const record of markedPayments) {
      const recordId = getRecordId(record);
      if (!recordId) continue;
      await this.gateway.deleteRecord('payment', recordId);
      deletedPayments += 1;
    }

    let deletedContracts = 0;
    for (const record of markedContracts) {
      const recordId = getRecordId(record);
      if (!recordId) continue;
      await this.storage.removeContractRecordAttachments(recordId);
      await this.gateway.deleteRecord('execution', recordId);
      deletedContracts += 1;
    }

    let deletedSuppliers = 0;
    for (const record of markedSuppliers) {
      const recordId = getRecordId(record);
      if (!recordId) continue;
      await this.gateway.deleteRecord('supplier', recordId);
      deletedSuppliers += 1;
    }

    const [
      remainingContractRecords,
      remainingSupplierRecords,
      remainingPaymentRecords,
    ] = await Promise.all([
      this.gateway.listRecords('execution'),
      this.gateway.listRecords('supplier'),
      this.gateway.listRecords('payment'),
    ]);
    const markedPaymentIds = new Set(
      markedPayments.map(getRecordId).filter(Boolean),
    );
    const residualPayments = remainingPaymentRecords.filter((record) =>
      markedPaymentIds.has(getRecordId(record)),
    ).length;
    const residualContracts = remainingContractRecords.filter(
      isMarkedSelfTestContract,
    ).length;
    const residualSuppliers = remainingSupplierRecords.filter(
      isMarkedSelfTestSupplier,
    ).length;
    if (residualPayments || residualContracts || residualSuppliers) {
      throw new BadGatewayException(
        '真实自测残留清理失败，多维表仍存在 CODEX-SELFTEST 记录',
      );
    }

    return {
      deletedPayments,
      deletedContracts,
      deletedSuppliers,
      residualPayments,
      residualContracts,
      residualSuppliers,
    };
  }

  async cleanupSelfTestRecord(
    recordId: string,
    accessIds: string[],
    paymentRecordIds: string[],
    supplierRecordId: string | null,
  ): Promise<ContractCreateSelfTestResponse['cleanup']> {
    const removedAttachments =
      await this.storage.removeContractRecordAttachments(recordId);
    let cosResidual = false;
    for (const accessId of accessIds) {
      try {
        await this.storage.getManifest(accessId);
        cosResidual = true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    for (const paymentRecordId of [...paymentRecordIds].reverse()) {
      await this.gateway.deleteRecord('payment', paymentRecordId);
    }
    await this.gateway.deleteRecord('execution', recordId);
    if (supplierRecordId) {
      await this.gateway.deleteRecord('supplier', supplierRecordId);
    }
    const residualRecord = await recordStillExists(
      () => this.gateway.getRecord('execution', recordId),
      3,
    );
    const residualPayment = (
      await Promise.all(
        paymentRecordIds.map((paymentRecordId) =>
          recordStillExists(
            () => this.gateway.getRecord('payment', paymentRecordId),
            3,
          ),
        ),
      )
    ).some(Boolean);
    const residualSupplier = supplierRecordId
      ? await recordStillExists(
          () => this.gateway.getRecord('supplier', supplierRecordId),
          3,
        )
      : false;
    if (
      cosResidual ||
      removedAttachments < accessIds.length ||
      residualPayment ||
      residualRecord ||
      residualSupplier
    ) {
      throw new BadGatewayException('真实自测清理校验失败，检测到残留数据');
    }
    return {
      baseDeleted: true,
      cosDeleted: true,
      residualRecord: false,
    };
  }

  private async notifyCreatedContract(
    request: ContractCreateRequest,
    definition: ContractCreateFieldDefinition[],
    people: ContractCreatePersonOption[],
    recordId: string,
    supplier: string,
    selfTest: boolean,
  ): Promise<ContractCreateNotificationResult> {
    const ownerOpenIds = strings(fieldValue(request, definition, '跟进人'));
    const peopleById = new Map(
      people.map((person) => [person.openId, person.name]),
    );
    try {
      return await this.workflow.notifyContractCreated({
        kind: request.kind,
        recordId,
        name: textField(request, definition, '合同名称'),
        code: textField(request, definition, '合同编号'),
        supplier,
        ownerNames: ownerOpenIds.map(
          (openId) => peopleById.get(openId) || openId,
        ),
        ownerOpenIds,
        specialty: textField(request, definition, '专业类别'),
        amount: numberField(request, definition, '合同金额'),
        startDate: textField(request, definition, '合同开始日期'),
        endDate: textField(request, definition, '合同结束日期'),
        selfTest,
      });
    } catch (error) {
      return {
        attempted: true,
        recipients: 0,
        sent: 0,
        failed: 1,
        message: `合同已创建，但通知流程执行失败：${safeMessage(error)}`,
      };
    }
  }
}

function activeFrameworks(
  records: RecordItem[],
  now: Date,
): ContractCreateFrameworkOption[] {
  const today = dateKey(now);
  return records.flatMap((record) => {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const startDate = dateValue(fields['合同开始日期']);
    const endDate = dateValue(fields['合同结束日期']);
    const status = displayText(fields['框架合同状态']);
    if (
      !recordId ||
      !startDate ||
      !endDate ||
      startDate > today ||
      endDate < today ||
      /失效|过期|作废|终止/.test(status)
    ) {
      return [];
    }
    return [
      {
        recordId,
        name: displayText(fields['合同名称']),
        code: displayText(fields['合同编号']),
        startDate,
        endDate,
      },
    ];
  });
}

function mapSuppliers(records: RecordItem[]): ContractCreateSupplierOption[] {
  return records.flatMap((record) => {
    const recordId = getRecordId(record);
    const fields = record.fields || {};
    const name = displayText(fields['公司单位']);
    if (!recordId || !name) return [];
    const contacts = displayText(fields['联系人'])
      .split(/[、,，]/)
      .map((contactName) => contactName.trim())
      .filter(Boolean)
      .map((contactName) => ({
        name: contactName,
        phone: displayText(fields['联系电话']),
      }));
    return [{ recordId, name, contacts }];
  });
}

function collectPeople(records: RecordItem[]): ContractCreatePersonOption[] {
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
    value.forEach((item) => collectPeopleFromValue(item, people));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  const openId = [item.id, item.open_id].find(
    (entry): entry is string =>
      typeof entry === 'string' && /^ou_[A-Za-z0-9]+$/.test(entry),
  );
  if (openId) people.set(openId, displayText(item.name) || openId);
  Object.values(item).forEach((entry) => collectPeopleFromValue(entry, people));
}

function resolveFramework(
  request: ContractCreateRequest,
  frameworks: ContractCreateFrameworkOption[],
): ContractCreateFrameworkOption | undefined {
  if (request.kind !== 'execution' || !request.linkFramework) return undefined;
  const framework = frameworks.find(
    (item) => item.recordId === request.frameworkRecordId,
  );
  if (!framework) throw new BadRequestException('请选择生效的框架合同');
  return framework;
}

function validateCreateRequest(
  request: ContractCreateRequest,
  files: ContractCreateUploadFile[],
): void {
  assertKind(request?.kind);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      request.idempotencyKey || '',
    )
  ) {
    throw new BadRequestException('创建请求标识无效，请刷新后重试');
  }
  validatePaymentPlans(request);
  if (!Array.isArray(files) || !files.length) {
    throw new BadRequestException('请上传合同 PDF 附件');
  }
  if (files.length > MAX_FILES) {
    throw new BadRequestException(`合同附件最多上传 ${MAX_FILES} 个`);
  }
  for (const file of files) {
    if (!file.buffer?.length || file.size <= 0) {
      throw new BadRequestException('合同附件内容为空');
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('单个合同附件不能超过 20MB');
    }
    if (
      file.mimetype !== 'application/pdf' ||
      !file.originalname.toLowerCase().endsWith('.pdf') ||
      file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-'
    ) {
      throw new BadRequestException('合同附件仅支持有效的 PDF 文件');
    }
  }
}

function validatePaymentPlans(request: ContractCreateRequest): void {
  if (request.kind === 'framework') {
    if (request.paymentPlans?.length) {
      throw new BadRequestException('框架合同不支持录入付款计划');
    }
    return;
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
}

function fieldValue(
  request: ContractCreateRequest,
  definition: ContractCreateFieldDefinition[],
  name: string,
): ContractCreateValue | undefined {
  const field = definition.find((item) => item.name === name);
  return field ? request.fields[field.fieldId] : undefined;
}

function textField(
  request: ContractCreateRequest,
  definition: ContractCreateFieldDefinition[],
  name: string,
): string {
  const value = fieldValue(request, definition, name);
  return typeof value === 'string' ? value.trim() : '';
}

function numberField(
  request: ContractCreateRequest,
  definition: ContractCreateFieldDefinition[],
  name: string,
): number {
  const value = fieldValue(request, definition, name);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function strings(value: ContractCreateValue | undefined): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values.flatMap((item) =>
        typeof item === 'string' && item.trim() ? [item.trim()] : [],
      ),
    ),
  ];
}

function dateValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return dateKey(new Date(value));
  }
  const text = displayText(value);
  if (!text) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00+08:00`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : dateKey(date);
}

function dateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map(displayText).filter(Boolean).join('、');
  }
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'name', 'value']) {
    const result = displayText(item[key]);
    if (result) return result;
  }
  return '';
}

function getRecordId(record: RecordItem): string {
  return (record.record_id || record.id || '').trim();
}

function isMarkedSelfTestContract(record: RecordItem): boolean {
  return displayText(record.fields?.['合同编号']).startsWith(
    SELF_TEST_MARKER_PREFIX,
  );
}

function isMarkedSelfTestSupplier(record: RecordItem): boolean {
  return displayText(record.fields?.['公司单位']).startsWith(
    SELF_TEST_MARKER_PREFIX,
  );
}

function isLinkedToMarkedContract(
  record: RecordItem,
  markedContractIds: ReadonlySet<string>,
): boolean {
  return linkedRecordIds(record.fields?.['合同编号']).some((recordId) =>
    markedContractIds.has(recordId),
  );
}

function linkedRecordIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(linkedRecordIds);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.record_ids)) {
    return record.record_ids.filter(
      (recordId): recordId is string =>
        typeof recordId === 'string' && Boolean(recordId.trim()),
    );
  }
  return typeof record.record_id === 'string' && record.record_id.trim()
    ? [record.record_id.trim()]
    : [];
}

function derivedUuid(seed: string, scope: string): string {
  const hash = createHash('sha256').update(`${seed}:${scope}`).digest('hex');
  const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function normalizeCreateError(error: unknown): Error {
  if (
    error instanceof BadRequestException ||
    error instanceof BadGatewayException
  ) {
    return error;
  }
  return new BadGatewayException(`新增合同失败：${safeMessage(error)}`);
}

function normalizeCreateValidationError(error: unknown): BadRequestException {
  return error instanceof BadRequestException
    ? error
    : new BadRequestException(safeMessage(error));
}

function assertKind(kind: unknown): asserts kind is ContractCreateKind {
  if (kind !== 'framework' && kind !== 'execution') {
    throw new BadRequestException('合同类型无效');
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : '未知错误';
}

function assignSelfTestField(
  definition: ContractCreateFieldDefinition[],
  values: Record<string, ContractCreateValue>,
  name: string,
  value: ContractCreateValue,
): void {
  const field = definition.find((item) => item.name === name);
  if (!field) {
    throw new BadRequestException(`真实自测无法执行：多维表缺少${name}字段`);
  }
  values[field.fieldId] = value;
}

function assignFirstOption(
  definition: ContractCreateFieldDefinition[],
  values: Record<string, ContractCreateValue>,
  name: string,
): void {
  const field = definition.find((item) => item.name === name);
  const value = field?.options[0]?.value;
  if (!field || !value) {
    throw new BadRequestException(`真实自测无法执行：${name}没有可用选项`);
  }
  values[field.fieldId] = value;
}

async function recordStillExists(
  read: () => Promise<unknown>,
  attempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await read();
      if (attempt < attempts - 1) await delay(500);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
  return true;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof NotFoundException ||
    (typeof error === 'object' &&
      error !== null &&
      'getStatus' in error &&
      typeof (error as { getStatus?: unknown }).getStatus === 'function' &&
      (error as { getStatus: () => number }).getStatus() === 404)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
