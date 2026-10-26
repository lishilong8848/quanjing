import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purchase inventory execution chart', () => {
  it('does not render a hover tooltip over the donut center label', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client',
        'src',
        'pages',
        'PurchaseInventoryManagement',
        'PurchaseOverviewPage.tsx',
      ),
      'utf8',
    );

    expect(source).not.toMatch(/<Tooltip\b/);
    expect(source).toContain('aria-label="采购经营概览"');
    expect(source.indexOf('<StageDistributionChart')).toBeLessThan(
      source.indexOf('title="采购申请阶段清单"'),
    );
  });
});
