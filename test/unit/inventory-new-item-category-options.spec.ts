import {
  INVENTORY_NEW_ITEM_CATEGORY_OPTIONS,
  getInventorySecondaryCategoryOptions,
  isInventoryNewItemCategoryPair,
} from '../../shared/inventory-management.interface';

describe('inventory new item category options', () => {
  it('exposes the approved primary and dependent secondary category pairs', () => {
    expect(INVENTORY_NEW_ITEM_CATEGORY_OPTIONS).toEqual([
      {
        primaryCategory: 'A备品备件类',
        secondaryCategories: ['应急件A1', '常备件A2'],
      },
      {
        primaryCategory: 'B工具类',
        secondaryCategories: ['检测工具B1', '日常工具B2', '防护工具B3'],
      },
      {
        primaryCategory: 'C物资类',
        secondaryCategories: ['应急物资C1', '防疫物资C2'],
      },
      {
        primaryCategory: 'D消耗类',
        secondaryCategories: ['运维耗材D1', '办公耗材D2'],
      },
    ]);

    expect(getInventorySecondaryCategoryOptions('B工具类')).toEqual([
      '检测工具B1',
      '日常工具B2',
      '防护工具B3',
    ]);
    expect(getInventorySecondaryCategoryOptions('未知分类')).toEqual([]);
    expect(isInventoryNewItemCategoryPair('C物资类', '防疫物资C2')).toBe(
      true,
    );
    expect(isInventoryNewItemCategoryPair('C物资类', '办公耗材D2')).toBe(
      false,
    );
  });
});
