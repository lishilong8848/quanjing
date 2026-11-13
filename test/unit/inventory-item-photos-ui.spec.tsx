import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { InventoryItemPhotoThumbnail } from '../../client/src/pages/InventoryManagement/InventoryItemPhotos';

describe('inventory ledger image column', () => {
  it('renders a visible placeholder with no image request when the item has no photo', () => {
    const html = renderToStaticMarkup(
      <InventoryItemPhotoThumbnail name="测试物品" images={[]} onOpen={jest.fn()} />,
    );
    expect(html).toContain('无图片');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<button');
  });

  it('renders an accessible lazy-loaded preview for attached photos', () => {
    const url = '/api/inventory-management/items/recSample/images/0-e0e0beef12345678';
    const html = renderToStaticMarkup(
      <InventoryItemPhotoThumbnail name="测试物品" images={[{ url, name: '样本.jpg' }]} onOpen={jest.fn()} />,
    );
    expect(html).toContain('aria-label="查看测试物品的物品图片，共 1 张"');
    expect(html).toContain(`src="${url}?variant=thumbnail"`);
    expect(html).not.toContain(`src="${url}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('无图片');
  });

  it('places the thumbnail in its own desktop column and keeps it on the mobile card', () => {
    const page = readFileSync(join(process.cwd(), 'client/src/pages/InventoryManagement/index.tsx'), 'utf8');
    const table = page.slice(page.indexOf('function InventoryTable('), page.indexOf('function InventoryRiskBadges('));
    expect(table).toMatch(/<th scope="col"[^>]*>图片<\/th>/);
    expect(table).toMatch(/<td[^>]*>\s*<InventoryItemPhotoThumbnail[^>]*\/>\s*<\/td>/);
    expect(table.match(/<InventoryItemPhotoThumbnail/g)).toHaveLength(2);
  });
});
