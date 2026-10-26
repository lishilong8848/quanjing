import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('inventory card detail dialog UI', () => {
  const root = process.cwd();
  const page = readFileSync(
    join(root, 'client/src/pages/InventoryManagement/index.tsx'),
    'utf8',
  );
  const dialogPath = join(
    root,
    'client/src/pages/InventoryManagement/InventoryDetailDialog.tsx',
  );

  it('opens one shared detail dialog from metric and building cards', () => {
    const dialog = readFileSync(dialogPath, 'utf8');

    expect(page).toContain('<InventoryDetailDialog');
    expect(page).toContain("kind: 'metric'");
    expect(page).toContain("kind: 'building'");
    expect(dialog).toContain('DialogContent');
    expect(dialog).toContain('getInventoryManagementItems');
  });

  it('supports risk switching, pagination, retry, and accessible close actions', () => {
    const dialog = readFileSync(dialogPath, 'utf8');

    expect(dialog).toContain("'low'");
    expect(dialog).toContain("'negative'");
    expect(dialog).toContain("'idle'");
    expect(dialog).toContain('onRetry');
    expect(dialog).toContain('上一页');
    expect(dialog).toContain('下一页');
    expect(dialog).toContain('关闭库存详情');
  });
});
