import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import type {
  SystemMonthlyReportPackageRequest,
  SystemMonthlyReportPackageTask,
  SystemMonthlyReportPerson,
} from '../../../shared/system-monthly-report.interface';
import { SystemMonthlyReportArchiveService } from './system-monthly-report-archive.service';
import { SystemMonthlyReportGateway } from './system-monthly-report.gateway';
import { SystemMonthlyReportPackageStore } from './system-monthly-report-package.store';

export const SYSTEM_MONTHLY_REPORT_PACKAGE_OPTIONS =
  'SYSTEM_MONTHLY_REPORT_PACKAGE_OPTIONS';
export interface SystemMonthlyReportPackageOptions {
  indexPath?: string;
  env?: NodeJS.ProcessEnv;
}
export interface SystemMonthlyReportPackageNotifier {
  sendPackageLink(input: {
    recipientOpenId: string;
    url: string;
    year: number;
    month: number;
    fileName: string;
    complete: boolean;
    missingRooms: string[];
    clientToken: string;
  }): Promise<string>;
}

@Injectable()
export class SystemMonthlyReportPackageService {
  private readonly logger = new Logger(SystemMonthlyReportPackageService.name);
  private readonly store: SystemMonthlyReportPackageStore;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();

  constructor(
    private readonly archive: SystemMonthlyReportArchiveService,
    private readonly notifier: SystemMonthlyReportGateway,
    @Optional()
    @Inject(SYSTEM_MONTHLY_REPORT_PACKAGE_OPTIONS)
    options: SystemMonthlyReportPackageOptions = {},
  ) {
    const env = options.env || process.env;
    const runtime = resolve(
      env.SYSTEM_MONTHLY_REPORT_RUNTIME_DIR ||
        resolve(process.cwd(), '.runtime', 'system-monthly-report'),
    );
    this.store = new SystemMonthlyReportPackageStore(
      options.indexPath || join(runtime, 'packages.json'),
    );
    for (const entry of this.store.listRecoverable()) this.enqueue(entry.id);
  }

  accept(
    request: SystemMonthlyReportPackageRequest,
    expectedRooms: string[],
    recipient: SystemMonthlyReportPerson,
    principalFingerprint: string,
  ): SystemMonthlyReportPackageTask {
    validateRequest(request, expectedRooms, recipient, principalFingerprint);
    const fingerprint = sha256(
      JSON.stringify({
        request,
        expectedRooms: [...expectedRooms].sort(),
        recipientOpenId: recipient.openId,
      }),
    );
    const id = `monthly-package-${sha256(`${principalFingerprint}\u001f${request.clientMutationId}`).slice(0, 24)}`;
    const reserved = this.store.reserve({
      id,
      clientMutationId: request.clientMutationId,
      principalFingerprint,
      requestFingerprint: fingerprint,
      year: request.year,
      month: request.month,
      expectedRooms: Array.from(new Set(expectedRooms)),
      recipientOpenId: recipient.openId,
    });
    if (reserved.created) this.enqueue(id);
    return reserved.entry.task;
  }

  getTask(id: string): SystemMonthlyReportPackageTask {
    const task = this.store.get(id);
    if (!task) throw new NotFoundException('月报打包任务不存在');
    return task;
  }
  getDownload(id: string) {
    const entry = this.store.getEntry(id);
    if (!entry?.objectKey || !entry.task.packageReady)
      throw new BadRequestException('月报压缩包尚未生成');
    return {
      ...this.archive.getPackageDownload(entry.objectKey, 3600),
      name: entry.task.fileName,
    };
  }
  retry(id: string): SystemMonthlyReportPackageTask {
    const entry = this.store.getEntry(id);
    if (!entry || entry.task.status !== 'error')
      throw new BadRequestException('当前打包任务不需要重试');
    const updated = this.store.update(id, {
      task: {
        ...entry.task,
        status: 'accepted',
        message: entry.task.packageReady
          ? '已重新受理，正在重试飞书通知'
          : '已重新受理，正在重新打包',
        notificationError: undefined,
      },
    });
    this.enqueue(id);
    return updated.task;
  }
  async waitForIdle(): Promise<void> {
    await this.queueTail;
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queueTail = this.queueTail
      .then(() => this.process(id))
      .catch((error) =>
        this.logger.error(`体系月报打包任务异常：${safeError(error)}`),
      )
      .finally(() => this.queued.delete(id));
  }
  private async process(id: string): Promise<void> {
    let entry = this.store.getEntry(id);
    if (!entry || ['success', 'partial'].includes(entry.task.status)) return;
    try {
      if (entry.task.packageReady && entry.objectKey) {
        await this.notifyCompletedPackage(entry);
        return;
      }
      this.store.update(id, {
        task: {
          ...entry.task,
          status: 'packaging',
          message: '正在从 COS 汇总终版附件',
        },
      });
      const expectedRoomSet = new Set(entry.expectedRooms);
      const archives = this.archive
        .listArchivedFinals(entry.year, entry.month)
        .filter((item) => expectedRoomSet.has(item.room));
      const availableRooms = new Set(archives.map((item) => item.room));
      const missingRooms = entry.expectedRooms.filter(
        (room) => !availableRooms.has(room),
      );
      if (!archives.length) throw new Error('所选月份暂无已归档终版附件');
      const fileEntries: Record<string, Uint8Array> = {};
      for (let index = 0; index < archives.length; index += 1) {
        const item = archives[index];
        let name = item.name;
        if (fileEntries[name]) name = `${item.room}-${index + 1}-${name}`;
        fileEntries[name] = await this.archive.readArchivedFile(item.archiveId);
      }
      const zipped = Buffer.from(zipSync(fileEntries, { level: 6 }));
      entry = this.store.update(id, {
        task: {
          ...entry.task,
          status: 'uploading',
          message: '压缩完成，正在上传 COS',
          missingRooms,
        },
      });
      const uploaded = await this.archive.uploadPackage(
        id,
        entry.task.fileName,
        zipped,
      );
      entry = this.store.update(id, {
        objectKey: uploaded.objectKey,
        task: {
          ...entry.task,
          status: 'notifying',
          message: '压缩包已生成，正在推送马进宇',
          missingRooms,
          packageReady: true,
        },
      });
      await this.notifyCompletedPackage(entry);
    } catch (error) {
      entry = this.store.getEntry(id) || entry;
      this.store.update(id, {
        task: {
          ...entry.task,
          status: 'error',
          message: `打包失败：${safeError(error)}`,
        },
      });
    }
  }

  private async notifyCompletedPackage(
    entry: NonNullable<ReturnType<SystemMonthlyReportPackageStore['getEntry']>>,
  ): Promise<void> {
    if (!entry.objectKey) throw new Error('月报压缩包对象标识缺失');
    const missingRooms = entry.task.missingRooms || [];
    const download = this.archive.getPackageDownload(entry.objectKey, 3600);
    try {
      const messageId = await (
        this.notifier as unknown as SystemMonthlyReportPackageNotifier
      ).sendPackageLink({
        recipientOpenId: entry.recipientOpenId,
        url: download.url,
        year: entry.year,
        month: entry.month,
        fileName: entry.task.fileName,
        complete: missingRooms.length === 0,
        missingRooms,
        clientToken: entry.id,
      });
      this.store.update(entry.id, {
        messageId,
        task: {
          ...entry.task,
          status: missingRooms.length ? 'partial' : 'success',
          message: missingRooms.length
            ? `打包完成，缺少 ${missingRooms.join('、')}`
            : '全部机房终版已打包并推送马进宇',
          missingRooms,
          packageReady: true,
          notified: true,
          notificationError: undefined,
          completedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      this.store.update(entry.id, {
        task: {
          ...entry.task,
          status: 'error',
          message: '压缩包已生成，飞书推送失败，可重试通知',
          missingRooms,
          packageReady: true,
          notified: false,
          notificationError: safeError(error),
        },
      });
    }
  }
}

function validateRequest(
  request: SystemMonthlyReportPackageRequest,
  rooms: string[],
  recipient: SystemMonthlyReportPerson,
  principal: string,
): void {
  if (!/^[a-zA-Z0-9:_-]{12,128}$/u.test(request.clientMutationId || ''))
    throw new BadRequestException('打包 clientMutationId 无效');
  if (
    !Number.isInteger(request.year) ||
    request.year < 2020 ||
    request.year > 2100 ||
    !Number.isInteger(request.month) ||
    request.month < 1 ||
    request.month > 12
  )
    throw new BadRequestException('打包月份无效');
  if (!rooms.length) throw new BadRequestException('所选月份没有机房数据');
  if (
    !/^ou_[A-Za-z0-9]+$/u.test(recipient.openId || '') ||
    recipient.name !== '马进宇'
  )
    throw new BadRequestException('马进宇稳定飞书身份未找到');
  if (principal.length < 8) throw new BadRequestException('当前打包会话无效');
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\u0000-\u001f]/gu, ' ')
    .slice(0, 240);
}
