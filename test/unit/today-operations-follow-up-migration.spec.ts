import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fieldScript = join(
  process.cwd(),
  'scripts/ensure-today-operations-follow-up-fields.mjs',
);
const migrationScript = join(
  process.cwd(),
  'scripts/migrate-legacy-exception-follow-ups.mjs',
);

describe('unified today-operations follow-up migrations', () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), 'operations-follow-up-migration-'),
  );

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('plans only missing fields and defaults to dry-run', () => {
    const file = join(tempDir, 'fields.json');
    writeFileSync(
      file,
      JSON.stringify([
        { field_name: '日期', type: 5 },
        { field_name: '异常项', type: 1 },
        { field_name: '异常说明', type: 1 },
        { field_name: '已知悉', type: 7 },
        { field_name: '已处理完成', type: 7 },
        { field_name: '处理措施', type: 1 },
      ]),
      'utf8',
    );

    const result = run(fieldScript, ['--field-list-file', file]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: [
        '日期',
        '异常项',
        '异常说明',
        '已知悉',
        '已处理完成',
        '处理措施',
      ],
      created: [
        '异常类型',
        '异常唯一键',
        '来源',
        '楼栋',
        '最近发现时间',
        '处理人姓名',
        '处理时间',
        '客户端变更ID',
      ],
      updated: [],
    });
  });

  it('fails closed when a same-name target field has the wrong type', () => {
    const file = join(tempDir, 'wrong-fields.json');
    writeFileSync(
      file,
      JSON.stringify([{ field_name: '异常唯一键', type: 2 }]),
      'utf8',
    );

    const result = run(fieldScript, ['--field-list-file', file]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('异常唯一键');
    expect(result.stderr).toContain('类型或配置不符');
  });

  it('plans an idempotent legacy migration without changing either fixture', () => {
    const sourceFile = join(tempDir, 'legacy-records.json');
    const targetFile = join(tempDir, 'target-records.json');
    const first = legacyRecord(
      'recOld1',
      '2026-09-01',
      '排班异常',
      '风险：A楼连班',
      '已换班',
    );
    const second = legacyRecord(
      'recOld2',
      '2026-09-02',
      '封网&变更',
      '冲突：B楼变更冲突',
      '延期执行',
    );
    writeFileSync(sourceFile, JSON.stringify([first, second]), 'utf8');
    writeFileSync(
      targetFile,
      JSON.stringify([
        {
          record_id: 'recNew1',
          fields: {
            异常唯一键: legacyKey('2026-09-01', '排班异常', '风险：A楼连班'),
          },
        },
      ]),
      'utf8',
    );

    const result = run(migrationScript, [
      '--source-records-file',
      sourceFile,
      '--target-records-file',
      targetFile,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      dryRun: true,
      sourceRecords: 2,
      alreadyPresent: 1,
      createCount: 1,
      planned: [
        {
          sourceRecordId: 'recOld2',
          date: '2026-09-02',
          type: '封网&变更',
          item: '冲突：B楼变更冲突',
          building: 'B楼',
          acknowledged: true,
          completed: false,
        },
      ],
    });
  });

  it('never allows fixture input in apply mode', () => {
    const result = run(migrationScript, [
      '--apply',
      '--source-records-file',
      join(tempDir, 'legacy-records.json'),
      '--target-records-file',
      join(tempDir, 'target-records.json'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--apply 不允许使用记录夹具');
  });

  it('understands lark-cli tabular record-list output', () => {
    const sourceFile = join(tempDir, 'legacy-tabular.json');
    const targetFile = join(tempDir, 'target-empty.json');
    writeFileSync(
      sourceFile,
      JSON.stringify({
        ok: true,
        data: {
          data: [
            [
              '2026-09-03T00:00:00.000+08:00',
              '已安排替班',
              '风险：H楼夜班后接白班',
              ['排班异常'],
            ],
          ],
          fields: ['异常日期', '异常修正与处理', '详细内容', '异常项类型'],
          record_id_list: ['recOldTabular'],
        },
      }),
      'utf8',
    );
    writeFileSync(targetFile, JSON.stringify([]), 'utf8');

    const result = run(migrationScript, [
      '--source-records-file',
      sourceFile,
      '--target-records-file',
      targetFile,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sourceRecords: 1,
      createCount: 1,
      planned: [
        {
          sourceRecordId: 'recOldTabular',
          date: '2026-09-03',
          type: '排班异常',
          building: 'H楼',
        },
      ],
    });
  });

  it('plans metadata-only backfill for existing target rows without stable identity', () => {
    const sourceFile = join(tempDir, 'legacy-empty.json');
    const targetFile = join(tempDir, 'target-needs-backfill.json');
    writeFileSync(sourceFile, JSON.stringify([]), 'utf8');
    writeFileSync(
      targetFile,
      JSON.stringify([
        {
          record_id: 'recExistingTarget',
          created_time: Date.parse('2026-08-23T09:00:00+08:00'),
          fields: {
            日期: Date.parse('2026-08-23T00:00:00+08:00'),
            异常项: '昨日告警总数异常上涨',
            异常说明: '告警由 20 条上涨至 40 条',
            已知悉: true,
            已处理完成: true,
            处理措施: '已完成复核',
          },
        },
      ]),
      'utf8',
    );

    const result = run(migrationScript, [
      '--source-records-file',
      sourceFile,
      '--target-records-file',
      targetFile,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      targetBackfillCount: 1,
      targetBackfills: [
        {
          recordId: 'recExistingTarget',
          date: '2026-08-23',
          source: '今日航图',
          type: '运行异常',
          building: '园区',
        },
      ],
    });
  });
});

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function legacyRecord(
  recordId: string,
  date: string,
  type: string,
  detail: string,
  handling: string,
) {
  return {
    record_id: recordId,
    last_modified_time: Date.parse(`${date}T10:00:00+08:00`),
    fields: {
      异常日期: Date.parse(`${date}T00:00:00+08:00`),
      异常项类型: type,
      详细内容: detail,
      异常修正与处理: handling,
    },
  };
}

function legacyKey(date: string, type: string, detail: string): string {
  return `legacy-manual:${createHash('sha256')
    .update(`${date}|${type}|${detail}`)
    .digest('hex')}`;
}
