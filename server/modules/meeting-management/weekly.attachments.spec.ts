import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptWeeklyImages,
  imageMime,
  syncWeeklyImages,
  cleanupWeeklyImages,
} from './weekly.attachments';
import { WeeklyStore } from './weekly.store';
import { WeeklyGateway } from './weekly.gateway';
import type {
  SaveWeeklyMeeting,
  WeeklyAttachmentCommand,
} from '../../../shared/weekly-workspace.interface';

describe('独立图片任务', () => {
  let directory: string;
  let store: WeeklyStore;
  const buffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII=',
    'base64',
  );
  const file = {
    buffer,
    originalname: '会议.png',
    size: buffer.length,
    mimetype: 'image/png',
  } as Express.Multer.File;
  const input = {
    clientMutationId: 'images-12345678',
    targetRecordId: 'recExample',
    kind: 'ali' as const,
    baseJobId: 'meeting-12345678',
  };
  const base: SaveWeeklyMeeting = {
    clientMutationId: input.baseJobId,
    expectedVersion: 0,
    expectedText: '',
    meeting: {
      targetRecordId: input.targetRecordId,
      kind: 'ali',
      plannedDate: '2026-10-09',
      actualDate: '2026-10-09',
      status: 'held',
      note: '',
      todos: [],
      rawText: '整段待办\n第二行',
    },
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'weekly-images-test-'));
    store = new WeeklyStore(join(directory, 'ledger.json'));
    store.accept('meeting', base, 'qa');
    store.change(base.clientMutationId, {}, { status: 'success' });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = () => ({
    assertAttachmentField: jest.fn().mockResolvedValue(undefined),
    uploadImage: jest.fn().mockResolvedValue('fileQA123'),
    record: jest.fn().mockResolvedValue({}),
    attachmentTokens: jest.fn().mockReturnValue([]),
    appendImages: jest.fn().mockResolvedValue(undefined),
  });
  it('先持久化文件及台账，重复提交不新增任务', () => {
    const job = acceptWeeklyImages(store, input, [file], 'qa');
    expect(acceptWeeklyImages(store, input, [file], 'qa')).toEqual(job);
    const command = store.get(job.id).command as WeeklyAttachmentCommand;
    expect(
      readFileSync(
        join(directory, 'images', job.id, `${command.files[0].sha256}.image`),
      ),
    ).toEqual(buffer);
    expect(store.list().jobs).toHaveLength(2);
    expect(() =>
      acceptWeeklyImages(
        store,
        input,
        [{ ...file, originalname: '不同.png' }],
        'qa',
      ),
    ).toThrow('不同内容');
  });
  it('同步成功并清理暂存；追加时保留旧附件', async () => {
    const job = acceptWeeklyImages(store, input, [file], 'qa');
    const g = gateway();
    g.attachmentTokens.mockReturnValue(['oldFile']);
    await syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id);
    expect(g.appendImages).toHaveBeenCalledWith(
      'recExample',
      '阿里会议附件',
      ['oldFile'],
      ['fileQA123'],
    );
    expect(store.get(job.id).job.status).toBe('success');
    expect(existsSync(join(directory, 'images', job.id))).toBe(false);
  });
  it('不限制累计附件数量，普通文件同样持久化并同步', async () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      ...file,
      originalname: `会议资料${index}.pdf`,
      mimetype: 'application/pdf',
      buffer: Buffer.from(`%PDF-1.7\n测试文件${index}`),
    }));
    const job = acceptWeeklyImages(store, input, files, 'qa');
    expect(job.attachmentNames).toHaveLength(7);
    const command = store.get(job.id).command as WeeklyAttachmentCommand;
    expect(command.files).toHaveLength(7);
    expect(
      command.files.every((item) => item.mime === 'application/octet-stream'),
    ).toBe(true);
    const g = gateway();
    await syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id);
    expect(g.uploadImage).toHaveBeenCalledTimes(7);
    expect(store.get(job.id).job.status).toBe('success');
    expect(existsSync(join(directory, 'images', job.id))).toBe(false);
  });
  it('浏览器UTF-8附件名经multipart解析后恢复中文，并保持合法文件名', () => {
    const name = '会议纪要（A楼）[本周].pdf';
    const job = acceptWeeklyImages(
      store,
      input,
      [
        {
          ...file,
          originalname: Buffer.from(name, 'utf8').toString('latin1'),
          mimetype: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7'),
        },
      ],
      'qa',
    );
    expect(job.attachmentNames).toEqual([name]);
  });
  it('普通附件追加任务串行同步保留之前已同步的附件', async () => {
    const g = gateway();
    const tokens: string[] = [];
    g.attachmentTokens.mockImplementation(() => [...tokens]);
    g.uploadImage.mockImplementation(async () => `file${tokens.length}`);
    g.appendImages.mockImplementation(async (_id, _field, _old, added) => {
      tokens.push(...added);
    });
    for (let index = 0; index < 7; index++) {
      const job = acceptWeeklyImages(
        store,
        { ...input, clientMutationId: `attachment-${index}-12345678` },
        [{ ...file, originalname: `截图${index}.png` }],
        'qa',
      );
      await syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id);
    }
    expect(tokens).toHaveLength(7);
    expect(g.appendImages.mock.calls[6][2]).toHaveLength(6);
  });
  it('回填失败重试只执行回填，不重复上传', async () => {
    const job = acceptWeeklyImages(store, input, [file], 'qa');
    const g = gateway();
    g.appendImages.mockRejectedValueOnce(new Error('回读失败'));
    await expect(
      syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id),
    ).rejects.toThrow('回读失败');
    await syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id);
    expect(g.uploadImage).toHaveBeenCalledTimes(1);
    expect(g.appendImages).toHaveBeenCalledTimes(2);
  });
  it('上传响应丢失以及重启未确认均停止重传', async () => {
    const job = acceptWeeklyImages(store, input, [file], 'qa');
    const g = gateway();
    g.uploadImage.mockRejectedValueOnce(new Error('timeout'));
    await syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id);
    expect(store.get(job.id).job.status).toBe('uncertain');
    await syncWeeklyImages(
      new WeeklyStore(store.path),
      g as unknown as WeeklyGateway,
      job.id,
    );
    expect(g.uploadImage).toHaveBeenCalledTimes(1);
  });
  it('明确拒绝可以重试该文件，文本失败不会上传', async () => {
    const job = acceptWeeklyImages(store, input, [file], 'qa');
    const g = gateway();
    g.uploadImage.mockRejectedValueOnce(
      Object.assign(new Error('拒绝'), { uploadRejected: true }),
    );
    await expect(
      syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id),
    ).rejects.toThrow('拒绝');
    expect(store.get(job.id).attachmentState?.uploading).toBeUndefined();
    store.change(base.clientMutationId, {}, { status: 'error' });
    await expect(
      syncWeeklyImages(store, g as unknown as WeeklyGateway, job.id),
    ).rejects.toThrow('文本尚未');
    expect(g.uploadImage).toHaveBeenCalledTimes(1);
  });
  it('假扩展名、超大文件、其他账号和非已召开会议拒绝', () => {
    expect(() => imageMime(Buffer.from('not-image'))).toThrow('仅支持');
    expect(() =>
      acceptWeeklyImages(
        store,
        input,
        [{ ...file, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }],
        'qa',
      ),
    ).toThrow('最多10MB');
    expect(() => acceptWeeklyImages(store, input, [file], 'other')).toThrow(
      '本人',
    );
  });
  it('成功回执先落盘、重启可重复清理遗留暂存', () => {
    const job = acceptWeeklyImages(store, input, [file], 'qa');
    store.change(job.id, {}, { status: 'success' });
    const restarted = new WeeklyStore(store.path);
    expect(restarted.completedImages()).toHaveLength(1);
    cleanupWeeklyImages(restarted, restarted.completedImages()[0]);
    expect(existsSync(join(directory, 'images', job.id))).toBe(false);
    expect(() =>
      cleanupWeeklyImages(restarted, restarted.completedImages()[0]),
    ).not.toThrow();
  });
});
