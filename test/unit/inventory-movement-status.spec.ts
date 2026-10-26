import { formatInventoryMovementStatusLabel } from '../../client/src/pages/InventoryManagement/inventory-movement-status';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('inventory movement status labels', () => {
  it.each([
    ['添加', '新增物品入库'],
    ['已有', '已有物品入库'],
    ['已入库', '已入库'],
  ])('formats inbound status %s as %s', (status, expected) => {
    expect(formatInventoryMovementStatusLabel('inbound', status)).toBe(
      expected,
    );
  });

  it('keeps outbound and borrow status values unchanged', () => {
    expect(formatInventoryMovementStatusLabel('outbound', '待路由')).toBe(
      '待路由',
    );
    expect(formatInventoryMovementStatusLabel('borrow', '借调中')).toBe(
      '借调中',
    );
  });

  it('uses an explicit fallback for an empty status', () => {
    expect(formatInventoryMovementStatusLabel('inbound', '  ')).toBe(
      '状态未填写',
    );
  });

  it('uses the formatter in the summary, filter, row and deletion dialog', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(source).toContain(
      'formatInventoryMovementStatusLabel(type, status)',
    );
    expect(source).toContain('formatInventoryMovementStatusLabel(type, item)');
    expect(source).toContain(
      'formatInventoryMovementStatusLabel(item.type, item.status)',
    );
  });
});
