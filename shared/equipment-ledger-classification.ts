import type { LedgerAsset } from './equipment-ledger.interface';

export const LEDGER_SYSTEMS = [
  '供配电',
  '暖通',
  '弱电',
  '消防',
  '其他',
] as const;
export const LEDGER_MANAGEMENTS = ['自建楼', '代维楼', '其他楼栋'] as const;

export function ledgerManagement(building: string): string {
  if (['A楼', 'B楼', 'C楼'].includes(building)) return '自建楼';
  if (['D楼', 'E楼'].includes(building)) return '代维楼';
  return '其他楼栋';
}

export function classifyLedgerAsset(
  asset: Pick<LedgerAsset, 'name' | 'category' | 'specialty'>,
): { family: string; system: string } {
  const name = asset.name.normalize('NFKC').toUpperCase();
  const category = asset.category.normalize('NFKC').toUpperCase();
  const source = /^(?:暖通|配电|制冷|电源)设备$/u.test(category)
    ? name
    : category;
  let family = asset.category;
  if (/UPS|HVDC|高压直流/u.test(source)) {
    const ups = /UPS/u.test(name);
    const hvdc = /HVDC|高压直流/u.test(name);
    family = ups && !hvdc ? 'UPS' : hvdc && !ups ? 'HVDC' : 'UPS/HVDC待分类';
  } else if (/柴油发电|柴发/u.test(source)) family = '柴发';
  else if (/冷水机|冷机/u.test(source)) family = '冷水机组';
  else if (/空调/u.test(source)) family = '空调';
  else if (/蓄电池/u.test(source) && !/监测/u.test(source)) family = '蓄电池';
  else if (/变压器/u.test(source)) family = '变压器';
  else if (/配电柜/u.test(source)) family = '配电柜';
  if (!family || family === '未填写') family = '待分类';

  let system: string;
  if (/消防|灭火|消火栓|防火门|应急照明|疏散|预作用|雨淋/u.test(family))
    system = '消防';
  else if (
    /柴发|UPS|HVDC|蓄电池|变压器|配电|列头柜|电源切换|直流屏|无功补偿|油箱|变频器|电池监测|控制柜箱/u.test(
      family,
    )
  )
    system = '供配电';
  else if (
    /空调|冷水机|冷却塔|换热|蓄冷|湿度调节|水处理|补水|供水|泵|风机|新风|阀门|风水末端/u.test(
      family,
    )
  )
    system = '暖通';
  else if (
    /网络|服务器|工作站|存储|门禁|识别|视频|监控|通讯网关|转换|控制采集|显示|人机|机柜|入侵|安检|通道|音频|监测传感器/u.test(
      family,
    )
  )
    system = '弱电';
  else if (/空压机/u.test(family)) system = '消防';
  else system = '其他';
  return { family, system };
}
