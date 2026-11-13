jest.mock('@server/common/config/external-services.config', () => ({
  getFeishuAuthPayload: jest.fn(() => ({
    app_id: 'test-app',
    app_secret: 'test-secret',
  })),
  readEnv: jest.fn(() => ''),
}));

// The service does `import FormData from 'form-data'`; under ts-jest without
// esModuleInterop the default export is undefined, so provide a minimal stub.
jest.mock('form-data', () => {
  class MockFormData {
    append() {}
    getHeaders() {
      return {};
    }
  }
  return { __esModule: true, default: MockFormData };
});

import { DutyDailyReportBitableService } from '../../server/modules/duty-schedule/duty-daily-report-bitable.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];

interface MockRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

/**
 * URL-routed axios mock. GET .../fields -> field types; GET .../records -> the
 * listing; POST .../records -> create (returns sequential ids); POST upload_all
 * -> file_token; PUT .../records/{id} -> ok. Records every call for assertions.
 */
function mockAxios(opts: {
  records?: MockRecord[];
  fieldTypes?: Array<{ field_name: string; type: number }>;
}) {
  const calls = {
    post: [] as Array<{ url: string; body: any }>,
    get: [] as Array<{ url: string }>,
    put: [] as Array<{ url: string; body: any }>,
  };
  let created = 0;
  const axiosRef = {
    post: jest.fn(async (url: string, body: any) => {
      calls.post.push({ url, body });
      if (url.includes('tenant_access_token'))
        return { data: { code: 0, tenant_access_token: 'tenant-token' } } as any;
      if (url.includes('drive/v1/medias/upload_all'))
        return { data: { code: 0, data: { file_token: 'uploaded-token' } } } as any;
      if (url.endsWith('/records')) {
        created += 1;
        const building = body?.fields?.['楼栋'] ?? `idx${created}`;
        return {
          data: { code: 0, data: { record: { record_id: `created-${building}` } } },
        } as any;
      }
      throw new Error(`unexpected POST ${url}`);
    }),
    get: jest.fn(async (url: string) => {
      calls.get.push({ url });
      if (url.endsWith('/fields'))
        return {
          data: { code: 0, data: { items: opts.fieldTypes ?? [], has_more: false } },
        } as any;
      if (url.endsWith('/records'))
        return {
          data: { code: 0, data: { items: opts.records ?? [], has_more: false } },
        } as any;
      throw new Error(`unexpected GET ${url}`);
    }),
    put: jest.fn(async (url: string, body: any) => {
      calls.put.push({ url, body });
      return { data: { code: 0 } } as any;
    }),
  };
  return { axiosRef, calls };
}

const createPosts = (calls: { post: Array<{ url: string; body: any }> }) =>
  calls.post.filter((p) => p.url.endsWith('/records'));
const uploadPosts = (calls: { post: Array<{ url: string }> }) =>
  calls.post.filter((p) => p.url.includes('drive/v1/medias/upload_all'));

describe('DutyDailyReportBitableService per-building records', () => {
  it('centralizes record creation in the bitable service, not in scheduler paths', () => {
    const read = (p: string) =>
      readFileSync(join(process.cwd(), p), 'utf8');
    const serviceSource = read(
      'server/modules/duty-schedule/duty-daily-report-bitable.service.ts',
    );
    const schedulerSource = read(
      'server/modules/duty-schedule/duty-daily-report-local-scheduler.service.ts',
    );
    const coordinatorSource = read(
      'server/modules/duty-schedule/duty-daily-report-task-coordinator.service.ts',
    );
    const automationSource = read(
      'server/modules/duty-schedule/duty-schedule.automation.ts',
    );

    // Creation now lives in the bitable service (one idempotent helper), and the
    // scheduler/coordinator/automation still have no ad-hoc record-creation path.
    expect(serviceSource).toContain('createDailyReportRecord');
    expect(serviceSource).toContain('resolveBuildingRecords');
    expect(schedulerSource).not.toContain('white-record');
    expect(schedulerSource).not.toContain('night-record');
    expect(coordinatorSource).not.toContain('ensureDailyReportRecord');
    expect(automationSource).not.toContain('CreateDutyDailyReport');
    expect(automationSource).not.toContain('white-record');
    expect(automationSource).not.toContain('night-record');
  });

  it('creates seven building records and mirrors one screenshot into all when none exist', async () => {
    const { axiosRef, calls } = mockAxios({
      records: [],
      fieldTypes: [
        { field_name: '日期', type: 5 },
        { field_name: '班次', type: 3 },
        { field_name: '楼栋', type: 3 },
        { field_name: '日报截图', type: 17 },
      ],
    });
    const service = new DutyDailyReportBitableService({ axiosRef } as never);

    const result = await service.appendScreenshot({
      date: '2026-07-22',
      shift: 'white',
      image: Buffer.from('image'),
      fileName: 'nantong-duty-overview-2026-07-22-white.png',
    });

    const creates = createPosts(calls);
    expect(creates).toHaveLength(7);
    expect(creates.map((c) => c.body.fields['楼栋'])).toEqual(BUILDINGS);
    // DateTime field (type 5) -> epoch millis at China midnight; round-trips via extractDateKey.
    expect(creates[0].body.fields['日期']).toBe(
      Date.parse('2026-07-22T00:00:00+08:00'),
    );
    expect(creates[0].body.fields['班次']).toBe('白班');
    // One upload, mirrored into all seven records.
    expect(uploadPosts(calls)).toHaveLength(1);
    expect(calls.put).toHaveLength(7);
    expect(
      calls.put.every(
        (p) =>
          p.body.fields['日报截图']?.[0]?.file_token === 'uploaded-token',
      ),
    ).toBe(true);
    expect(result).toMatchObject({ appended: true, created: true, shiftLabel: '白班' });
  });

  it('writes the date as a YYYY-MM-DD string when the date field is text, not DateTime', async () => {
    const { axiosRef, calls } = mockAxios({
      records: [],
      fieldTypes: [
        { field_name: '日期', type: 1 },
        { field_name: '班次', type: 1 },
        { field_name: '楼栋', type: 3 },
      ],
    });
    const service = new DutyDailyReportBitableService({ axiosRef } as never);

    await service.appendScreenshot({
      date: '2026-07-22',
      shift: 'night',
      image: Buffer.from('image'),
      fileName: 'nantong-duty-overview-2026-07-22-night.png',
    });

    const creates = createPosts(calls);
    expect(creates).toHaveLength(7);
    expect(creates[0].body.fields['日期']).toBe('2026-07-22');
    expect(creates[0].body.fields['班次']).toBe('夜班');
  });

  it('is idempotent: reuses seven existing building records and skips an already-present screenshot', async () => {
    const records: MockRecord[] = BUILDINGS.map((building, index) => ({
      record_id: `rec-${building}`,
      fields: {
        日期: '2026-07-20',
        班次: '白班',
        楼栋: building,
        日报截图:
          index === 0
            ? [
                {
                  file_token: 'existing-token',
                  name: 'nantong-duty-overview-2026-07-20-white.png',
                },
              ]
            : [],
      },
    }));
    const { axiosRef, calls } = mockAxios({ records });
    const service = new DutyDailyReportBitableService({ axiosRef } as never);

    const result = await service.appendScreenshot({
      date: '2026-07-20',
      shift: 'white',
      image: Buffer.from('image'),
      fileName: 'nantong-duty-overview-2026-07-20-white.png',
    });

    // No creation (all seven buildings exist); no field-type lookup needed.
    expect(createPosts(calls)).toHaveLength(0);
    expect(calls.get.some((g) => g.url.endsWith('/fields'))).toBe(false);
    // Six records lack the screenshot -> one upload mirrored into those six; the
    // record that already has it is left untouched (no duplicate).
    expect(uploadPosts(calls)).toHaveLength(1);
    expect(calls.put).toHaveLength(6);
    expect(result).toMatchObject({ appended: true, created: false });

    // Second run: every record now has the file (simulate) -> nothing uploaded.
    const records2: MockRecord[] = BUILDINGS.map((building) => ({
      record_id: `rec-${building}`,
      fields: {
        日期: '2026-07-20',
        班次: '白班',
        楼栋: building,
        日报截图: [
          {
            file_token: 'uploaded-token',
            name: 'nantong-duty-overview-2026-07-20-white.png',
          },
        ],
      },
    }));
    const second = mockAxios({ records: records2 });
    const service2 = new DutyDailyReportBitableService({
      axiosRef: second.axiosRef,
    } as never);
    const result2 = await service2.appendScreenshot({
      date: '2026-07-20',
      shift: 'white',
      image: Buffer.from('image'),
      fileName: 'nantong-duty-overview-2026-07-20-white.png',
    });
    expect(uploadPosts(second.calls)).toHaveLength(0);
    expect(second.calls.put).toHaveLength(0);
    expect(createPosts(second.calls)).toHaveLength(0);
    expect(result2).toMatchObject({ appended: false, created: false });
  });

  it('adopts a legacy record without 楼栋 into a building instead of creating a stray', async () => {
    const { axiosRef, calls } = mockAxios({
      records: [
        {
          record_id: 'legacy-1',
          fields: { 日期: '2026-07-21', 班次: '白班' },
        },
      ],
      fieldTypes: [
        { field_name: '日期', type: 5 },
        { field_name: '班次', type: 3 },
        { field_name: '楼栋', type: 3 },
      ],
    });
    const service = new DutyDailyReportBitableService({ axiosRef } as never);

    const result = await service.appendScreenshot({
      date: '2026-07-21',
      shift: 'white',
      image: Buffer.from('image'),
      fileName: 'nantong-duty-overview-2026-07-21-white.png',
    });

    // Six new buildings created; the legacy row is adopted into the seventh (A楼).
    expect(createPosts(calls)).toHaveLength(6);
    const adoptPut = calls.put.find(
      (p) => p.url.endsWith('/records/legacy-1') && p.body.fields['楼栋'],
    );
    expect(adoptPut?.body.fields['楼栋']).toBe('A楼');
    // Screenshot mirrored into all seven (1 upload).
    expect(uploadPosts(calls)).toHaveLength(1);
    expect(result).toMatchObject({ appended: true, created: true });
  });
});
