import { HttpService } from '@nestjs/axios';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FormData = require('form-data');
import { chromium, type Browser } from 'playwright-core';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import { PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';
import {
  INVENTORY_INBOUND_PHOTO_MAX_BYTES,
  INVENTORY_INBOUND_PHOTO_MAX_COUNT,
  WAREHOUSE_BUILDINGS,
  type InventoryInboundPhotoUploadResponse,
  type InventoryItemImage,
  type WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
import { readEnv } from '../../common/config/external-services.config';
import { InventoryWorkflowGateway } from './inventory-workflow.gateway';
import { InventoryInboundTaskLedgerStore } from './inventory-inbound-task-ledger.store';

export const INVENTORY_PHOTO_FIELD = '物品图片';
const API = 'https://open.feishu.cn/open-apis';
const ROOT = '/api/inventory-management';
const HASH = /^[a-f0-9]{64}$/;
const MEDIA_TOKEN = /^[A-Za-z0-9_-]{6,256}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MUTATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const IMAGE_SELECTOR = /^\d{1,6}-[a-f0-9]{16}$/;
const MAX_NAME_LENGTH = 100;
const MAX_LEDGER_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_LEDGER_IMAGES = 3;
const THUMBNAIL_MAX_PIXELS = 50_000_000;
const THUMBNAIL_SIZE = 160;
const THUMBNAIL_MAX_BYTES = 64 * 1024;
const THUMBNAIL_CACHE_LIMIT = 256;
const THUMBNAIL_CACHE_MS = 2 * 60 * 60_000;
const THUMBNAIL_QUEUE_LIMIT = 24;
const THUMBNAIL_QUEUE_MS = 20_000;
const THUMBNAIL_BROWSER_IDLE_MS = 45_000;
const STAGED_PHOTO_RETENTION_MS = 72 * 60 * 60_000;
const STAGED_PHOTO_SWEEP_INTERVAL_MS = 10 * 60_000;
const STAGED_PHOTO_DISK_LIMIT = 2 * 1024 * 1024 * 1024;

interface PhotoUpload {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface PhotoFile {
  buffer: Buffer;
  type: string;
  name: string;
}

interface BitablePhoto {
  file_token: string;
}

interface LedgerPhoto extends BitablePhoto {
  index: number;
  name: string;
}

interface LedgerImageContext {
  tableId: string;
  fieldId: string;
  recordId: string;
}

export function normalizeInventoryInboundPhotoIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > INVENTORY_INBOUND_PHOTO_MAX_COUNT ||
      value.some((id) => typeof id !== 'string' || !HASH.test(id)) ||
      new Set(value).size !== value.length) {
    throw new BadRequestException('入库照片标识无效');
  }
  return value.length ? value : undefined;
}

export function describeInventoryLedgerImages(recordId: string, field: unknown): InventoryItemImage[] {
  if (!RECORD_ID.test(recordId)) return [];
  return ledgerPhotos(field).map((photo) => ({
    name: photo.name,
    url: `${ROOT}/items/${encodeURIComponent(recordId)}/images/${imageSelector(photo)}`,
  }));
}

export function findInventoryLedgerImage(field: unknown, selector: string): string {
  if (!IMAGE_SELECTOR.test(selector)) throw new NotFoundException('物品图片不存在');
  const photo = ledgerPhotos(field).find((item) => imageSelector(item) === selector);
  if (!photo) throw new NotFoundException('物品图片不存在');
  return photo.file_token;
}

export function inventoryPhotoFieldIsEmpty(field: unknown): boolean {
  return field == null || (Array.isArray(field) && field.length === 0);
}

export function assertInventoryPhotoReceipt(field: unknown, expected: readonly BitablePhoto[]): void {
  if (!expected.length) return;
  const recorded = new Set(ledgerPhotos(field).map((photo) => photo.file_token));
  if (expected.some((photo) => !recorded.has(photo.file_token))) {
    throw new ServiceUnavailableException('入库照片写入结果待核对，将使用原请求继续核对');
  }
}

@Injectable()
export class InventoryInboundPhotoService implements OnModuleDestroy {
  private readonly mediaUploads = new Map<string, Promise<string>>();
  private readonly mediaDownloads = new Map<string, Promise<PhotoFile>>();
  private readonly thumbnailRequests = new Map<string, Promise<PhotoFile>>();
  private readonly thumbnails = new Map<string, { file: PhotoFile; expiresAt: number }>();
  private thumbnailQueue = Promise.resolve();
  private thumbnailBrowser?: Promise<Browser>;
  private thumbnailBrowserIdle?: NodeJS.Timeout;
  private closing = false;
  private readonly directory = process.env.INVENTORY_INBOUND_PHOTO_DIRECTORY ||
    join(process.cwd(), '.runtime', 'inventory-inbound-photos');
  private diskUsed = 0;
  private nextSweepAt = 0;
  private staging = Promise.resolve();

  constructor(
    private readonly httpService: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
    @Optional() private readonly taskLedger?: InventoryInboundTaskLedgerStore,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearTimeout(this.thumbnailBrowserIdle);
    await this.closeThumbnailBrowser();
  }

  async stage(
    principal: AccessPrincipal,
    building: unknown,
    clientMutationId: unknown,
    files: readonly PhotoUpload[],
  ): Promise<InventoryInboundPhotoUploadResponse> {
    const key = this.scope(principal, building, clientMutationId);
    if (!Array.isArray(files) || !files.length || files.length > INVENTORY_INBOUND_PHOTO_MAX_COUNT) {
      throw new BadRequestException('请选择 1 至 5 张物品照片');
    }
    const valid = files.map((file) => {
      const type = imageType(file?.buffer);
      if (!type || file.buffer.length > INVENTORY_INBOUND_PHOTO_MAX_BYTES ||
          (file.mimetype !== type && file.mimetype !== 'application/octet-stream')) {
        throw new BadRequestException('物品照片需为 JPEG、PNG、WebP 或 GIF，单张不超过 8 MB');
      }
      const name = safeName(file.originalname);
      const id = hash(file.buffer);
      return { id, type, name, buffer: file.buffer };
    });
    if (new Set(valid.map((photo) => photo.id)).size !== valid.length) {
      throw new BadRequestException('请移除重复的物品照片');
    }
    await this.runStaging(async () => {
      await this.sweepExpired();
      await mkdir(key, { recursive: true, mode: 0o700 });
      const stored = new Set(await readdir(key));
      for (const photo of valid) {
        const fileName = `${photo.id}.image`;
        if (stored.has(fileName)) continue;
        const body = Buffer.concat([Buffer.from(JSON.stringify({ name: photo.name }) + '\n'), photo.buffer]);
        if (this.diskUsed + body.length > STAGED_PHOTO_DISK_LIMIT) {
          throw new ServiceUnavailableException('入库照片临时空间不足，请稍后重试');
        }
        await writeOnce(join(key, fileName), body);
        this.diskUsed += body.length;
      }
      const now = new Date();
      await utimes(key, now, now);
    });
    return {
      photos: valid.map(({ id, name }) => ({
        id,
        name,
        url: `${ROOT}/inbound-photos/${encodeURIComponent(String(building))}/${clientMutationId}/${id}`,
      })),
    };
  }

  async readStaged(
    principal: AccessPrincipal,
    building: unknown,
    clientMutationId: unknown,
    id: string,
  ): Promise<PhotoFile> {
    const key = this.scope(principal, building, clientMutationId);
    if (!HASH.test(id)) throw new NotFoundException('物品照片不存在');
    return this.readLocal(key, id);
  }

  async assertStaged(
    principal: AccessPrincipal,
    building: WarehouseBuilding,
    mutation: string,
    ids: readonly string[],
  ): Promise<void> {
    const key = this.scope(principal, building, mutation);
    await this.runStaging(async () => {
      for (const id of ids) {
        try {
          await this.readLocal(key, id);
        } catch (error) {
          if (error instanceof NotFoundException) {
            throw new BadRequestException('入库照片不存在或不属于当前申请，请重新选择照片');
          }
          throw error;
        }
      }
      const now = new Date();
      await utimes(key, now, now);
    });
  }

  async prepare(
    principal: AccessPrincipal,
    building: WarehouseBuilding,
    mutation: string,
    ids: readonly string[],
    appToken: string,
    inboundTableId: string,
    inventoryTableId: string,
    assertOwnership?: () => Promise<void>,
  ): Promise<BitablePhoto[]> {
    const key = this.scope(principal, building, mutation);
    const schema = await Promise.all([
      this.gateway.getFieldSchemas(appToken, inboundTableId, '入库填写'),
      this.gateway.getFieldSchemas(appToken, inventoryTableId, '库存台账'),
    ]);
    if (schema.some((fields) => !fields.some((field) =>
      field.fieldName === INVENTORY_PHOTO_FIELD && field.type === 17 && field.writable))) {
      throw new ServiceUnavailableException('入库填写或库存台账的物品图片字段尚未可用');
    }
    const photos: BitablePhoto[] = [];
    for (const id of ids) {
      await assertOwnership?.();
      const file_token = await this.getOrUploadMedia(key, id, appToken);
      photos.push({ file_token });
    }
    return photos;
  }

  async download(fileToken: string, context: LedgerImageContext): Promise<PhotoFile> {
    const key = ledgerImageScope(fileToken, context);
    const active = this.mediaDownloads.get(key);
    if (active) return active;
    if (this.mediaDownloads.size >= MAX_CONCURRENT_LEDGER_IMAGES) {
      throw new ServiceUnavailableException('物品图片读取繁忙，请稍后重试');
    }
    const pending = this.downloadFromFeishu(fileToken, key);
    this.mediaDownloads.set(key, pending);
    try {
      return await pending;
    } finally {
      this.mediaDownloads.delete(key);
    }
  }

  async downloadThumbnail(fileToken: string, context: LedgerImageContext): Promise<PhotoFile> {
    const key = ledgerImageScope(fileToken, context);
    const cached = this.thumbnails.get(key);
    if (cached) {
      this.thumbnails.delete(key);
      if (cached.expiresAt > Date.now()) {
        this.thumbnails.set(key, cached);
        return cached.file;
      }
    }
    const active = this.thumbnailRequests.get(key);
    if (active) return active;
    if (this.closing || this.thumbnailRequests.size >= THUMBNAIL_QUEUE_LIMIT) {
      throw new ServiceUnavailableException('物品缩略图读取繁忙，请稍后重试');
    }
    const queuedAt = Date.now();
    const pending = this.thumbnailQueue.then(async () => {
      if (this.closing || Date.now() - queuedAt >= THUMBNAIL_QUEUE_MS) {
        throw new ServiceUnavailableException('物品缩略图读取繁忙，请稍后重试');
      }
      const file = await this.renderThumbnail(await this.download(fileToken, context));
      if (this.thumbnails.size >= THUMBNAIL_CACHE_LIMIT) {
        this.thumbnails.delete(this.thumbnails.keys().next().value!);
      }
      this.thumbnails.set(key, { file, expiresAt: Date.now() + THUMBNAIL_CACHE_MS });
      return file;
    });
    this.thumbnailQueue = pending.then(() => undefined, () => undefined);
    this.thumbnailRequests.set(key, pending);
    try {
      return await pending;
    } finally {
      this.thumbnailRequests.delete(key);
    }
  }

  private async renderThumbnail(source: PhotoFile): Promise<PhotoFile> {
    const dimensions = imageDimensions(source);
    if (!dimensions || dimensions.width * dimensions.height > THUMBNAIL_MAX_PIXELS) {
      throw new NotFoundException('物品缩略图无法生成，可尝试查看原图');
    }
    let directory: string | undefined;
    let path: string | undefined;
    clearTimeout(this.thumbnailBrowserIdle);
    try {
      directory = await mkdtemp(join(tmpdir(), 'nantong-inventory-image-'));
      path = join(directory, 'source.image');
      await writeFile(path, source.buffer, { mode: 0o600 });
      if (this.closing) throw new Error('thumbnail service is closing');
      const browser = await this.openThumbnailBrowser();
      const context = await browser.newContext({ offline: true, serviceWorkers: 'block', acceptDownloads: false });
      const timeout = setTimeout(() => void context.close().catch(() => undefined), 10_000).unref();
      try {
        const page = await context.newPage();
        await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><input type="file">');
        await page.locator('input').setInputFiles(path);
        const data = await page.evaluate(async (size) => {
          const file = document.querySelector('input')?.files?.[0];
          if (!file) throw new Error('thumbnail source is missing');
          const image = await createImageBitmap(file);
          try {
            const scale = Math.min(1, size / Math.max(image.width, image.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            const drawing = canvas.getContext('2d');
            if (!drawing) throw new Error('thumbnail canvas unavailable');
            drawing.imageSmoothingQuality = 'high';
            drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/webp', 0.8);
          } finally {
            image.close();
          }
        }, THUMBNAIL_SIZE);
        const buffer = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
        if (buffer.length > THUMBNAIL_MAX_BYTES || imageType(buffer) !== 'image/webp') {
          throw new Error('invalid thumbnail output');
        }
        return { buffer, type: 'image/webp', name: source.name };
      } finally {
        clearTimeout(timeout);
        await context.close();
      }
    } catch {
      throw new ServiceUnavailableException('物品缩略图暂时无法读取，可尝试查看原图');
    } finally {
      if (path) await rm(path, { force: true }).catch(() => undefined);
      if (directory) await rmdir(directory).catch(() => undefined);
      if (!this.closing && this.thumbnailBrowser) {
        this.thumbnailBrowserIdle = setTimeout(() => void this.closeThumbnailBrowser(), THUMBNAIL_BROWSER_IDLE_MS).unref();
      }
    }
  }

  private openThumbnailBrowser(): Promise<Browser> {
    if (this.thumbnailBrowser) return this.thumbnailBrowser;
    const executablePath = readEnv('DUTY_SCREENSHOT_BROWSER_PATH', ['SCREENSHOT_BROWSER_PATH', 'CHROME_PATH', 'EDGE_PATH']) ||
      [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ].find(existsSync);
    const launching = chromium.launch({ executablePath, chromiumSandbox: true, timeout: 8_000 });
    this.thumbnailBrowser = launching;
    const reset = () => {
      if (this.thumbnailBrowser === launching) this.thumbnailBrowser = undefined;
    };
    void launching.then((browser) => browser.on('disconnected', reset), reset);
    return launching;
  }

  private async closeThumbnailBrowser(): Promise<void> {
    const active = this.thumbnailBrowser;
    this.thumbnailBrowser = undefined;
    if (active) await active.then((browser) => browser.close()).catch(() => undefined);
  }

  private async downloadFromFeishu(fileToken: string, extra: string): Promise<PhotoFile> {
    try {
      const tenant = await getTenantAccessToken(this.httpService, undefined, { requestTimeoutMs: () => 8_000 });
      const response = await this.httpService.axiosRef.get<ArrayBuffer>(
        `${API}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
        {
          headers: { Authorization: `Bearer ${tenant}` },
          params: { extra },
          responseType: 'arraybuffer',
          maxContentLength: MAX_LEDGER_IMAGE_BYTES,
          timeout: 20_000,
          maxRedirects: 0,
        },
      );
      const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
      const type = imageType(buffer);
      if (!type || buffer.length > MAX_LEDGER_IMAGE_BYTES) throw new NotFoundException('物品图片格式不可预览');
      return { buffer, type, name: '物品图片' };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('物品图片暂时无法读取');
    }
  }

  private scope(principal: AccessPrincipal, building: unknown, mutation: unknown): string {
    if (typeof building !== 'string' || !WAREHOUSE_BUILDINGS.includes(building as WarehouseBuilding) ||
        typeof mutation !== 'string' || !MUTATION_ID.test(mutation)) {
      throw new BadRequestException('入库照片的楼栋或请求标识无效');
    }
    // Match either real inbound entry point. Submission validates its exact item and action again.
    const allowed = (['create', 'confirm'] as const).some((action) =>
      PROFESSIONAL_SPECIALTIES.some((specialty) =>
        canPerformBusinessAction(principal, { module: 'inventory', action, building, specialty })));
    if (!allowed || !(principal.accountId || principal.displayName || principal.role === 'admin')) {
      throw new ForbiddenException('无权使用该楼栋的入库照片');
    }
    return this.photoDirectory(principal, building, mutation);
  }

  private photoDirectory(principal: AccessPrincipal, building: string, mutation: string): string {
    return join(this.directory, hash(JSON.stringify([
      principal.accountId || principal.displayName,
      principal.role, principal.authorizationVersion, principal.impersonation?.actorAccountId,
      building, mutation,
    ])));
  }

  private runStaging<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.staging.then(work);
    this.staging = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const pending = await this.taskLedger?.listRecoverableInbounds();
    const protectedPaths = new Set(pending?.filter((entry) => entry.request.photoIds?.length).map((entry) =>
      this.photoDirectory(entry.principal, entry.request.building, entry.request.clientMutationId)));
    let total = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !HASH.test(entry.name)) continue;
      const path = join(this.directory, entry.name);
      if (pending && !protectedPaths.has(path) && now - (await stat(path)).mtimeMs >= STAGED_PHOTO_RETENTION_MS) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (file.isFile()) total += (await stat(join(path, file.name))).size;
      }
    }
    this.diskUsed = total;
    this.nextSweepAt = now + STAGED_PHOTO_SWEEP_INTERVAL_MS;
  }

  private async readLocal(key: string, id: string): Promise<PhotoFile> {
    if (!HASH.test(id)) throw new NotFoundException('物品照片不存在');
    let raw: Buffer;
    try {
      raw = await readFile(join(key, `${id}.image`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('物品照片不存在');
      throw new ServiceUnavailableException('暂时无法读取已上传的物品照片');
    }
    const end = raw.indexOf(10);
    const buffer = raw.subarray(end + 1);
    const type = imageType(buffer);
    if (end < 1 || end > 1024 || !type || buffer.length > INVENTORY_INBOUND_PHOTO_MAX_BYTES || hash(buffer) !== id) {
      throw new ServiceUnavailableException('已上传的物品照片暂时无法核验');
    }
    const metadata = JSON.parse(raw.toString('utf8', 0, end)) as { name?: unknown };
    return { buffer, type, name: safeName(metadata.name) };
  }

  private async getOrUploadMedia(key: string, id: string, appToken: string): Promise<string> {
    if (!HASH.test(id)) throw new BadRequestException('入库照片标识无效');
    const receipt = join(key, `${id}.${hash(appToken)}.token`);
    const active = this.mediaUploads.get(receipt);
    if (active) return active;
    const uploading = (async () => {
      try {
        const previous = await readFile(receipt, 'utf8');
        if (!MEDIA_TOKEN.test(previous)) throw new ServiceUnavailableException('入库照片上传回执无法核验');
        return previous;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const file = await this.readLocal(key, id);
      try {
        const form = new FormData();
        form.append('file_name', file.name);
        form.append('parent_type', 'bitable_image');
        form.append('parent_node', appToken);
        form.append('size', String(file.buffer.length));
        form.append('file', file.buffer, { filename: file.name, contentType: file.type });
        const tenant = await getTenantAccessToken(this.httpService);
        const response = await this.httpService.axiosRef.post(`${API}/drive/v1/medias/upload_all`, form, {
          headers: { Authorization: `Bearer ${tenant}`, ...form.getHeaders() },
          maxBodyLength: INVENTORY_INBOUND_PHOTO_MAX_BYTES + 16_384,
          timeout: 30_000,
          maxRedirects: 0,
        });
        const token = response.data?.data?.file_token;
        if (response.data?.code !== 0 || typeof token !== 'string' || !MEDIA_TOKEN.test(token)) {
          throw new Error('invalid Feishu attachment receipt');
        }
        await writeOnce(receipt, token);
        return token;
      } catch {
        throw new ServiceUnavailableException('物品照片上传飞书暂未完成，将使用原请求重试');
      }
    })();
    this.mediaUploads.set(receipt, uploading);
    try {
      return await uploading;
    } finally {
      if (this.mediaUploads.get(receipt) === uploading) this.mediaUploads.delete(receipt);
    }
  }
}

function ledgerImageScope(fileToken: string, { tableId, fieldId, recordId }: LedgerImageContext): string {
  if (!MEDIA_TOKEN.test(fileToken)) throw new NotFoundException('物品图片不存在');
  return JSON.stringify({
    bitablePerm: { tableId, attachments: { [fieldId]: { [recordId]: [fileToken] } } },
  });
}

async function writeOnce(path: string, data: Buffer | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const output = await open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(data);
      await output.sync();
    } finally {
      await output.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value: unknown): string {
  if (typeof value !== 'string') return '物品照片';
  return value.replace(/[\u0000-\u001f\u007f\\/"]/g, '').trim().slice(0, MAX_NAME_LENGTH) || '物品照片';
}

function imageType(buffer?: Buffer): string | undefined {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return undefined;
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  const first = buffer.toString('ascii', 0, 6);
  if (first === 'GIF87a' || first === 'GIF89a') return 'image/gif';
  if (first.startsWith('RIFF') && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function imageDimensions({ buffer, type }: PhotoFile): { width: number; height: number } | undefined {
  let width = 0;
  let height = 0;
  if (type === 'image/png' && buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (type === 'image/gif') {
    width = buffer.readUInt16LE(6);
    height = buffer.readUInt16LE(8);
  } else if (type === 'image/webp' && buffer.length >= 30) {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      width = buffer.readUIntLE(24, 3) + 1;
      height = buffer.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8L' && buffer[20] === 0x2f) {
      const packed = buffer.readUInt32LE(21);
      width = (packed & 0x3fff) + 1;
      height = ((packed >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && buffer.readUIntLE(23, 3) === 0x2a019d) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    }
  } else if (type === 'image/jpeg') {
    for (let offset = 2; offset + 3 < buffer.length && offset < 1024 * 1024;) {
      if (buffer[offset++] !== 0xff) break;
      while (buffer[offset] === 0xff) offset++;
      if (offset + 2 >= buffer.length) break;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        height = buffer.readUInt16BE(offset + 3);
        width = buffer.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  return width && height ? { width, height } : undefined;
}

function ledgerPhotos(value: unknown): LedgerPhoto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.file_token !== 'string' ||
        !MEDIA_TOKEN.test(item.file_token) ||
        (typeof item.type === 'string' && item.type.includes('/') && !item.type.startsWith('image/'))) return [];
    return [{ file_token: item.file_token, name: safeName(item.name), index }];
  });
}

function imageSelector(photo: LedgerPhoto): string {
  return `${photo.index}-${hash(photo.file_token).slice(0, 16)}`;
}
