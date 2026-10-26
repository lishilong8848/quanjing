import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { SystemMonthlyReportPackageService } from './system-monthly-report-package.service';

describe('SystemMonthlyReportPackageService', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'monthly-package-service-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('packages the selected month COS finals once and notifies 示例人员020 with the signed link', async () => {
    let uploaded = Buffer.alloc(0);
    const archive = {
      listArchivedFinals: jest.fn().mockReturnValue([
        { archiveId: 'arc-b', room: '南通-B', name: '南通-B-终版.xlsx' },
        { archiveId: 'arc-c', room: '南通-C', name: '南通-C-终版.xlsx' },
        { archiveId: 'arc-z', room: '南通-Z', name: '南通-Z-终版.xlsx' },
      ]),
      readArchivedFile: jest.fn(async (id: string) =>
        Buffer.from(`content-${id}`),
      ),
      uploadPackage: jest.fn(
        async (_id: string, _name: string, value: Buffer) => {
          uploaded = value;
          return { objectKey: 'packages/2026-07.zip' };
        },
      ),
      getPackageDownload: jest.fn().mockReturnValue({
        url: 'https://cos.test/package',
        expiresInSeconds: 3600,
      }),
    };
    const notifier = {
      sendPackageLink: jest.fn().mockResolvedValue('om_message'),
    };
    const service = new SystemMonthlyReportPackageService(
      archive as any,
      notifier as any,
      {
        indexPath: join(directory, 'packages.json'),
      },
    );
    const accepted = service.accept(
      { clientMutationId: 'mutation-package-001', year: 2026, month: 7 },
      ['南通-B', '南通-C'],
      { openId: 'ou_ma', name: '示例人员020' },
      'editor:local',
    );
    expect(accepted.status).toBe('accepted');
    await service.waitForIdle();

    const task = service.getTask(accepted.id);
    expect(task).toMatchObject({
      status: 'success',
      missingRooms: [],
      notified: true,
    });
    const entries = unzipSync(uploaded);
    expect(Object.keys(entries).sort()).toEqual([
      '南通-B-终版.xlsx',
      '南通-C-终版.xlsx',
    ]);
    expect(strFromU8(entries['南通-B-终版.xlsx'])).toBe('content-arc-b');
    expect(notifier.sendPackageLink).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientOpenId: 'ou_ma',
        url: 'https://cos.test/package',
        year: 2026,
        month: 7,
      }),
    );
  });

  it('keeps a usable partial package and reports missing rooms', async () => {
    const archive = {
      listArchivedFinals: jest
        .fn()
        .mockReturnValue([
          { archiveId: 'arc-b', room: '南通-B', name: '南通-B-终版.xlsx' },
        ]),
      readArchivedFile: jest.fn().mockResolvedValue(Buffer.from('b')),
      uploadPackage: jest
        .fn()
        .mockResolvedValue({ objectKey: 'packages/partial.zip' }),
      getPackageDownload: jest.fn().mockReturnValue({
        url: 'https://cos.test/partial',
        expiresInSeconds: 3600,
      }),
    };
    const notifier = {
      sendPackageLink: jest.fn().mockResolvedValue('om_message'),
    };
    const service = new SystemMonthlyReportPackageService(
      archive as any,
      notifier as any,
      {
        indexPath: join(directory, 'packages.json'),
      },
    );
    const accepted = service.accept(
      { clientMutationId: 'mutation-package-002', year: 2026, month: 7 },
      ['南通-B', '南通-C'],
      { openId: 'ou_ma', name: '示例人员020' },
      'editor:local',
    );
    await service.waitForIdle();
    expect(service.getTask(accepted.id)).toMatchObject({
      status: 'partial',
      missingRooms: ['南通-C'],
      notified: true,
    });
  });

  it('retries only the failed notification after the selected-month ZIP is ready', async () => {
    const archive = {
      listArchivedFinals: jest
        .fn()
        .mockReturnValue([
          { archiveId: 'arc-b', room: '南通-B', name: '南通-B-终版.xlsx' },
        ]),
      readArchivedFile: jest.fn().mockResolvedValue(Buffer.from('b')),
      uploadPackage: jest
        .fn()
        .mockResolvedValue({ objectKey: 'packages/retry.zip' }),
      getPackageDownload: jest.fn().mockReturnValue({
        url: 'https://cos.test/retry',
        expiresInSeconds: 3600,
      }),
    };
    const notifier = {
      sendPackageLink: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary IM failure'))
        .mockResolvedValueOnce('om_retried'),
    };
    const service = new SystemMonthlyReportPackageService(
      archive as any,
      notifier as any,
      {
        indexPath: join(directory, 'packages.json'),
      },
    );
    const accepted = service.accept(
      { clientMutationId: 'mutation-package-003', year: 2026, month: 7 },
      ['南通-B'],
      { openId: 'ou_ma', name: '示例人员020' },
      'editor:local',
    );
    await service.waitForIdle();
    expect(service.getTask(accepted.id)).toMatchObject({
      status: 'error',
      packageReady: true,
      notified: false,
    });

    service.retry(accepted.id);
    await service.waitForIdle();

    expect(service.getTask(accepted.id)).toMatchObject({
      status: 'success',
      packageReady: true,
      notified: true,
    });
    expect(archive.readArchivedFile).toHaveBeenCalledTimes(1);
    expect(archive.uploadPackage).toHaveBeenCalledTimes(1);
    expect(notifier.sendPackageLink).toHaveBeenCalledTimes(2);
  });
});
