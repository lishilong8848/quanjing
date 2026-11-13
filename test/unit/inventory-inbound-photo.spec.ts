jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  getTenantAccessToken: jest.fn().mockResolvedValue('test-tenant-token'),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  describeInventoryLedgerImages,
  findInventoryLedgerImage,
  InventoryInboundPhotoService,
  normalizeInventoryInboundPhotoIds,
} from '../../server/modules/inventory-management/inventory-inbound-photo.service';

const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEE0AAAAASUVORK5CYII=', 'base64');
const PRINCIPAL = { accountId: 'owner-a', purchaseBuilding: 'A楼', role: 'inventory_admin' } as const;
const MUTATION = 'inventory-inbound-photo-1';
const LEDGER_SCOPE = { tableId: 'tblInventory', fieldId: 'fldPhotos', recordId: 'recInventory' };

describe('InventoryInboundPhotoService', () => {
  let directory: string;
  let originalDirectory: string | undefined;
  const axiosRef = {
    get: jest.fn(),
    post: jest.fn(),
  };
  const gateway = {
    getFieldSchemas: jest.fn(),
  };
  const service = () => new InventoryInboundPhotoService({ axiosRef } as never, gateway as never);

  beforeEach(async () => {
    jest.resetAllMocks();
    originalDirectory = process.env.INVENTORY_INBOUND_PHOTO_DIRECTORY;
    directory = await mkdtemp(join(tmpdir(), 'inventory-inbound-photos-'));
    process.env.INVENTORY_INBOUND_PHOTO_DIRECTORY = directory;
    gateway.getFieldSchemas.mockResolvedValue([{ fieldName: '物品图片', type: 17, writable: true }]);
    axiosRef.post.mockResolvedValue({ data: { code: 0, data: { file_token: 'base-photo-token' } } });
    axiosRef.get.mockResolvedValue({ data: PHOTO });
    const direct = jest.requireMock('../../server/common/feishu/bitable-direct-read');
    direct.getTenantAccessToken.mockResolvedValue('test-tenant-token');
  });

  afterEach(async () => {
    if (originalDirectory === undefined) delete process.env.INVENTORY_INBOUND_PHOTO_DIRECTORY;
    else process.env.INVENTORY_INBOUND_PHOTO_DIRECTORY = originalDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  it('persists safe opaque staged photos and rejects a different owner or building', async () => {
    const files = [{ originalname: '测试图片.png', mimetype: 'image/png', buffer: PHOTO }];
    const staged = await service().stage(PRINCIPAL, 'A楼', MUTATION, files);
    const { id, url } = staged.photos[0];
    expect(url).toBe(`/api/inventory-management/inbound-photos/A%E6%A5%BC/${MUTATION}/${id}`);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    await expect(service().readStaged(PRINCIPAL, 'A楼', MUTATION, id)).resolves.toEqual({
      name: '测试图片.png', buffer: PHOTO, type: 'image/png',
    });
    await expect(service().readStaged({ ...PRINCIPAL, accountId: 'owner-b' }, 'A楼', MUTATION, id)).rejects.toThrow('物品照片不存在');
    await expect(service().stage(PRINCIPAL, 'B楼', MUTATION, files)).rejects.toThrow('无权使用该楼栋的入库照片');
    await expect(service().stage(PRINCIPAL, 'A楼', MUTATION, [{ ...files[0], buffer: Buffer.from('<svg onload=1></svg>') }]))
      .rejects.toThrow('物品照片需为 JPEG');
    expect(normalizeInventoryInboundPhotoIds([id])).toEqual([id]);
    expect(() => normalizeInventoryInboundPhotoIds([id, id])).toThrow('入库照片标识无效');
  });

  it('reuses persisted Base upload receipts across process reconstruction', async () => {
    const staged = await service().stage(PRINCIPAL, 'A楼', MUTATION, [{ originalname: 'test.png', mimetype: 'image/png', buffer: PHOTO }]);
    const ids = [staged.photos[0].id];
    await expect(service().prepare(PRINCIPAL, 'A楼', MUTATION, ids, 'app-example', 'tblInbound', 'tblInventory'))
      .resolves.toEqual([{ file_token: 'base-photo-token' }]);
    await expect(service().prepare(PRINCIPAL, 'A楼', MUTATION, ids, 'app-example', 'tblInbound', 'tblInventory'))
      .resolves.toEqual([{ file_token: 'base-photo-token' }]);
    expect(axiosRef.post).toHaveBeenCalledTimes(1);
    const [endpoint, form] = axiosRef.post.mock.calls[0];
    expect(endpoint).toMatch(/\/drive\/v1\/medias\/upload_all$/);
    expect(form.getBuffer().toString('latin1')).toMatch(/name="parent_node"\r\n\r\napp-example/);
  });

  it('uses a scoped Feishu attachment request and never exposes a token in the item response', async () => {
    const field = [{ file_token: 'photo-file-token', name: 'test.png', type: 'image/png', url: 'https://untrusted.invalid' }];
    const images = describeInventoryLedgerImages('recInventory', field);
    expect(images).toEqual([{ name: 'test.png', url: expect.stringMatching(/^\/api\/inventory-management\/items\/recInventory\/images\/0-[a-f0-9]{16}$/) }]);
    const selector = images[0].url.split('/').at(-1)!;
    expect(findInventoryLedgerImage(field, selector)).toBe('photo-file-token');
    expect(() => findInventoryLedgerImage([{ ...field[0], file_token: 'different-token' }], selector)).toThrow('物品图片不存在');
    await expect(service().download('photo-file-token', { tableId: 'tblInventory', fieldId: 'fldPhotos', recordId: 'recInventory' }))
      .resolves.toMatchObject({ type: 'image/png', buffer: PHOTO });
    const [, config] = axiosRef.get.mock.calls[0];
    expect(config).toMatchObject({ maxRedirects: 0, responseType: 'arraybuffer' });
    expect(JSON.parse(config.params.extra)).toEqual({
      bitablePerm: { tableId: 'tblInventory', attachments: { fldPhotos: { recInventory: ['photo-file-token'] } } },
    });
  });

  it('previews a historical image over 20 MiB while rejecting files above the new bound', async () => {
    const historical = Buffer.alloc(21_229_237);
    PHOTO.copy(historical);
    axiosRef.get.mockResolvedValueOnce({ data: historical });
    const photos = service();
    expect((await photos.download('historical-image-token', LEDGER_SCOPE)).buffer.length).toBe(historical.length);
    expect(axiosRef.get.mock.calls[0][1].maxContentLength).toBe(64 * 1024 * 1024);
    const oversized = Buffer.alloc(64 * 1024 * 1024 + 1);
    PHOTO.copy(oversized);
    axiosRef.get.mockResolvedValueOnce({ data: oversized });
    await expect(photos.download('historical-image-token', LEDGER_SCOPE)).rejects.toThrow('格式不可预览');
  });

  it('rejects oversized decode dimensions before opening a thumbnail renderer', async () => {
    const source = Buffer.from(PHOTO);
    source.writeUInt32BE(20_000, 16);
    source.writeUInt32BE(20_000, 20);
    axiosRef.get.mockResolvedValue({ data: source });
    const photos = service();
    await expect(photos.downloadThumbnail('large-photo-token', LEDGER_SCOPE)).rejects.toThrow('缩略图无法生成');
    await expect(photos.download('large-photo-token', LEDGER_SCOPE)).resolves.toMatchObject({ buffer: source });
  });

  const browserPath = process.env.NANTONG_TEST_LEDGER_THUMBNAIL_BROWSER;
  (browserPath ? it : it.skip)('serves real 160 px thumbnails and only reuses them within the same record scope', async () => {
    const previousBrowserPath = process.env.DUTY_SCREENSHOT_BROWSER_PATH;
    process.env.DUTY_SCREENSHOT_BROWSER_PATH = browserPath;
    const photos = service();
    const browser = await chromium.launch({ executablePath: browserPath, chromiumSandbox: true });
    try {
      const page = await browser.newPage({ offline: true });
      const source = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 320;
        const drawing = canvas.getContext('2d')!;
        drawing.fillStyle = '#306d88';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = '#77bc65';
        drawing.fillRect(320, 0, 320, 320);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      // The local file path must also work above Playwright's remote file-transfer limit.
      const historicalSource = Buffer.alloc(51 * 1024 * 1024);
      historicalSource.write(source, 'base64');
      axiosRef.get.mockResolvedValueOnce({ data: historicalSource });
      axiosRef.get.mockResolvedValue({ data: Buffer.from(source, 'base64') });
      const [first, concurrent] = await Promise.all([
        photos.downloadThumbnail('preview-photo-token', LEDGER_SCOPE),
        photos.downloadThumbnail('preview-photo-token', LEDGER_SCOPE),
      ]);
      expect(first).toBe(concurrent);
      expect(first.type).toBe('image/webp');
      expect(first.buffer.length).toBeLessThan(1024);
      const size = await page.evaluate(async (data) => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (value) => value.charCodeAt(0))]));
        return [image.width, image.height];
      }, first.buffer.toString('base64'));
      expect(size).toEqual([160, 80]);
      expect(await photos.downloadThumbnail('preview-photo-token', LEDGER_SCOPE)).toBe(first);
      expect(axiosRef.get).toHaveBeenCalledTimes(1);
      await photos.downloadThumbnail('preview-photo-token', { ...LEDGER_SCOPE, recordId: 'another-record' });
      expect(axiosRef.get).toHaveBeenCalledTimes(2);
    } finally {
      await photos.onModuleDestroy();
      await browser.close();
      if (previousBrowserPath === undefined) delete process.env.DUTY_SCREENSHOT_BROWSER_PATH;
      else process.env.DUTY_SCREENSHOT_BROWSER_PATH = previousBrowserPath;
    }
  }, 25_000);
});
