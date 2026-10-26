import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const fieldScript = join(
  process.cwd(),
  'scripts/ensure-attendance-archive-summary-fields.mjs',
);
const backfillScript = join(
  process.cwd(),
  'scripts/backfill-dingtalk-attendance-archive.mjs',
);

const requiredNames = [
  '班次',
  '上班打卡时间',
  '下班打卡时间',
  '上班状态',
  '下班状态',
  '打卡次数',
  '全部打卡时间',
];

describe('attendance archive schema and coverage migration', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'attendance-archive-fields-'));

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('defaults to dry-run, creates only missing summary fields, and plans the additive select option', () => {
    const fieldFile = join(tempDir, 'partial-fields.json');
    writeFileSync(
      fieldFile,
      JSON.stringify({
        data: {
          items: [
            {
              field_id: 'fldPunchType',
              field_name: '打卡类型',
              type: 3,
              property: {
                options: [{ name: '上班' }, { name: '下班' }],
              },
            },
            {
              field_id: 'fldShift',
              field_name: '班次',
              type: 3,
              property: {
                options: [
                  { name: '白班' },
                  { name: '夜班' },
                  { name: '长白班' },
                  { name: '未识别班次' },
                ],
              },
            },
          ],
        },
      }),
      'utf8',
    );

    const result = run(fieldScript, ['--field-list-file', fieldFile]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: ['班次'],
      created: requiredNames.slice(1),
      updated: ['打卡类型'],
    });
  });

  it('is idempotent when all fields and the summary option already exist', () => {
    const fieldFile = join(tempDir, 'complete-fields.json');
    writeFileSync(
      fieldFile,
      JSON.stringify([
        selectField('打卡类型', ['上班', '下班', '班次汇总']),
        selectField('班次', ['白班', '夜班', '长白班', '未识别班次']),
        dateField('上班打卡时间'),
        dateField('下班打卡时间'),
        selectField('上班状态', ['正常', '未打卡', '迟到', '旷工', '考勤异常']),
        selectField('下班状态', ['正常', '未打卡', '早退', '旷工', '考勤异常']),
        { field_name: '打卡次数', type: 2 },
        { field_name: '全部打卡时间', type: 1 },
      ]),
      'utf8',
    );

    const result = run(fieldScript, [
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      fieldFile,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: requiredNames,
      created: [],
      updated: [],
    });
  });

  it('fails closed for a same-name field with the wrong type', () => {
    const fieldFile = join(tempDir, 'wrong-type.json');
    writeFileSync(
      fieldFile,
      JSON.stringify([{ field_name: '打卡次数', type: 1 }]),
      'utf8',
    );

    const result = run(fieldScript, ['--field-list-file', fieldFile]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('打卡次数');
    expect(result.stderr).toContain('类型或配置不符');
  });

  it('audits September coverage from a fixture without loading the compiled runtime or writing records', () => {
    const recordFile = join(tempDir, 'attendance-records.json');
    writeFileSync(
      recordFile,
      JSON.stringify({
        data: {
          items: [
            resultRecord('2026-09-01'),
            resultRecord('2026-09-02', {
              实际打卡时间: shanghaiMillis('2026-09-02') + 9 * 60 * 60 * 1000,
              时间状态: '未打卡',
            }),
            {
              fields: {
                工作日期: shanghaiMillis('2026-09-03'),
                记录类型: '打卡明细',
              },
            },
          ],
        },
      }),
      'utf8',
    );

    const result = run(backfillScript, [
      '--from',
      '2026-09-01',
      '--through',
      '2026-09-03',
      '--audit-only',
      '--record-list-file',
      recordFile,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      mode: 'audit-only',
      from: '2026-09-01',
      through: '2026-09-03',
      coverage: [
        { date: '2026-09-01', resultRows: 1 },
        { date: '2026-09-02', resultRows: 1 },
        { date: '2026-09-03', resultRows: 0 },
      ],
      missingDates: ['2026-09-03'],
      staleStatusWithActual: {
        total: 1,
        byDate: [
          { date: '2026-09-01', rows: 0 },
          { date: '2026-09-02', rows: 1 },
          { date: '2026-09-03', rows: 0 },
        ],
      },
    });
  });
});

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function selectField(name: string, options: string[]) {
  return {
    field_id: `fld${name}`,
    field_name: name,
    type: 3,
    property: { options: options.map((option) => ({ name: option })) },
  };
}

function dateField(name: string) {
  return { field_name: name, type: 5 };
}

function resultRecord(date: string, fields: Record<string, unknown> = {}) {
  return {
    fields: {
      工作日期: shanghaiMillis(date),
      记录类型: '考勤结果',
      ...fields,
    },
  };
}

function shanghaiMillis(date: string) {
  return Date.parse(`${date}T00:00:00+08:00`);
}
