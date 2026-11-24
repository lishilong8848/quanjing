import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { FilePublicationDeliveryRejected, type FilePublicationGateway, type PreparedFilePublication } from '../../server/modules/file-publication/file-publication.gateway';
import { FilePublicationService } from '../../server/modules/file-publication/file-publication.service';
import { FilePublicationStore } from '../../server/modules/file-publication/file-publication.store';

const groups = [{ id: 'oc_a', name: '一号群' }, { id: 'oc_b', name: '二号群' }];
const url = 'https://example.feishu.cn/base/FilePublication?table=tblPublication';
const publisher: AccessPrincipal = { role: 'editor', accountId: 'publisher', purchaseBuilding: null, displayName: '发布人' };
const viewer: AccessPrincipal = { ...publisher, accountId: 'viewer' };
const manager: AccessPrincipal = { ...publisher, role: 'admin', accountId: 'reviewer', displayName: '审核人' };

function prepareGateway(batchField?: string) {
  const rows = new Map<string, string>();
  const records = {
    tableName: '文件台账', sourceUrl: url, title: '巡检规程', code: 'GL-2026-038', appToken: 'FilePublication',
    tableId: 'tblPublication', batchField, fields: { 文件附件: [{ file_token: 'file_a' }, { file_token: 'file_b' }] },
  };
  const createRecord = async (_body: PreparedFilePublication, id: string) => {
    if (!rows.has(id)) rows.set(id, 'rec_' + id);
    return rows.get(id)!;
  };
  const gateway = {
    groups: () => groups,
    parse: jest.fn().mockResolvedValue({
      ...records, fields: [{ key: 'fldTitle', name: '资料名称', value: '巡检规程' }],
    }),
    prepareBatch: jest.fn().mockResolvedValue(records),
    commitBatch: jest.fn(createRecord),
    findCommittedBatch: jest.fn(async (_body: PreparedFilePublication, id: string) => rows.get(id) ?? null),
    notifyRecipient: jest.fn(async (_batch, group) => 'om_' + group.id),
  };
  return { gateway, records, rows, createRecord };
}

describe('file publication durable workflow', () => {
  let testDirectory: string;
  let previousStateDirectory: string | undefined;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'nantong-publication-test-'));
    previousStateDirectory = process.env.FILE_PUBLICATION_STATE_DIR;
    process.env.FILE_PUBLICATION_STATE_DIR = join(testDirectory, 'state');
  });

  afterEach(async () => {
    if (previousStateDirectory === undefined) delete process.env.FILE_PUBLICATION_STATE_DIR;
    else process.env.FILE_PUBLICATION_STATE_DIR = previousStateDirectory;
    if (dirname(resolve(testDirectory)) === resolve(tmpdir())) await rm(testDirectory, { force: true, recursive: true });
  });

  const input = (groupIds = groups.map(group => group.id)) => ({ requestId: randomUUID(), link: url, metadata: {}, groupIds });

  async function upload(name: string, text: string) {
    const id = randomUUID();
    const path = join(testDirectory, id);
    await writeFile(path, text);
    return { id, path, name, size: Buffer.byteLength(text) };
  }

  const service = (gateway: ReturnType<typeof prepareGateway>['gateway']) =>
    new FilePublicationService(new FilePublicationStore(), gateway as unknown as FilePublicationGateway);

  it('replays the same prepared row after receipt loss, then sends one aggregate card per group', async () => {
    const { gateway, rows, createRecord } = prepareGateway();
    gateway.commitBatch.mockImplementationOnce(async (body, id) => {
      await createRecord(body, id);
      throw new Error('Lost Bitable receipt');
    });
    gateway.notifyRecipient
      .mockResolvedValueOnce('om_a')
      .mockRejectedValueOnce(new Error('Lost group B receipt'));
    const files = [await upload('巡视说明.pdf', 'first'), await upload('记录.xlsx', 'second')];
    const request = input();
    const original = service(gateway);
    const batch = await original.submit(publisher, request, files);
    await expect(original.submit(publisher, { ...request, groupIds: [] }, files)).rejects.toThrow('该申请已受理');
    await expect(original.review(manager, batch.id, { decision: 'approve' })).rejects.toThrow('当前不可审核');
    expect(await original.list(viewer)).toEqual({ batches: [] });
    const now = Date.now();
    await original.processPending(now);
    expect(rows.size).toBe(1);
    expect(gateway.notifyRecipient).not.toHaveBeenCalled();
    const restarted = service(gateway);
    await restarted.processPending(now + 16_000);
    expect(gateway.prepareBatch).toHaveBeenCalledTimes(1);
    expect(gateway.commitBatch.mock.calls).toHaveLength(2);
    expect(gateway.commitBatch.mock.calls[0]).toEqual(gateway.commitBatch.mock.calls[1]);
    expect(rows.size).toBe(1);
    await expect(restarted.review(viewer, batch.id, { decision: 'approve' })).rejects.toThrow('无权办理');
    await restarted.review(manager, batch.id, { decision: 'approve' });
    await restarted.processPending(now + 17_000);
    await restarted.review(manager, batch.id, { decision: 'approve' });
    await restarted.processPending(now + 35_000);
    expect(gateway.notifyRecipient.mock.calls.map(([, group]) => group.id)).toEqual(['oc_a', 'oc_b', 'oc_b']);
    expect(gateway.notifyRecipient.mock.calls[0][0]).toMatchObject({ id: batch.id, files: batch.files });
    expect(await restarted.list(viewer)).toMatchObject({ batches: [{ id: batch.id, status: 'published' }] });
    const download = await restarted.download(viewer, batch.id, batch.files[0].id);
    const parts: Buffer[] = [];
    for await (const part of download.stream) parts.push(part);
    expect(Buffer.concat(parts).toString()).toBe('first');
  });

  it('isolates original submission lookups and filters the whole history before paging', async () => {
    const { gateway } = prepareGateway();
    const app = service(gateway);
    const files = [await upload('部署手册.pdf', 'test')];
    const request = input([]);
    expect(await app.submission(publisher, request.requestId)).toEqual({ batch: null });
    const first = await app.submit(publisher, request, files);
    expect(await app.submission(publisher, request.requestId)).toMatchObject({ batch: { id: first.id } });
    expect(await app.submission(viewer, request.requestId)).toEqual({ batch: null });
    await expect(app.detail(viewer, first.id)).rejects.toThrow('记录不存在');
    await app.submit(publisher, input([]), [await upload('巡检附件.pdf', 'second')]);
    const page = await app.list(publisher, { page: '1', pageSize: '1', q: '部署手册' });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 1, batches: [{ id: first.id }] });
    expect(await app.list(viewer, { page: '1' })).toMatchObject({ total: 0, batches: [] });
    await expect(app.list(publisher, { from: '2026-02-30' })).rejects.toThrow('日期无效');
    await expect(app.list(publisher, { status: 'published', pageSize: '101' })).rejects.toThrow('分页参数');
  });

  it('retries only explicit failures and never turns an earlier lost receipt into a retryable failure', async () => {
    const { gateway } = prepareGateway();
    gateway.notifyRecipient.mockRejectedValueOnce(new FilePublicationDeliveryRejected('机器人未加入目标群'))
      .mockRejectedValueOnce(new Error('lost receipt'));
    const initial = service(gateway);
    const batch = await initial.submit(publisher, input(), [await upload('规程.pdf', 'test')]);
    const now = Date.now();
    await initial.processPending(now);
    await initial.review(manager, batch.id, { decision: 'approve' });
    await initial.processPending(now);
    expect(await initial.detail(manager, batch.id)).toMatchObject({ batch: { deliveries: [
      { recipientId: 'oc_a', status: 'failed', canRetry: true }, { recipientId: 'oc_b', status: 'sending', canRetry: false },
    ] } });
    const requestId = randomUUID();
    await expect(initial.retryDeliveries(viewer, batch.id, { requestId, recipientIds: ['oc_a'] })).rejects.toThrow('无权');
    await expect(initial.retryDeliveries(manager, batch.id, { requestId, recipientIds: ['oc_b'] })).rejects.toThrow('只有已确认发送失败');
    const restarted = service(gateway);
    const late = now + 56 * 60_000;
    await restarted.processPending(late);
    expect(await restarted.detail(manager, batch.id)).toMatchObject({ batch: { deliveries: [
      { recipientId: 'oc_a', status: 'failed', canRetry: true }, { recipientId: 'oc_b', status: 'uncertain', canRetry: false },
    ] } });
    await restarted.retryDeliveries(manager, batch.id, { requestId, recipientIds: ['oc_a'] });
    await restarted.retryDeliveries(manager, batch.id, { requestId, recipientIds: ['oc_a'] });
    await restarted.processPending(late + 1_000);
    expect(gateway.notifyRecipient.mock.calls.map(([, group]) => group.id)).toEqual(['oc_a', 'oc_b', 'oc_a']);
    expect(await restarted.detail(manager, batch.id)).toMatchObject({ batch: {
      status: 'published', deliveries: [
        { recipientId: 'oc_a', status: 'sent', canRetry: false }, { recipientId: 'oc_b', status: 'uncertain', canRetry: false },
      ],
    } });
    await expect(restarted.retryDeliveries(manager, batch.id, { requestId: randomUUID(), recipientIds: ['oc_a'] }))
      .rejects.toThrow('只有已确认发送失败');
  });

  it('checks for an existing cloud row before replay, even after a long restart', async () => {
    const { gateway, rows, createRecord } = prepareGateway('发布批次ID');
    gateway.commitBatch.mockImplementationOnce(async (body, id) => {
      await createRecord(body, id);
      throw new Error('Lost Bitable receipt');
    });
    const first = service(gateway);
    const batch = await first.submit(publisher, input([]), [await upload('规程.docx', 'content')]);
    const now = Date.now();
    await first.processPending(now);
    const restarted = service(gateway);
    await restarted.processPending(now + 86_400_000);
    expect(gateway.commitBatch).toHaveBeenCalledTimes(1);
    expect(gateway.findCommittedBatch).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
    expect(await restarted.review(manager, batch.id, { decision: 'approve' })).toMatchObject({ status: 'published' });
    await restarted.processPending(now + 86_410_000);
    expect(gateway.notifyRecipient).not.toHaveBeenCalled();
  });

  it('holds a cloud write with no receipt after automatic retry expires', async () => {
    const { gateway } = prepareGateway();
    gateway.commitBatch.mockRejectedValueOnce(new Error('Unknown Bitable result'));
    const first = service(gateway);
    const batch = await first.submit(publisher, input(), [await upload('手册.pdf', 'content')]);
    const now = Date.now();
    await first.processPending(now);
    const restarted = service(gateway);
    await restarted.processPending(now + 6 * 60_000);
    expect(gateway.commitBatch).toHaveBeenCalledTimes(1);
    expect(await restarted.list(publisher)).toMatchObject({
      batches: [{ id: batch.id, status: 'failed', error: '多维表写入结果待核对，请联系管理员检查原批次' }],
    });
    await expect(restarted.review(manager, batch.id, { decision: 'approve' })).rejects.toThrow('当前不可审核');
    expect(gateway.notifyRecipient).not.toHaveBeenCalled();
  });

  it('does not resend an uncertain message beyond Feishu deduplication and records the warning', async () => {
    const { gateway } = prepareGateway();
    const original = service(gateway);
    const batch = await original.submit(publisher, input(['oc_a']), [await upload('巡视.pdf', 'audit')]);
    const now = Date.now();
    await original.processPending(now);
    await original.review(manager, batch.id, { decision: 'approve' });
    gateway.notifyRecipient.mockRejectedValueOnce(new Error('Lost message receipt'));
    await original.processPending(now + 10_000);
    const restarted = service(gateway);
    await restarted.processPending(now + 61 * 60_000);
    expect(gateway.notifyRecipient).toHaveBeenCalledTimes(1);
    expect(await restarted.list(viewer)).toMatchObject({
      batches: [{ id: batch.id, status: 'published', error: '有通知投递结果待核对，请联系管理员' }],
    });
  });

  it('keeps rejected records and unpublished files private and sends no group messages', async () => {
    const { gateway } = prepareGateway();
    const publication = service(gateway);
    const batch = await publication.submit(publisher, input(), [await upload('草拟.doc', 'draft')]);
    await publication.processPending();
    expect(await publication.review(manager, batch.id, { decision: 'reject', reason: '请补齐文件' }))
      .toMatchObject({ status: 'rejected', reason: '请补齐文件' });
    await publication.processPending();
    expect(await publication.list(viewer)).toEqual({ batches: [] });
    await expect(publication.download(viewer, batch.id, batch.files[0].id)).rejects.toThrow('无权下载');
    expect(gateway.notifyRecipient).not.toHaveBeenCalled();
  });
});
