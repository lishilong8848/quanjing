jest.mock('@server/common/config/external-services.config', () => ({
  getFeishuAuthPayload: jest.fn(() => ({
    app_id: 'test-app',
    app_secret: 'test-secret',
  })),
  readEnv: jest.fn(() => ''),
}));

import { DutyDailyReportBitableService } from '../../server/modules/duty-schedule/duty-daily-report-bitable.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DutyDailyReportBitableService screenshot idempotency', () => {
  it('does not expose any scheduler path that creates daily report records', () => {
    const serviceSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-daily-report-bitable.service.ts',
      ),
      'utf8',
    );
    const schedulerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-daily-report-local-scheduler.service.ts',
      ),
      'utf8',
    );
    const coordinatorSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-daily-report-task-coordinator.service.ts',
      ),
      'utf8',
    );
    const automationSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.automation.ts',
      ),
      'utf8',
    );

    expect(serviceSource).not.toContain('ensureDailyReportRecord');
    expect(serviceSource).not.toContain('createDailyReportRecord');
    expect(schedulerSource).not.toContain('white-record');
    expect(schedulerSource).not.toContain('night-record');
    expect(coordinatorSource).not.toContain('ensureDailyReportRecord');
    expect(automationSource).not.toContain('CreateDutyDailyReport');
    expect(automationSource).not.toContain('white-record');
    expect(automationSource).not.toContain('night-record');
  });

  it('does not create a report record when the target date and shift are missing', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-token' },
      }),
      get: jest.fn().mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [],
            has_more: false,
          },
        },
      }),
      put: jest.fn(),
    };
    const service = new DutyDailyReportBitableService({
      axiosRef,
    } as never);

    await expect(
      service.appendScreenshot({
        date: '2026-07-22',
        shift: 'white',
        image: Buffer.from('image'),
        fileName: 'nantong-duty-overview-2026-07-22-white.png',
      }),
    ).rejects.toMatchObject({
      code: 'DUTY_DAILY_REPORT_RECORD_MISSING',
      date: '2026-07-22',
      shift: 'white',
      message: expect.stringContaining('DUTY_DAILY_REPORT_RECORD_MISSING'),
    });

    expect(axiosRef.post).toHaveBeenCalledTimes(1);
    expect(axiosRef.get).toHaveBeenCalledTimes(1);
    expect(axiosRef.put).not.toHaveBeenCalled();
  });

  it('reuses an attachment with the same deterministic file name', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token' },
        })
        .mockResolvedValueOnce({
          data: { code: 0, data: { file_token: 'new-token' } },
        }),
      get: jest
        .fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              items: [
                {
                  record_id: 'record-1',
                  fields: {
                    日期: '2026-07-20',
                    班次: '白班',
                  },
                },
              ],
              has_more: false,
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              record: {
                record_id: 'record-1',
                fields: {
                  日报截图: [
                    {
                      file_token: 'existing-token',
                      name: 'nantong-duty-overview-2026-07-20-white.png',
                    },
                  ],
                },
              },
            },
          },
        }),
      put: jest.fn().mockResolvedValue({ data: { code: 0 } }),
    };
    const service = new DutyDailyReportBitableService({
      axiosRef,
    } as never);

    await expect(
      service.appendScreenshot({
        date: '2026-07-20',
        shift: 'white',
        image: Buffer.from('image'),
        fileName: 'nantong-duty-overview-2026-07-20-white.png',
      }),
    ).resolves.toMatchObject({
      fileToken: 'existing-token',
      attachmentCount: 1,
      appended: false,
    });

    expect(axiosRef.post).toHaveBeenCalledTimes(1);
    expect(axiosRef.put).not.toHaveBeenCalled();
  });

  it('replaces a same-name attachment only when an explicit repair requests it', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token' },
        }),
      get: jest
        .fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              items: [
                {
                  record_id: 'record-1',
                  fields: {
                    日期: '2026-07-22',
                    班次: '白班',
                  },
                },
              ],
              has_more: false,
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              record: {
                record_id: 'record-1',
                fields: {
                  日报截图: [
                    {
                      file_token: 'incomplete-token',
                      name: 'nantong-duty-overview-2026-07-22-white.png',
                    },
                    {
                      file_token: 'campus-token',
                      name: 'nantong-campus-operations-2026-07-22-white.png',
                    },
                  ],
                },
              },
            },
          },
        }),
      put: jest.fn().mockResolvedValue({ data: { code: 0 } }),
    };
    const service = new DutyDailyReportBitableService({ axiosRef } as never);
    jest
      .spyOn(service as never, 'uploadBitableAttachment' as never)
      .mockResolvedValue('corrected-token' as never);

    await expect(
      service.appendScreenshot({
        date: '2026-07-22',
        shift: 'white',
        image: Buffer.from('corrected-image'),
        fileName: 'nantong-duty-overview-2026-07-22-white.png',
        replaceExisting: true,
      }),
    ).resolves.toMatchObject({
      fileToken: 'corrected-token',
      attachmentCount: 2,
      appended: true,
    });

    expect(axiosRef.post).toHaveBeenCalledTimes(1);
    expect(axiosRef.put).toHaveBeenCalledWith(
      expect.any(String),
      {
        fields: {
          日报截图: [
            { file_token: 'corrected-token' },
            { file_token: 'campus-token' },
          ],
        },
      },
      expect.any(Object),
    );
  });
});
