import type { HttpService } from '@nestjs/axios';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTenantAccessToken,
  invalidateBitableRecordCache,
} from '../../common/feishu/bitable-direct-read';
import {
  SYSTEM_MONTHLY_REPORT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES,
  SYSTEM_MONTHLY_REPORT_SINGLE_UPLOAD_MAX_BYTES,
  SystemMonthlyReportIndeterminateWriteError,
  SystemMonthlyReportGateway,
  buildSystemMonthlyReportClientToken,
  buildSystemMonthlyReportUploadParts,
  buildSystemMonthlyReportFinalAttachmentDownloadUrl,
  describeSystemMonthlyReportFeishuError,
} from './system-monthly-report.gateway';

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  getTenantAccessToken: jest.fn(),
  invalidateBitableRecordCache: jest.fn(),
}));

describe('system monthly report Feishu attachment download', () => {
  it('adds the exact Base record and attachment-field permission scope', () => {
    const url = new URL(
      buildSystemMonthlyReportFinalAttachmentDownloadUrl(
        'box-final-token',
        'rec-final-b',
        'fld-final-report',
      ),
    );

    expect(url.searchParams.get('file_tokens')).toBe('box-final-token');
    expect(JSON.parse(url.searchParams.get('extra') || '{}')).toEqual({
      bitablePerm: {
        tableId: 'tbl6d8113872958f',
        attachments: {
          'fld-final-report': {
            'rec-final-b': ['box-final-token'],
          },
        },
      },
    });
  });

  it('allows large final workbooks without leaving downloads unbounded', () => {
    expect(SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES).toBe(
      256 * 1024 * 1024,
    );
    expect(SYSTEM_MONTHLY_REPORT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS).toBe(300_000);
  });
});

describe('system monthly report Feishu attachment upload', () => {
  const mockedGetTenantAccessToken =
    getTenantAccessToken as jest.MockedFunction<typeof getTenantAccessToken>;

  beforeEach(() => {
    mockedGetTenantAccessToken.mockResolvedValue('tenant-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a safe Feishu HTTP error code and message for diagnosis', () => {
    expect(
      describeSystemMonthlyReportFeishuError({
        message: 'Request failed with status code 400',
        response: {
          status: 400,
          data: { code: 1061002, msg: 'invalid file size' },
        },
      }),
    ).toBe('HTTP 400，错误码 1061002：invalid file size');
  });

  it('keeps one-shot uploads within Feishu 20 MiB and builds exact server-sized parts', () => {
    expect(SYSTEM_MONTHLY_REPORT_SINGLE_UPLOAD_MAX_BYTES).toBe(
      20 * 1024 * 1024,
    );
    expect(buildSystemMonthlyReportUploadParts(10, 4, 3)).toEqual([
      { seq: 0, start: 0, end: 4, size: 4 },
      { seq: 1, start: 4, end: 8, size: 4 },
      { seq: 2, start: 8, end: 10, size: 2 },
    ]);
    expect(() => buildSystemMonthlyReportUploadParts(10, 4, 2)).toThrow(
      '飞书返回的分片数量与文件大小不一致',
    );
  });

  it('uses prepare, ordered parts, and finish for an attachment over 20 MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'monthly-report-upload-'));
    const filePath = join(directory, 'large.xlsx');
    const fileSize = SYSTEM_MONTHLY_REPORT_SINGLE_UPLOAD_MAX_BYTES + 1;
    await writeFile(filePath, Buffer.alloc(fileSize, 1));
    const blockSize = 4 * 1024 * 1024;
    const blockNum = Math.ceil(fileSize / blockSize);
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/upload_prepare')) {
        return {
          data: {
            code: 0,
            data: {
              upload_id: 'upload-1',
              block_size: blockSize,
              block_num: blockNum,
            },
          },
        };
      }
      if (url.endsWith('/upload_part')) return { data: { code: 0 } };
      if (url.endsWith('/upload_finish')) {
        return { data: { code: 0, data: { file_token: 'box-large' } } };
      }
      return { data: { code: 0, data: { file_token: 'box-single' } } };
    });
    const gateway = new SystemMonthlyReportGateway({
      axiosRef: { post },
    } as unknown as HttpService);

    try {
      await expect(
        gateway.uploadFile({
          key: 'large-file',
          path: filePath,
          originalName: 'large.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: fileSize,
          sha256: 'test-sha256',
        }),
      ).resolves.toBe('box-large');

      expect(post.mock.calls.map(([url]) => url)).toEqual([
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare',
        ...Array.from(
          { length: blockNum },
          () => 'https://open.feishu.cn/open-apis/drive/v1/medias/upload_part',
        ),
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('system monthly report Feishu record creation', () => {
  const mockedGetTenantAccessToken =
    getTenantAccessToken as jest.MockedFunction<typeof getTenantAccessToken>;
  const mockedInvalidateBitableRecordCache =
    invalidateBitableRecordCache as jest.MockedFunction<
      typeof invalidateBitableRecordCache
    >;

  beforeEach(() => {
    mockedGetTenantAccessToken.mockResolvedValue('tenant-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('maps a task id to one stable UUID client token', () => {
    const first = buildSystemMonthlyReportClientToken(
      'system-monthly-5953adc4fda03258435e3ce2',
    );
    const second = buildSystemMonthlyReportClientToken(
      'system-monthly-5953adc4fda03258435e3ce2',
    );

    expect(first).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(second).toBe(first);
    expect(
      buildSystemMonthlyReportClientToken('system-monthly-another-task'),
    ).not.toBe(first);
  });

  it('clears persisted table caches after creating a collection record', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: { record: { record_id: 'rec-new-report' } },
      },
    });
    const gateway = new SystemMonthlyReportGateway({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      gateway.createCollectionRecord({}, 'system-monthly-task-cache'),
    ).resolves.toBe('rec-new-report');

    expect(mockedInvalidateBitableRecordCache).toHaveBeenCalledTimes(2);
    expect(mockedInvalidateBitableRecordCache).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deletePersisted: true }),
    );
    expect(mockedInvalidateBitableRecordCache).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deletePersisted: true }),
    );
  });

  it('keeps a definite Feishu HTTP error without retrying it as uncertain', async () => {
    const post = jest.fn().mockRejectedValue({
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { code: 1254060, msg: 'invalid attachment field' },
      },
    });
    const gateway = new SystemMonthlyReportGateway({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      gateway.createCollectionRecord({}, 'system-monthly-task-1'),
    ).rejects.toThrow(
      '提交体系月报记录失败：HTTP 400，错误码 1254060：invalid attachment field',
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[2]?.params?.client_token).toBe(
      buildSystemMonthlyReportClientToken('system-monthly-task-1'),
    );
  });

  it('retries an interrupted request once before marking the write uncertain', async () => {
    const post = jest.fn().mockRejectedValue(new Error('read ECONNRESET'));
    const gateway = new SystemMonthlyReportGateway({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      gateway.createCollectionRecord({}, 'system-monthly-task-2'),
    ).rejects.toBeInstanceOf(SystemMonthlyReportIndeterminateWriteError);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
