import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SystemMonthlyReportArchiveStore,
  buildSystemMonthlyReportArchiveId,
} from './system-monthly-report-archive.store';

describe('SystemMonthlyReportArchiveStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'monthly-report-archive-'));
    filePath = join(directory, 'archives.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses a stable source identity and persists progress across restart', () => {
    const id = buildSystemMonthlyReportArchiveId('rec-final-b', 'box-final-b');
    const store = new SystemMonthlyReportArchiveStore(filePath);
    const first = store.reserve({
      id,
      sourceRecordId: 'rec-final-b',
      sourceFileToken: 'box-final-b',
      year: 2026,
      month: 7,
      room: '南通-B',
      name: '南通-B-7月终版.xlsx',
      size: 18_201,
      objectKey: 'system-monthly-report/v1/2026/07/nantong-b/hash/report.xlsx',
    });
    const duplicate = store.reserve({
      id,
      sourceRecordId: 'rec-final-b',
      sourceFileToken: 'box-final-b',
      year: 2026,
      month: 7,
      room: '南通-B',
      name: '南通-B-7月终版.xlsx',
      size: 18_201,
      objectKey: 'system-monthly-report/v1/2026/07/nantong-b/hash/report.xlsx',
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    store.update(id, {
      status: 'syncing',
      step: 'verify',
      attempts: 1,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sha256: 'a'.repeat(64),
    });

    const restarted = new SystemMonthlyReportArchiveStore(filePath);
    expect(restarted.get(id)).toMatchObject({
      status: 'syncing',
      step: 'verify',
      attempts: 1,
      sourceFileToken: 'box-final-b',
    });
    expect(restarted.listRecoverable()).toHaveLength(1);
  });

  it('clears the previous error after a retry completes', () => {
    const id = buildSystemMonthlyReportArchiveId('rec-final-c', 'box-final-c');
    const store = new SystemMonthlyReportArchiveStore(filePath);
    store.reserve({
      id,
      sourceRecordId: 'rec-final-c',
      sourceFileToken: 'box-final-c',
      year: 2026,
      month: 7,
      room: '南通-C',
      name: '南通-C-7月终版.xlsx',
      size: 120_000_000,
      objectKey: 'system-monthly-report/v1/2026/07/nantong-c/hash/report.xlsx',
    });
    store.update(id, {
      status: 'error',
      lastError: 'temporary download failure',
    });
    store.update(id, {
      status: 'archived',
      step: 'complete',
      lastError: undefined,
    });

    expect(store.get(id)).not.toHaveProperty('lastError');
    expect(
      new SystemMonthlyReportArchiveStore(filePath).get(id),
    ).not.toHaveProperty('lastError');
  });
});
