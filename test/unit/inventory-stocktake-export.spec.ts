import * as XLSX from 'xlsx-js-style';
import type { StocktakeLine, StocktakeSheet } from '../../shared/inventory-stocktake.interface';
import { buildStocktakeExport } from '../../client/src/pages/InventoryManagement/inventory-stocktake.export';

function sheet(count = 127): StocktakeSheet {
  return {
    building: 'C楼', month: '2026-11', scope: 'sample',
    lines: Array.from({ length: count }, (_, i) => ({
      inventory: {
        recordId: `rec${i}`, building: 'C楼', name: i === 0 ? '=HYPERLINK("https://example.invalid")' : `物品${i}`,
        sku: `000${i}`, primaryCategory: '耗材', secondaryCategory: '配件', specification: '8*500',
        brand: '示例品牌', location: `C-1F-112值班室-${i}-2F`, unit: '个', quantity: 1,
      },
      actualQuantity: i === 0 ? null : i === 1 ? 0 : 1,
      status: i === 2 ? 'confirmed' : 'draft',
      confirmer: i === 2 ? { name: '示例人员' } : null,
      confirmedAt: i === 2 ? '2026-11-19T01:00:00Z' : null,
      note: i === 1 ? '实盘为零' : '', reasons: i % 2 ? ['movement'] : ['random'],
    } as StocktakeLine)),
  } as StocktakeSheet;
}

function roundtrip(input: StocktakeSheet) {
  const result = buildStocktakeExport(input, new Date('2026-11-19T01:02:03Z'));
  const bytes = XLSX.write(result.workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  const parsed = XLSX.read(bytes, { type: 'buffer', cellStyles: true });
  const ws = parsed.Sheets[parsed.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
  return { ...result, ws, rows };
}

describe('按楼栋导出盘点完整清单', () => {
  it('exports every record across pages with quantity, confirmation and date values intact', () => {
    const input = sheet();
    const before = JSON.stringify(input);
    const result = roundtrip(input);
    expect(result.count).toBe(127);
    expect(result.rows).toHaveLength(132);
    expect(result.filename).toBe('C楼_2026-11_重点抽盘清单_20261119090203.xlsx');
    expect(result.rows.slice(5).map(row => row[6])).toEqual(expect.arrayContaining(input.lines.map(line => line.inventory.sku)));
    expect(new Set(result.rows.slice(5).map(row => row[6])).size).toBe(127);
    const pending = result.rows.find(row => row[6] === '0000')!;
    expect(pending.slice(11, 16)).toEqual([1, '', '', '', '待盘']);
    const zero = result.rows.find(row => row[6] === '0001')!;
    expect(zero.slice(11, 16)).toEqual([1, 0, -1, '', '已暂存']);
    expect(zero[16]).toBe('上月出入库');
    const confirmed = result.rows.find(row => row[6] === '0002')!;
    expect(confirmed.slice(12, 16)).toEqual([1, 0, '示例人员', '已确认']);
    expect(confirmed[18]).toBe('2026/11/19 09:00:00');
    expect(result.ws['!autofilter']?.ref).toBe('A5:S132');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps SKU leading zeroes and formula-looking user content as literal strings', () => {
    const { ws, rows } = roundtrip(sheet(1));
    expect(rows[5][5]).toBe('=HYPERLINK("https://example.invalid")');
    expect(ws.F6.t).toBe('s');
    expect(ws.F6.f).toBeUndefined();
    expect(ws.G6.v).toBe('0000');
    expect(ws.G6.t).toBe('s');
  });

  it('leaves difference blank for uncounted zero-stock records and handles a large full list', () => {
    const input = sheet(5000);
    input.lines[0].inventory.quantity = 0;
    const result = buildStocktakeExport(input);
    const ws = result.workbook.Sheets['重点抽盘'];
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
    const pending = rows.find(row => row[6] === '0000')!;
    expect(pending.slice(11, 16)).toEqual([0, '', '', '', '待盘']);
    expect(result.count).toBe(5000);
    expect(rows).toHaveLength(5005);
  });

  it('supports historical months and review lists and rejects empty or mixed-building data', () => {
    const input = sheet(2);
    input.month = '2026-01'; input.scope = 'review';
    const result = roundtrip(input);
    expect(result.workbook.SheetNames).toEqual(['库存核盘']);
    expect(result.filename).toContain('2026-01_库存核盘清单');
    expect(() => buildStocktakeExport(sheet(0))).toThrow('暂无');
    input.lines[1].inventory.building = 'A楼';
    expect(() => buildStocktakeExport(input)).toThrow('楼栋不一致');
  });
});
