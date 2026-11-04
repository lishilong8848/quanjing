import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PurchaseComparisonCardAssetsStore } from '../../server/modules/purchase-inventory/purchase-comparison-card-assets.store';
import { preparePurchaseComparisonCardEvidence, purchaseComparisonRecordUrl } from '../../server/modules/purchase-inventory/purchase-comparison-card-media';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXeoAAAAASUVORK5CYII=', 'base64');
const source = { appId: 'cli_synthetic', appToken: 'appSynthetic', tableId: 'tblSynthetic', sourceUrl: 'https://vnet.feishu.cn/base/appSynthetic?table=tblSynthetic&view=vewSynthetic' };
const record = { recordId: 'recSynthetic', requestCode: 'CG-SYNTHETIC-001', building: 'H楼', requesterOpenId: 'ou_synthetic', procurementForm: '三方比价', status: '未开始（待审批）' } as any;
const attachment = (suffix: number) => ({ file_token: `file_synthetic_${suffix}`, name: `第${suffix}家报价.png`, type: 'image/png', size: png.length });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('采购审批比价图片准备与跨重试缓存', () => {
  let directory: string, file: string;
  let cache: PurchaseComparisonCardAssetsStore;
  let get: jest.Mock, post: jest.Mock;
  const prepare = (files: unknown[] = [attachment(1), attachment(2), attachment(3)], extra: Record<string, unknown> = {}) => preparePurchaseComparisonCardEvidence({
    source, expected: record, actual: record, rawRecord: { record_id: record.recordId, fields: { '三方比价依据（邮件/报价单）': files } },
    token: 'synthetic-tenant-token', http: { axiosRef: { get, post } } as never, cache, ...extra,
  } as never);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'purchase-comparison-assets-'));
    file = join(directory, 'assets.json'); cache = new PurchaseComparisonCardAssetsStore(file);
    get = jest.fn(async () => ({ data: png, headers: { 'content-type': 'application/octet-stream' } }));
    let uploaded = 0;
    post = jest.fn(async () => ({ data: { code: 0, data: { image_key: `img_synthetic_${++uploaded}` } } }));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('3张本申请图变成安全image_key，下载和上传都固定Feishu端点且拒绝重定向', async () => {
    const evidence = await prepare();
    expect(evidence.attachments.map(item => item.imageKey)).toEqual(['img_synthetic_1', 'img_synthetic_2', 'img_synthetic_3']);
    expect(evidence.recordUrl).toBe('https://vnet.feishu.cn/base/appSynthetic?table=tblSynthetic&record=recSynthetic');
    expect(get).toHaveBeenCalledTimes(3); expect(post).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[0][0]).toBe('https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download');
    expect(get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, timeout: 10000, responseType: 'arraybuffer', maxContentLength: 10 * 1024 * 1024 });
    expect(post.mock.calls[0][0]).toBe('https://open.feishu.cn/open-apis/im/v1/images');
    expect(post.mock.calls[0][2]).toMatchObject({ maxRedirects: 0, timeout: 10000 });
    for (const bytes of [JSON.stringify(evidence), readFileSync(file, 'utf8')]) {
      expect(bytes).not.toContain('file_synthetic_'); expect(bytes).not.toContain('synthetic-tenant-token'); expect(bytes).not.toContain('tmp_url');
    }
  });

  it('相同申请不同物品复用同一token集合的图片且保留各自原记录链接', async () => {
    const first = await prepare();
    const next = { ...record, recordId: 'recOtherItem' };
    const second = await prepare(undefined, { expected: next, actual: next, rawRecord: { record_id: next.recordId, fields: { '三方比价依据（邮件/报价单）': [attachment(1), attachment(2), attachment(3)] } } });
    expect(second.attachments).toEqual(first.attachments);
    expect(second.recordUrl).toContain('record=recOtherItem');
    expect(post).toHaveBeenCalledTimes(3); expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([{ appId: 'cli_other' }, { appToken: 'anotherApp' }, { tableId: 'tblOther' }])('不同应用来源不借用同token缓存 %#', async change => {
    await prepare();
    await prepare(undefined, { source: { ...source, ...change } });
    expect(post).toHaveBeenCalledTimes(6);
  });

  it('不同申请或不同token集合不借用缓存，不能把首条的图套到他单', async () => {
    await prepare();
    const other = { ...record, requestCode: 'CG-SYNTHETIC-OTHER' };
    await prepare(undefined, { expected: other, actual: other });
    expect(post).toHaveBeenCalledTimes(6);
    await prepare([attachment(1), attachment(2), attachment(4)]);
    expect(post).toHaveBeenCalledTimes(9);
  });

  it('部分上传失败交给outbox重试；重启后复用已经成功的一张', async () => {
    post.mockResolvedValueOnce({ data: { code: 0, data: { image_key: 'img_first' } } }).mockRejectedValueOnce(new Error('synthetic upstream failure token must not escape'));
    await expect(prepare()).rejects.toThrow('采购比价图片上传失败');
    expect(post).toHaveBeenCalledTimes(2);
    cache = new PurchaseComparisonCardAssetsStore(file);
    const result = await prepare();
    expect(result.attachments[0].imageKey).toBe('img_first');
    expect(post).toHaveBeenCalledTimes(4);
  });

  it('正常两个不同key同时准备会排队成功，相同key合并', async () => {
    const create = jest.fn(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return 'img_parallel'; });
    const result = await Promise.all([cache.getOrCreate(hash('one'), create), cache.getOrCreate(hash('two'), create), cache.getOrCreate(hash('one'), create)]);
    expect(result).toEqual(['img_parallel', 'img_parallel', 'img_parallel']); expect(create).toHaveBeenCalledTimes(2);
  });

  it('非图片和超过10MiB的合法附件保留真实名称和受保护原单入口，不下载、不上传', async () => {
    const result = await prepare([{ ...attachment(1), name: '完整报价（含税）.pdf', type: 'application/pdf' }, { ...attachment(2), size: 20 * 1024 * 1024 }]);
    expect(result.attachments).toEqual([{ name: '完整报价（含税）.pdf', disposition: 'original' }, { name: '第2家报价.png', disposition: 'original' }]);
    expect(result.recordUrl).toContain('record=recSynthetic'); expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });

  it('预览总预算12图耗尽后仍保留其它附件原件入口', async () => {
    const budget = new Set(Array.from({ length: 12 }, (_, i) => hash(String(i))));
    const result = await prepare(undefined, { previewBudget: budget });
    expect(result.attachments).toHaveLength(3); expect(result.attachments.every(item => item.disposition === 'original')).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['recordId', 'requestCode', 'building', 'requesterOpenId', 'status'])('源记录%s不一致时完全不下载', async field => {
    await expect(prepare(undefined, { actual: { ...record, [field]: 'other' } })).rejects.toThrow('不一致');
    expect(get).not.toHaveBeenCalled();
  });

  it('单一采购不会触发下载上传，文件提供的任意url不被使用', async () => {
    await expect(prepare(undefined, { expected: { ...record, procurementForm: '单一采购' } })).rejects.toThrow('不一致');
    expect(get).not.toHaveBeenCalled();
    await prepare([{ ...attachment(1), url: 'https://attacker.example.test/steal', tmp_url: 'http://127.0.0.1/private' }]);
    expect(get.mock.calls[0][0]).toMatch(/^https:\/\/open\.feishu\.cn\/open-apis\/drive\/v1\/medias\//);
  });

  it.each([{ data: Buffer.from('<html>not an image</html>'), headers: { 'content-type': 'image/png' } }, { data: png, headers: { 'content-type': 'text/html' } }])('伪装图片或矛盾MIME不能上传 %#', async response => {
    get.mockResolvedValue(response);
    await expect(prepare()).rejects.toThrow('采购比价图片内容校验失败'); expect(post).not.toHaveBeenCalled();
  });

  it('坏缓存保留原字节，不重新上传伪造成功', async () => {
    writeFileSync(file, '{broken');
    await expect(prepare()).rejects.toThrow('暂不可用');
    expect(readFileSync(file, 'utf8')).toBe('{broken'); expect(get).not.toHaveBeenCalled();
  });

  it('可信的多维表下载链接提供当前表权限参数，仍只请求固定飞书下载端点', async () => {
    const extra = { bitablePerm: { tableId: source.tableId, rev: 32 } };
    const url = `https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download?extra=${encodeURIComponent(JSON.stringify(extra))}`;
    get.mockImplementation(async (_url, options) => {
      if (options.params?.extra !== JSON.stringify(extra)) throw new Error('synthetic upstream 400: extra required');
      return { data: png, headers: { 'content-type': 'application/octet-stream' } };
    });
    await prepare([{ ...attachment(1), url }]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download');
    expect(JSON.parse(get.mock.calls[0][1].params.extra)).toEqual(extra);
  });

  it('字段和记录限定的权限参数只用于对应附件', async () => {
    const extra = { bitablePerm: { tableId: source.tableId, attachments: { fldSynthetic: { [record.recordId]: ['file_synthetic_1'] } } } };
    const url = `https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download?extra=${encodeURIComponent(JSON.stringify(extra))}`;
    await prepare([{ ...attachment(1), url }]);
    expect(JSON.parse(get.mock.calls[0][1].params.extra)).toEqual(extra);
  });

  it.each([
    'https://attacker.example.test/open-apis/drive/v1/medias/file_synthetic_1/download?extra=%7B%7D',
    'http://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download?extra=%7B%7D',
    'https://user:secret@open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download?extra=%7B%7D',
    'https://open.feishu.cn:444/open-apis/drive/v1/medias/file_synthetic_1/download?extra=%7B%7D',
    'https://open.feishu.cn/open-apis/drive/v1/medias/file_other/download?extra=%7B%7D',
  ])('不向伪造来源或其他附件地址发送请求 %s', async url => {
    try { await prepare([{ ...attachment(1), url }]); } catch { /* A rejected source is also safe. */ }
    for (const [address, options] of get.mock.calls) {
      expect(address).toBe('https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download');
      expect(options.params).toBeUndefined();
    }
  });

  it.each([
    { bitablePerm: { tableId: 'tblOther', rev: 32 } },
    { bitablePerm: { tableId: source.tableId, attachments: { fldSynthetic: { recOther: ['file_synthetic_1'] } } } },
    { bitablePerm: { tableId: source.tableId, attachments: { fldSynthetic: { [record.recordId]: ['file_other'] } } } },
  ])('不转发其他表、记录或附件的权限参数 %#', async extra => {
    const url = `https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download?extra=${encodeURIComponent(JSON.stringify(extra))}`;
    try { await prepare([{ ...attachment(1), url }]); } catch { /* A rejected parameter is also safe. */ }
    for (const [, options] of get.mock.calls) expect(options.params?.extra).not.toBe(JSON.stringify(extra));
  });

  it('重复或无法解析的 extra 不发起下载', async () => {
    const base = 'https://open.feishu.cn/open-apis/drive/v1/medias/file_synthetic_1/download?';
    const valid = encodeURIComponent(JSON.stringify({ bitablePerm: { tableId: source.tableId, rev: 32 } }));
    for (const query of [`extra=${valid}&extra=${valid}`, 'extra=not-json']) {
      await expect(prepare([{ ...attachment(1), url: base + query }])).rejects.toThrow('采购比价附件授权信息无效');
      expect(get).not.toHaveBeenCalled();
    }
  });

  it('下载失败给出可重试的阶段提示，不泄漏上游错误和授权数据', async () => {
    get.mockRejectedValue(new Error('synthetic-tenant-token https://secret.example/file'));
    let message = '';
    try { await prepare(); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('采购比价图片下载失败');
    expect(message).not.toContain('synthetic-tenant-token');
    expect(message).not.toContain('secret.example');
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.example.test/base/app', 'http://vnet.feishu.cn/base/app', 'https://vnet.feishu.cn:3001/base/app', 'https://user:secret@vnet.feishu.cn/base/app'])('原件地址不接受不可信源 %s', sourceUrl => {
    expect(() => purchaseComparisonRecordUrl({ ...source, sourceUrl }, record.recordId)).toThrow();
  });
});
