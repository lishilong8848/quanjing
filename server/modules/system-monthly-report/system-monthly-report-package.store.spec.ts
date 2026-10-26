import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemMonthlyReportPackageStore } from './system-monthly-report-package.store';

describe('SystemMonthlyReportPackageStore', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'monthly-package-store-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns one durable task for the same mutation and month', () => {
    const path = join(directory, 'packages.json');
    const store = new SystemMonthlyReportPackageStore(path);
    const first = store.reserve({
      id: 'monthly-package-001',
      clientMutationId: 'mutation-package-001',
      principalFingerprint: 'editor:local',
      requestFingerprint: 'sha256:same',
      year: 2026,
      month: 7,
      expectedRooms: ['南通-B'],
      recipientOpenId: 'ou_ma',
    });
    const duplicate = store.reserve({
      id: 'monthly-package-001',
      clientMutationId: 'mutation-package-001',
      principalFingerprint: 'editor:local',
      requestFingerprint: 'sha256:same',
      year: 2026,
      month: 7,
      expectedRooms: ['南通-B'],
      recipientOpenId: 'ou_ma',
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(
      new SystemMonthlyReportPackageStore(path).get('monthly-package-001'),
    ).toMatchObject({
      status: 'accepted',
      year: 2026,
      month: 7,
    });
  });
});
