const normalized = (value: string) =>
  value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐‑‒–—―﹣－_]/g, '-');

export function eventDeviceCode(description: string) {
  return (
    normalized(description).match(
      /(?:^|[^A-Z0-9])([A-EH]-\d{2,4}(?:-[A-Z0-9]+){2,})/,
    )?.[1] ?? ''
  );
}

export function eventBuilding(field: string, description: string) {
  const entered = field.trim();
  if (entered && entered !== '未标注') return entered;
  const title = normalized(description);
  const buildings = new Set([
    ...[...title.matchAll(/([A-EH])\s*(?:楼|栋|机楼)/g)].map(
      (match) => match[1],
    ),
    ...[
      ...title.matchAll(/(?:^|[^A-Z0-9])([A-EH])-\s*\d{1,4}(?=[^0-9]|$)/g),
    ].map((match) => match[1]),
  ]);
  return buildings.size === 1 ? `${[...buildings][0]}楼` : '未标注';
}

const specialtyByDevice: Record<string, string> = {
  UPS: '电气',
  HVDC: '电气',
  TRB: '电气',
  ATS: '电气',
  RPP: '电气',
  SVG: '电气',
  AH: '电气',
  GPSB: '电气',
  CRAH: '暖通',
  CRAHB: '暖通',
  CRAC: '暖通',
  CHL: '暖通',
  CHLB: '暖通',
  HUM: '暖通',
  LEAK: '暖通',
  DDC: '暖通',
  CWPB: '暖通',
  ES: '弱电',
  BA: '弱电',
  GW: '弱电',
};

export function eventSpecialty(field: string, description: string) {
  const entered = field.trim();
  if (entered && entered !== '未标注') return entered;
  const title = normalized(description);
  const devices = [
    ...title.matchAll(
      /(?:^|[^A-Z0-9])[A-EH]-\s*\d{1,4}[-_]?([A-Z]{2,5})(?=[^A-Z]|$)/g,
    ),
  ]
    .map((match) => specialtyByDevice[match[1]])
    .filter(Boolean);
  const categories = new Set(devices);
  if (categories.size === 1) return devices[0];
  if (categories.size > 1) return '未标注';
  if (/柴发|柴油发电|发电机|并机系统|油罐|油箱/.test(title)) return '电气';
  if (/消防排烟|烟感|火警|气体灭火|消防主机|喷淋|防火阀/.test(title))
    return '消防';
  if (
    /制冷|冷机|冷水机组|冷冻|冷却|冷塔|冷通道|空调|单元机|CRA[CH]|HUM|漏水|渗水|冷媒|温湿度|蓄冷|补水|二次泵|水泵|水池|蓄水罐|集水坑|加药|水表|空压机|压差/.test(
      title,
    )
  )
    return '暖通';
  if (
    /门禁|监控服务器|监控系统|BA(?:备用)?服务器|BMS服务器|动环服务器|视频监控|网络控制器|BA系统集成|MOS机|网关|声光/.test(
      title,
    )
  )
    return '弱电';
  if (
    /(?:^|[^A-Z])(?:AC|DC)[-_]?\d{2,4}(?=[^A-Z0-9]|$)|UAC|UPS|HVDC|变压器|直流屏|列头柜|支路开关|综保|电量仪|开关柜|配电柜|配电箱|断路器|电池|电压|电流|功率|断电|失电|失压|送电|主用电源|母线|接地电阻|普通照明|氢气浓度|综合电源/.test(
      title,
    )
  )
    return '电气';
  return '未标注';
}

function faultDescription(description: string, device: string) {
  return normalized(description)
    .replace(device, '')
    .replace(/(?:BMS|BA)(?:系统)?(?:报|发现)?|巡检(?:发现)?|维护(?:发现)?/g, '')
    .replace(/过滤器|过滤网|滤网/g, '滤网')
    .replace(/脏堵|阻塞|堵塞/g, '堵塞')
    .replace(/渗漏|渗水|漏水/g, '漏水')
    .replace(/报警|警报|告警/g, '告警')
    .replace(/空调(?=滤网)/g, '')
    .replace(/[^\p{L}\p{N}#]+/gu, '')
    .replace(/(?:告警)+$/u, '');
}

export function eventRepeatKey(description: string, building: string) {
  if (!description || description === '未填写事件描述') return '';
  const device = eventDeviceCode(description);
  const fault = faultDescription(description, device);
  if (fault.length < 2) return '';
  if (device) return `${device}|${fault}`;
  if (
    building === '未标注' ||
    !/\d{1,4}(?:#|号|层|机房|室|列|柜)/u.test(description)
  )
    return '';
  return `${building}|${fault}`;
}
