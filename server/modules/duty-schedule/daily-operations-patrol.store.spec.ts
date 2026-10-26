import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DailyOperationsPatrolStore } from './daily-operations-patrol.store';

describe('DailyOperationsPatrolStore', () => {
  let directory = '';
  let ledgerPath = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'daily-operations-patrol-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists a sent business date and prevents duplicate delivery', async () => {
    const store = new DailyOperationsPatrolStore(ledgerPath);

    await store.prepare('2026-09-07', 'digest-1');
    await store.markSent('2026-09-07', 'om_message_1');

    await expect(store.isSent('2026-09-07')).resolves.toBe(true);
    await expect(store.getDelivery('2026-09-07')).resolves.toMatchObject({
      status: 'sent',
      messageId: 'om_message_1',
    });
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(ledger.entries['2026-09-07']).toMatchObject({
      status: 'sent',
      digest: 'digest-1',
      messageId: 'om_message_1',
      attempts: 1,
    });
  });

  it('retains a failed attempt so the same date can be retried', async () => {
    const store = new DailyOperationsPatrolStore(ledgerPath);

    await store.prepare('2026-09-07', 'digest-1');
    await store.markFailed('2026-09-07', new Error('send failed'));
    await store.prepare('2026-09-07', 'digest-2');

    await expect(store.isSent('2026-09-07')).resolves.toBe(false);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(ledger.entries['2026-09-07']).toMatchObject({
      status: 'pending',
      digest: 'digest-2',
      attempts: 2,
    });
  });

  it('persists a versioned complete-card delivery separately from the legacy date slot', async () => {
    const store = new DailyOperationsPatrolStore(ledgerPath);

    await store.prepare('2026-09-11', 'legacy-digest');
    await store.markSent('2026-09-11', 'om_legacy_degraded');
    await store.prepare('2026-09-11', 'complete-digest', 'unified-full-v4');
    await store.markSent('2026-09-11', 'om_complete_card', 'unified-full-v4');

    await expect(store.getDelivery('2026-09-11')).resolves.toMatchObject({
      messageId: 'om_legacy_degraded',
    });
    await expect(
      store.getDelivery('2026-09-11', 'unified-full-v4'),
    ).resolves.toMatchObject({ messageId: 'om_complete_card' });
    const restarted = new DailyOperationsPatrolStore(ledgerPath);
    await expect(
      restarted.getDelivery('2026-09-11', 'unified-full-v4'),
    ).resolves.toMatchObject({ status: 'sent', messageId: 'om_complete_card' });
  });
});
