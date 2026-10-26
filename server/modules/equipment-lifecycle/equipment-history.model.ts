import type { LedgerAsset } from '../../../shared/equipment-ledger.interface';
import type { EquipmentRepairHistory } from '../../../shared/equipment-history.interface';
import {
  extractDisplayText,
  extractDateTimeIso,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

export type HistoryLedgerAsset = LedgerAsset & { buildingAlias?: string };
export interface RepairAssociation {
  assetId: string | null;
  reason: string;
}
const text = (v: unknown) => extractDisplayText(v).trim();
const norm = (v: unknown) =>
  text(v)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐‑–—]/gu, '-');
const floor = (v: unknown) =>
  norm(v).match(/^(?:南通)?([A-E])(?:楼|机楼)?$/u)?.[1] || '';
const compound = (v: string) => /[,，、;；\n]|\d+#.*\d+#/u.test(v);

function family(v: unknown): string {
  const n = norm(v);
  if (!n || compound(n)) return '';
  const aliases: [RegExp, string][] = [
    [/^(?:高压|低压)?(?:柴油发电机|柴发)$/u, '柴发'],
    [/^(?:水冷|风冷)?(?:型)?(?:精密)?空调$/u, '空调'],
    [/^(?:水冷)?冷水机组$/u, '冷水机组'],
    [/^(?:铅酸阀控)?蓄电池$/u, '蓄电池'],
    [/^(?:三相)?UPS$/u, 'UPS'],
    [/^(?:HVDC|高压直流)$/u, 'HVDC'],
    [/^(?:高压|低压)?配电柜$/u, '配电柜'],
    [/^(?:开式|闭式)?冷却塔$/u, '冷却塔'],
    [/^(?:冷却泵|冷却水泵)$/u, '冷却泵'],
    [
      /^(?:冷冻泵|冷冻水泵|冷冻一次泵|冷冻二次泵|冷冻一次水泵|冷冻二次水泵)$/u,
      '冷冻泵',
    ],
    [/^(?:开式|闭式)?蓄冷罐$/u, '蓄冷罐'],
    [/^(?:三相)?ATS(?:_|-)?STS$/u, 'ATS/STS'],
    [/^(?:水冷型)?AHU$/u, 'AHU'],
    [/^(?:预作用装置|预作用阀组)$/u, '预作用'],
  ];
  return aliases.find(([pattern]) => pattern.test(n))?.[1] || n;
}
function compatible(a: unknown, b: unknown): boolean {
  if (!family(a) || family(a) !== family(b)) return false;
  return ![
    ['水冷', '风冷'],
    ['高压', '低压'],
    ['开式', '闭式'],
  ].some(
    ([x, y]) =>
      (norm(a).includes(x) && norm(b).includes(y)) ||
      (norm(a).includes(y) && norm(b).includes(x)),
  );
}

export function matchEquipmentRepair(
  assets: readonly HistoryLedgerAsset[],
  records: readonly BitableRecordItem[],
  requireBinding = true,
): Map<string, RepairAssociation> {
  const index = new Map<string, HistoryLedgerAsset[]>();
  for (const asset of assets) {
    const key = `${floor(asset.building)}|${norm(asset.sourceCode)}`;
    index.set(key, [...(index.get(key) || []), asset]);
  }
  const numbers = new Map<string, number>();
  for (const row of records) {
    const number = text(row.fields?.['维修单号']);
    if (number) numbers.set(number, (numbers.get(number) || 0) + 1);
  }
  const result = new Map<string, RepairAssociation>();
  for (const record of records) {
    const f = record.fields || {};
    const primaryFloor = text(f['所属数据中心/楼栋-使用']);
    const legacyFloor = text(f['所属数据中心/楼栋-使用-L']);
    const b = floor(primaryFloor || legacyFloor);
    const code = text(f['设备编号']) || text(f['设备编号-L']);
    const name = text(f['设备名称']) || text(f['设备名称-L']);
    const candidates = index.get(`${b}|${norm(code)}`) || [];
    const asset = candidates.length === 1 ? candidates[0] : null;
    let reason = '';
    if (!b) reason = '楼栋异常或不属于A–E';
    else if (!code || /^(?:\/|无|未填写|待确认|未知|-|—)$/u.test(norm(code)))
      reason = '缺少完整设备编号';
    else if (
      (primaryFloor &&
        legacyFloor &&
        floor(primaryFloor) !== floor(legacyFloor)) ||
      (text(f['设备编号']) &&
        text(f['设备编号-L']) &&
        norm(f['设备编号']) !== norm(f['设备编号-L'])) ||
      (text(f['设备名称']) &&
        text(f['设备名称-L']) &&
        !compatible(f['设备名称'], f['设备名称-L']))
    )
      reason = '维修身份字段冲突';
    else if ((numbers.get(text(f['维修单号'])) || 0) > 1)
      reason = '维修单号重复';
    else if (compound(code) || compound(name))
      reason = '多设备或部件编号需核查';
    else if (norm(code).match(/^([A-E])[-_]/u)?.[1] && norm(code)[0] !== b)
      reason = '设备编号与业务楼栋冲突';
    else if (!candidates.length) reason = '完整编号未命中台账';
    else if (candidates.length > 1) reason = '台账同楼同编号不唯一';
    else if (asset?.kind !== 'detail' || asset.quantity !== 1)
      reason = '集合或非单台条目';
    else if (asset.buildingAlias && floor(asset.buildingAlias) !== b)
      reason = '台账楼栋字段冲突';
    else if (!compatible(name, asset.name))
      reason = '设备名称或类别不能确认一致';
    else {
      const descriptions = [f['故障发生现象描述'], f['故障发生现象描述-L']]
        .map(norm)
        .join('\n');
      const tags = [
        ...descriptions.matchAll(
          /([A-E])\s*-\s*(\d{3})\s*-\s*(HVDC|UPS|CRAH|CRAC|GPS|TRB|AD|AH|SVG|CWP|SCHWP|PCHWP|CFE|CHL)\s*-\s*(\d+)/gu,
        ),
      ];
      if (tags.some((m) => `${m[1]}-${m[2]}-${m[3]}-${m[4]}` !== norm(code)))
        reason = '故障描述出现其他设备编号';
    }
    if (
      !reason &&
      requireBinding &&
      (text(f['台账关联状态']) !== '已关联' ||
        text(f['关联台账记录ID']) !== asset?.id)
    )
      reason = '关联待确认或关联对象已变化';
    result.set(getRecordId(record), {
      assetId: reason ? null : asset!.id,
      reason,
    });
  }
  return result;
}

export function mapEquipmentRepair(
  record: BitableRecordItem,
): EquipmentRepairHistory {
  const f = record.fields || {};
  const value = (...keys: string[]) =>
    keys.map((k) => text(f[k])).find(Boolean) || '';
  const date = (...keys: string[]) =>
    keys.map((k) => extractDateTimeIso(f[k])).find(Boolean) || null;
  return {
    id: getRecordId(record),
    repairNumber: value('维修单号'),
    status: value('流程') || '待确认',
    faultAt: date('故障发生时间-L'),
    startedAt: date('维修开始时间-L', '维修开始时间'),
    endedAt: date('维修结束时间（2026）-L', '维修结束时间'),
    fault: value('故障发生现象描述-L', '故障发生现象描述'),
    cause: value('故障维修原因-L', '故障维修原因'),
    result: value('维修进展描述-L', '维修进展描述'),
    parts: value('更换备件名称-L', '更换备件名称'),
    actions: value('后续整改措施-L', '后续整改措施'),
  };
}
