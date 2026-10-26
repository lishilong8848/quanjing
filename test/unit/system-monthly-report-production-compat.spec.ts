import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as ts from 'typescript';

describe('system monthly report production compatibility', () => {
  it('uses a production dependency for spreadsheet previews', () => {
    const archiveServicePath = join(
      process.cwd(),
      'server',
      'modules',
      'system-monthly-report',
      'system-monthly-report-archive.service.ts',
    );
    const archiveServiceSource = readFileSync(archiveServicePath, 'utf8');
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(archiveServiceSource).toContain("from 'xlsx-js-style'");
    expect(archiveServiceSource).not.toMatch(/from ['"]xlsx['"]/u);
    expect(packageJson.dependencies?.['xlsx-js-style']).toBeDefined();
    expect(packageJson.devDependencies?.['xlsx-js-style']).toBeUndefined();
  });

  it('keeps all August final reports when the mapper is downlevel compiled', () => {
    const mapper = loadDownlevelMapper();
    const rooms = [
      '南通-A',
      '南通-B',
      '南通-C',
      '南通-D',
      '南通-E',
      '昆山',
      '宿州',
      '央广云',
      '下沙',
    ];
    const records = rooms.map((room, index) =>
      finalRecord(room, `rec-${index + 1}`, 1788488050327 + index * 1_000),
    );
    records.push(
      finalRecord(
        '南通-B',
        'rec-b-latest',
        1788773360679,
        '南通-B-终版-v2.xlsx',
      ),
    );

    const result = mapper.mapLatestFinalReportRecords(records);

    expect(result).toHaveLength(9);
    expect(result.find((item) => item.room === '南通-B')).toMatchObject({
      recordId: 'rec-b-latest',
      year: 2026,
      month: 8,
      attachments: [{ name: '南通-B-终版-v2.xlsx' }],
    });
  });
});

function loadDownlevelMapper(): {
  mapLatestFinalReportRecords: (
    records: Array<Record<string, unknown>>,
  ) => Array<{
    recordId: string;
    year: number;
    month: number;
    room: string;
    attachments: Array<{ name: string }>;
  }>;
} {
  const mapperPath = join(
    process.cwd(),
    'server',
    'modules',
    'system-monthly-report',
    'system-monthly-report.mapper.ts',
  );
  const output = ts.transpileModule(readFileSync(mapperPath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const moduleRef = { exports: {} as Record<string, unknown> };
  const localRequire = createRequire(mapperPath);
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(localRequire, moduleRef, moduleRef.exports);
  return moduleRef.exports as ReturnType<typeof loadDownlevelMapper>;
}

function finalRecord(
  room: string,
  recordId: string,
  createdAt: number,
  name = `${room}-终版.xlsx`,
) {
  return {
    record_id: recordId,
    fields: {
      机房: room,
      月报月份: { type: 2, value: [8] },
      创建时间: createdAt,
      终版月报: [
        {
          file_token: `box-${recordId}`,
          name,
          size: 1024,
        },
      ],
    },
  };
}
