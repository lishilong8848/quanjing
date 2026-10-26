import { businessAuthorizationSnapshot, businessPermissionScopeKey, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { canAccessBuilding, buildingScopeKey } from '../../../shared/building-access';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty, scopeProfessionalBitableRecords } from '../../common/access/professional-record-scope';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AliMonthlyQualityDataset,
  AliRiskInspectionDashboard,
  CrossInspectionGuide,
  CrossInspectionGuidePage,
  CrossInspectionGuideSource,
  CrossInspectionDashboard,
} from '../../../shared/risk-inspection.interface';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { MonthlyAlarmOverviewResponse } from '../../../shared/monthly-alarm-overview.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  type FeishuBitableAuthConfig,
  fetchBitableRecords,
  extractDisplayText,
  getTenantAccessToken,
  invalidateBitableRecordCache,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  buildActivePersonnelDirectory,
  DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
  DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
} from '../bitable-sync/active-personnel-directory';
import {
  mapAliMonthlyQualityDataset,
  mapAliRiskInspectionDashboard,
  mapCrossInspectionGuides,
  mapCrossInspectionDashboard,
} from './risk-inspection.mapper';
import { mapMonthlyAlarmOverview } from './monthly-alarm-overview.mapper';
import { QualityFollowUpTaskStore, type QualityFollowUpTask } from './quality-follow-up-task.store';

const ALI_TABLE_NAME = '现场风险检查-Ali';
const CROSS_TABLE_NAME = '交叉互查互纠';
const CROSS_GUIDE_TABLES = [
  {
    source: 'system',
    tableName: '风险排查标准-体系',
    sourceUrl:
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  },
  {
    source: 'ali',
    tableName: '风险排查标准-阿里',
    sourceUrl:
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  },
  {
    source: 'environment',
    tableName: '环境检查标准',
    sourceUrl:
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  },
] as const satisfies ReadonlyArray<{
  source: CrossInspectionGuideSource;
  tableName: string;
  sourceUrl: string;
}>;
const CACHE_TTL_MS = 5 * 60 * 1000;
const ALI_DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const ALI_MONTHLY_QUALITY_TABLE_NAME = '阿里月度质量检查清单';
const ALI_MONTHLY_QUALITY_DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const ALI_MONTHLY_QUALITY_RATING_TABLE_NAME = '阿里月度质量评级';
const ALI_MONTHLY_QUALITY_RATING_DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const MONTHLY_ALARM_OVERVIEW_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const CROSS_DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
const LOCAL_MONTHLY_REPORT_CONFIG =
  'D:\\ai\\codex\\阿里月报下载及邮件发送\\config.json';
const STALE_WARNING =
  '飞书实时数据暂时不可用，当前展示最近一次成功同步的数据。';
const MAX_QUALITY_EVIDENCE_BYTES = 20 * 1024 * 1024;

export interface RiskInspectionAliQuery {
  month?: string;
  refresh?: string;
}

export interface RiskInspectionAliMonthlyQualityQuery {
  refresh?: string;
}

export interface AliMonthlyQualityEvidenceFile {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

type MonthlyQualitySourceResult = {
  records: BitableRecordItem[];
  status: 'fresh' | 'stale' | 'error';
  warning: string;
};

export interface RiskInspectionCrossQuery {
  month?: string;
  refresh?: string;
}

export interface RiskInspectionCrossGuideQuery {
  source?: string;
  query?: string;
  page?: string;
  pageSize?: string;
  refresh?: string;
}

@Injectable()
export class RiskInspectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RiskInspectionService.name);
  private readonly processingQualityTaskIds = new Set<string>();
  private qualityTaskTimer: NodeJS.Timeout | null = null;
  private lastGoodAliRecords: BitableRecordItem[] | null = null;
  private lastGoodAliMonthlyQualityIssueRecords: BitableRecordItem[] | null =
    null;
  private lastGoodAliMonthlyQualityRatingRecords: BitableRecordItem[] | null =
    null;
  private lastGoodCrossRecords: BitableRecordItem[] | null = null;
  private lastGoodCrossGuides: CrossInspectionGuide[] | null = null;
  private lastGoodMonthlyAlarmRecords: BitableRecordItem[] | null = null;
  private lastGoodMonthlyAlarmReadAt: string | null = null;

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly qualityTaskStore?: QualityFollowUpTaskStore,
  ) {}

  onModuleInit(): void {
    if (!this.qualityTaskStore) return;
    this.qualityTaskTimer = setInterval(() => void this.runReadyQualityTasks(), 5_000);
    void this.runReadyQualityTasks();
  }

  onModuleDestroy(): void {
    if (this.qualityTaskTimer) clearInterval(this.qualityTaskTimer);
  }

  async acceptAliMonthlyQualitySupplemental(
    recordId: string,
    input: { supplemental?: unknown; expectedSupplemental?: unknown; clientMutationId?: unknown },
    principal?: AccessPrincipal,
  ) {
    if (!this.qualityTaskStore) throw new ServiceUnavailableException('问题跟进同步台账未配置');
    if (!principal || (!['admin', 'editor', 'building_admin', 'professional_admin', 'professional_engineer'].includes(principal.role) && !isProfessionalBusinessPrincipal(principal))) {
      throw new ForbiddenException('无权跟进质量问题');
    }
    if (!/^[a-z0-9_-]{1,128}$/iu.test(recordId)) {
      throw new BadRequestException('质量问题记录 ID 无效');
    }
    const supplemental = typeof input?.supplemental === 'string' ? input.supplemental.trim() : '';
    const expectedSupplemental = typeof input?.expectedSupplemental === 'string'
      ? input.expectedSupplemental.trim() : null;
    const clientMutationId = typeof input?.clientMutationId === 'string'
      ? input.clientMutationId.trim() : '';
    if (!supplemental || supplemental.length > 3000 || expectedSupplemental === null ||
      !/^[a-z0-9_-]{8,128}$/iu.test(clientMutationId)) {
      throw new BadRequestException('问题跟进内容或提交标识无效');
    }
    if (isProfessionalBusinessPrincipal(principal)) {
      const records = await this.fetchRecords(readEnv('FEISHU_RISK_INSPECTION_ALI_MONTHLY_QUALITY_SOURCE_URL') || ALI_MONTHLY_QUALITY_DEFAULT_SOURCE_URL, ALI_MONTHLY_QUALITY_TABLE_NAME, true);
      assertProfessionalBitableRecord(principal, records.find(item => item.record_id === recordId));
    }
    const task = this.qualityTaskStore.create({
      recordId, supplemental, expectedSupplemental, clientMutationId,
      principal: businessAuthorizationSnapshot(principal),
    });
    setImmediate(() => void this.runReadyQualityTasks());
    return this.qualityTaskResponse(task);
  }

  getAliMonthlyQualitySupplementalTask(taskId: string, principal?: AccessPrincipal) {
    const task = this.qualityTaskStore?.get(taskId);
    if (!task || !principal || (!['admin', 'editor', 'building_admin', 'professional_admin', 'professional_engineer'].includes(principal.role) && !isProfessionalBusinessPrincipal(principal)) ||
      (principal.role !== 'admin' &&
        (principal.role !== task.principal.role || principal.purchaseBuilding !== task.principal.purchaseBuilding || buildingScopeKey(principal) !== buildingScopeKey(task.principal) || (isProfessionalBusinessPrincipal(principal) && (businessPermissionScopeKey(principal) !== businessPermissionScopeKey(task.principal)))))) {
      throw new NotFoundException('问题跟进任务不存在');
    }
    return this.qualityTaskResponse(task);
  }

  private qualityTaskResponse(task: QualityFollowUpTask) {
    return {
      taskId: task.id,
      recordId: task.recordId,
      clientMutationId: task.clientMutationId,
      supplemental: task.supplemental,
      syncStatus: task.status,
      message: task.message,
    };
  }

  private async runReadyQualityTasks(): Promise<void> {
    if (!this.qualityTaskStore) return;
    try {
      for (const task of this.qualityTaskStore.listReady()) {
        void this.runQualityTask(task);
      }
    } catch (error) {
      this.logger.error(`问题跟进同步台账读取失败: ${String(error)}`);
    }
  }

  private async runQualityTask(task: QualityFollowUpTask): Promise<void> {
    if (!this.qualityTaskStore || this.processingQualityTaskIds.has(task.id)) return;
    this.processingQualityTaskIds.add(task.id);
    try {
      const running = this.qualityTaskStore.update(task.id, (current) => ({
        ...current,
        status: 'running',
        attempts: current.attempts + 1,
        nextRetryAt: null,
        message: '正在同步飞书多维表',
      }));
      await this.updateAliMonthlyQualitySupplemental(running.recordId, {
        supplemental: running.supplemental,
        expectedSupplemental: running.expectedSupplemental,
        clientMutationId: running.clientMutationId,
      }, running.principal);
      this.qualityTaskStore.update(task.id, (current) => ({
        ...current, status: 'success', message: '问题跟进已同步', nextRetryAt: null,
      }));
    } catch (error) {
      const permanent = error instanceof BadRequestException ||
        error instanceof ForbiddenException || error instanceof ConflictException;
      const retry = !permanent && task.attempts < 2;
      const message = error instanceof Error ? error.message : '问题跟进同步失败';
      try {
        this.qualityTaskStore.update(task.id, (current) => ({
          ...current,
          status: retry ? 'pending' : 'error',
          message: retry ? '飞书同步暂时失败，正在重试' : message,
          nextRetryAt: retry ? new Date(Date.now() + 1_000 * (current.attempts + 1)).toISOString() : null,
        }));
      } catch (storeError) {
        this.logger.error(`问题跟进任务状态保存失败: ${String(storeError)}`);
      }
      this.logger.warn(`问题跟进同步失败: task=${task.id}, message=${message}`);
    } finally {
      this.processingQualityTaskIds.delete(task.id);
    }
  }

  async getMonthlyAlarmOverview(
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<MonthlyAlarmOverviewResponse> {
    let records: BitableRecordItem[];
    let sourceStatus: MonthlyAlarmOverviewResponse['sourceStatus'] = 'ready';
    let warning = '';
    try {
      records = await this.fetchRecords(
        MONTHLY_ALARM_OVERVIEW_SOURCE_URL,
        '预期外告警跟进（来源阿里数据）',
        forceRefresh,
        false,
      );
      this.lastGoodMonthlyAlarmRecords = records;
      this.lastGoodMonthlyAlarmReadAt = new Date().toISOString();
    } catch {
      if (!this.lastGoodMonthlyAlarmRecords) {
        return {
          records: [],
          months: [],
          sourceStatus: 'error',
          syncedAt: null,
          warning: '月度告警数据读取失败，请重试。',
        };
      }
      records = this.lastGoodMonthlyAlarmRecords;
      sourceStatus = 'stale';
      warning = STALE_WARNING;
    }
    const mapped = mapMonthlyAlarmOverview(scopeProfessionalBitableRecords(principal, records));
    return {
      records: mapped,
      months: [...new Set(mapped.map((record) => record.month))]
        .sort()
        .reverse(),
      sourceStatus:
        sourceStatus === 'ready' && mapped.length === 0
          ? 'empty'
          : sourceStatus,
      syncedAt: this.lastGoodMonthlyAlarmReadAt,
      warning,
    };
  }

  async getMonthlyAlarmEvidence(
    recordId: string,
    index: string,
    principal?: AccessPrincipal,
  ): Promise<AliMonthlyQualityEvidenceFile> {
    if (!/^[a-z0-9_-]{1,128}$/iu.test(recordId)) {
      throw new BadRequestException('告警记录 ID 无效');
    }
    const evidenceIndex = Number(index);
    if (!Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0) {
      throw new BadRequestException('告警截图序号无效');
    }
    const records =
      this.lastGoodMonthlyAlarmRecords ||
      (await this.fetchRecords(
        MONTHLY_ALARM_OVERVIEW_SOURCE_URL,
        '预期外告警跟进（来源阿里数据）',
        false,
        false,
      ));
    this.lastGoodMonthlyAlarmRecords = records;
    const record = records.find((item) => item.record_id === recordId);
    const images = record?.fields?.['备注截图'];
    const raw = Array.isArray(images) ? images[evidenceIndex] : null;
    if (!raw || typeof raw !== 'object')
      throw new NotFoundException('告警截图不存在');
    const image = raw as Record<string, unknown>;
    const fileToken = String(image.file_token || '').trim();
    if (!fileToken) throw new NotFoundException('告警截图不可用');
    try {
      const tenantAccessToken = await getTenantAccessToken(
        this.httpService,
        resolveRiskInspectionAuth(),
      );
      const file = await this.downloadQualityEvidence(
        fileToken,
        tenantAccessToken,
        String(image.url || '').trim(),
        String(image.tmp_url || '').trim(),
      );
      const contentType = normalizeEvidenceContentType(
        file.contentType,
        String(image.type || ''),
      );
      if (!contentType.startsWith('image/'))
        throw new BadRequestException('告警截图格式无效');
      return {
        ...file,
        contentType,
        fileName: normalizeEvidenceFileName(String(image.name || ''), 'image'),
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException('告警截图暂时无法读取');
    }
  }

  async getAliDashboard(
    query: RiskInspectionAliQuery,
    principal?: AccessPrincipal,
  ): Promise<AliRiskInspectionDashboard> {
    const month = normalizeAliMonth(query.month);
    const syncedAt = new Date().toISOString();

    try {
      const records = await this.fetchRecords(
        readEnv('FEISHU_RISK_INSPECTION_ALI_SOURCE_URL') ||
          ALI_DEFAULT_SOURCE_URL,
        ALI_TABLE_NAME,
        isForceRefresh(query.refresh),
      );
      this.lastGoodAliRecords = records;
      return mapAliRiskInspectionDashboard(scopeProfessionalBitableRecords(principal, records), { month, syncedAt });
    } catch {
      if (this.lastGoodAliRecords) {
        return {
          ...mapAliRiskInspectionDashboard(scopeProfessionalBitableRecords(principal, this.lastGoodAliRecords), {
            month,
            syncedAt,
          }),
          sourceStatus: 'stale',
          warnings: [STALE_WARNING],
        };
      }
      throw new ServiceUnavailableException(
        '现场风险检查-Ali 数据暂时不可用，请稍后重试。',
      );
    }
  }

  async getAliMonthlyQuality(
    query: RiskInspectionAliMonthlyQualityQuery,
    principal?: AccessPrincipal,
  ): Promise<AliMonthlyQualityDataset> {
    const syncedAt = new Date().toISOString();
    const forceRefresh = isForceRefresh(query.refresh);
    const [issues, ratings, personnelDirectory] = await Promise.all([
      this.loadMonthlyQualitySource({
        sourceUrl:
          readEnv('FEISHU_RISK_INSPECTION_ALI_MONTHLY_QUALITY_SOURCE_URL') ||
          ALI_MONTHLY_QUALITY_DEFAULT_SOURCE_URL,
        tableName: ALI_MONTHLY_QUALITY_TABLE_NAME,
        forceRefresh,
        lastGood: this.lastGoodAliMonthlyQualityIssueRecords,
        staleWarning:
          '问题清单实时数据暂时不可用，当前展示最近一次成功同步的数据。',
        errorWarning: '问题清单数据暂时不可用。',
        onSuccess: (records) => {
          this.lastGoodAliMonthlyQualityIssueRecords = records;
        },
      }),
      this.loadMonthlyQualitySource({
        sourceUrl:
          readEnv(
            'FEISHU_RISK_INSPECTION_ALI_MONTHLY_QUALITY_RATING_SOURCE_URL',
          ) || ALI_MONTHLY_QUALITY_RATING_DEFAULT_SOURCE_URL,
        tableName: ALI_MONTHLY_QUALITY_RATING_TABLE_NAME,
        forceRefresh,
        lastGood: this.lastGoodAliMonthlyQualityRatingRecords,
        staleWarning:
          '评级表实时数据暂时不可用，当前展示最近一次成功同步的数据。',
        errorWarning: '评级表数据暂时不可用。',
        onSuccess: (records) => {
          this.lastGoodAliMonthlyQualityRatingRecords = records;
        },
      }),
      this.loadActivePersonnelDirectory(),
    ]);

    if (issues.status === 'error' && ratings.status === 'error') {
      throw new ServiceUnavailableException(
        '阿里月度质量评级与问题清单数据暂时不可用，请稍后重试。',
      );
    }

    return mapAliMonthlyQualityDataset(scopeProfessionalBitableRecords(principal, issues.records), scopeProfessionalBitableRecords(principal, ratings.records), {
      syncedAt,
      personnelDirectory,
      sources: {
        issues: {
          status: issues.status,
          sourceUpdatedAt: null,
          warning: issues.warning,
        },
        ratings: {
          status: ratings.status,
          sourceUpdatedAt: null,
          warning: ratings.warning,
        },
      },
    });
  }

  async updateAliMonthlyQualitySupplemental(
    recordId: string,
    input: {
      supplemental?: unknown;
      expectedSupplemental?: unknown;
      clientMutationId?: unknown;
    },
    principal?: AccessPrincipal,
  ): Promise<{ recordId: string; supplemental: string; clientMutationId: string; syncStatus: 'success' }> {
    if (!principal || (!['admin', 'editor', 'building_admin', 'professional_admin', 'professional_engineer'].includes(principal.role) && !isProfessionalBusinessPrincipal(principal))) {
      throw new ForbiddenException('无权跟进质量问题');
    }
    if (!/^[a-z0-9_-]{1,128}$/iu.test(recordId)) {
      throw new BadRequestException('质量问题记录 ID 无效');
    }
    const supplemental = typeof input?.supplemental === 'string'
      ? input.supplemental.trim()
      : '';
    const expected = typeof input?.expectedSupplemental === 'string'
      ? input.expectedSupplemental.trim()
      : null;
    const clientMutationId = typeof input?.clientMutationId === 'string'
      ? input.clientMutationId.trim()
      : '';
    if (!supplemental || supplemental.length > 3000 || expected === null ||
      !/^[a-z0-9_-]{8,128}$/iu.test(clientMutationId)) {
      throw new BadRequestException('问题跟进内容或提交标识无效');
    }

    const source = parseFeishuBitableLink(
      readEnv('FEISHU_RISK_INSPECTION_ALI_MONTHLY_QUALITY_SOURCE_URL') ||
        ALI_MONTHLY_QUALITY_DEFAULT_SOURCE_URL,
    );
    const auth = resolveRiskInspectionAuth();
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: source.appToken,
      wikiToken: source.wikiToken,
      tableName: ALI_MONTHLY_QUALITY_TABLE_NAME,
      auth,
    });
    const token = await getTenantAccessToken(this.httpService, auth);
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(source.tableId)}/records/${encodeURIComponent(recordId)}`;
    const readRecord = async (): Promise<BitableRecordItem> => {
      const response = await this.httpService.axiosRef.get(url, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 20_000,
      });
      if (response.data?.code !== 0 || !response.data?.data?.record) {
        throw new ServiceUnavailableException('质量问题记录读取失败');
      }
      return response.data.data.record as BitableRecordItem;
    };
    try {
      const current = await readRecord();
      assertProfessionalBitableRecord(principal, current);
      const building = extractDisplayText(current.fields?.['楼栋']).trim();
      if (principal.role === 'building_admin' && !canAccessBuilding(principal, building)) {
        throw new ForbiddenException('只能跟进本楼栋质量问题');
      }
      const currentText = extractDisplayText(current.fields?.['问题补充描述']).trim();
      if (currentText !== supplemental) {
        if (currentText !== expected) {
          throw new ConflictException('问题补充描述已被更新，请刷新后再提交');
        }
        const response = await this.httpService.axiosRef.put(url, {
          fields: { 问题补充描述: supplemental },
        }, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 30_000,
        });
        if (response.data?.code !== 0) {
          throw new ServiceUnavailableException('问题跟进写入飞书失败');
        }
      }
      const confirmed = await readRecord();
      const confirmedText = extractDisplayText(confirmed.fields?.['问题补充描述']).trim();
      if (confirmedText !== supplemental) {
        throw new ServiceUnavailableException('问题跟进回读未确认，请稍后重试');
      }
      this.lastGoodAliMonthlyQualityIssueRecords =
        this.lastGoodAliMonthlyQualityIssueRecords?.map((item) =>
          item.record_id === recordId
            ? { ...item, fields: { ...item.fields, 问题补充描述: supplemental } }
            : item,
        ) || null;
      invalidateBitableRecordCache({ appToken, tableId: source.tableId });
      return { recordId, supplemental: confirmedText, clientMutationId, syncStatus: 'success' };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException ||
        error instanceof ConflictException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException('问题跟进同步失败，请稍后重试');
    }
  }

  async getAliMonthlyQualityEvidence(
    recordId: string,
    kind: string,
    index: string,
    principal?: AccessPrincipal,
  ): Promise<AliMonthlyQualityEvidenceFile> {
    const normalizedRecordId = recordId.trim();
    if (!/^[a-z0-9_-]{1,128}$/iu.test(normalizedRecordId)) {
      throw new BadRequestException('质量问题记录 ID 无效');
    }
    if (kind !== 'image' && kind !== 'attachment') {
      throw new BadRequestException('质量问题证据类型无效');
    }
    const evidenceIndex = Number(index);
    if (!Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0) {
      throw new BadRequestException('质量问题证据序号无效');
    }

    const records =
      this.lastGoodAliMonthlyQualityIssueRecords ||
      (await this.fetchRecords(
        readEnv('FEISHU_RISK_INSPECTION_ALI_MONTHLY_QUALITY_SOURCE_URL') ||
          ALI_MONTHLY_QUALITY_DEFAULT_SOURCE_URL,
        ALI_MONTHLY_QUALITY_TABLE_NAME,
        false,
      ));
    this.lastGoodAliMonthlyQualityIssueRecords = records;
    const record = records.find(
      (candidate) => candidate.record_id === normalizedRecordId,
    );
    assertProfessionalBitableRecord(principal, record);
    const fieldName = kind === 'image' ? '问题图片' : '附件';
    const evidenceItems = record?.fields?.[fieldName];
    const rawEvidence = Array.isArray(evidenceItems)
      ? evidenceItems[evidenceIndex]
      : undefined;
    if (!rawEvidence || typeof rawEvidence !== 'object') {
      throw new NotFoundException('质量问题证据不存在');
    }
    const evidence = rawEvidence as Record<string, unknown>;
    const fileToken = String(evidence.file_token || '').trim();
    if (!fileToken) {
      throw new NotFoundException('质量问题证据文件不可用');
    }

    try {
      const tenantAccessToken = await getTenantAccessToken(
        this.httpService,
        resolveRiskInspectionAuth(),
      );
      const file = await this.downloadQualityEvidence(
        fileToken,
        tenantAccessToken,
        String(evidence.url || '').trim(),
        String(evidence.tmp_url || '').trim(),
      );
      return {
        ...file,
        contentType: normalizeEvidenceContentType(
          file.contentType,
          String(evidence.type || ''),
        ),
        fileName: normalizeEvidenceFileName(String(evidence.name || ''), kind),
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException('质量问题证据暂时无法读取');
    }
  }

  async getCrossDashboard(
    query: RiskInspectionCrossQuery,
    principal?: AccessPrincipal,
  ): Promise<CrossInspectionDashboard> {
    const month = normalizeCrossMonth(query.month);
    const syncedAt = new Date().toISOString();

    try {
      const records = await this.fetchRecords(
        readEnv('FEISHU_RISK_INSPECTION_CROSS_SOURCE_URL') ||
          CROSS_DEFAULT_SOURCE_URL,
        CROSS_TABLE_NAME,
        isForceRefresh(query.refresh),
        false,
      );
      this.lastGoodCrossRecords = records;
      return mapCrossInspectionDashboard(scopeProfessionalBitableRecords(principal, records), { month, syncedAt });
    } catch {
      if (this.lastGoodCrossRecords) {
        return {
          ...mapCrossInspectionDashboard(scopeProfessionalBitableRecords(principal, this.lastGoodCrossRecords), {
            month,
            syncedAt,
          }),
          sourceStatus: 'stale',
          warnings: [STALE_WARNING],
        };
      }
      throw new ServiceUnavailableException(
        '交叉互查互纠数据暂时不可用，请稍后重试。',
      );
    }
  }

  async getCrossGuides(
    query: RiskInspectionCrossGuideQuery,
  ): Promise<CrossInspectionGuidePage> {
    const source = normalizeCrossGuideSource(query.source);
    const page = normalizePositiveInteger(query.page, 1, 'page');
    const pageSize = normalizePositiveInteger(
      query.pageSize,
      20,
      'pageSize',
      50,
    );
    const searchQuery = query.query?.trim() || '';
    const syncedAt = new Date().toISOString();

    try {
      const [system, ali, environment] = await Promise.all(
        CROSS_GUIDE_TABLES.map((table) =>
          this.fetchRecords(
            table.sourceUrl,
            table.tableName,
            isForceRefresh(query.refresh),
            false,
          ),
        ),
      );
      const guides = mapCrossInspectionGuides({
        system,
        ali,
        environment,
      });
      this.lastGoodCrossGuides = guides;
      return buildCrossGuidePage(guides, {
        source,
        query: searchQuery,
        page,
        pageSize,
        syncedAt,
        sourceStatus: 'fresh',
        warnings: [],
      });
    } catch {
      if (this.lastGoodCrossGuides) {
        return buildCrossGuidePage(this.lastGoodCrossGuides, {
          source,
          query: searchQuery,
          page,
          pageSize,
          syncedAt,
          sourceStatus: 'stale',
          warnings: [STALE_WARNING],
        });
      }
      throw new ServiceUnavailableException(
        '互查互纠标准与指引数据暂时不可用，请稍后重试。',
      );
    }
  }

  private async fetchRecords(
    sourceUrl: string,
    tableName: string,
    forceRefresh: boolean,
    applySourceView = true,
  ): Promise<BitableRecordItem[]> {
    const source = parseFeishuBitableLink(sourceUrl);
    const auth = resolveRiskInspectionAuth();
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: source.appToken,
      wikiToken: source.wikiToken,
      tableName,
      auth,
    });

    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId: source.tableId,
      ...(applySourceView && source.viewId ? { viewId: source.viewId } : {}),
      tableName,
      cacheTtlMs: CACHE_TTL_MS,
      forceRefresh,
      strict: true,
      auth,
    });
  }

  private async loadMonthlyQualitySource(options: {
    sourceUrl: string;
    tableName: string;
    forceRefresh: boolean;
    lastGood: BitableRecordItem[] | null;
    staleWarning: string;
    errorWarning: string;
    onSuccess: (records: BitableRecordItem[]) => void;
  }): Promise<MonthlyQualitySourceResult> {
    try {
      const records = await this.fetchRecords(
        options.sourceUrl,
        options.tableName,
        options.forceRefresh,
      );
      options.onSuccess(records);
      return { records, status: 'fresh', warning: '' };
    } catch {
      if (options.lastGood) {
        return {
          records: options.lastGood,
          status: 'stale',
          warning: options.staleWarning,
        };
      }
      return { records: [], status: 'error', warning: options.errorWarning };
    }
  }

  private async loadActivePersonnelDirectory() {
    try {
      const snapshot = await readLatestPersistedBitableRecordSnapshot({
        tableId: DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
        viewId: DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
        tableName: '在职人员',
      });
      return snapshot ? buildActivePersonnelDirectory(snapshot) : undefined;
    } catch {
      return undefined;
    }
  }

  private async downloadQualityEvidence(
    fileToken: string,
    tenantAccessToken: string,
    sourceDownloadUrl = '',
    sourceBatchUrl = '',
  ): Promise<{ buffer: Buffer; contentType: string }> {
    let downloadUrl = isAllowedFeishuEvidenceUrl(sourceDownloadUrl)
      ? sourceDownloadUrl
      : '';
    if (!downloadUrl) {
      const defaultBatchUrl =
        'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url' +
        `?file_tokens=${encodeURIComponent(fileToken)}`;
      const batchUrl = isAllowedFeishuEvidenceUrl(sourceBatchUrl)
        ? sourceBatchUrl
        : defaultBatchUrl;
      try {
        const batchResponse = await this.httpService.axiosRef.get(batchUrl, {
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          timeout: 20_000,
        });
        downloadUrl = extractFeishuTmpDownloadUrl(batchResponse.data);
      } catch {
        downloadUrl = '';
      }
    }
    const resolvedUrl =
      downloadUrl ||
      `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`;
    if (!isAllowedFeishuEvidenceUrl(resolvedUrl)) {
      throw new ServiceUnavailableException('质量问题证据下载地址无效');
    }

    const response = await this.httpService.axiosRef.get<ArrayBuffer>(
      resolvedUrl,
      {
        responseType: 'arraybuffer',
        headers: resolvedUrl.includes('open.feishu.cn/open-apis/')
          ? { Authorization: `Bearer ${tenantAccessToken}` }
          : undefined,
        timeout: 20_000,
        maxContentLength: MAX_QUALITY_EVIDENCE_BYTES,
        maxBodyLength: MAX_QUALITY_EVIDENCE_BYTES,
      },
    );
    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_QUALITY_EVIDENCE_BYTES) {
      throw new BadRequestException('质量问题证据超过 20MB 限制');
    }
    const headerContentType = response.headers?.['content-type'];
    return {
      buffer,
      contentType:
        typeof headerContentType === 'string' ? headerContentType : '',
    };
  }
}

interface CrossGuidePageOptions {
  source: 'all' | CrossInspectionGuideSource;
  query: string;
  page: number;
  pageSize: number;
  syncedAt: string;
  sourceStatus: 'fresh' | 'stale';
  warnings: string[];
}

function buildCrossGuidePage(
  guides: readonly CrossInspectionGuide[],
  options: CrossGuidePageOptions,
): CrossInspectionGuidePage {
  const query = options.query.toLocaleLowerCase('zh-CN');
  const filtered = guides.filter((guide) => {
    if (options.source !== 'all' && guide.source !== options.source) {
      return false;
    }
    if (!query) return true;
    return [
      guide.code,
      guide.category,
      guide.subcategory,
      guide.item,
      guide.standard,
      guide.method,
      guide.level,
      guide.cycle,
    ]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(query);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const start = (page - 1) * options.pageSize;

  return {
    items: filtered.slice(start, start + options.pageSize),
    total: filtered.length,
    page,
    pageSize: options.pageSize,
    totalPages,
    sourceStatus: options.sourceStatus,
    syncedAt: options.syncedAt,
    warnings: options.warnings,
  };
}

function extractFeishuTmpDownloadUrl(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const payload = value as Record<string, unknown>;
  const data =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : payload;
  const urls = data.tmp_download_urls;
  if (Array.isArray(urls)) {
    for (const item of urls) {
      if (typeof item === 'string' && item.startsWith('https://')) return item;
      if (!item || typeof item !== 'object') continue;
      const candidate = item as Record<string, unknown>;
      const url = String(
        candidate.tmp_download_url ||
          candidate.tmpDownloadUrl ||
          candidate.url ||
          '',
      ).trim();
      if (url.startsWith('https://')) return url;
    }
  }
  const single = String(data.tmp_download_url || '').trim();
  return single.startsWith('https://') ? single : '';
}

function isAllowedFeishuEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return [
      'feishu.cn',
      'feishucdn.com',
      'larksuite.com',
      'larksuitecdn.com',
    ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function normalizeEvidenceContentType(
  responseType: string,
  sourceType: string,
): string {
  const candidate = (responseType || sourceType)
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (/^image\/(?:jpeg|png|webp|gif|bmp)$/u.test(candidate)) return candidate;
  if (candidate === 'application/pdf') return candidate;
  return 'application/octet-stream';
}

function normalizeEvidenceFileName(value: string, kind: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
    .trim()
    .slice(0, 180);
  return normalized || (kind === 'image' ? '现场证据' : '问题附件');
}

function resolveRiskInspectionAuth(): FeishuBitableAuthConfig | undefined {
  const riskAuth = createCompleteAuth(
    readEnv('FEISHU_RISK_INSPECTION_APP_ID'),
    readEnv('FEISHU_RISK_INSPECTION_APP_SECRET'),
  );
  if (riskAuth) return riskAuth;

  const monthlyReportAuth = createCompleteAuth(
    readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_ID'),
    readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_SECRET'),
  );
  if (monthlyReportAuth) return monthlyReportAuth;

  for (const configPath of getRiskInspectionCredentialPaths()) {
    const fileAuth = readAuthFromConfig(configPath);
    if (fileAuth) return fileAuth;
  }

  return undefined;
}

function createCompleteAuth(
  appId: string,
  appSecret: string,
): FeishuBitableAuthConfig | undefined {
  const normalizedAppId = appId.trim();
  const normalizedAppSecret = appSecret.trim();
  if (!normalizedAppId || !normalizedAppSecret) return undefined;
  return {
    appId: normalizedAppId,
    appSecret: normalizedAppSecret,
  };
}

function getRiskInspectionCredentialPaths(): string[] {
  const emailAppDir = readEnv('ALI_MONTHLY_REPORT_EMAIL_APP_DIR');
  const candidates = [
    readEnv('FEISHU_RISK_INSPECTION_CREDENTIALS_CONFIG'),
    readEnv('ALI_MONTHLY_REPORT_CONFIG', ['ALI_REPORT_CONFIG']),
    join(process.cwd(), 'tools', 'ali-monthly-report', 'config.json'),
    emailAppDir ? join(resolveConfigPath(emailAppDir), 'config.json') : '',
    LOCAL_MONTHLY_REPORT_CONFIG,
  ];
  return [
    ...new Set(
      candidates
        .filter(Boolean)
        .map(resolveConfigPath)
        .filter((candidate) => existsSync(candidate)),
    ),
  ];
}

function resolveConfigPath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function readAuthFromConfig(
  configPath: string,
): FeishuBitableAuthConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    return createCompleteAuth(
      String(parsed.feishu_app_id || ''),
      String(parsed.feishu_app_secret || ''),
    );
  } catch {
    return undefined;
  }
}

function normalizeAliMonth(value: string | undefined): string {
  const month = value?.trim() || currentShanghaiMonth();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
    throw new BadRequestException('month 必须使用 YYYY-MM 格式');
  }
  return month;
}

function normalizeCrossMonth(value: string | undefined): string | undefined {
  const month = value?.trim();
  if (!month) return undefined;
  if (!/^(?:[1-9]|1[0-2])月$/u.test(month)) {
    throw new BadRequestException('month 必须使用 N月 格式');
  }
  return month;
}

function normalizeCrossGuideSource(
  value: string | undefined,
): 'all' | CrossInspectionGuideSource {
  const source = value?.trim() || 'all';
  if (!['all', 'system', 'ali', 'environment'].includes(source)) {
    throw new BadRequestException(
      'source 必须是 all、system、ali 或 environment',
    );
  }
  return source as 'all' | CrossInspectionGuideSource;
}

function normalizePositiveInteger(
  value: string | undefined,
  fallback: number,
  fieldName: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(`${fieldName} 必须是 1 到 ${max} 之间的整数`);
  }
  return parsed;
}

function currentShanghaiMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}`;
}

function isForceRefresh(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}
