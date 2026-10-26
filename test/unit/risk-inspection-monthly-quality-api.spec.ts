import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('monthly quality API contract', () => {
  test('exposes a dedicated controller route', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'server/modules/risk-inspection/risk-inspection.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Get('ali-monthly-quality')");
    expect(source).toContain('getAliMonthlyQuality');
    expect(source).toContain(
      "@Get('ali-monthly-quality/evidence/:recordId/:kind/:index')",
    );
    expect(source).toContain("'Cache-Control', 'private, max-age=300'");
    expect(source).toContain("'X-Content-Type-Options', 'nosniff'");
    expect(source).toContain("'Vary', 'Cookie'");
  });

  test('uses the dedicated endpoint from the client API', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(source).toContain(
      'export async function getAliMonthlyQualityDataset',
    );
    expect(source).toContain("url: '/api/risk-inspection/ali-monthly-quality'");
  });
});
