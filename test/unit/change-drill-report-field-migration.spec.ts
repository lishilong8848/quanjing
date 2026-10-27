import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const script = join(
  process.cwd(),
  'scripts/ensure-change-drill-report-fields.mjs',
);

describe('change drill report Base field migration', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'change-drill-report-fields-'));

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('plans only missing fields and is idempotent', () => {
    const fieldFile = join(tempDir, 'partial.json');
    writeFileSync(
      fieldFile,
      JSON.stringify({
        data: {
          fields: [
            {
              name: '演练楼栋',
              type: 'select',
              multiple: true,
              options: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站', 'H楼'].map(
                (name) => ({ name }),
              ),
            },
          ],
        },
      }),
    );

    const partial = run(fieldFile);
    expect(partial.status).toBe(0);
    expect(JSON.parse(partial.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: ['演练楼栋'],
      created: ['演练提交请求唯一ID', '演练提交请求指纹'],
    });

    writeFileSync(
      fieldFile,
      JSON.stringify([
        {
          name: '演练楼栋',
          type: 'select',
          multiple: true,
          options: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站', 'H楼'].map(
            (name) => ({ name }),
          ),
        },
        { name: '演练提交请求唯一ID', type: 'text' },
        { name: '演练提交请求指纹', type: 'text' },
      ]),
    );
    expect(JSON.parse(run(fieldFile).stdout).created).toEqual([]);
  });

  it.each([
    [{ name: '演练楼栋', type: 'select', multiple: false }, '演练楼栋'],
    [{ name: '演练提交请求唯一ID', type: 'number' }, '演练提交请求唯一ID'],
  ])('fails closed for a wrong existing field shape', (field, label) => {
    const fieldFile = join(tempDir, `${label}.json`);
    writeFileSync(fieldFile, JSON.stringify([field]));
    const result = run(fieldFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(label);
    expect(result.stderr).toContain('类型或配置不符');
  });

  it('targets the real linked drill report table and uses Windows-safe JSON files', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('tblZZHIJCY3f551K');
    expect(source).toContain('FEISHU_CHANGE_DRILL_REPORT_TABLE_ID');
    expect(source).toContain('JhiVwgfoIimAqEk8YwEc09sknGd');
    expect(source).toContain("'+url-resolve'");
    expect(source).toContain('writeJsonArgumentFile');
    expect(source).toContain('`@${payloadPath}`');
  });

  function run(fieldFile: string) {
    return spawnSync(
      process.execPath,
      [script, '--dry-run', '--field-list-file', fieldFile],
      { encoding: 'utf8', windowsHide: true },
    );
  }
});
