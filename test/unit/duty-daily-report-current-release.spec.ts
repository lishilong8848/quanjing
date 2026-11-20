jest.mock('@server/common/config/external-services.config', () => ({
  getFeishuAuthPayload: () => ({ app_id: 'isolated-app', app_secret: 'isolated-secret' }),
  readEnv: () => '',
}));

jest.mock('form-data', () => ({
  __esModule: true,
  default: class {
    fields = new Map<string, unknown>();
    append(name: string, value: unknown) { this.fields.set(name, value); }
    getHeaders() { return {}; }
  },
}));

import { DutyDailyReportBitableService } from '../../server/modules/duty-schedule/duty-daily-report-bitable.service';

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
const DATE = '2026-11-19';
const FILE = 'nantong-duty-overview-2026-11-19-white.png';
interface RecordValue { record_id: string; fields: Record<string, unknown> }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const row = (building: string, attachments: unknown[] = [], shift = '白班'): RecordValue => ({
  record_id: `rec-${building}-${shift}`,
  fields: { 日期: DATE, 班次: shift, 楼栋: building, 日报截图: attachments },
});

function fixture(initial: RecordValue[] = []) {
  const rows = clone(initial);
  const uploads: string[] = [];
  const creates: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const names = new Map<string, string>();
  const controls = { failPutBuilding: '', failCreateBuilding: '', loseCreateResponseBuilding: '', afterList: undefined as (() => void) | undefined };
  const axiosRef = {
    get: jest.fn(async (url: string) => {
      if (url.endsWith('/fields')) return { data: { code: 0, data: { items: [
        { field_name: '日期', type: 5 }, { field_name: '班次', type: 3 },
        { field_name: '楼栋', type: 3 }, { field_name: '日报截图', type: 17 },
      ] } } };
      if (url.endsWith('/records')) {
        const snapshot = clone(rows);
        controls.afterList?.();
        controls.afterList = undefined;
        return { data: { code: 0, data: { items: snapshot, has_more: false } } };
      }
      const id = url.split('/records/')[1];
      const found = rows.find(r => r.record_id === id);
      if (found) return { data: { code: 0, data: { record: clone(found) } } };
      throw new Error('Unexpected isolated GET');
    }),
    post: jest.fn(async (url: string, body: { fields?: Record<string, unknown> | Map<string, unknown> }) => {
      if (url.includes('tenant_access_token')) return { data: { code: 0, tenant_access_token: 'isolated-token' } };
      if (url.endsWith('/upload_all')) {
        const token = `upload-${uploads.length + 1}`;
        uploads.push(token);
        names.set(token, String((body.fields as Map<string, unknown>).get('file_name')));
        return { data: { code: 0, data: { file_token: token } } };
      }
      if (url.endsWith('/records')) {
        const fields = body.fields as Record<string, unknown>;
        if (controls.failCreateBuilding === fields['楼栋']) {
          controls.failCreateBuilding = '';
          throw new Error('Isolated create failure');
        }
        creates.push(clone(fields));
        const record = { record_id: `created-${rows.length + 1}`, fields: clone(fields) };
        rows.push(record);
        if (controls.loseCreateResponseBuilding === fields['楼栋']) {
          controls.loseCreateResponseBuilding = '';
          throw new Error('Isolated create response lost');
        }
        return { data: { code: 0, data: { record: clone(record) } } };
      }
      throw new Error('Unexpected isolated POST');
    }),
    put: jest.fn(async (url: string, body: { fields: Record<string, unknown> }) => {
      const id = url.split('/records/')[1], record = rows.find(r => r.record_id === id);
      if (!record) throw new Error('Unknown isolated record');
      if (controls.failPutBuilding === record.fields['楼栋'] && body.fields['日报截图']) {
        controls.failPutBuilding = '';
        throw new Error('Isolated update failure');
      }
      const fields = clone(body.fields);
      if (Array.isArray(fields['日报截图'])) fields['日报截图'] = (fields['日报截图'] as Array<{ file_token: string }>).map(a => ({
        ...a, ...(names.has(a.file_token) ? { name: names.get(a.file_token) } : {}),
      }));
      updates.push({ id, fields: clone(fields) });
      Object.assign(record.fields, fields);
      return { data: { code: 0 } };
    }),
  };
  const service = new DutyDailyReportBitableService({ axiosRef } as never);
  const append = () => service.appendScreenshot({ date: DATE, shift: 'white', fileName: FILE, image: Buffer.from('isolated-image') });
  return { rows, uploads, creates, updates, controls, service, append, axiosRef };
}

describe('current-release daily report persistence', () => {
  it('creates exactly seven rows and uploads once across concurrent identical calls', async () => {
    const f = fixture();
    await Promise.all([f.append(), f.append()]);
    expect(f.rows).toHaveLength(7);
    expect(f.creates.map(r => r['楼栋'])).toEqual(BUILDINGS);
    expect(f.uploads).toHaveLength(1);
    expect(f.updates).toHaveLength(7);
  });

  it('reuses a successfully attached image after a partial write failure, including a new service instance', async () => {
    const f = fixture(BUILDINGS.map(b => row(b)));
    f.controls.failPutBuilding = 'B楼';
    await expect(f.append()).rejects.toThrow('Isolated update failure');
    expect(f.uploads).toHaveLength(1);
    expect(f.rows[0].fields['日报截图']).toEqual([{ file_token: 'upload-1', name: FILE }]);
    const restarted = new DutyDailyReportBitableService({ axiosRef: f.axiosRef } as never);
    await restarted.appendScreenshot({ date: DATE, shift: 'white', fileName: FILE, image: Buffer.from('isolated-image') });
    expect(f.uploads).toHaveLength(1);
    expect(f.updates.filter(x => x.id === f.rows[0].record_id)).toHaveLength(1);
    expect(f.rows.every(r => (r.fields['日报截图'] as Array<{ file_token: string }>)[0].file_token === 'upload-1')).toBe(true);
  });

  it('preserves attachments added after the initial listing', async () => {
    const f = fixture(BUILDINGS.map(b => row(b, [{ file_token: 'original', name: 'original.png' }])));
    f.controls.afterList = () => { (f.rows[0].fields['日报截图'] as unknown[]).push({ file_token: 'concurrent', name: 'other.png' }); };
    const result = await f.append();
    expect((f.rows[0].fields['日报截图'] as Array<{ file_token: string }>).map(a => a.file_token)).toEqual(['original', 'concurrent', 'upload-1']);
    expect(result).toMatchObject({ recordId: f.rows[0].record_id, fileToken: 'upload-1', attachmentCount: 3 });
  });

  it('adopts one blank-building legacy row, preserving its other fields and screenshot', async () => {
    const legacy = row(''); legacy.record_id = 'legacy'; legacy.fields['说明'] = 'keep'; legacy.fields['日报截图'] = [{ file_token: 'old', name: 'old.png' }];
    const f = fixture([legacy]); await f.append();
    expect(f.rows).toHaveLength(7); expect(f.creates).toHaveLength(6);
    expect(f.rows[0].fields).toMatchObject({ 楼栋: 'A楼', 说明: 'keep' });
    expect((f.rows[0].fields['日报截图'] as Array<{ file_token: string }>).map(a => a.file_token)).toEqual(['old', 'upload-1']);
  });

  it('keeps other date and shift rows untouched and resumes missing-row creation after failure', async () => {
    const night = row('A楼', [], '夜班'), previous = row('B楼'); previous.fields['日期'] = '2026-11-18';
    const f = fixture([night, previous]); f.controls.failCreateBuilding = 'C楼';
    await expect(f.append()).rejects.toThrow('Isolated create failure');
    expect(f.uploads).toHaveLength(0);
    await f.append();
    expect(f.creates).toHaveLength(7); expect(f.rows).toHaveLength(9);
    expect(f.updates.some(u => u.id === night.record_id || u.id === previous.record_id)).toBe(false);
  });

  it('performs no upload or write after a successful retry', async () => {
    const f = fixture(); await f.append(); const count = f.updates.length;
    const result = await f.append();
    expect(result.appended).toBe(false); expect(f.uploads).toHaveLength(1); expect(f.updates).toHaveLength(count);
  });

  it('reconciles a created row from the next source read when its first response is lost', async () => {
    const f = fixture(); f.controls.loseCreateResponseBuilding = 'C楼';
    await expect(f.append()).rejects.toThrow('Isolated create response lost');
    await f.append();
    expect(f.creates).toHaveLength(7); expect(f.rows).toHaveLength(7); expect(f.uploads).toHaveLength(1);
  });

  it('serializes distinct screenshot files for the same date and shift without losing either', async () => {
    const f = fixture(); const second = 'details-white.png';
    await Promise.all([f.append(), f.service.appendScreenshot({ date: DATE, shift: 'white', fileName: second, image: Buffer.from('details') })]);
    expect(f.creates).toHaveLength(7); expect(f.uploads).toHaveLength(2);
    expect(f.rows.every(r => (r.fields['日报截图'] as Array<{ name: string }>).map(a => a.name).join(',') === `${FILE},${second}`)).toBe(true);
  });

  it('explicit replacement uploads fresh content and retains unrelated attachments', async () => {
    const f = fixture(BUILDINGS.map(b => row(b, [{ file_token: 'old-target', name: FILE }, { file_token: 'keep', name: 'other.png' }])));
    await f.service.appendScreenshot({ date: DATE, shift: 'white', fileName: FILE, image: Buffer.from('new-content'), replaceExisting: true });
    expect(f.uploads).toHaveLength(1);
    expect(f.rows.every(r => (r.fields['日报截图'] as Array<{ file_token: string }>).map(a => a.file_token).join(',') === 'upload-1,keep')).toBe(true);
  });
});
