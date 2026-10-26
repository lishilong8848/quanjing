import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttendancePeriodicSummaryStore } from './attendance-periodic-summary.store';

describe('AttendancePeriodicSummaryStore', () => {
  let directory = '';
  let ledgerPath = '';
  const run = {
    period: 'weekly' as const,
    startDate: '2026-09-01',
    endDate: '2026-09-07',
    scheduledAt: new Date('2026-09-08T02:00:00.000Z'),
  };
  const key = 'weekly:2026-09-01:2026-09-07';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'attendance-summary-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists a sent period so a restart will skip duplicate delivery', async () => {
    const store = new AttendancePeriodicSummaryStore(ledgerPath);

    await store.prepare(key, 'digest-one', run);
    await store.markSent(key, 'om_weekly');

    await expect(
      new AttendancePeriodicSummaryStore(ledgerPath).isSent(key),
    ).resolves.toBe(true);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(ledger.entries[key]).toMatchObject({
      status: 'sent',
      period: 'weekly',
      attempts: 1,
      messageId: 'om_weekly',
    });
  });

  it('retains a failed attempt and allows a later retry', async () => {
    const store = new AttendancePeriodicSummaryStore(ledgerPath);

    await store.prepare(key, 'digest-one', run);
    await store.markFailed(key, new Error('send failed'));
    await store.prepare(key, 'digest-two', run);

    await expect(store.isSent(key)).resolves.toBe(false);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(ledger.entries[key]).toMatchObject({
      status: 'pending',
      digest: 'digest-two',
      attempts: 2,
    });
  });
});
