import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const script = join(
  process.cwd(),
  'scripts/ensure-change-adjustment-fields.mjs',
);

describe('change adjustment Base field migration', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'change-adjustment-fields-'));

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('plans only missing fields and is idempotent', () => {
    const fieldFile = join(tempDir, 'partial.json');
    writeFileSync(
      fieldFile,
      JSON.stringify({
        data: {
          items: [
            { field_name: '申请提交人', type: 11 },
            { field_name: '延期理由', type: 1 },
          ],
        },
      }),
    );
    const result = run(fieldFile);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: ['申请提交人', '延期理由'],
      created: ['调整请求唯一ID', '调整请求指纹'],
    });

    writeFileSync(
      fieldFile,
      JSON.stringify({
        items: [
          { name: '申请提交人', type: 'user' },
          { name: '延期理由', type: 'text' },
          { name: '调整请求唯一ID', type: 'text' },
          { name: '调整请求指纹', type: 'text' },
        ],
      }),
    );
    expect(JSON.parse(run(fieldFile).stdout).created).toEqual([]);
  });

  it('fails closed when an existing field has the wrong type', () => {
    const fieldFile = join(tempDir, 'wrong.json');
    writeFileSync(
      fieldFile,
      JSON.stringify([{ name: '申请提交人', type: 'text' }]),
    );
    const result = run(fieldFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('申请提交人');
    expect(result.stderr).toContain('类型不是 user');
  });

  it('resolves the actual change calendar Base when explicit tokens are absent', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('FEISHU_CALENDAR_CHANGE_APP_TOKEN');
    expect(source).toContain('FEISHU_CHANGE_MANAGEMENT_APP_TOKEN');
    expect(source).toContain('FEISHU_CALENDAR_CHANGE_TABLE_ID');
    expect(source).toContain('FEISHU_CHANGE_MANAGEMENT_SOURCE_URL');
    expect(source).toContain("'+url-resolve'");
    expect(source).toContain('FEISHU_CHANGE_MIGRATION_IDENTITY');
    expect(source).toContain('JhiVwgfoIimAqEk8YwEc09sknGd');
    expect(source).toContain('tblBvg6wCYSX3hcg');
  });

  it('passes field definitions through an @file JSON argument on Windows-safe paths', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('writeJsonArgumentFile');
    expect(source).toContain("'--json'");
    expect(source).toContain('`@${payloadPath}`');
    expect(source).toContain('relative(process.cwd(), absolutePath)');
    expect(source).not.toContain("from 'node:os'");
    expect(source).not.toContain(
      "'--json',\n      JSON.stringify(required.json)",
    );
  });

  it('does not corrupt errors while the Base token is still unresolved', () => {
    const result = spawnSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        LARK_CLI_BIN: 'codex-intentionally-missing-lark-cli',
        FEISHU_CALENDAR_CHANGE_APP_TOKEN: '',
        FEISHU_CHANGE_CALENDAR_APP_TOKEN: '',
        FEISHU_CHANGE_MANAGEMENT_APP_TOKEN: '',
        FEISHU_FOCUS_CHANGE_APP_TOKEN: '',
        FEISHU_CHANGE_APP_TOKEN: '',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).not.toContain('[redacted]l[redacted]a');
  });

  function run(fieldFile: string) {
    return spawnSync(
      process.execPath,
      [script, '--dry-run', '--field-list-file', fieldFile],
      { encoding: 'utf8', windowsHide: true },
    );
  }
});
