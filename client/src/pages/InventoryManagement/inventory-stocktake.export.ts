import * as XLSX from 'xlsx-js-style';
import type { StocktakeSheet } from '@shared/inventory-stocktake.interface';
import { groupStocktakeLines } from './inventory-stocktake.logic';

const HEADERS = [
  '序号', '楼栋', '盘点月份', '一级分类', '二级分类', '物品名称', 'SKU',
  '规格型号', '品牌', '库位', '单位', '账面数量', '实盘数量', '差异数量',
  '确认人', '盘点状态', '抽盘原因', '备注 / 差异说明', '确认时间',
];

function dateTime(value: string | Date | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function buildStocktakeExport(sheet: StocktakeSheet, now = new Date()) {
  if (!sheet.lines.length) throw new Error('当前楼栋暂无可导出的盘点记录');
  if (sheet.lines.some(line => line.inventory.building !== sheet.building))
    throw new Error('清单楼栋不一致，请刷新后再导出');
  const label = sheet.scope === 'review' ? '库存核盘' : '重点抽盘';
  const lines = groupStocktakeLines(sheet.lines).flatMap(group => group.lines);
  const rows: (string | number)[][] = [
    [`${sheet.building}${label}清单`],
    ['盘点月份', sheet.month, '楼栋', sheet.building, '记录数', lines.length],
    ['导出时间', dateTime(now), '数据范围', '当前楼栋全部已保存记录（不含未保存草稿）'],
    [],
    HEADERS,
    ...lines.map((line, index) => {
      const item = line.inventory;
      return [
        index + 1, sheet.building, sheet.month, item.primaryCategory, item.secondaryCategory,
        item.name, item.sku, item.specification, item.brand, item.location, item.unit,
        item.quantity, line.actualQuantity ?? '',
        line.actualQuantity === null ? '' : Number((line.actualQuantity - item.quantity).toFixed(6)),
        line.confirmer?.name || '', line.status === 'confirmed' ? '已确认' : line.actualQuantity === null ? '待盘' : '已暂存',
        line.reasons.map(reason => reason === 'movement' ? '上月出入库' : '随机抽盘').join('、'),
        line.note, dateTime(line.confirmedAt),
      ];
    }),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: HEADERS.length - 1 } }];
  worksheet['!cols'] = [6, 9, 12, 14, 14, 28, 16, 24, 16, 30, 8, 12, 12, 12, 14, 12, 20, 36, 23].map(wch => ({ wch }));
  worksheet['!rows'] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 24 }, { hpt: 8 }, { hpt: 26 }];
  worksheet['!autofilter'] = { ref: `A5:S${rows.length}` };
  for (const key of Object.keys(worksheet)) {
    if (key.startsWith('!')) continue;
    const cell = worksheet[key], { r } = XLSX.utils.decode_cell(key);
    cell.s = {
      font: { name: '微软雅黑', sz: r === 0 ? 16 : 10, bold: r === 0 || r === 4, color: { rgb: r === 0 || r === 4 ? 'FFFFFF' : '334155' } },
      fill: { fgColor: { rgb: r === 0 || r === 4 ? '174EA6' : r > 4 && r % 2 ? 'F1F5F9' : 'FFFFFF' } },
      alignment: { vertical: 'center', wrapText: true },
    };
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, label);
  const stamp = dateTime(now).replace(/[^0-9]/g, '');
  return { workbook, filename: `${sheet.building}_${sheet.month}_${label}清单_${stamp}.xlsx`, count: lines.length };
}

export function downloadStocktakeExport(sheet: StocktakeSheet) {
  const result = buildStocktakeExport(sheet);
  XLSX.writeFile(result.workbook, result.filename, { bookType: 'xlsx', compression: true });
  return result.count;
}
