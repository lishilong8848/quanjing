import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  SystemMonthlyReportAcceptedResponse,
  SystemMonthlyReportArchiveRetryResponse,
  SystemMonthlyReportDashboard,
  SystemMonthlyReportModuleKey,
  SystemMonthlyReportPackageRequest,
  SystemMonthlyReportPackageTask,
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportSubmissionDeletionRequest,
  SystemMonthlyReportSubmissionRequest,
  SystemMonthlyReportTask,
} from '../../../shared/system-monthly-report.interface';
import { SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES } from '../../../shared/system-monthly-report.interface';
import {
  SystemMonthlyReportGateway,
  SystemMonthlyReportIndeterminateWriteError,
} from './system-monthly-report.gateway';
import {
  findSystemMonthlyReportSubmissionRecordIds,
  mapSystemMonthlyReportSources,
} from './system-monthly-report.mapper';
import { mapLatestFinalReportRecords } from './system-monthly-report.mapper';
import { mapLatestReviewOpinionRecords } from './system-monthly-report.mapper';
import {
  assertSystemMonthlyReportReviewTransition,
  assertSystemMonthlyReportSemanticReadback,
  assertSystemMonthlyReportSubmissionMutationAllowed,
  assertSystemMonthlyReportSubmissionTransition,
  buildSystemMonthlyReportReviewFields,
  buildSystemMonthlyReportSubmissionClearFields,
  buildSystemMonthlyReportSubmissionFields,
  normalizeSystemMonthlyReportSubmission,
  validateSystemMonthlyReportReview,
  validateSystemMonthlyReportSubmission,
} from './system-monthly-report.rules';
import {
  SystemMonthlyReportTaskStore,
  type SystemMonthlyReportStagedFile,
  type SystemMonthlyReportTaskLedgerEntry,
} from './system-monthly-report-task.store';
import {
  SystemMonthlyReportArchiveService,
  type SystemMonthlyReportArchiveDownload,
} from './system-monthly-report-archive.service';
import { SystemMonthlyReportPackageService } from './system-monthly-report-package.service';
import {
  assertSystemMonthlyReportReviewAuthorized,
  assertSystemMonthlyReportRoomReadAuthorized,
  assertSystemMonthlyReportSubmissionAuthorized,
  buildSystemMonthlyReportScope,
  isSystemMonthlyReportTaskOwner,
  type SystemMonthlyReportAccessSubject,
} from './system-monthly-report-access';

export interface SystemMonthlyReportUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface SystemMonthlyReportReviewUpload {
  key: SystemMonthlyReportModuleKey;
  file: SystemMonthlyReportUploadFile;
}

const MUTATION_ID_PATTERN = /^[a-zA-Z0-9:_-]{12,128}$/;
const RECORD_ID_PATTERN = /^rec[a-zA-Z0-9_-]{4,128}$/;
const REPORT_EXTENSIONS = new Set(['.xlsx', '.xls', '.pdf']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

@Injectable()
export class SystemMonthlyReportService implements OnModuleInit {
  private readonly logger = new Logger(SystemMonthlyReportService.name);
  private readonly runtimeDirectory = resolve(
    process.env.SYSTEM_MONTHLY_REPORT_RUNTIME_DIR ||
      resolve(process.cwd(), '.runtime', 'system-monthly-report'),
  );
  private readonly store = new SystemMonthlyReportTaskStore(
    resolve(this.runtimeDirectory, 'tasks.json'),
  );
  private queueTail: Promise<void> = Promise.resolve();
  private readonly queuedTaskIds = new Set<string>();
  private cachedDashboard: SystemMonthlyReportDashboard | null = null;

  constructor(
    private readonly gateway: SystemMonthlyReportGateway,
    private readonly archiveService: SystemMonthlyReportArchiveService,
    private readonly packageService: SystemMonthlyReportPackageService,
    private readonly bitableSyncService: BitableSyncService,
  ) {}

  onModuleInit(): void {
    for (const entry of this.store.listRecoverable()) {
      this.enqueue(entry.task.id);
    }
  }

  async getDashboard(
    forceRefresh: boolean,
    publicRead: boolean,
  ): Promise<SystemMonthlyReportDashboard> {
    try {
      const sources = await this.gateway.loadSources(forceRefresh);
      const organizationPeople = await this.loadOrganizationPeople();
      const finalSources = mapLatestFinalReportRecords(
        sources.collectionRecords,
      );
      const reviewSources = mapLatestReviewOpinionRecords(
        sources.collectionRecords,
      );
      this.archiveService.discover(finalSources);
      this.archiveService.discoverReviewImages(reviewSources);
      const mapped = mapSystemMonthlyReportSources({
        ...sources,
        organizationPeople,
        now: new Date(),
      });
      const dashboard: SystemMonthlyReportDashboard = {
        ...mapped,
        history: this.archiveService.decorateHistory(
          mapped.history,
          finalSources,
        ),
        reviewOpinions: this.archiveService.decorateReviewOpinions(
          mapped.reviewOpinions,
          reviewSources,
        ),
      };
      this.cachedDashboard = dashboard;
      return publicRead ? redactDashboard(dashboard) : dashboard;
    } catch (error) {
      if (!this.cachedDashboard) throw error;
      const dashboard: SystemMonthlyReportDashboard = {
        ...this.cachedDashboard,
        generatedAt: new Date().toISOString(),
        stale: true,
        warnings: [
          ...this.cachedDashboard.warnings,
          '飞书数据暂时不可用，当前展示最近一次成功同步的数据。',
        ],
      };
      return publicRead ? redactDashboard(dashboard) : dashboard;
    }
  }

  async acceptSubmission(
    request: SystemMonthlyReportSubmissionRequest,
    file: SystemMonthlyReportUploadFile,
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<SystemMonthlyReportAcceptedResponse> {
    validateRequestIdentity(request);
    validateUpload(
      file,
      REPORT_EXTENSIONS,
      SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES,
      '月报附件',
    );
    const normalized = normalizeSystemMonthlyReportSubmission(
      request,
      file.originalname,
    );
    const normalizedRequest = normalized.request;
    const normalizedFile = {
      ...file,
      originalname: normalized.fileName,
    };
    validateSystemMonthlyReportSubmission(normalizedRequest);
    const fileHash = sha256(file.buffer);
    const requestFingerprint = fingerprint({
      request: normalizedRequest,
      file: {
        name: normalizedFile.originalname,
        size: normalizedFile.size,
        sha256: fileHash,
      },
    });
    await this.assertSubmissionAllowed(normalizedRequest, subject);
    const principalFingerprint = subject.principalFingerprint;
    const taskId = taskIdFor(
      principalFingerprint,
      normalizedRequest.clientMutationId,
    );
    const duplicate = this.reserveDuplicateIfPresent({
      request: normalizedRequest,
      principalFingerprint,
      requestFingerprint,
      taskId,
      action: 'submit_stage',
      payload: { kind: 'submission', request: normalizedRequest },
    });
    if (duplicate) return { accepted: true, task: duplicate };

    const files = await this.stageFiles(taskId, [
      { key: 'report', file: normalizedFile, sha256: fileHash },
    ]);
    const reserved = this.store.reserve(
      createLedgerEntry({
        taskId,
        request: normalizedRequest,
        principalFingerprint,
        requestFingerprint,
        action: 'submit_stage',
        payload: { kind: 'submission', request: normalizedRequest },
        files,
      }),
    );
    this.enqueue(reserved.entry.task.id);
    return { accepted: true, task: reserved.entry.task };
  }

  async acceptSubmissionDeletion(
    request: SystemMonthlyReportSubmissionDeletionRequest,
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<SystemMonthlyReportAcceptedResponse> {
    validateRequestIdentity(request);
    const requestFingerprint = fingerprint({ request });
    await this.assertSubmissionDeletionAllowed(request, subject);
    const principalFingerprint = subject.principalFingerprint;
    const taskId = taskIdFor(principalFingerprint, request.clientMutationId);
    const duplicate = this.reserveDuplicateIfPresent({
      request,
      principalFingerprint,
      requestFingerprint,
      taskId,
      action: 'delete_stage',
      payload: { kind: 'deletion', request },
    });
    if (duplicate) return { accepted: true, task: duplicate };

    const reserved = this.store.reserve(
      createLedgerEntry({
        taskId,
        request,
        principalFingerprint,
        requestFingerprint,
        action: 'delete_stage',
        payload: { kind: 'deletion', request },
        files: [],
      }),
    );
    this.enqueue(reserved.entry.task.id);
    return { accepted: true, task: reserved.entry.task };
  }

  async acceptReview(
    request: SystemMonthlyReportReviewRequest,
    uploads: SystemMonthlyReportReviewUpload[],
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<SystemMonthlyReportAcceptedResponse> {
    validateRequestIdentity(request);
    const fileNames = Object.fromEntries(
      uploads.map(({ key, file }) => [key, [file.originalname]]),
    );
    validateSystemMonthlyReportReview(request, fileNames);
    for (const { file } of uploads) {
      validateUpload(file, IMAGE_EXTENSIONS, MAX_SCREENSHOT_BYTES, '问题截图');
    }
    const prepared = uploads.map(({ key, file }) => ({
      key,
      file,
      sha256: sha256(file.buffer),
    }));
    const requestFingerprint = fingerprint({
      request,
      files: prepared.map(({ key, file, sha256: hash }) => ({
        key,
        name: file.originalname,
        size: file.size,
        sha256: hash,
      })),
    });
    await this.assertReviewAllowed(request, subject);
    const principalFingerprint = subject.principalFingerprint;
    const taskId = taskIdFor(principalFingerprint, request.clientMutationId);
    const duplicate = this.reserveDuplicateIfPresent({
      request,
      principalFingerprint,
      requestFingerprint,
      taskId,
      action: 'submit_review',
      payload: { kind: 'review', request },
    });
    if (duplicate) return { accepted: true, task: duplicate };

    const files = await this.stageFiles(taskId, prepared);
    const reserved = this.store.reserve(
      createLedgerEntry({
        taskId,
        request,
        principalFingerprint,
        requestFingerprint,
        action: 'submit_review',
        payload: { kind: 'review', request },
        files,
      }),
    );
    this.enqueue(reserved.entry.task.id);
    return { accepted: true, task: reserved.entry.task };
  }

  getTask(
    taskId: string,
    subject: SystemMonthlyReportAccessSubject,
  ): SystemMonthlyReportTask {
    const entry = this.store.getEntry(taskId);
    if (!isSystemMonthlyReportTaskOwner(subject, entry.principalFingerprint)) {
      throw new ForbiddenException('无权查看该月报同步任务');
    }
    return entry.task;
  }

  async getArchiveDownload(
    archiveId: string,
    subject: SystemMonthlyReportAccessSubject,
    dashboard: SystemMonthlyReportDashboard,
  ): Promise<SystemMonthlyReportArchiveDownload> {
    const descriptor = this.archiveService.getArchiveDescriptor(archiveId);
    const scope = buildSystemMonthlyReportScope(subject, dashboard);
    assertSystemMonthlyReportRoomReadAuthorized(scope, descriptor.room);
    return this.archiveService.getSignedDownload(archiveId, 300);
  }

  async getArchivePreview(
    archiveId: string,
    subject: SystemMonthlyReportAccessSubject,
    dashboard: SystemMonthlyReportDashboard,
  ) {
    const descriptor = this.archiveService.getArchiveDescriptor(archiveId);
    const scope = buildSystemMonthlyReportScope(subject, dashboard);
    assertSystemMonthlyReportRoomReadAuthorized(scope, descriptor.room);
    return this.archiveService.getPreview(archiveId);
  }

  retryArchive(
    archiveId: string,
    subject: SystemMonthlyReportAccessSubject,
  ): SystemMonthlyReportArchiveRetryResponse {
    requirePrivileged(subject);
    const entry = this.archiveService.retry(archiveId);
    return { id: entry.id, status: entry.status };
  }

  async acceptPackage(
    request: SystemMonthlyReportPackageRequest,
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<SystemMonthlyReportPackageTask> {
    requirePrivileged(subject);
    const dashboard = await this.getDashboard(false, false);
    const snapshot = dashboard.monthlySnapshots.find(
      (item) => item.year === request.year && item.month === request.month,
    );
    const expectedRooms = snapshot?.rooms.map((item) => item.room) || [];
    const people = dashboard.rooms.flatMap((room) => [
      ...room.leaders,
      ...room.submitters,
    ]);
    const configuredOpenId = clean(
      process.env.SYSTEM_MONTHLY_REPORT_MA_JINYU_OPEN_ID ||
        process.env.ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_OPEN_ID,
    );
    const recipient =
      people.find((person) => person.name === '马进宇' && person.openId) ||
      (configuredOpenId ? { openId: configuredOpenId, name: '马进宇' } : null);
    if (!recipient)
      throw new BadRequestException('人员数据中未找到马进宇的稳定飞书 open_id');
    return this.packageService.accept(
      request,
      expectedRooms,
      recipient,
      subject.principalFingerprint,
    );
  }

  getPackageTask(
    taskId: string,
    subject: SystemMonthlyReportAccessSubject,
  ): SystemMonthlyReportPackageTask {
    requirePrivileged(subject);
    return this.packageService.getTask(taskId);
  }

  getPackageDownload(
    taskId: string,
    subject: SystemMonthlyReportAccessSubject,
  ) {
    requirePrivileged(subject);
    return this.packageService.getDownload(taskId);
  }

  retryPackage(
    taskId: string,
    subject: SystemMonthlyReportAccessSubject,
  ): SystemMonthlyReportPackageTask {
    requirePrivileged(subject);
    return this.packageService.retry(taskId);
  }

  retryTask(
    taskId: string,
    subject: SystemMonthlyReportAccessSubject,
  ): SystemMonthlyReportTask {
    const task = this.getTask(taskId, subject);
    if (!['error', 'uncertain'].includes(task.status) || !task.retryable) {
      throw new BadRequestException('当前任务不需要或不能重试');
    }
    const entry = this.store.getEntry(taskId);
    if (entry.files.some((file) => !existsSync(file.path))) {
      throw new BadRequestException('原始附件已不存在，请重新提交');
    }
    const updated = this.store.updateTask(taskId, {
      status: 'accepted',
      message: '已重新受理，正在后台同步',
      retryable: false,
      failedStep: undefined,
    });
    this.enqueue(taskId);
    return updated;
  }

  private reserveDuplicateIfPresent(input: {
    request:
      | SystemMonthlyReportSubmissionRequest
      | SystemMonthlyReportSubmissionDeletionRequest
      | SystemMonthlyReportReviewRequest;
    principalFingerprint: string;
    requestFingerprint: string;
    taskId: string;
    action: SystemMonthlyReportTask['action'];
    payload: SystemMonthlyReportTaskLedgerEntry['payload'];
  }): SystemMonthlyReportTask | null {
    if (!this.store.findByMutation(input.request.clientMutationId)) return null;
    return this.store.reserve(createLedgerEntry({ ...input, files: [] })).entry
      .task;
  }

  private async assertSubmissionAllowed(
    request: SystemMonthlyReportSubmissionRequest,
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<void> {
    const dashboard = await this.getDashboard(false, false);
    if (dashboard.stale) {
      throw new BadRequestException('飞书状态暂不可确认，请稍后重试');
    }
    if (
      dashboard.period.year !== request.reportYear ||
      dashboard.period.month !== request.reportMonth
    ) {
      throw new BadRequestException('月报报告期已变化，请刷新后重新提交');
    }
    const room = dashboard.rooms.find(
      (item) => item.recordId === request.currentRecordId,
    );
    if (!room || room.room !== request.room.trim()) {
      throw new BadRequestException('月报关联记录与机房不匹配，请刷新后重试');
    }
    assertSystemMonthlyReportSubmissionAuthorized(
      buildSystemMonthlyReportScope(subject, dashboard),
      room.room,
    );
    assertSystemMonthlyReportSubmissionMutationAllowed(
      room.status,
      request.stage,
      request.operation || 'create',
      request.reportYear,
      request.reportMonth,
    );
  }

  private async assertSubmissionDeletionAllowed(
    request: SystemMonthlyReportSubmissionDeletionRequest,
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<void> {
    const dashboard = await this.getDashboard(false, false);
    if (dashboard.stale) {
      throw new BadRequestException('当前状态暂不可确认，请稍后重试');
    }
    if (
      dashboard.period.year !== request.reportYear ||
      dashboard.period.month !== request.reportMonth
    ) {
      throw new BadRequestException('月报报告期已变化，请刷新后重试');
    }
    const room = dashboard.rooms.find(
      (item) => item.recordId === request.currentRecordId,
    );
    if (!room || room.room !== request.room.trim()) {
      throw new BadRequestException('月报关联记录与机房不匹配，请刷新后重试');
    }
    assertSystemMonthlyReportSubmissionAuthorized(
      buildSystemMonthlyReportScope(subject, dashboard),
      room.room,
    );
    assertSystemMonthlyReportSubmissionMutationAllowed(
      room.status,
      request.stage,
      'delete',
      request.reportYear,
      request.reportMonth,
    );
  }

  private async assertReviewAllowed(
    request: SystemMonthlyReportReviewRequest,
    subject: SystemMonthlyReportAccessSubject,
  ): Promise<void> {
    const { room, dashboard } = await this.loadCurrentRoom(
      request.currentRecordId,
      request.room,
    );
    assertSystemMonthlyReportReviewAuthorized(
      buildSystemMonthlyReportScope(subject, dashboard),
      room.room,
      request.round,
    );
    assertSystemMonthlyReportReviewTransition(room.status, request.round);
  }

  private async loadCurrentRoom(recordId: string, roomName: string) {
    const dashboard = await this.getDashboard(false, false);
    if (dashboard.stale) {
      throw new BadRequestException('飞书状态暂不可确认，请稍后重试');
    }
    const room = dashboard.rooms.find((item) => item.recordId === recordId);
    if (!room || room.room !== roomName.trim()) {
      throw new BadRequestException('月报关联记录与机房不匹配，请刷新后重试');
    }
    return { room, dashboard };
  }

  private async loadOrganizationPeople() {
    try {
      const { organizations } =
        await this.bitableSyncService.getOrganizations();
      return organizations.flatMap((organization) =>
        (organization.dutyAccount || []).map((openId) => ({
          openId,
          name: organization.supervisorText || '',
          rooms: organization.buildingsSpecialties || [],
        })),
      );
    } catch (error) {
      this.logger.warn(
        `体系月报审核人归属暂不可用：${safeErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async stageFiles(
    taskId: string,
    files: Array<{
      key: string;
      file: SystemMonthlyReportUploadFile;
      sha256: string;
    }>,
  ): Promise<SystemMonthlyReportStagedFile[]> {
    const taskDirectory = resolve(this.runtimeDirectory, 'files', taskId);
    await mkdir(taskDirectory, { recursive: true });
    const staged: SystemMonthlyReportStagedFile[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const item = files[index];
      const extension = safeExtension(item.file.originalname);
      const filePath = resolve(
        taskDirectory,
        `${String(index + 1).padStart(2, '0')}-${safeKey(item.key)}${extension}`,
      );
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, item.file.buffer, { flag: 'wx' });
      await rename(temporaryPath, filePath);
      staged.push({
        key: item.key,
        path: filePath,
        originalName: item.file.originalname,
        mimeType: item.file.mimetype,
        size: item.file.size,
        sha256: item.sha256,
      });
    }
    return staged;
  }

  private enqueue(taskId: string): void {
    if (this.queuedTaskIds.has(taskId)) return;
    this.queuedTaskIds.add(taskId);
    this.queueTail = this.queueTail
      .then(() => this.processTask(taskId))
      .catch((error) => {
        this.logger.error(
          `体系月报后台任务异常：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.queuedTaskIds.delete(taskId));
  }

  private async processTask(taskId: string): Promise<void> {
    const entry = this.store.getEntry(taskId);
    if (entry.task.status === 'success') return;
    if (entry.payload.kind === 'review') {
      await this.processReviewTask(taskId);
      return;
    }
    this.store.updateTask(taskId, {
      status: 'syncing',
      message: '飞书与 COS 正在并行同步',
      retryable: false,
      failedStep: undefined,
    });
    const current = this.store.getEntry(taskId);
    if (current.payload.kind === 'deletion') {
      if (current.task.sync?.feishu.status !== 'success') {
        await Promise.allSettled([this.syncSubmissionToFeishu(taskId)]);
      }
      const afterRecordUpdate = this.store.getEntry(taskId);
      if (
        afterRecordUpdate.task.sync?.feishu.status === 'success' &&
        afterRecordUpdate.task.sync?.cos.status !== 'success'
      ) {
        await Promise.allSettled([this.syncSubmissionToCos(taskId)]);
      }
    } else {
      const work: Promise<void>[] = [];
      if (current.task.sync?.feishu.status !== 'success') {
        work.push(this.syncSubmissionToFeishu(taskId));
      }
      if (current.task.sync?.cos.status !== 'success') {
        work.push(this.syncSubmissionToCos(taskId));
      }
      await Promise.allSettled(work);
    }
    let settled = this.store.getEntry(taskId);
    const feishuReady = settled.task.sync?.feishu.status === 'success';
    const cosReady = settled.task.sync?.cos.status === 'success';
    if (feishuReady && cosReady) {
      if (settled.payload.kind === 'submission') {
        const request = settled.payload.request;
        if (request.operation === 'replace') {
          try {
            const oldObjectKeys = this.store.listSubmissionObjectKeys(
              request,
              taskId,
            );
            await this.archiveService.deleteSubmissionObjects(oldObjectKeys);
          } catch (error) {
            this.store.updateSyncBranch(taskId, 'cos', {
              status: 'error',
              message: `旧附件清理失败：${safeErrorMessage(error)}`,
            });
            this.store.updateTask(taskId, {
              status: 'error',
              message: '新版本已保存，旧附件清理失败',
              retryable: true,
              failedStep: 'upload',
            });
            return;
          }
          settled = this.store.getEntry(taskId);
        }
        const fileToken = settled.uploadedTokens.report?.[0];
        const cosObject = settled.cosObjects?.report;
        if (settled.task.feishuRecordId && fileToken && cosObject) {
          this.archiveService.bindFinalSubmissionObject(
            settled.task.feishuRecordId,
            fileToken,
            request,
            cosObject,
          );
        }
      }
      this.store.updateTask(taskId, {
        status: 'success',
        message:
          settled.payload.kind === 'deletion' ? '附件已删除' : '月报已同步',
        completedAt: new Date().toISOString(),
        retryable: false,
        failedStep: undefined,
      });
      this.cachedDashboard = null;
      await Promise.allSettled(settled.files.map((file) => unlink(file.path)));
      this.store.clearFiles(taskId);
      return;
    }
    this.store.updateTask(taskId, {
      status: 'error',
      message: `部分同步失败：飞书${feishuReady ? '已完成' : '失败'}，COS${cosReady ? '已完成' : '失败'}；重试只执行失败分支`,
      retryable: true,
      failedStep: feishuReady ? 'upload' : 'record',
    });
  }

  private async syncSubmissionToFeishu(taskId: string): Promise<void> {
    this.store.updateSyncBranch(taskId, 'feishu', {
      status: 'syncing',
      message: '正在同步飞书多维表',
    });
    try {
      let entry = this.store.getEntry(taskId);
      if (entry.payload.kind === 'deletion') {
        await this.clearSubmissionRecords(entry.payload.request);
        this.store.updateSyncBranch(taskId, 'feishu', {
          status: 'success',
          message: '业务记录已更新',
          completedAt: new Date().toISOString(),
        });
        return;
      }
      if (entry.payload.kind !== 'submission') return;
      const uploadedTokens = { ...entry.uploadedTokens };
      for (const file of entry.files) {
        if (uploadedTokens[file.key]?.length) continue;
        uploadedTokens[file.key] = [await this.gateway.uploadFile(file)];
        this.store.updateUploadedTokens(taskId, uploadedTokens);
      }
      entry = this.store.getEntry(taskId);
      if (entry.payload.kind !== 'submission') return;
      const fields = buildSystemMonthlyReportSubmissionFields(
        entry.payload.request,
        entry.uploadedTokens.report || [],
      );
      let recordId = entry.task.feishuRecordId;
      if (!recordId) {
        recordId = await this.gateway.createCollectionRecord(fields, taskId);
        this.store.updateTask(taskId, { feishuRecordId: recordId });
      }
      const record = await this.gateway.getCollectionRecord(recordId);
      assertSystemMonthlyReportSemanticReadback(fields, record.fields || {});
      if (entry.payload.request.operation === 'replace') {
        await this.clearSubmissionRecords(entry.payload.request, recordId);
      }
      this.store.updateSyncBranch(taskId, 'feishu', {
        status: 'success',
        message: '飞书多维表已同步',
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.store.updateSyncBranch(taskId, 'feishu', {
        status: 'error',
        message:
          error instanceof SystemMonthlyReportIndeterminateWriteError
            ? `飞书写入结果暂无法确认：${safeErrorMessage(error)}`
            : `飞书同步失败：${safeErrorMessage(error)}`,
      });
      throw error;
    }
  }

  private async syncSubmissionToCos(taskId: string): Promise<void> {
    this.store.updateSyncBranch(taskId, 'cos', {
      status: 'syncing',
      message: '正在同步 COS 对象存储',
    });
    try {
      const entry = this.store.getEntry(taskId);
      if (entry.payload.kind === 'deletion') {
        const objectKeys = this.store.listSubmissionObjectKeys(
          entry.payload.request,
        );
        await this.archiveService.deleteSubmissionObjects(objectKeys);
        this.store.updateSyncBranch(taskId, 'cos', {
          status: 'success',
          message: '附件已清理',
          completedAt: new Date().toISOString(),
        });
        return;
      }
      if (entry.payload.kind !== 'submission') return;
      const file = entry.files.find((item) => item.key === 'report');
      if (!file) throw new BadRequestException('待同步 COS 的月报附件不存在');
      const object = await this.archiveService.uploadStagedSubmission(
        taskId,
        entry.payload.request,
        file,
      );
      this.store.updateCosObjects(taskId, {
        ...(entry.cosObjects || {}),
        report: object,
      });
      this.store.updateSyncBranch(taskId, 'cos', {
        status: 'success',
        message: 'COS 对象存储已同步',
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.store.updateSyncBranch(taskId, 'cos', {
        status: 'error',
        message: `COS 同步失败：${safeErrorMessage(error)}`,
      });
      throw error;
    }
  }

  private async processReviewTask(taskId: string): Promise<void> {
    let entry = this.store.getEntry(taskId);
    let failedStep: NonNullable<SystemMonthlyReportTask['failedStep']> =
      'upload';
    try {
      this.store.updateTask(taskId, {
        status: 'syncing',
        message: '正在上传附件并同步飞书多维表',
        retryable: false,
        failedStep: undefined,
      });
      const uploadedTokens = { ...entry.uploadedTokens };
      for (const file of entry.files) {
        if (uploadedTokens[file.key]?.length) continue;
        uploadedTokens[file.key] = [await this.gateway.uploadFile(file)];
        this.store.updateUploadedTokens(taskId, uploadedTokens);
      }
      entry = this.store.getEntry(taskId);
      if (entry.payload.kind !== 'review') return;
      const fields = buildSystemMonthlyReportReviewFields(
        entry.payload.request,
        entry.uploadedTokens,
      );

      failedStep = 'record';
      let recordId = entry.task.feishuRecordId;
      if (!recordId) {
        recordId = await this.gateway.createCollectionRecord(fields, taskId);
        this.store.updateTask(taskId, { feishuRecordId: recordId });
      }
      failedStep = 'readback';
      const record = await this.gateway.getCollectionRecord(recordId);
      assertSystemMonthlyReportSemanticReadback(fields, record.fields || {});
      this.store.updateTask(taskId, {
        status: 'success',
        message: '已同步飞书多维表',
        completedAt: new Date().toISOString(),
        retryable: false,
        failedStep: undefined,
      });
      this.cachedDashboard = null;
      await Promise.allSettled(entry.files.map((file) => unlink(file.path)));
      this.store.clearFiles(taskId);
    } catch (error) {
      const uncertain =
        error instanceof SystemMonthlyReportIndeterminateWriteError;
      this.store.updateTask(taskId, {
        status: uncertain ? 'uncertain' : 'error',
        message: uncertain
          ? '飞书写入结果暂无法确认，可安全重试'
          : `同步失败：${safeErrorMessage(error)}`,
        failedStep,
        retryable: true,
      });
    }
  }

  private async clearSubmissionRecords(
    request:
      | SystemMonthlyReportSubmissionRequest
      | SystemMonthlyReportSubmissionDeletionRequest,
    excludeRecordId?: string,
  ): Promise<void> {
    const sources = await this.gateway.loadSources(true);
    const recordIds = findSystemMonthlyReportSubmissionRecordIds(
      sources.collectionRecords,
      request,
    ).filter((recordId) => recordId !== excludeRecordId);
    const clearFields = buildSystemMonthlyReportSubmissionClearFields(
      request.stage,
    );
    for (const recordId of recordIds) {
      await this.gateway.updateCollectionRecord(recordId, clearFields);
      const record = await this.gateway.getCollectionRecord(recordId);
      assertSystemMonthlyReportSemanticReadback(
        clearFields,
        record.fields || {},
      );
    }
  }
}

function createLedgerEntry(input: {
  taskId: string;
  request:
    | SystemMonthlyReportSubmissionRequest
    | SystemMonthlyReportSubmissionDeletionRequest
    | SystemMonthlyReportReviewRequest;
  principalFingerprint: string;
  requestFingerprint: string;
  action: SystemMonthlyReportTask['action'];
  payload: SystemMonthlyReportTaskLedgerEntry['payload'];
  files: SystemMonthlyReportStagedFile[];
}): SystemMonthlyReportTaskLedgerEntry {
  const now = new Date().toISOString();
  const task: SystemMonthlyReportTask = {
    id: input.taskId,
    clientMutationId: input.request.clientMutationId,
    action: input.action,
    targetRecordId: input.request.currentRecordId,
    status: 'accepted',
    message: '已受理，正在后台同步',
    createdAt: now,
    updatedAt: now,
    ...(input.payload.kind !== 'review'
      ? {
          sync: {
            feishu: { status: 'pending' as const, message: '等待同步飞书' },
            cos: { status: 'pending' as const, message: '等待同步 COS' },
          },
        }
      : {}),
  };
  return {
    principalFingerprint: input.principalFingerprint,
    requestFingerprint: input.requestFingerprint,
    task,
    payload: input.payload,
    files: input.files,
    uploadedTokens: {},
    cosObjects: {},
  };
}

function validateRequestIdentity(
  request:
    | SystemMonthlyReportSubmissionRequest
    | SystemMonthlyReportSubmissionDeletionRequest
    | SystemMonthlyReportReviewRequest,
): void {
  if (!MUTATION_ID_PATTERN.test(request.clientMutationId || '')) {
    throw new BadRequestException('clientMutationId 格式无效');
  }
  if (!RECORD_ID_PATTERN.test(request.currentRecordId || '')) {
    throw new BadRequestException('月报关联记录格式无效');
  }
  if (!request.room?.trim() || request.room.length > 64) {
    throw new BadRequestException('机房格式无效');
  }
}

function validateUpload(
  file: SystemMonthlyReportUploadFile,
  extensions: Set<string>,
  maxBytes: number,
  label: string,
): void {
  if (!file?.buffer?.length || file.size !== file.buffer.length) {
    throw new BadRequestException(`${label}内容为空或不完整`);
  }
  if (file.size > maxBytes) {
    throw new BadRequestException(`${label}超过大小限制`);
  }
  if (!extensions.has(safeExtension(file.originalname))) {
    throw new BadRequestException(`${label}格式不支持`);
  }
}

function redactDashboard(
  dashboard: SystemMonthlyReportDashboard,
): SystemMonthlyReportDashboard {
  const redactPerson = <T extends { openId: string } | null>(person: T): T =>
    (person ? { ...person, openId: '' } : null) as T;
  return {
    ...dashboard,
    rooms: dashboard.rooms.map((room) => ({
      ...room,
      submitters: room.submitters.map((person) => redactPerson(person)),
      leaders: room.leaders.map((person) => redactPerson(person)),
      leader: redactPerson(room.leader),
      initialReviewer: redactPerson(room.initialReviewer),
      recheckReviewer: redactPerson(room.recheckReviewer),
    })),
    schedule: dashboard.schedule.map((item) => ({
      ...item,
      reviewer: redactPerson(item.reviewer),
    })),
    reviewOpinions: dashboard.reviewOpinions.map((opinion) => ({
      ...opinion,
      reviewer: redactPerson(opinion.reviewer),
    })),
    history: dashboard.history.map((item) => ({
      ...item,
      attachments: [],
    })),
  };
}

function requirePrivileged(subject: SystemMonthlyReportAccessSubject): void {
  if (subject.kind !== 'privileged') {
    throw new ForbiddenException('该操作仅限管理员或子管理员');
  }
}

function taskIdFor(principalFingerprint: string, mutationId: string): string {
  return `system-monthly-${sha256(`${principalFingerprint}\u001f${mutationId}`).slice(0, 24)}`;
}

function fingerprint(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeExtension(fileName: string): string {
  const match = /\.[a-zA-Z0-9]{1,8}$/.exec(fileName.trim());
  return match ? match[0].toLowerCase() : '';
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'file';
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
