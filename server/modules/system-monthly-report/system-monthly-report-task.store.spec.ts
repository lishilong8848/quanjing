import { ConflictException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SystemMonthlyReportTaskStore,
  type SystemMonthlyReportTaskLedgerEntry,
} from './system-monthly-report-task.store';

describe('SystemMonthlyReportTaskStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'monthly-report-ledger-'));
    filePath = join(directory, 'tasks.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns the same durable task for an identical client mutation', () => {
    const store = new SystemMonthlyReportTaskStore(filePath);
    const first = store.reserve(entry());
    const duplicate = store.reserve(entry());

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(first.entry.task.id);

    const restarted = new SystemMonthlyReportTaskStore(filePath);
    expect(restarted.findTask('task-monthly-001')).toMatchObject({
      id: 'task-monthly-001',
      status: 'accepted',
    });
  });

  it('rejects mutation-id reuse with a different request fingerprint', () => {
    const store = new SystemMonthlyReportTaskStore(filePath);
    store.reserve(entry());

    expect(() =>
      store.reserve(entry({ requestFingerprint: 'different-payload' })),
    ).toThrow(ConflictException);
  });

  it('persists status transitions and exposes interrupted tasks for recovery', () => {
    const store = new SystemMonthlyReportTaskStore(filePath);
    store.reserve(entry());
    store.updateTask('task-monthly-001', {
      status: 'syncing',
      message: '正在同步飞书多维表',
      failedStep: 'upload',
    });

    const restarted = new SystemMonthlyReportTaskStore(filePath);
    expect(restarted.findTask('task-monthly-001')).toMatchObject({
      status: 'syncing',
      failedStep: 'upload',
    });
    expect(restarted.listRecoverable()).toHaveLength(1);

    restarted.updateTask('task-monthly-001', {
      status: 'success',
      message: '已同步',
      completedAt: '2026-08-20T05:00:00.000Z',
    });
    expect(restarted.listRecoverable()).toEqual([]);
  });

  it('persists Feishu and COS branches independently for precise retry', () => {
    const store = new SystemMonthlyReportTaskStore(filePath);
    store.reserve(entry());
    store.updateSyncBranch('task-monthly-001', 'cos', {
      status: 'success',
      message: 'COS 已同步',
      completedAt: '2026-08-20T04:30:00.000Z',
    });
    store.updateSyncBranch('task-monthly-001', 'feishu', {
      status: 'error',
      message: '飞书写入失败',
    });
    store.updateCosObjects('task-monthly-001', {
      report: {
        objectKey: 'system-monthly-report/v1/submissions/task/report.xlsx',
        size: 128,
        sha256: 'a'.repeat(64),
      },
    });

    const restarted = new SystemMonthlyReportTaskStore(filePath).getEntry(
      'task-monthly-001',
    );
    expect(restarted.task.sync).toMatchObject({
      cos: { status: 'success' },
      feishu: { status: 'error' },
    });
    expect(restarted.cosObjects.report.objectKey).toContain('/submissions/');
  });

  it('lists only matching submission objects', () => {
    const store = new SystemMonthlyReportTaskStore(filePath);
    store.reserve(entry());
    store.updateCosObjects('task-monthly-001', {
      report: {
        objectKey: 'system-monthly-report/v1/submissions/old.xlsx',
        size: 128,
        sha256: 'a'.repeat(64),
      },
    });
    const otherStage = entry();
    otherStage.task.id = 'task-monthly-002';
    otherStage.task.clientMutationId = 'mutation-monthly-002';
    if (otherStage.payload.kind === 'submission') {
      otherStage.payload.request.clientMutationId = 'mutation-monthly-002';
      otherStage.payload.request.stage = 'recheck';
    }
    store.reserve(otherStage);
    store.updateCosObjects('task-monthly-002', {
      report: {
        objectKey: 'system-monthly-report/v1/submissions/other.xlsx',
        size: 128,
        sha256: 'b'.repeat(64),
      },
    });

    expect(
      store.listSubmissionObjectKeys({
        room: '南通-B',
        reportYear: 2026,
        reportMonth: 7,
        stage: 'initial',
      }),
    ).toEqual(['system-monthly-report/v1/submissions/old.xlsx']);
  });
});

function entry(
  overrides: Partial<SystemMonthlyReportTaskLedgerEntry> = {},
): SystemMonthlyReportTaskLedgerEntry {
  return {
    principalFingerprint: 'editor:local',
    requestFingerprint: 'sha256:request-001',
    task: {
      id: 'task-monthly-001',
      clientMutationId: 'mutation-monthly-001',
      action: 'submit_stage',
      targetRecordId: 'rec-current-b',
      status: 'accepted',
      message: '已受理，正在后台同步',
      createdAt: '2026-08-20T04:00:00.000Z',
      updatedAt: '2026-08-20T04:00:00.000Z',
    },
    payload: {
      kind: 'submission',
      request: {
        clientMutationId: 'mutation-monthly-001',
        currentRecordId: 'rec-current-b',
        room: '南通-B',
        stage: 'initial',
        reportYear: 2026,
        reportMonth: 7,
        versionedFileName: '南通-B-2026年07月体系月报-初版.xlsx',
      },
    },
    files: [
      {
        key: 'report',
        path: join(tmpdir(), 'monthly-report-test.xlsx'),
        originalName: '南通-B-7月初版.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 128,
        sha256: 'sha256:file-001',
      },
    ],
    uploadedTokens: {},
    ...overrides,
  };
}
