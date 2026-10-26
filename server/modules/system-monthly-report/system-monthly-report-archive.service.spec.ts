import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import type {
  SystemMonthlyReportHistoryItem,
  SystemMonthlyReportReviewOpinion,
} from '../../../shared/system-monthly-report.interface';
import {
  SystemMonthlyReportArchiveService,
  buildSystemMonthlyReportArchiveObjectKey,
  type SystemMonthlyReportArchiveCosClient,
} from './system-monthly-report-archive.service';
import type { SystemMonthlyReportFinalRecordSource } from './system-monthly-report.mapper';
import type { SystemMonthlyReportReviewOpinionSource } from './system-monthly-report.mapper';

class FakeCos implements SystemMonthlyReportArchiveCosClient {
  putCalls: Array<Record<string, unknown>> = [];
  headCalls: Array<Record<string, unknown>> = [];
  deleteCalls: Array<Record<string, unknown>> = [];
  urlCalls: Array<Record<string, unknown>> = [];

  async putObject(params: Record<string, unknown>) {
    this.putCalls.push(params);
    return { ETag: '"archive-etag"' };
  }

  async headObject(params: Record<string, unknown>) {
    this.headCalls.push(params);
    const call = this.putCalls.at(-1) || {};
    return {
      headers: {
        'content-length': String(call.ContentLength || 0),
        'x-cos-meta-sha256': call['x-cos-meta-sha256'],
      },
      ETag: '"archive-etag"',
    };
  }

  getObjectUrl(params: Record<string, unknown>) {
    this.urlCalls.push(params);
    return 'https://private-cos.example.test/signed-monthly-report';
  }

  async getObject() {
    return { Body: this.putCalls.at(-1)?.Body };
  }

  async deleteObject(params: Record<string, unknown>) {
    this.deleteCalls.push(params);
    return {};
  }
}

describe('SystemMonthlyReportArchiveService', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'monthly-report-archive-service-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('downloads once, writes a deterministic COS object and returns only a safe archive id', async () => {
    const cos = new FakeCos();
    const gateway = {
      downloadFinalAttachment: jest.fn().mockResolvedValue({
        buffer: Buffer.from('monthly-report-content'),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    };
    const service = new SystemMonthlyReportArchiveService(gateway as any, {
      cos,
      indexPath: join(directory, 'archives.json'),
      env: {
        COS_SYSTEM_MONTHLY_REPORT_BUCKET: 'monthly-report-1234567890',
        COS_SYSTEM_MONTHLY_REPORT_REGION: 'ap-shanghai',
        COS_SYSTEM_MONTHLY_REPORT_PREFIX: 'system-monthly-report/v1',
      },
    });
    const source = finalSource();

    service.discover([source]);
    await service.waitForIdle();
    service.discover([source]);
    await service.waitForIdle();

    expect(gateway.downloadFinalAttachment).toHaveBeenCalledTimes(1);
    expect(cos.putCalls).toHaveLength(1);
    expect(cos.putCalls[0]).toMatchObject({
      Bucket: 'monthly-report-1234567890',
      Region: 'ap-shanghai',
      Key: buildSystemMonthlyReportArchiveObjectKey(
        'system-monthly-report/v1',
        source,
        source.attachments[0],
      ),
    });

    const history = service.decorateHistory([pendingHistory()], [source]);
    expect(history[0]).toMatchObject({
      archiveStatus: 'archived',
      archivedAttachmentCount: 1,
      attachments: [
        {
          status: 'archived',
          retryable: false,
          message: 'COS 已归档',
        },
      ],
    });
    expect(JSON.stringify(history)).not.toMatch(/box-final-token|feishu\.cn/u);

    const download = service.getSignedDownload(
      history[0].attachments[0].id,
      300,
    );
    expect(download).toMatchObject({
      url: 'https://private-cos.example.test/signed-monthly-report',
      expiresInSeconds: 300,
      name: '南通-B-7月终版.xlsx',
    });
  });

  it('archives review screenshots through their real collection field and decorates opinion images', async () => {
    const cos = new FakeCos();
    const gateway = {
      downloadCollectionAttachment: jest.fn().mockResolvedValue({
        buffer: Buffer.from('review-image-content'),
        contentType: 'image/png',
      }),
    };
    const service = new SystemMonthlyReportArchiveService(gateway as any, {
      cos,
      indexPath: join(directory, 'archives.json'),
      env: {
        COS_SYSTEM_MONTHLY_REPORT_BUCKET: 'monthly-report-1234567890',
        COS_SYSTEM_MONTHLY_REPORT_REGION: 'ap-shanghai',
        COS_SYSTEM_MONTHLY_REPORT_PREFIX: 'system-monthly-report/v1',
      },
    });
    const source = reviewSource();

    service.discoverReviewImages([source]);
    await service.waitForIdle();

    expect(gateway.downloadCollectionAttachment).toHaveBeenCalledWith(
      'rec-review-b',
      'box-review-token',
      '初审问题截图',
    );
    expect(cos.putCalls[0]).toMatchObject({
      Key: expect.stringMatching(
        /^system-monthly-report\/v1\/reviews\/2026\/07\/南通-B\/initial\//u,
      ),
    });

    const decorated = service.decorateReviewOpinions(
      [source.opinion],
      [source],
    );
    expect(decorated[0].images).toEqual([
      expect.objectContaining({
        name: '问题截图.png',
        status: 'archived',
        retryable: false,
      }),
    ]);
    expect(JSON.stringify(decorated)).not.toContain('box-review-token');
  });

  it('returns an inline signed PDF preview without exposing the COS object key', async () => {
    const cos = new FakeCos();
    const pdf = Buffer.from('%PDF-1.7 monthly report');
    const source: SystemMonthlyReportFinalRecordSource = {
      ...finalSource(),
      attachments: [
        {
          fileToken: 'box-final-pdf',
          name: '南通-B-2026年07月体系月报-终版.pdf',
          size: pdf.length,
        },
      ],
    };
    const service = new SystemMonthlyReportArchiveService(
      {
        downloadFinalAttachment: jest.fn().mockResolvedValue({
          buffer: pdf,
          contentType: 'application/pdf',
        }),
      } as any,
      {
        cos,
        indexPath: join(directory, 'archives.json'),
        env: {
          COS_SYSTEM_MONTHLY_REPORT_BUCKET: 'monthly-report-1234567890',
          COS_SYSTEM_MONTHLY_REPORT_REGION: 'ap-shanghai',
        },
      },
    );
    service.discover([source]);
    await service.waitForIdle();
    const history = service.decorateHistory([pendingHistory()], [source]);

    const preview = await service.getPreview(history[0].attachments[0].id);

    expect(preview).toMatchObject({
      kind: 'pdf',
      name: '南通-B-2026年07月体系月报-终版.pdf',
      url: 'https://private-cos.example.test/signed-monthly-report',
    });
    expect(cos.urlCalls.at(-1)).toMatchObject({
      Query: expect.objectContaining({
        'response-content-disposition': expect.stringMatching(/^inline;/u),
        'response-content-type': 'application/pdf',
      }),
    });
    expect(JSON.stringify(preview)).not.toContain('system-monthly-report/v1');
  });

  it('returns a bounded table preview for an archived Excel final report', async () => {
    const cos = new FakeCos();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['指标', '结果'],
        ['可用率', '99.99%'],
      ]),
      '月报概览',
    );
    const excel = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    const source: SystemMonthlyReportFinalRecordSource = {
      ...finalSource(),
      attachments: [
        {
          fileToken: 'box-final-excel',
          name: '南通-B-2026年07月体系月报-终版.xlsx',
          size: excel.length,
        },
      ],
    };
    const service = new SystemMonthlyReportArchiveService(
      {
        downloadFinalAttachment: jest.fn().mockResolvedValue({
          buffer: excel,
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      } as any,
      {
        cos,
        indexPath: join(directory, 'archives.json'),
        env: {
          COS_SYSTEM_MONTHLY_REPORT_BUCKET: 'monthly-report-1234567890',
          COS_SYSTEM_MONTHLY_REPORT_REGION: 'ap-shanghai',
        },
      },
    );
    service.discover([source]);
    await service.waitForIdle();
    const history = service.decorateHistory([pendingHistory()], [source]);

    const preview = await service.getPreview(history[0].attachments[0].id);

    expect(preview).toMatchObject({
      kind: 'spreadsheet',
      sheets: [
        {
          name: '月报概览',
          rows: [
            ['指标', '结果'],
            ['可用率', '99.99%'],
          ],
        },
      ],
    });
  });

  it('deletes only the requested submission object keys', async () => {
    const cos = new FakeCos();
    const service = new SystemMonthlyReportArchiveService({} as any, {
      cos,
      indexPath: join(directory, 'archives.json'),
      env: {
        COS_SYSTEM_MONTHLY_REPORT_BUCKET: 'monthly-report-1234567890',
        COS_SYSTEM_MONTHLY_REPORT_REGION: 'ap-shanghai',
      },
    });

    await service.deleteSubmissionObjects([
      'system-monthly-report/v1/submissions/2026/08/南通-B/initial/old/report.xlsx',
    ]);

    expect(cos.deleteCalls).toEqual([
      expect.objectContaining({
        Key: 'system-monthly-report/v1/submissions/2026/08/南通-B/initial/old/report.xlsx',
      }),
    ]);
  });
});

function reviewSource(): SystemMonthlyReportReviewOpinionSource {
  const opinion: SystemMonthlyReportReviewOpinion = {
    recordId: 'rec-review-b',
    year: 2026,
    month: 7,
    room: '南通-B',
    round: 'initial',
    reviewer: { openId: 'ou-reviewer', name: '杨占山' },
    submittedAt: '2026-08-04T02:20:00.000Z',
    summary: '事件管理：问题',
    conclusion: 'has_issues',
    issues: [{ key: 'event', label: '事件管理', description: '问题' }],
    images: [],
  };
  return {
    opinion,
    sourceFieldName: '初审问题截图',
    attachments: [
      {
        fileToken: 'box-review-token',
        name: '问题截图.png',
        size: Buffer.byteLength('review-image-content'),
      },
    ],
  };
}

function finalSource(): SystemMonthlyReportFinalRecordSource {
  return {
    recordId: 'rec-final-b',
    year: 2026,
    month: 7,
    room: '南通-B',
    submittedAt: '2026-08-07T08:20:00.000Z',
    attachments: [
      {
        fileToken: 'box-final-token',
        name: '南通-B-7月终版.xlsx',
        size: Buffer.byteLength('monthly-report-content'),
      },
    ],
    initialAttachmentCount: 1,
    recheckAttachmentCount: 1,
  };
}

function pendingHistory(): SystemMonthlyReportHistoryItem {
  return {
    recordId: 'rec-final-b',
    year: 2026,
    month: 7,
    room: '南通-B',
    createdAt: '2026-08-07T08:20:00.000Z',
    finalSubmittedAt: '2026-08-07T08:20:00.000Z',
    initialAttachmentCount: 1,
    recheckAttachmentCount: 1,
    finalAttachmentCount: 1,
    archiveStatus: 'pending',
    archivedAttachmentCount: 0,
    attachments: [],
  };
}
