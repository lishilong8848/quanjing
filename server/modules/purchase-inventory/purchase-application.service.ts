import { HttpService } from '@nestjs/axios';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { matchesSelfServicePersonnelIdentity } from '../../common/access/self-service-applicant';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- form-data exposes a CommonJS constructor.
import FormData = require('form-data');
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  PurchaseApplicationBatchRequest,
  PurchaseApplicationApplicant,
  PurchaseApplicationApplicantSearchParams,
  PurchaseApplicationCatalogItem,
  PurchaseApplicationCatalogSearchParams,
  PurchaseApplicationOptionsResponse,
  PurchaseApplicationSubmissionResponse,
  PurchaseApplicationSubmissionTask,
  PurchaseApplicationSubmissionTaskStatusResponse,
  PurchaseApplicationSubmitResponse,
} from '../../../shared/purchase-application.interface';
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  extractDisplayText,
  extractDisplayValues,
  fetchBitableRecords,
  getRecordId,
  invalidateBitableRecordCache,
  pickField,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  buildPurchaseExecutionFields,
  validatePurchaseApplication,
} from './purchase-application.validation';
import {
  PurchaseApplicationTaskLedgerStore,
  type PurchaseApplicationLedgerTask,
  type PurchaseApplicationTaskLedgerEntry,
} from './purchase-application-task-ledger.store';
import { PurchaseCodeService } from './purchase-code.service';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { comparisonAttachmentIssue } from '../../../shared/purchase-comparison-attachments';

const CATALOG_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_EMPLOYEE_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/AdQmwOqwei6Xr4kag3pcp1Flnmg?table=tblOu75UtJTDNHIM&view=vewrQcypV4';
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 50 * 1024 * 1024;
const MAX_RETAINED_SUBMISSION_TASKS = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const SUBMISSION_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const UNCERTAIN_SUBMISSION_MESSAGE =
  '采购申请同步结果暂不确定；系统不会重复执行，请使用原幂等号查询并核对采购清单';
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

class UncertainApplicationRecordMutationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UncertainApplicationRecordMutationError';
  }
}

class DefinitelyNotWrittenApplicationSubmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DefinitelyNotWrittenApplicationSubmissionError';
  }
}

export interface PurchaseApplicationUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const APPLICATION_OPTIONS: PurchaseApplicationOptionsResponse = {
  buildings: ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'],
  specialties: ['电气', '暖通', '弱电', '消防', '土建', '其他'],
  purchaseMethods: ['需求自采（楼内）', '综合采购'],
  purchaseChannels: ['线上', '线下'],
  procurementForms: ['三方比价', '单一采购'],
  comparisonOptions: ['是', '否'],
  primaryCategories: ['A备品备件类', 'B工具类', 'C物资类', 'D消耗类', '//'],
  secondaryCategories: [
    '应急件A1',
    '常备件A2',
    '检测工具B1',
    '日常工具B2',
    '防护工具B3',
    '应急物资C1',
    '防疫物资C2',
    '日常物资C3',
    '运维耗材D1',
    '办公耗材D2',
  ],
};

@Injectable()
export class PurchaseApplicationService {
  private readonly logger = new Logger(PurchaseApplicationService.name);
  private tenantToken: { value: string; expiresAt: number } | null = null;
  private tenantTokenPromise: Promise<string> | null = null;
  private readonly ensuredOnlineLinkFieldCounts = new Map<string, number>();
  private readonly submissionTasks = new Map<
    string,
    {
      task: PurchaseApplicationLedgerTask;
      building: string;
      principalFingerprint: string;
      idempotencyKey: string;
      requestFingerprint: string;
      submissionFingerprint: string;
    }
  >();
  private readonly submissionTaskIdsByIdempotencyKey = new Map<
    string,
    string
  >();
  private readonly durabilityFailureFallbackTaskIds = new Set<string>();

  constructor(
    private readonly httpService: HttpService,
    @Optional()
    private readonly purchaseManagerApprovalService?: PurchaseManagerApprovalService,
    private readonly purchaseCodeService: PurchaseCodeService = new PurchaseCodeService(
      httpService,
    ),
    private readonly submissionTaskLedger: PurchaseApplicationTaskLedgerStore = new PurchaseApplicationTaskLedgerStore(),
  ) {}

  getOptions(): PurchaseApplicationOptionsResponse {
    return {
      ...APPLICATION_OPTIONS,
      buildings: [...APPLICATION_OPTIONS.buildings],
      specialties: [...APPLICATION_OPTIONS.specialties],
      purchaseMethods: [...APPLICATION_OPTIONS.purchaseMethods],
      purchaseChannels: [...APPLICATION_OPTIONS.purchaseChannels],
      procurementForms: [...APPLICATION_OPTIONS.procurementForms],
      comparisonOptions: [...APPLICATION_OPTIONS.comparisonOptions],
      primaryCategories: [...APPLICATION_OPTIONS.primaryCategories],
      secondaryCategories: [...APPLICATION_OPTIONS.secondaryCategories],
    };
  }

  async searchCatalog(
    params: PurchaseApplicationCatalogSearchParams,
    forceRefresh = false,
  ): Promise<PurchaseApplicationCatalogItem[]> {
    const appToken = await this.resolveAppToken();
    const tableId = readEnv('FEISHU_ITEM_CATEGORY_TABLE_ID');
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '物品类别',
      cacheTtlMs: CATALOG_CACHE_TTL_MS,
      forceRefresh,
    });
    const query = clean(params.query).toLocaleLowerCase('zh-CN');
    const building = clean(params.building);
    const primaryCategory = clean(params.primaryCategory);
    const secondaryCategory = clean(params.secondaryCategory);
    const limit = clampLimit(params.limit);

    return records
      .map(mapCatalogRecord)
      .filter((item) => item.name)
      .filter((item) => !building || item.building === building)
      .filter(
        (item) => !primaryCategory || item.primaryCategory === primaryCategory,
      )
      .filter(
        (item) =>
          !secondaryCategory || item.secondaryCategory === secondaryCategory,
      )
      .filter((item) => !query || searchableText(item).includes(query))
      .sort((left, right) => compareCatalogItems(left, right, query))
      .slice(0, limit);
  }

  async searchApplicants(
    params: PurchaseApplicationApplicantSearchParams,
    forceRefresh = false,
  ): Promise<PurchaseApplicationApplicant[]> {
    const applicants = await this.readActiveApplicants(forceRefresh);
    const building = clean(params.building);
    const query = clean(params.query).toLocaleLowerCase('zh-CN');
    const limit = clampApplicantLimit(params.limit);

    return applicants
      .filter(
        (applicant) => !building || clean(applicant.building) === building,
      )
      .filter(
        (applicant) =>
          !query || applicantSearchableText(applicant).includes(query),
      )
      .sort((left, right) => compareApplicants(left, right, query))
      .slice(0, limit);
  }

  async resolveCurrentApplicant(
    principal: AccessPrincipal,
    building: string,
  ): Promise<PurchaseApplicationApplicant> {
    const applicants = await this.readActiveApplicants(false);
    const source = this.resolveApplicantSource();
    const appToken = await this.resolveApplicantAppToken();
    const tableId = readEnv('FEISHU_ACTIVE_EMPLOYEE_TABLE_ID', [
      'FEISHU_PERSONNEL_MOVEMENT_TABLE_ID', 'FEISHU_ORG_TABLE_ID', 'FEISHU_ORGANIZATION_TABLE_ID',
    ]) || source.tableId;
    const matches = applicants.filter(person => matchesSelfServicePersonnelIdentity(principal, {
      appId: readEnv('FEISHU_APP_ID'), appToken, tableId,
      recordId: person.recordId, openId: person.openId,
    }));
    if (matches.length !== 1 || matches[0].name !== principal.displayName?.trim()) {
      throw new BadRequestException('登录账号未唯一匹配到采购申请人，请联系管理员核对');
    }
    if (building && matches[0].building !== building) {
      throw new BadRequestException('登录本人不属于申请楼栋，请核对申请楼栋或联系管理员');
    }
    return matches[0];
  }

  async resolveApplicantForBuilding(
    params: { recordId: string; openId: string; building: string },
    forceRefresh = false,
  ): Promise<PurchaseApplicationApplicant | null> {
    const recordId = clean(params.recordId);
    const openId = clean(params.openId);
    const building = clean(params.building);
    if (!recordId || !openId || !building) return null;

    const applicants = await this.readActiveApplicants(forceRefresh);
    const matches = applicants.filter(
      (applicant) =>
        clean(applicant.recordId) === recordId &&
        clean(applicant.openId) === openId &&
        clean(applicant.building) === building,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  private async readActiveApplicants(
    forceRefresh: boolean,
  ): Promise<PurchaseApplicationApplicant[]> {
    const source = this.resolveApplicantSource();
    const appToken = await this.resolveApplicantAppToken();
    const tableId =
      readEnv('FEISHU_ACTIVE_EMPLOYEE_TABLE_ID', [
        'FEISHU_PERSONNEL_MOVEMENT_TABLE_ID',
        'FEISHU_ORG_TABLE_ID',
        'FEISHU_ORGANIZATION_TABLE_ID',
      ]) || source.tableId;
    const viewId =
      readEnv('FEISHU_ACTIVE_EMPLOYEE_VIEW_ID', [
        'FEISHU_PERSONNEL_MOVEMENT_VIEW_ID',
        'FEISHU_ORG_PROFILE_VIEW_ID',
        'FEISHU_ORG_VIEW_ID',
        'FEISHU_ORGANIZATION_PROFILE_VIEW_ID',
        'FEISHU_ORGANIZATION_VIEW_ID',
      ]) || source.viewId;
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      viewId,
      tableName: '在职人员',
      cacheTtlMs: CATALOG_CACHE_TTL_MS,
      forceRefresh,
    });

    return records
      .filter((record) => !checked(record.fields?.['离职/异动情况']))
      .map(mapApplicantRecord)
      .filter((applicant) => applicant.name && applicant.openId);
  }

  acceptApplications(
    request: PurchaseApplicationBatchRequest,
    files: PurchaseApplicationUploadFile[],
    today = shanghaiDate(),
    idempotencyKeyValue = '',
    submissionFingerprintValue = '',
    fingerprintRequest: PurchaseApplicationBatchRequest = request,
    principalFingerprintValue = '',
    revalidateApplicantInBackground = false,
  ): PurchaseApplicationSubmissionResponse {
    const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue);
    const submissionFingerprint = normalizeSubmissionFingerprint(
      submissionFingerprintValue,
    );
    const principalFingerprint = normalizePrincipalFingerprint(
      principalFingerprintValue,
    );
    const normalizedFiles = normalizePurchaseApplicationUploadFiles(files);
    const requestFingerprint =
      fingerprintPurchaseApplication(fingerprintRequest);
    const requestedBuilding = clean(request?.shared?.building);
    const fingerprintFiles = selectComparisonFiles(
      fingerprintRequest,
      normalizedFiles,
    );
    const suppliedFilesFingerprint = fingerprintFiles.length
      ? buildPurchaseApplicationSubmissionFingerprint(
          fingerprintRequest,
          fingerprintFiles,
        )
      : '';
    if (
      suppliedFilesFingerprint &&
      suppliedFilesFingerprint !== submissionFingerprint
    ) {
      throw new BadRequestException('采购申请幂等指纹与附件内容不一致');
    }

    const persistedEntry = this.submissionTaskLedger.findByIdentity(
      requestedBuilding,
      principalFingerprint,
      idempotencyKey,
    );
    if (persistedEntry) {
      this.assertMatchingSubmissionIdentity(persistedEntry, {
        requestFingerprint,
        submissionFingerprint,
      });
      this.restoreSubmissionTaskInMemory(persistedEntry);
      return acceptedSubmission(persistedEntry.task);
    }

    const computedSubmissionFingerprint =
      suppliedFilesFingerprint ||
      buildPurchaseApplicationSubmissionFingerprint(
        fingerprintRequest,
        fingerprintFiles,
      );
    if (computedSubmissionFingerprint !== submissionFingerprint) {
      throw new BadRequestException('采购申请幂等指纹与提交内容不一致');
    }

    assertPurchaseApplicationSyncReady();
    const preparedRequest = this.validateSubmission(
      request,
      normalizedFiles,
      today,
    );
    const comparisonFiles = selectComparisonFiles(
      preparedRequest,
      normalizedFiles,
    );
    const preparedFiles = comparisonFiles.map((file) => ({
      ...file,
      buffer: Buffer.from(file.buffer),
    }));
    const task: PurchaseApplicationLedgerTask = {
      id: `purchase-application-${randomUUID()}`,
      status: 'pending',
      message: '采购申请已受理，正在后台同步飞书多维表',
      createdAt: new Date().toISOString(),
    };
    const reservation = this.submissionTaskLedger.reserve({
      task,
      building: preparedRequest.shared.building,
      principalFingerprint,
      idempotencyKey,
      requestFingerprint,
      submissionFingerprint,
    });
    if (!reservation.created) {
      this.assertMatchingSubmissionIdentity(reservation.entry, {
        requestFingerprint,
        submissionFingerprint,
      });
      this.restoreSubmissionTaskInMemory(reservation.entry);
      return acceptedSubmission(reservation.entry.task);
    }
    this.restoreSubmissionTaskInMemory(reservation.entry);
    setImmediate(() => {
      void this.executeSubmissionTask(
        task.id,
        preparedRequest,
        preparedFiles,
        today,
        revalidateApplicantInBackground,
      );
    });
    return acceptedSubmission(task);
  }

  findAcceptedApplication(
    fingerprintRequest: PurchaseApplicationBatchRequest,
    files: PurchaseApplicationUploadFile[],
    buildingValue: string,
    idempotencyKeyValue: string,
    submissionFingerprintValue: string,
    principalFingerprintValue: string,
  ): PurchaseApplicationSubmissionResponse | null {
    const building = clean(buildingValue);
    const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue);
    const submissionFingerprint = normalizeSubmissionFingerprint(
      submissionFingerprintValue,
    );
    const principalFingerprint = normalizePrincipalFingerprint(
      principalFingerprintValue,
    );
    const normalizedFiles = normalizePurchaseApplicationUploadFiles(files);
    const fingerprintFiles = selectComparisonFiles(
      fingerprintRequest,
      normalizedFiles,
    );
    const suppliedFilesFingerprint = fingerprintFiles.length
      ? buildPurchaseApplicationSubmissionFingerprint(
          fingerprintRequest,
          fingerprintFiles,
        )
      : '';
    if (
      suppliedFilesFingerprint &&
      suppliedFilesFingerprint !== submissionFingerprint
    ) {
      throw new BadRequestException('采购申请幂等指纹与附件内容不一致');
    }

    const persistedEntry = this.submissionTaskLedger.findByIdentity(
      building,
      principalFingerprint,
      idempotencyKey,
    );
    if (!persistedEntry) return null;

    this.assertMatchingSubmissionIdentity(persistedEntry, {
      requestFingerprint: fingerprintPurchaseApplication(fingerprintRequest),
      submissionFingerprint,
    });
    this.restoreSubmissionTaskInMemory(persistedEntry);
    return acceptedSubmission(persistedEntry.task);
  }

  getSubmissionTaskStatus(
    taskIdValue: string,
    expectedBuilding?: string | null,
    expectedPrincipalFingerprintValue = '',
  ): PurchaseApplicationSubmissionTaskStatusResponse {
    const taskId = clean(taskIdValue);
    const expectedPrincipalFingerprint = normalizePrincipalFingerprint(
      expectedPrincipalFingerprintValue,
    );
    let entry: ReturnType<typeof this.submissionTasks.get>;
    try {
      const persisted = taskId
        ? this.submissionTaskLedger.findByTaskId(taskId)
        : undefined;
      if (persisted) {
        this.restoreSubmissionTaskInMemory(persisted);
        entry = this.submissionTasks.get(taskId);
      }
    } catch (error) {
      const fallbackEntry = taskId
        ? this.submissionTasks.get(taskId)
        : undefined;
      if (
        !fallbackEntry ||
        fallbackEntry.task.status !== 'uncertain' ||
        !this.durabilityFailureFallbackTaskIds.has(taskId)
      ) {
        throw error;
      }
      entry = fallbackEntry;
    }
    if (
      !entry ||
      expectedPrincipalFingerprint !== entry.principalFingerprint ||
      (expectedBuilding !== undefined &&
        clean(expectedBuilding) !== entry.building)
    ) {
      return {
        success: false,
        message: '采购申请后台任务不存在或已过期',
      };
    }
    return {
      success: true,
      task: cloneSubmissionTask(entry.task),
    };
  }

  private assertMatchingSubmissionIdentity(
    entry: PurchaseApplicationTaskLedgerEntry,
    identity: {
      requestFingerprint: string;
      submissionFingerprint: string;
    },
  ): void {
    if (entry.requestFingerprint !== identity.requestFingerprint) {
      throw new ConflictException('同一幂等键不能用于不同的采购申请内容');
    }
    if (entry.submissionFingerprint !== identity.submissionFingerprint) {
      throw new ConflictException('同一幂等键不能用于不同的采购申请附件');
    }
  }

  private restoreSubmissionTaskInMemory(
    persisted: PurchaseApplicationTaskLedgerEntry,
  ): void {
    this.submissionTasks.set(persisted.task.id, {
      task: cloneLedgerTask(persisted.task),
      building: persisted.building,
      principalFingerprint: persisted.principalFingerprint,
      idempotencyKey: persisted.idempotencyKey,
      requestFingerprint: persisted.requestFingerprint,
      submissionFingerprint: persisted.submissionFingerprint,
    });
    this.submissionTaskIdsByIdempotencyKey.set(
      submissionIdempotencyIndexKey(
        persisted.building,
        persisted.principalFingerprint,
        persisted.idempotencyKey,
      ),
      persisted.task.id,
    );
    this.pruneSubmissionTasks();
  }

  async submitApplications(
    request: PurchaseApplicationBatchRequest,
    files: PurchaseApplicationUploadFile[],
    today = shanghaiDate(),
    approvalBatchId = '',
  ): Promise<PurchaseApplicationSubmitResponse> {
    const normalizedFiles = normalizePurchaseApplicationUploadFiles(files);
    const validatedRequest = this.validateSubmission(
      request,
      normalizedFiles,
      today,
    );
    const comparisonFiles = selectComparisonFiles(
      validatedRequest,
      normalizedFiles,
    );

    const appToken = await this.resolveAppToken();
    const submissionTableId = readEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID');
    if (!submissionTableId) {
      throw new BadRequestException('采购提交表尚未配置，无法校验历史采购编码');
    }
    const executionTableId = readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID');
    if (!executionTableId) {
      throw new BadRequestException('采购执行表尚未配置');
    }
    const requestCode = await this.purchaseCodeService.allocate({
      appToken,
      date: today,
      building: validatedRequest.shared.building,
      submissionTableId,
      executionTableId,
    });
    const accessToken = await this.getTenantAccessToken();
    await this.ensureOnlineLinkFields(
      appToken,
      executionTableId,
      Math.max(
        0,
        ...validatedRequest.items.map((item) => item.onlineUrls?.length || 0),
      ),
      accessToken,
    );

    const attachmentTokens: string[] = [];
    for (const file of comparisonFiles) {
      attachmentTokens.push(
        await this.uploadAttachment(appToken, file, accessToken),
      );
    }

    const created: PurchaseApplicationSubmitResponse['created'] = [];
    const failed: PurchaseApplicationSubmitResponse['failed'] = [];
    const warnings: PurchaseApplicationSubmitResponse['warnings'] = [];
    for (const item of validatedRequest.items) {
      let executionRecordId: string;
      try {
        executionRecordId = await this.createApplicationRecord(
          appToken,
          executionTableId,
          buildPurchaseExecutionFields(
            validatedRequest,
            item,
            attachmentTokens,
            requestCode,
            approvalBatchId,
          ),
          accessToken,
          '采购执行',
        );
        const createdItem = {
          lineId: item.lineId,
          recordId: executionRecordId,
          requestCode,
          executionRecordId,
        };
        created.push(createdItem);
      } catch (error) {
        if (error instanceof UncertainApplicationRecordMutationError) {
          this.invalidateApplicationRecordCache(appToken, executionTableId);
          throw error;
        }
        failed.push({ lineId: item.lineId, message: safeErrorMessage(error) });
        continue;
      }
      if (!approvalBatchId) {
        try {
          await this.purchaseManagerApprovalService?.enqueueApprovalRequest(
            executionRecordId,
          );
        } catch {
          warnings.push({
            lineId: item.lineId,
            executionRecordId,
            message: '经理审批消息登记失败，请人工核对',
          });
        }
      }
    }

    if (created.length) {
      this.invalidateApplicationRecordCache(appToken, executionTableId);
    }
    return {
      success: failed.length === 0,
      created,
      failed,
      warnings,
      message: failed.length
        ? `已提交 ${created.length} 项，${failed.length} 项失败`
        : `已成功提交 ${created.length} 项采购申请`,
    };
  }

  private validateSubmission(
    request: PurchaseApplicationBatchRequest,
    files: PurchaseApplicationUploadFile[],
    today: string,
  ): PurchaseApplicationBatchRequest {
    const validation = validatePurchaseApplication(request, today);
    if (!validation.value) {
      throw new BadRequestException({
        message: '采购申请内容校验失败',
        issues: validation.issues,
      });
    }
    const comparisonFiles = selectComparisonFiles(validation.value, files);
    validateAttachments(comparisonFiles);
    const attachmentIssue = validation.value.shared.procurementForm === '三方比价'
      ? comparisonAttachmentIssue(comparisonFiles.map(file => ({ type: verifiedComparisonImageType(file) }))) : null;
    if (attachmentIssue) {
      throw new BadRequestException({
        message: attachmentIssue,
        issues: [
          {
            code: 'REQUIRED_COMPARISON_ATTACHMENT',
            path: 'shared.comparisonAttachment',
            message: attachmentIssue,
          },
        ],
      });
    }
    return validation.value;
  }

  private async executeSubmissionTask(
    taskId: string,
    request: PurchaseApplicationBatchRequest,
    files: PurchaseApplicationUploadFile[],
    today: string,
    revalidateApplicantInBackground: boolean,
  ): Promise<void> {
    const entry = this.submissionTasks.get(taskId);
    if (!entry) return;
    const runningTask: PurchaseApplicationLedgerTask = {
      ...entry.task,
      status: 'running',
      message: '采购申请正在后台同步飞书多维表',
    };
    try {
      entry.task = this.submissionTaskLedger.updateTask(
        taskId,
        runningTask,
      ).task;
    } catch (error) {
      entry.task = uncertainSubmissionTask(entry.task);
      this.durabilityFailureFallbackTaskIds.add(taskId);
      this.logger.error(
        `采购申请后台任务无法持久化运行态，已停止外部写入: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
      return;
    }

    let terminalTask: PurchaseApplicationLedgerTask;
    let batchRequesterOpenId = request.shared.applicantOpenId;
    try {
      const authoritativeRequest = revalidateApplicantInBackground
        ? await this.revalidateSubmissionApplicant(request)
        : request;
      batchRequesterOpenId = authoritativeRequest.shared.applicantOpenId;
      const result = await this.submitApplications(
        authoritativeRequest,
        files,
        today,
        taskId,
      );
      terminalTask = {
        ...entry.task,
        status: 'completed',
        result,
        message: result.message,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      terminalTask =
        error instanceof UncertainApplicationRecordMutationError
          ? uncertainSubmissionTask(entry.task)
          : error instanceof DefinitelyNotWrittenApplicationSubmissionError
            ? {
                ...entry.task,
                status: 'failed',
                message: error.message,
                completedAt: new Date().toISOString(),
                definitelyNotWritten: true,
              }
            : {
                ...entry.task,
                status: 'failed',
                message:
                  '采购申请同步飞书多维表失败，写入结果未完全确认，请使用原编号核对',
                completedAt: new Date().toISOString(),
              };
      this.logger.error(
        `采购申请后台同步失败: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
    }
    try {
      entry.task = this.submissionTaskLedger.updateTask(
        taskId,
        terminalTask,
      ).task;
      if (
        entry.task.status === 'completed' &&
        entry.task.result?.created.length &&
        this.purchaseManagerApprovalService
      ) {
        try {
          await this.purchaseManagerApprovalService.enqueueApprovalBatch({
            approvalBatchId: taskId,
            requesterOpenId: batchRequesterOpenId,
            recordIds: entry.task.result.created.map(
              (item) => item.executionRecordId || item.recordId,
            ),
          });
        } catch (error) {
          const first = entry.task.result.created[0];
          const warning = {
            lineId: first?.lineId || 'batch',
            executionRecordId:
              first?.executionRecordId || first?.recordId || 'batch',
            message: '经理批次审批消息登记失败，后台将自动补偿',
          };
          entry.task = this.submissionTaskLedger.updateTask(taskId, {
            ...entry.task,
            result: {
              ...entry.task.result,
              warnings: [...entry.task.result.warnings, warning],
            },
          }).task;
          this.logger.error(
            `采购批次审批登记失败，等待后台补偿: task=${taskId}, message=${safeErrorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      entry.task = uncertainSubmissionTask(entry.task);
      this.durabilityFailureFallbackTaskIds.add(taskId);
      this.logger.error(
        `采购申请终态持久化失败，结果转为不确定: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
    } finally {
      this.pruneSubmissionTasks();
    }
  }

  private async revalidateSubmissionApplicant(
    request: PurchaseApplicationBatchRequest,
  ): Promise<PurchaseApplicationBatchRequest> {
    const building = request.shared.building;
    let applicant: PurchaseApplicationApplicant | null;
    try {
      applicant = await this.resolveApplicantForBuilding(
        {
          recordId: request.shared.applicantRecordId,
          openId: request.shared.applicantOpenId,
          building,
        },
        true,
      );
    } catch (error) {
      throw new DefinitelyNotWrittenApplicationSubmissionError(
        `申请人资格校验失败，采购申请未写入：${safeErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (!applicant) {
      throw new DefinitelyNotWrittenApplicationSubmissionError(
        `申请人已失效或不属于${building}，采购申请未写入`,
      );
    }
    return {
      ...request,
      shared: {
        ...request.shared,
        building,
        applicantRecordId: applicant.recordId,
        applicantOpenId: applicant.openId,
        applicantName: applicant.name,
        applicantEmployeeNo: applicant.employeeNo,
        applicantPosition: applicant.position,
        applicantBuilding: building,
      },
    };
  }

  private invalidateApplicationRecordCache(
    appToken: string,
    tableId: string,
  ): void {
    try {
      invalidateBitableRecordCache({ appToken, tableId });
    } catch (error) {
      this.logger.warn(
        `采购申请记录已写入，但缓存失效失败，将等待后续刷新：${safeErrorMessage(error)}`,
      );
    }
  }

  private pruneSubmissionTasks(): void {
    if (this.submissionTasks.size <= MAX_RETAINED_SUBMISSION_TASKS) return;
    for (const [taskId, entry] of this.submissionTasks) {
      const { task } = entry;
      if (task.status === 'pending' || task.status === 'running') continue;
      this.deleteSubmissionTask(taskId, entry);
      if (this.submissionTasks.size <= MAX_RETAINED_SUBMISSION_TASKS) return;
    }
  }

  private deleteSubmissionTask(
    taskId: string,
    entry: {
      task: PurchaseApplicationLedgerTask;
      building: string;
      principalFingerprint: string;
      idempotencyKey: string;
      requestFingerprint: string;
      submissionFingerprint: string;
    },
  ): void {
    this.submissionTasks.delete(taskId);
    this.durabilityFailureFallbackTaskIds.delete(taskId);
    const indexKey = submissionIdempotencyIndexKey(
      entry.building,
      entry.principalFingerprint,
      entry.idempotencyKey,
    );
    if (this.submissionTaskIdsByIdempotencyKey.get(indexKey) === taskId) {
      this.submissionTaskIdsByIdempotencyKey.delete(indexKey);
    }
  }

  private async resolveAppToken(): Promise<string> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'),
    );
    return resolveBitableAppToken(this.httpService, {
      appToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || source.appToken,
      wikiToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_WIKI_TOKEN') || source.wikiToken,
      tableName: '采购与库房管理',
    });
  }

  private async resolveApplicantAppToken(): Promise<string> {
    const source = this.resolveApplicantSource();
    return resolveBitableAppToken(this.httpService, {
      appToken:
        readEnv('FEISHU_ACTIVE_EMPLOYEE_APP_TOKEN', [
          'FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN',
          'FEISHU_ORG_APP_TOKEN',
          'FEISHU_ORGANIZATION_APP_TOKEN',
        ]) || source.appToken,
      wikiToken:
        readEnv('FEISHU_ACTIVE_EMPLOYEE_WIKI_TOKEN', [
          'FEISHU_PERSONNEL_MOVEMENT_WIKI_TOKEN',
          'FEISHU_ORG_WIKI_TOKEN',
          'FEISHU_ORGANIZATION_WIKI_TOKEN',
        ]) || source.wikiToken,
      tableName: '在职人员',
    });
  }

  private resolveApplicantSource() {
    return parseFeishuBitableLink(
      readEnv('FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL', [
        'FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL',
        'FEISHU_ORG_SOURCE_URL',
        'FEISHU_ORGANIZATION_SOURCE_URL',
      ]) || DEFAULT_ACTIVE_EMPLOYEE_SOURCE_URL,
    );
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now()) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenPromise) return this.tenantTokenPromise;

    this.tenantTokenPromise = (async () => {
      const response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: 30_000 },
      );
      assertFeishuSuccess(response.data, '获取飞书租户令牌失败');
      const value = clean(response.data?.tenant_access_token);
      if (!value) throw new Error('获取飞书租户令牌失败：响应缺少令牌');
      const seconds = Number(response.data?.expire);
      this.tenantToken = {
        value,
        expiresAt:
          Date.now() +
          (Number.isFinite(seconds) ? Math.max(60, seconds - 300) : 5400) *
            1000,
      };
      return value;
    })();

    try {
      return await this.tenantTokenPromise;
    } finally {
      this.tenantTokenPromise = null;
    }
  }

  private async uploadAttachment(
    appToken: string,
    file: PurchaseApplicationUploadFile,
    userAccessToken: string,
  ): Promise<string> {
    const form = new FormData();
    const fileName = safeFileName(file.originalname);
    form.append('file_name', fileName);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', appToken);
    form.append('size', String(file.size));
    form.append('file', file.buffer, {
      filename: fileName,
      contentType: file.mimetype,
    });

    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
      form,
      {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: 60_000,
      },
    );
    assertFeishuSuccess(response.data, '上传三方比价附件失败');
    const fileToken = clean(
      response.data?.data?.file_token || response.data?.data?.media_token,
    );
    if (!fileToken)
      throw new Error('上传三方比价附件失败：响应缺少 file_token');
    return fileToken;
  }

  private async createApplicationRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
    userAccessToken: string,
    tableName = '采购申请',
  ): Promise<string> {
    let responseData: unknown;
    try {
      const response = await this.httpService.axiosRef.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { fields },
        {
          headers: { Authorization: `Bearer ${userAccessToken}` },
          timeout: 30_000,
        },
      );
      responseData = response.data;
    } catch (error) {
      if (recordWriteOutcomeIsUncertain(error)) {
        throw new UncertainApplicationRecordMutationError(
          `写入${tableName}的结果暂不确定：${safeErrorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    assertFeishuSuccess(responseData, `写入${tableName}失败`);
    const responsePayload = isRecord(responseData) ? responseData : {};
    const responseRecordData = isRecord(responsePayload.data)
      ? responsePayload.data
      : {};
    const responseRecord = isRecord(responseRecordData.record)
      ? responseRecordData.record
      : {};
    const recordId = clean(
      responseRecord.record_id ||
        responseRecordData.record_id ||
        responseRecord.id,
    );
    if (!recordId) {
      throw new UncertainApplicationRecordMutationError(
        `写入${tableName}的结果暂不确定：响应缺少 record_id`,
      );
    }
    return recordId;
  }

  private async ensureOnlineLinkFields(
    appToken: string,
    tableId: string,
    requiredCount: number,
    accessToken: string,
  ): Promise<void> {
    if (requiredCount <= 1) return;
    const cacheKey = `${appToken}:${tableId}`;
    if (
      (this.ensuredOnlineLinkFieldCounts.get(cacheKey) || 1) >= requiredCount
    ) {
      return;
    }

    const fieldNames = new Set<string>();
    let pageToken = '';
    do {
      const response = await this.httpService.axiosRef.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(response.data, '读取采购执行表字段失败');
      for (const item of response.data?.data?.items || []) {
        const fieldName = clean(item?.field_name || item?.name);
        if (fieldName) fieldNames.add(fieldName);
      }
      pageToken = response.data?.data?.has_more
        ? clean(response.data?.data?.page_token)
        : '';
    } while (pageToken);

    const requiredFields = ['线上链接2', '线上链接3'].slice(
      0,
      Math.min(3, requiredCount) - 1,
    );
    for (const fieldName of requiredFields) {
      if (fieldNames.has(fieldName)) continue;
      const response = await this.httpService.axiosRef.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        { field_name: fieldName, type: 15 },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(
        response.data,
        `创建采购执行表字段“${fieldName}”失败`,
      );
    }
    this.ensuredOnlineLinkFieldCounts.set(cacheKey, requiredCount);
  }
}

function cloneSubmissionTask(
  task: PurchaseApplicationLedgerTask,
): PurchaseApplicationSubmissionTask {
  return cloneLedgerTask(task);
}

function acceptedSubmission(
  task: PurchaseApplicationLedgerTask,
): PurchaseApplicationSubmissionResponse {
  return {
    pending: true,
    taskId: task.id,
    message: task.message,
  };
}

function normalizeIdempotencyKey(value: unknown): string {
  const key = clean(value);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new BadRequestException('采购申请必须提供有效幂等键');
  }
  return key;
}

export function normalizePurchaseApplicationIdempotencyKey(
  value: unknown,
): string {
  return normalizeIdempotencyKey(value);
}

function normalizeSubmissionFingerprint(value: unknown): string {
  const fingerprint = clean(value).toLowerCase();
  if (!SUBMISSION_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new BadRequestException('采购申请必须提供有效幂等指纹');
  }
  return fingerprint;
}

function normalizePrincipalFingerprint(value: unknown): string {
  const fingerprint = clean(value);
  if (
    fingerprint.length < 8 ||
    fingerprint.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(fingerprint)
  ) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return fingerprint;
}

export function normalizePurchaseApplicationSubmissionFingerprint(
  value: unknown,
): string {
  return normalizeSubmissionFingerprint(value);
}

function submissionIdempotencyIndexKey(
  building: string,
  principalFingerprint: string,
  idempotencyKey: string,
): string {
  return JSON.stringify([
    clean(building),
    clean(principalFingerprint),
    idempotencyKey,
  ]);
}

function fingerprintPurchaseApplication(
  request: PurchaseApplicationBatchRequest,
): string {
  return createHash('sha256')
    .update(stableSerialize(request), 'utf8')
    .digest('hex');
}

export function buildPurchaseApplicationSubmissionFingerprint(
  request: PurchaseApplicationBatchRequest,
  files: PurchaseApplicationUploadFile[],
): string {
  return createHash('sha256')
    .update(
      stableSerialize({
        payload: request,
        attachments: files.map((file) => ({
          name: normalizePurchaseApplicationUploadFileName(file.originalname),
          type: file.mimetype,
          size: file.size,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
        })),
      }),
      'utf8',
    )
    .digest('hex');
}

export function normalizePurchaseApplicationUploadFileName(
  fileNameValue: unknown,
): string {
  const original = typeof fileNameValue === 'string' ? fileNameValue : '';
  if (
    !original ||
    !original.trim() ||
    /[\u0000-\u001f\u007f/\\]/u.test(original) ||
    original.includes('\ufffd')
  ) {
    throw new BadRequestException('采购申请附件文件名无效');
  }

  const codePoints = [...original].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const latin1Bytes = codePoints.filter((codePoint) => codePoint >= 0x80);
  if (
    latin1Bytes.length === 0 ||
    codePoints.some((codePoint) => codePoint > 0xff)
  ) {
    return assertValidPurchaseApplicationUploadFileName(original);
  }

  const repaired = Buffer.from(original, 'latin1').toString('utf8');
  const reversible =
    repaired &&
    !repaired.includes('\ufffd') &&
    Buffer.from(repaired, 'utf8').toString('latin1') === original;
  if (reversible && shouldUseRepairedUploadFileName(original, repaired)) {
    return assertValidPurchaseApplicationUploadFileName(repaired);
  }
  return assertValidPurchaseApplicationUploadFileName(original);
}

function assertValidPurchaseApplicationUploadFileName(value: string): string {
  if (value.length > 180 || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    throw new BadRequestException('采购申请附件文件名无效');
  }
  return value;
}

function normalizePurchaseApplicationUploadFiles(
  files: PurchaseApplicationUploadFile[],
): PurchaseApplicationUploadFile[] {
  return files.map((file) => {
    const originalname = normalizePurchaseApplicationUploadFileName(
      file.originalname,
    );
    return originalname === file.originalname
      ? file
      : { ...file, originalname };
  });
}

function shouldUseRepairedUploadFileName(
  original: string,
  repaired: string,
): boolean {
  const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/gu;
  const latin1Pattern = /[\u0080-\u00ff]/gu;
  const originalCjkCount = original.match(cjkPattern)?.length || 0;
  const repairedCjkCount = repaired.match(cjkPattern)?.length || 0;
  const originalLatin1Count = original.match(latin1Pattern)?.length || 0;
  const repairedLatin1Count = repaired.match(latin1Pattern)?.length || 0;
  return (
    repairedCjkCount > originalCjkCount ||
    repairedLatin1Count < originalLatin1Count
  );
}

function cloneLedgerTask(
  task: PurchaseApplicationLedgerTask,
): PurchaseApplicationLedgerTask {
  return {
    ...task,
    ...(task.result
      ? {
          result: {
            ...task.result,
            created: task.result.created.map((item) => ({ ...item })),
            failed: task.result.failed.map((item) => ({ ...item })),
            warnings: task.result.warnings.map((item) => ({ ...item })),
          },
        }
      : {}),
  };
}

function uncertainSubmissionTask(
  task: PurchaseApplicationLedgerTask,
): PurchaseApplicationLedgerTask {
  return {
    ...task,
    status: 'uncertain',
    message: UNCERTAIN_SUBMISSION_MESSAGE,
    completedAt: new Date().toISOString(),
  };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function assertPurchaseApplicationSyncReady(): void {
  const invalidKeys: string[] = [];
  if (
    !/^tbl[A-Za-z0-9_-]+$/u.test(readEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID'))
  ) {
    invalidKeys.push('FEISHU_PURCHASE_SUBMISSION_TABLE_ID');
  }
  if (
    !/^tbl[A-Za-z0-9_-]+$/u.test(readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID'))
  ) {
    invalidKeys.push('FEISHU_PURCHASE_EXECUTION_TABLE_ID');
  }

  if (invalidKeys.length) {
    throw new ServiceUnavailableException(
      `采购申请同步配置不完整：${invalidKeys.join('、')}`,
    );
  }
}

function mapCatalogRecord(
  record: BitableRecordItem,
): PurchaseApplicationCatalogItem {
  const fields = record.fields || {};
  return {
    recordId: getRecordId(record),
    sku: fieldText(fields, ['物品类别号', '物品类别号（单选）', 'SourceID']),
    name: fieldText(fields, ['名称']),
    building: fieldText(fields, ['楼栋']),
    specialty: fieldText(fields, ['专业', '所属专业/设备/所持人']),
    primaryCategory: fieldText(fields, ['一级分类']),
    secondaryCategory: fieldText(fields, ['二级分类']),
    specification: fieldText(fields, ['规格型号、设备序列号']),
    brand: fieldText(fields, ['品牌']),
    unit: fieldText(fields, ['计数单位']),
  };
}

function mapApplicantRecord(
  record: BitableRecordItem,
): PurchaseApplicationApplicant {
  const fields = record.fields || {};
  const specialtyValues = extractDisplayValues(
    pickField(fields, ['机楼/专业']),
  );
  const rawBuilding = fieldText(fields, ['楼栋']);
  const buildingFromSpecialty = specialtyValues.find((value) =>
    /^(?:[A-EH]楼|110站)$/i.test(value.trim()),
  );
  return {
    recordId: getRecordId(record),
    openId: userOpenId(pickField(fields, ['员工姓名'])),
    name: fieldText(fields, ['姓名', '员工姓名']),
    employeeNo: fieldText(fields, ['员工工号']),
    position: fieldText(fields, ['岗位', '体系岗位']),
    building:
      buildingFromSpecialty || (/^opt/i.test(rawBuilding) ? '' : rawBuilding),
    specialty: specialtyValues.join('、'),
  };
}

function fieldText(fields: Record<string, unknown>, names: string[]): string {
  return clean(extractDisplayText(pickField(fields, names)));
}

function searchableText(item: PurchaseApplicationCatalogItem): string {
  return [item.name, item.sku, item.specification]
    .join('\n')
    .toLocaleLowerCase('zh-CN');
}

function applicantSearchableText(item: PurchaseApplicationApplicant): string {
  return [
    item.name,
    item.employeeNo,
    item.position,
    item.building,
    item.specialty,
  ]
    .join('\n')
    .toLocaleLowerCase('zh-CN');
}

function compareApplicants(
  left: PurchaseApplicationApplicant,
  right: PurchaseApplicationApplicant,
  query: string,
): number {
  if (query) {
    const leftExact = left.name.toLocaleLowerCase('zh-CN') === query;
    const rightExact = right.name.toLocaleLowerCase('zh-CN') === query;
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    const leftStarts = left.name.toLocaleLowerCase('zh-CN').startsWith(query);
    const rightStarts = right.name.toLocaleLowerCase('zh-CN').startsWith(query);
    if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
  }
  return left.name.localeCompare(right.name, 'zh-CN');
}

function compareCatalogItems(
  left: PurchaseApplicationCatalogItem,
  right: PurchaseApplicationCatalogItem,
  query: string,
): number {
  if (query) {
    const leftExact = left.name.toLocaleLowerCase('zh-CN') === query;
    const rightExact = right.name.toLocaleLowerCase('zh-CN') === query;
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
  }
  return left.name.localeCompare(right.name, 'zh-CN');
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(50, Math.max(1, Math.floor(value as number)));
}

function clampApplicantLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(30, Math.max(1, Math.floor(value as number)));
}

function userOpenId(value: unknown): string {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of values) {
    if (!isRecord(item)) continue;
    const id = clean(item.id || item.open_id || item.user_id);
    if (id) return id;
  }
  return '';
}

function checked(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  return extractDisplayValues(value).some((item) =>
    ['true', '1', '是', '已离职', '已异动'].includes(item.trim().toLowerCase()),
  );
}

function selectComparisonFiles(
  request: PurchaseApplicationBatchRequest,
  files: PurchaseApplicationUploadFile[],
): PurchaseApplicationUploadFile[] {
  return request.shared.procurementForm === '三方比价' ? files : [];
}

function validateAttachments(files: PurchaseApplicationUploadFile[]): void {
  if (files.length > 5)
    throw new BadRequestException('三方比价附件最多上传 5 个');
  let totalSize = 0;
  for (const file of files) {
    if (!file.buffer?.length || file.size <= 0) {
      throw new BadRequestException('不能上传空附件');
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `附件 ${safeFileName(file.originalname)} 格式不支持，仅支持 PDF、PNG、JPEG、WebP`,
      );
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        `附件 ${safeFileName(file.originalname)} 超过 20MB`,
      );
    }
    totalSize += file.size;
  }
  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    throw new BadRequestException('附件总大小不能超过 50MB');
  }
}

function verifiedComparisonImageType(file: PurchaseApplicationUploadFile): string {
  const bytes = file.buffer;
  if (file.mimetype === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return file.mimetype;
  if (file.mimetype === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return file.mimetype;
  if (file.mimetype === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return file.mimetype;
  return '';
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  const data = isRecord(payload) ? payload : {};
  const code = Number(data.code || 0);
  if (code !== 0) throw new Error(`${prefix}：${clean(data.msg) || code}`);
}

function safeFileName(value: string): string {
  return basename(clean(value) || 'attachment')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 120);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知写入错误';
}

function recordWriteOutcomeIsUncertain(error: unknown): boolean {
  const response =
    isRecord(error) && isRecord(error.response) ? error.response : null;
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status <= 0) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function shanghaiDate(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
