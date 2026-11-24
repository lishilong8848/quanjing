import {
  BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, Logger,
  NotFoundException, ServiceUnavailableException, UnprocessableEntityException, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction, type BusinessAction } from '../../../shared/business-permissions';
import { cancelHotfixInitialization, currentHotfixActivation, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { FilePublicationDeliveryRejected, FilePublicationGateway, type FilePublicationFile } from './file-publication.gateway';
import {
  FilePublicationStore, publicationIdPattern, type PublicationBatch, type PublicationStatus, type PublicationUpload,
} from './file-publication.store';

export const FILE_PUBLICATION_LIMITS = {
  maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024,
};
const extensions = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.txt', '.md',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.zip', '.rar', '.7z',
]);
const TABLE_RETRY_WINDOW_MS = 5 * 60_000;
const NOTIFICATION_RETRY_WINDOW_MS = 55 * 60_000;
const MAX_RECIPIENTS = 20;
const HISTORY_STATUSES = new Set<PublicationStatus>(['syncing', 'pending', 'publishing', 'published', 'archived', 'rejected', 'failed']);
export interface PublicationHistoryQuery {
  page?: unknown;
  pageSize?: unknown;
  status?: unknown;
  q?: unknown;
  from?: unknown;
  to?: unknown;
  focus?: unknown;
}

function historyInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,8}$/u.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new BadRequestException('发布历史分页参数无效');
  }
  return Number(value);
}

function historyDay(value: unknown, end: boolean): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new BadRequestException('发布历史日期无效');
  }
  const raw = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(raw.getTime()) || raw.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('发布历史日期无效');
  }
  return Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`);
}

function manualRecipients(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS || value.some(input =>
    typeof input !== 'string' || input.trim().length > 128 || /[\u0000-\u001f\u007f]/u.test(input))) {
    throw new BadRequestException('最多填写 20 项通知对象，每项不超过 128 个字符');
  }
  return [...new Set((value as string[]).map(input => input.trim().normalize('NFC')).filter(Boolean))].sort();
}

function identify(principal: AccessPrincipal): string {
  if (principal.accountId) return principal.accountId;
  if (principal.role === 'admin') return 'legacy-admin';
  throw new ForbiddenException('文件发布需要可识别的平台账号');
}

function allowed(principal: AccessPrincipal | undefined, action: BusinessAction): principal is AccessPrincipal {
  return !!principal && principal.role !== 'guest' && !principal.requiresPasswordChange &&
    canPerformBusinessAction(principal, { module: 'file_publication', action });
}

function canArchive(principal: AccessPrincipal | undefined): boolean {
  return allowed(principal, 'create') &&
    canPerformBusinessAction(principal, { module: 'file_publication_table', action: 'create' });
}

function requirePermission(principal: AccessPrincipal | undefined, action: BusinessAction): AccessPrincipal {
  if (!allowed(principal, action)) throw new ForbiddenException('当前账号无权办理该文件发布操作');
  return principal;
}

function submitterName(principal: AccessPrincipal): string {
  return principal.displayName?.trim().slice(0, 100) || (principal.role === 'admin' ? '平台管理员' : '发布人');
}

export function publicationFilename(value: unknown, multipart = false): string {
  if (typeof value !== 'string') throw new BadRequestException('附件名称无效');
  let name = value;
  if (multipart && /^[\u0000-\u00ff]*$/u.test(name)) {
    const bytes = Buffer.from(name, 'latin1');
    if (isUtf8(bytes)) name = bytes.toString('utf8');
  }
  name = name.trim().normalize('NFC');
  if (!name || /[\\/\u0000-\u001f\u007f]/u.test(name) || Array.from(name).length > 180 ||
      !extensions.has(extname(name).toLowerCase())) {
    throw new BadRequestException('附件格式或文件名不受支持');
  }
  return name;
}

function validateFileList(value: unknown, required: boolean): FilePublicationFile[] {
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > FILE_PUBLICATION_LIMITS.maxFiles) {
    throw new BadRequestException('每批请上传 1 至 10 个附件');
  }
  const files = value.map(file => {
    const name = publicationFilename(file?.name);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > FILE_PUBLICATION_LIMITS.maxFileBytes) {
      throw new BadRequestException('附件必须非空，单个文件最多 20 MB');
    }
    return { name, size: file.size as number };
  });
  if (files.reduce((total, file) => total + file.size, 0) > FILE_PUBLICATION_LIMITS.maxTotalBytes) {
    throw new BadRequestException('一批附件总大小最多 50 MB');
  }
  return files;
}

function validateLink(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000) {
    throw new BadRequestException('请填写获准使用的飞书多维表链接');
  }
  return value.trim();
}

function parseMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('发布资料字段无效');
  }
  const entries = Object.entries(value);
  if (entries.length > 60 || entries.some(([key, text]) =>
    !/^fld[A-Za-z0-9_-]{1,80}$/u.test(key) || typeof text !== 'string' || Array.from(text).length > 2_000)) {
    throw new BadRequestException('发布资料字段无效');
  }
  return Object.fromEntries(entries.map(([key, text]) => [key, (text as string).trim()]));
}

async function fileHash(file: PublicationUpload): Promise<string> {
  const stat = await lstat(file.path);
  if (!stat.isFile() || stat.size !== file.size) throw new BadRequestException('附件没有完整上传');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file.path)) hash.update(bytes);
  return hash.digest('hex');
}

function batchIdFor(publisherId: string, requestId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['file-publication', publisherId, requestId])).digest();
  // Feishu requires the same UUIDv4-shaped client token on each retry.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

@Injectable()
export class FilePublicationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilePublicationService.name);
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private admissions: Promise<unknown> = Promise.resolve();
  private readonly deliveryLanes = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly store: FilePublicationStore,
    private readonly gateway: FilePublicationGateway,
  ) {}

  onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, () => {
      try {
        if (!this.gateway.tables().length) return;
      } catch {
        this.logger.error('文件发布台账配置不可用，后台同步未启动');
        return;
      }
      this.stopped = false;
      this.timer = setInterval(() => this.wake(), 15_000);
      this.timer.unref();
      this.wake();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await cancelHotfixInitialization(this);
    await this.pending;
  }

  getOptions(principal: AccessPrincipal | undefined) {
    const canReadPublication = allowed(principal, 'read');
    const canManageRecords = !!principal && principal.role !== 'guest' && !principal.requiresPasswordChange &&
      canPerformBusinessAction(principal, { module: 'file_publication_table', action: 'read' });
    if (!canReadPublication && !canManageRecords) requirePermission(principal, 'read');
    return {
      groups: canReadPublication ? this.gateway.groups() : [],
      sources: this.gateway.tables().map(table => ({ label: table.label, url: table.link })),
      canReadPublication,
      canPublish: canReadPublication && allowed(principal, 'create'),
      canArchive: canReadPublication && canArchive(principal),
      canReview: canReadPublication && allowed(principal, 'approve'),
      canManageRecords,
      limits: FILE_PUBLICATION_LIMITS,
    };
  }

  parse(principal: AccessPrincipal | undefined, input: { link?: unknown; files?: unknown }) {
    requirePermission(principal, 'create');
    return this.gateway.parse(validateLink(input?.link), validateFileList(input?.files ?? [], false));
  }

  async list(principal: AccessPrincipal | undefined, query?: PublicationHistoryQuery) {
    const viewer = requirePermission(principal, 'read');
    if (!query || Object.keys(query).length === 0) {
      const batches = (await this.store.list()).filter(batch => this.visible(batch, viewer));
      return { batches: batches.map(batch => this.present(batch, viewer)) };
    }
    const requestedPage = historyInteger(query.page, 1, 1_000_000);
    const pageSize = historyInteger(query.pageSize, 20, 100);
    const { q, status, focus } = query;
    if ((q !== undefined && (typeof q !== 'string' || q.length > 150)) ||
        (status !== undefined && status !== '' && !HISTORY_STATUSES.has(status as PublicationStatus)) ||
        (focus !== undefined && (typeof focus !== 'string' || !publicationIdPattern.test(focus)))) {
      throw new BadRequestException('发布历史筛选参数无效');
    }
    const needle = typeof q === 'string' ? q.trim().toLocaleLowerCase() : '';
    const from = historyDay(query.from, false);
    const to = historyDay(query.to, true);
    if (from !== undefined && to !== undefined && from > to) throw new BadRequestException('开始日期不能晚于结束日期');
    const batches = (await this.store.list()).filter(batch => {
      if (!this.visible(batch, viewer) || (status && batch.status !== status)) return false;
      const time = Date.parse(batch.submittedAt);
      if ((from !== undefined && !(time >= from)) || (to !== undefined && !(time <= to))) return false;
      return !needle || [batch.id, batch.title, batch.code, batch.publisher, ...batch.files.map(file => file.name)]
        .some(value => value?.toLocaleLowerCase().includes(needle));
    });
    const focused = focus ? batches.findIndex(batch => batch.id === focus) : -1;
    const page = focused >= 0 ? Math.floor(focused / pageSize) + 1 :
      Math.min(requestedPage, Math.max(1, Math.ceil(batches.length / pageSize)));
    return { batches: batches.slice((page - 1) * pageSize, page * pageSize).map(batch => this.present(batch, viewer)),
      total: batches.length, page, pageSize };
  }

  async detail(principal: AccessPrincipal | undefined, batchId: string) {
    const viewer = requirePermission(principal, 'read');
    const batch = await this.getBatch(batchId);
    if (!this.visible(batch, viewer)) throw new NotFoundException('文件发布记录不存在');
    return { batch: this.present(batch, viewer) };
  }

  async submission(principal: AccessPrincipal | undefined, requestId: string) {
    const publisher = requirePermission(principal, 'create');
    if (!publicationIdPattern.test(requestId)) throw new BadRequestException('发布申请标识无效');
    const publisherId = identify(publisher);
    const batch = await this.store.read(batchIdFor(publisherId, requestId));
    return { batch: batch?.publisherId === publisherId && batch.requestId === requestId ? this.present(batch, publisher) : null };
  }

  async retryDeliveries(principal: AccessPrincipal | undefined, batchId: string, input: {
    requestId?: unknown;
    recipientIds?: unknown;
  }) {
    const reviewer = requirePermission(principal, 'approve');
    const requestId = input?.requestId;
    const recipientIds = input?.recipientIds;
    if (typeof requestId !== 'string' || !publicationIdPattern.test(requestId) ||
        !Array.isArray(recipientIds) || !recipientIds.length || recipientIds.length > MAX_RECIPIENTS ||
        recipientIds.some(id => typeof id !== 'string' || !/^o[uc]_[A-Za-z0-9_-]{1,125}$/u.test(id))) {
      throw new BadRequestException('请选择发送失败的通知对象');
    }
    const ids: string[] = [...new Set(recipientIds as string[])].sort();
    const saved = await this.serialDelivery(batchId, async () => {
      const batch = await this.getBatch(batchId);
      const previous = batch.retryReceipts?.[requestId];
      if (previous) {
        if (ids.join(',') !== previous.join(',')) throw new ConflictException('该补发请求已用于其他通知对象');
        return batch;
      }
      if (batch.reviewed?.decision !== 'approve') throw new ConflictException('当前发布批次尚未通过审批');
      const deliveries = ids.map(id => batch.deliveries.find(item => item.groupId === id));
      if (deliveries.some(item => item?.phase !== 'failed' || item.messageId || item.needsCheck)) {
        throw new ConflictException('只有已确认发送失败的通知可以补发，请刷新批次状态');
      }
      for (const item of deliveries) {
        item!.phase = 'queued';
        item!.firstAttemptAt = 0;
        delete item!.message;
      }
      (batch.retryReceipts ??= {})[requestId] = ids;
      batch.status = 'publishing';
      batch.nextAttemptAt = 0;
      await this.store.save(batch);
      return batch;
    });
    this.wake();
    return { batch: this.present(saved, reviewer) };
  }

  async submit(
    principal: AccessPrincipal | undefined,
    input: {
      requestId?: unknown; link?: unknown; metadata?: unknown; groupIds?: unknown;
      recipientInputs?: unknown; schemaVersion?: unknown; mode?: unknown;
    },
    uploads: PublicationUpload[],
  ) {
    const publisher = requirePermission(principal, 'create');
    const publisherId = identify(publisher);
    if (input.mode !== undefined && input.mode !== 'archive' && input.mode !== 'publish') {
      throw new BadRequestException('文件保存方式无效');
    }
    const archive = input.mode === 'archive';
    if (archive && !canArchive(publisher)) throw new ForbiddenException('当前账号没有直接新增多维表记录的权限');
    const { requestId } = input;
    if (typeof requestId !== 'string' || !publicationIdPattern.test(requestId)) {
      throw new BadRequestException('发布申请标识无效，请重新选择文件');
    }
    const batchId = batchIdFor(publisherId, requestId);
    const link = validateLink(input.link);
    const metadata = parseMetadata(input.metadata);
    const files = validateFileList(uploads, true);
    const manual = manualRecipients(input.recipientInputs);
    const schemaVersion = input.schemaVersion;
    if (schemaVersion !== undefined && (typeof schemaVersion !== 'string' || !/^[0-9a-f]{64}$/u.test(schemaVersion))) {
      throw new BadRequestException('台账字段核对信息无效，请重新解析后提交');
    }
    const groups = this.gateway.groups();
    if (!Array.isArray(input.groupIds) || input.groupIds.length > groups.length ||
        input.groupIds.some(id => !groups.some(group => group.id === id))) {
      throw new BadRequestException('请选择已配置的通知群组');
    }
    const selected = new Set(input.groupIds);
    if (selected.size !== input.groupIds.length) throw new BadRequestException('通知群组不能重复');
    if (archive && (selected.size || manual.length)) throw new BadRequestException('直接保存台账时不能指定通知对象');
    const assignedGroups = groups.filter(group => selected.has(group.id));
    const hashes = await Promise.all(uploads.map(fileHash));
    const fingerprint = createHash('sha256').update(JSON.stringify([
      link, Object.entries(metadata).sort(), assignedGroups.map(group => group.id).sort(),
      files.map((file, i) => [file.name, file.size, hashes[i]]),
      ...(manual.length || schemaVersion ? [manual, schemaVersion ?? null] : []),
      ...(archive ? ['archive'] : []),
    ])).digest('hex');
    const existing = await this.findSubmission(batchId, fingerprint);
    if (existing) return this.present(existing, publisher);

    const preview = await this.gateway.parse(link, files);
    if (schemaVersion && schemaVersion !== preview.schemaVersion) {
      throw new BadRequestException({
        code: 'PUBLICATION_SCHEMA_CHANGED', message: '多维表写入字段已变化，请重新解析后提交',
      });
    }
    for (const [key, value] of Object.entries(metadata)) {
      const field = preview.fields.find(item => item.key === key);
      if (!field) throw new BadRequestException('多维表字段已变化，请重新解析后提交');
      if ((field.required && !value) || Array.from(value).length > (field.maxLength ?? 2_000)) {
        throw new BadRequestException(`请检查“${field.name}”的内容和字数`);
      }
    }
    const added = manual.length ? await this.gateway.resolveManualRecipients(manual).catch(error => {
      if (error instanceof BadGatewayException || error instanceof ServiceUnavailableException) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }) : [];
    const recipientsById = new Map(added.map(recipient => [recipient.id, recipient]));
    for (const group of assignedGroups) recipientsById.set(group.id, group);
    if ((manual.length || schemaVersion) && recipientsById.size > MAX_RECIPIENTS) {
      throw new BadRequestException('本批次最多通知 20 个不同人员或群组');
    }
    return this.serialAdmission(async () => {
      const duplicate = await this.findSubmission(batchId, fingerprint);
      if (duplicate) return this.present(duplicate, publisher);
      const batch: PublicationBatch = {
        id: batchId, requestId, publisherId, fingerprint, publisher: submitterName(publisher),
        sourceUrl: preview.sourceUrl, title: preview.title, code: preview.code,
        status: 'syncing', submittedAt: new Date().toISOString(), metadata, groups: [...recipientsById.values()],
        ...(archive ? { mode: 'archive' as const } : {}),
        ...(preview.schemaVersion ? { schemaVersion: preview.schemaVersion } : {}),
        files: files.map((file, i) => ({ ...file, id: uploads[i].id })),
        deliveries: [], failures: 0, nextAttemptAt: 0,
      };
      await this.store.create(batch, uploads);
      this.wake();
      return this.present(batch, publisher);
    });
  }

  async review(principal: AccessPrincipal | undefined, batchId: string, input: { decision?: unknown; reason?: unknown }) {
    const reviewer = requirePermission(principal, 'approve');
    const actorId = identify(reviewer);
    const decision = input?.decision;
    if (decision !== 'approve' && decision !== 'reject') throw new BadRequestException('请选择审核结果');
    if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) {
      throw new BadRequestException('驳回原因最多 500 字');
    }
    const reason = decision === 'reject' ? (input.reason as string | undefined)?.trim() : undefined;
    return this.serialAdmission(async () => {
      const batch = await this.getBatch(batchId);
      if (batch.mode === 'archive') throw new ConflictException('直接保存的批次无需审核');
      if (batch.reviewed?.decision === decision) return this.present(batch, reviewer);
      if (batch.status !== 'pending' || !batch.recordId || batch.reviewed) {
        throw new ConflictException('该批次当前不可审核，请刷新状态');
      }
      const at = new Date().toISOString();
      batch.reviewed = { decision, actorId, actor: submitterName(reviewer), at, reason };
      if (decision === 'reject') batch.status = 'rejected';
      else if (batch.groups.length) batch.status = 'publishing';
      else {
        batch.status = 'published';
        batch.publishedAt = at;
      }
      batch.nextAttemptAt = 0;
      delete batch.error;
      await this.store.save(batch);
      this.wake();
      return this.present(batch, reviewer);
    });
  }

  async download(principal: AccessPrincipal | undefined, batchId: string, fileId: string) {
    const viewer = requirePermission(principal, 'export');
    const batch = await this.getBatch(batchId);
    const file = batch.files.find(item => item.id === fileId);
    if (!file || !this.visible(batch, viewer)) throw new NotFoundException('附件不存在或无权下载');
    const path = this.store.filePath(batch.id, file.id);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.size !== file.size) throw new ServiceUnavailableException('附件暂不可读取');
    return { ...file, stream: createReadStream(path) };
  }

  async processPending(now = Date.now()): Promise<void> {
    const started = Date.now();
    const batches = await this.store.list();
    const ready = batches.filter(batch => (
      (batch.status === 'syncing' || batch.status === 'publishing') && batch.nextAttemptAt <= now
    )).reverse();
    for (const batch of ready.slice(0, 10)) {
      if (!this.mayProcess()) return;
      const batchTime = now + Math.max(0, Date.now() - started);
      await this.serialDelivery(batch.id, async () => {
        const current = await this.store.read(batch.id);
        if (!current || current.nextAttemptAt > batchTime) return;
        if (current.status === 'publishing') await this.publish(current, batchTime);
        else if (current.status === 'syncing') await this.register(current, batchTime);
      });
    }
  }

  private async register(batch: PublicationBatch, now: number): Promise<void> {
    const started = Date.now();
    try {
      if (!batch.prepared) {
        batch.prepared = await this.gateway.prepareBatch({
          batchId: batch.id, link: batch.sourceUrl, metadata: batch.metadata, schemaVersion: batch.schemaVersion,
          files: batch.files.map(file => ({ ...file, path: this.store.filePath(batch.id, file.id) })),
        });
        batch.title = batch.prepared.title;
        batch.code = batch.prepared.code;
        await this.store.save(batch);
      }
      const commitTime = now + Math.max(0, Date.now() - started);
      const previousAttempt = batch.commitStartedAt;
      if (previousAttempt === undefined) {
        if (!this.mayProcess()) return;
        batch.commitStartedAt = commitTime;
        await this.store.save(batch);
      }
      if (!this.mayProcess()) return;
      const recovered = previousAttempt !== undefined && batch.prepared.batchField
        ? await this.gateway.findCommittedBatch(batch.prepared, batch.id)
        : null;
      if (recovered) {
        batch.recordId = recovered;
      } else if (previousAttempt !== undefined &&
        now + Math.max(0, Date.now() - started) - previousAttempt >= TABLE_RETRY_WINDOW_MS) {
        batch.status = 'failed';
        batch.error = '多维表写入结果待核对，请联系管理员检查原批次';
        await this.store.save(batch);
        return;
      } else if (this.mayProcess()) {
        batch.recordId = await this.gateway.commitBatch(batch.prepared, batch.id);
      } else return;
      batch.status = batch.mode === 'archive' ? 'archived' : 'pending';
      batch.failures = 0;
      batch.nextAttemptAt = 0;
      delete batch.error;
    } catch (error) {
      batch.failures += 1;
      if (batch.commitStartedAt === undefined && (error instanceof BadRequestException || batch.failures >= 5)) {
        batch.status = 'failed';
        batch.error = error instanceof BadRequestException ? error.message : '多维表资料或附件同步失败，请核对本批次';
      } else {
        batch.nextAttemptAt = now + this.backoff(batch.failures);
        batch.error = '多维表同步待确认，系统将按原批次重试';
      }
    }
    await this.store.save(batch);
  }

  private async publish(batch: PublicationBatch, now: number): Promise<void> {
    let retry = false;
    const started = Date.now();
    for (const group of batch.groups) {
      if (!this.mayProcess()) return;
      const checkedAt = now + Math.max(0, Date.now() - started);
      let delivery = batch.deliveries.find(entry => entry.groupId === group.id);
      if (delivery?.messageId || delivery?.needsCheck || delivery?.phase === 'failed') continue;
      const mayHaveSentBefore = !!delivery?.firstAttemptAt;
      if (!delivery) {
        delivery = { groupId: group.id, firstAttemptAt: 0 };
        batch.deliveries.push(delivery);
      }
      if (mayHaveSentBefore && checkedAt - delivery.firstAttemptAt >= NOTIFICATION_RETRY_WINDOW_MS) {
        delivery.needsCheck = true;
        await this.store.save(batch);
        continue;
      }
      delivery.firstAttemptAt ||= checkedAt;
      delivery.phase = 'sending';
      await this.store.save(batch);
      if (!this.mayProcess()) return;
      try {
        delivery.messageId = await this.gateway.notifyRecipient(batch, group);
        delete delivery.message;
      } catch (error) {
        if (!mayHaveSentBefore && error instanceof FilePublicationDeliveryRejected) {
          delivery.phase = 'failed';
          delivery.message = error.message;
          await this.store.save(batch);
          continue;
        }
        retry = true;
        continue;
      }
      await this.store.save(batch);
    }
    if (retry) {
      batch.nextAttemptAt = now + this.backoff(++batch.failures);
      batch.error = '部分通知待确认，系统将按原通知重试';
    } else {
      batch.status = 'published';
      batch.publishedAt = new Date(now).toISOString();
      if (batch.deliveries.some(delivery => delivery.needsCheck)) {
        batch.error = '有通知投递结果待核对，请联系管理员';
      } else if (batch.deliveries.some(delivery => delivery.phase === 'failed')) {
        batch.error = '部分通知发送失败，可在批次详情按对象补发';
      } else {
        delete batch.error;
      }
    }
    await this.store.save(batch);
  }

  private wake(): void {
    if (!this.timer || this.pending || !this.mayProcess()) return;
    this.pending = this.processPending().catch(() => {
      this.logger.error('文件发布后台任务未完成，将继续核对原批次');
    }).finally(() => { this.pending = undefined; });
  }

  private mayProcess(): boolean {
    return !this.stopped && (this.timer === undefined || currentHotfixActivation().isAcceptingNewWork());
  }

  private backoff(attempts: number): number {
    return Math.min(5 * 60_000, 15_000 * (2 ** Math.min(5, attempts - 1)));
  }

  private async getBatch(id: string): Promise<PublicationBatch> {
    const batch = publicationIdPattern.test(id) ? await this.store.read(id) : null;
    if (!batch) throw new NotFoundException('文件发布记录不存在');
    return batch;
  }

  private visible(batch: PublicationBatch, principal: AccessPrincipal): boolean {
    return batch.status === 'published' || batch.status === 'publishing' ||
      batch.publisherId === (principal.accountId || (principal.role === 'admin' ? 'legacy-admin' : undefined)) ||
      allowed(principal, 'approve');
  }

  private present(batch: PublicationBatch, principal: AccessPrincipal) {
    const { id, title, code, groups, publisher, submittedAt, status, mode, files, publishedAt, error, reviewed } = batch;
    const canApprove = allowed(principal, 'approve');
    return {
      id, title, code, groups, publisher, submittedAt, status, mode, files, publishedAt, error,
      deliveries: groups.map(group => {
        const entry = batch.deliveries.find(item => item.groupId === group.id);
        const status = entry?.messageId ? 'sent' : entry?.needsCheck ? 'uncertain' :
          entry?.phase === 'failed' ? 'failed' : entry?.phase === 'sending' || entry?.firstAttemptAt ? 'sending' :
          reviewed?.decision === 'reject' ? 'not_applicable' : 'pending';
        return { recipientId: group.id, status, ...(entry?.message ? { message: entry.message } : {}),
          canRetry: status === 'failed' && reviewed?.decision === 'approve' && canApprove };
      }),
      reason: reviewed?.reason,
      canReview: status === 'pending' && canApprove,
      canDownload: allowed(principal, 'export') && this.visible(batch, principal),
    };
  }

  private async findSubmission(batchId: string, fingerprint: string) {
    const batch = await this.store.read(batchId);
    if (batch && batch.fingerprint !== fingerprint) {
      throw new ConflictException('该申请已受理，变更文件或资料时请使用新申请标识');
    }
    return batch;
  }

  private serialAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.admissions.then(operation);
    this.admissions = next.catch(() => undefined);
    return next;
  }

  private serialDelivery<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.deliveryLanes.get(batchId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.deliveryLanes.set(batchId, next);
    return next.finally(() => { if (this.deliveryLanes.get(batchId) === next) this.deliveryLanes.delete(batchId); });
  }
}
