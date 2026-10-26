import type { Point } from './motion';
export interface CampusStop {
  id: string;
  name: string;
  label: Point;
  route: Point[];
  polygon: string;
}
export const CAMPUS_STOPS: readonly CampusStop[] = [
  {
    id: 'gate',
    name: '园区大门',
    label: [808, 318],
    route: [[816, 329]],
    polygon: '',
  },
  {
    id: 'H',
    name: 'H 楼',
    label: [715, 269],
    route: [
      [784, 349],
      [753, 340],
    ],
    polygon: '657,285 722,252 759,264 759,280 695,316 657,299',
  },
  {
    id: 'C',
    name: 'C 楼',
    label: [563, 296],
    route: [
      [737, 375],
      [697, 408],
      [666, 427],
      [636, 410],
      [603, 391],
    ],
    polygon: '470,275 510,254 678,309 678,342 617,384 445,311 445,299',
  },
  {
    id: 'D',
    name: 'D 楼',
    label: [372, 215],
    route: [
      [537, 365],
      [480, 342],
      [397, 299],
    ],
    polygon: '287,204 342,182 465,224 465,253 398,282 277,240 277,222',
  },
  {
    id: 'B',
    name: 'B 楼',
    label: [581, 199],
    route: [
      [451, 276],
      [487, 251],
      [535, 266],
      [617, 285],
    ],
    polygon: '498,190 537,172 674,200 674,234 626,263 483,225 483,208',
  },
  {
    id: 'A',
    name: 'A 楼',
    label: [408, 140],
    route: [
      [680, 257],
      [698, 230],
      [677, 195],
      [570, 170],
      [493, 155],
      [480, 176],
    ],
    polygon: '330,134 382,121 479,145 479,177 425,199 331,172',
  },
  {
    id: 'E',
    name: 'E 楼',
    label: [221, 144],
    route: [
      [453, 199],
      [417, 209],
      [361, 187],
      [316, 164],
      [309, 184],
      [260, 216],
    ],
    polygon: '156,140 214,125 300,157 300,185 250,205 144,169 144,153',
  },
  {
    id: '110',
    name: '110 站',
    label: [285, 97],
    route: [
      [184, 184],
      [143, 151],
      [208, 127],
      [244, 113],
      [300, 98],
    ],
    polygon: '244,125 304,110 329,117 329,130 271,145 244,137',
  },
];
export interface SystemInfo {
  english: string;
  title: string;
  body: string;
  app: string;
  photos: [string, string, string][];
}
export const SYSTEMS: Record<string, SystemInfo> = {
  power: {
    english: 'POWER THAT KEEPS COMPUTING',
    title: '稳定供电\n算力不息',
    body: '高压直流供电协同市电与后备电源，为关键负载提供电力保障。',
    app: '主变运行',
    photos: [
      ['HVDC 高压直流', 'ali-hvdc.jpg', '从电源到负载，守护持续供电。'],
      ['低压配电柜', 'ppt-distribution.jpg', '双路配电，连接电源与关键负载。'],
      ['UPS', 'field-ups.jpg', '双变换稳压滤波，断电毫秒切换。'],
      ['后备电池', 'ppt-battery.jpg', '后备储能，为电力切换留出保障窗口。'],
      ['柴油发电机', 'ppt-generator.jpg', '应急电源，支撑持续运行。'],
      [
        '柴发并机柜',
        'field-generator-paralleling-cabinet.jpg',
        '多机并联运行，备电无缝接管。',
      ],
      [
        '柴发并机系统',
        'field-generator-paralleling-system.jpg',
        '自动并机调度，让后备电源持续可靠。',
      ],
    ],
  },
  cooling: {
    english: 'COOLING THAT FLOWS',
    title: '让冷量流动\n让算力从容',
    body: '围绕冷机、水泵、板换、冷塔与末端空调，呈现水冷系统的关键设备。',
    app: '孪生图谱',
    photos: [
      ['冷水机组', 'ppt-chiller.jpg', '冷源、管网与末端，共同构成温度保障。'],
      ['循环水泵', 'ppt-pumps.jpg', '推动水循环，将冷量送往末端。'],
      ['板式换热器', 'ppt-plate.jpg', '隔离水回路，完成热量交换。'],
      ['冷却塔', 'cooling-tower.jpg', '将系统热量排向室外环境。'],
      ['末端空调', 'ppt-terminal.jpg', '通过换热与送风，维持机房环境。'],
      ['恒湿机', 'field-humidifier.jpg', '湿度精准恒控，守护设备环境。'],
      [
        '无负压补水装置',
        'field-non-negative-pressure-makeup.jpg',
        '稳压持续补水，让管网压力保持恒定。',
      ],
      [
        '旁滤装置',
        'field-side-stream-filter.jpg',
        '循环水旁路过滤，保持水质洁净并减少结垢。',
      ],
      [
        '加药装置',
        'field-water-treatment-dosing.jpg',
        '药剂精准投加，让循环水水质稳定达标。',
      ],
    ],
  },
  weak: {
    english: 'CONNECTED AND AWARE',
    title: '全域感知\n协同守护',
    body: '连接动力环境监测、视频监控、门禁与综合布线，让设备状态和园区安全清晰可见。',
    app: '孪生图谱',
    photos: [
      [
        '蓄电池在线监测',
        'ppt-monitoring.jpg',
        '从单体电池到监测系统，采集关键状态。',
      ],
      ['交换机', 'field-network-switch.jpg', '数据交换枢纽，保障网络畅通。'],
      [
        'DDC 控制柜',
        'field-ddc-control-cabinet.jpg',
        '楼宇机电控制中枢，自动感知并调节设备。',
      ],
      [
        '阀控柜',
        'field-valve-control-cabinet.jpg',
        '阀门集中管控，让联动调节精准自动。',
      ],
    ],
  },
  fire: {
    english: 'PROTECTION IN EVERY DETAIL',
    title: '多层防护\n守住安全',
    body: '火灾探测、报警联动与气体灭火设备，共同构成机房消防保障。',
    app: '风险排查',
    photos: [
      ['气体灭火瓶组', 'ppt-fire-gas.jpg', '以专业设施，守护关键空间。'],
      [
        '吸气式烟雾探测',
        'ppt-fire-detection.jpg',
        '持续采样，让火灾预警更早一步。',
      ],
      [
        '灭火装置与管路',
        'ppt-fire-manifold.jpg',
        '瓶组、阀件与输送管路，共同组成灭火设施。',
      ],
      [
        '水喷雾系统',
        'field-water-mist-system.jpg',
        '细雾降温隔氧，高效控制并扑灭火情。',
      ],
      [
        '消防主机',
        'field-fire-alarm-panel.jpg',
        '火警集中监测，联动设备统一调度。',
      ],
      [
        '预作用系统',
        'field-preaction-system.jpg',
        '先探测后出水，降低误喷风险。',
      ],
    ],
  },
};
export interface AppPreview {
  image?: string;
  stamp: string;
  english: string;
  lead: string;
  features: [string, string][];
}
export const APP_PREVIEWS: Record<string, AppPreview> = {
  今日航图: {
    image: 'panorama-snapshot.png',
    stamp: '历史快照 · 2026-07-28',
    english: 'DAILY OPERATIONS',
    lead: '一屏掌握，今日运行全貌。',
    features: [
      ['园区运行概览', '集中呈现运行、人员、能效与负载信息。'],
      ['110 站与楼栋', '查看主变运行状态和各楼机房运行信息。'],
      ['关键事件', '汇总变更、检修、维保与重点事项。'],
    ],
  },
  今日重点: {
    english: 'DAILY PRIORITIES',
    lead: '把今天要关注的事，放在一起。',
    stamp: '按现有页面结构制作 · 布局示意',
    features: [
      ['封网关注', '查看当日生效或跨日延续的封网。'],
      ['重点变更与事件', '聚合符合关注条件的变更和事件。'],
      ['其他关注', '集中查看补充事项，减少来回查找。'],
    ],
  },
  排班中心: {
    image: 'schedule-snapshot.png',
    stamp: '页面快照 · 2026-09-09',
    english: 'PEOPLE & SCHEDULE',
    lead: '每一栋楼，每一个班次。',
    features: [
      ['日期与楼栋', '按日期查看七栋楼的值班安排。'],
      ['近期值班概览', '集中查看前一天、当天和后一天人员。'],
      ['天气与保障', '结合天气、封网和人员信息安排工作。'],
    ],
  },
  主变运行: {
    image: 'power-dashboard-snapshot.png',
    stamp: '历史快照 · 2026-06-12',
    english: 'POWER OPERATIONS',
    lead: '看清园区电力运行。',
    features: [
      ['运行指标', '查看主变和园区运行指标。'],
      ['运行关系', '结合拓扑查看供电设施关系。'],
    ],
  },
  孪生图谱: {
    image: 'twin-snapshot.png',
    stamp: '历史快照 · 2026-07-23',
    english: 'DIGITAL TWIN',
    lead: '从园区，到每一个设备。',
    features: [
      ['空间与设备', '结合园区和楼栋定位设施。'],
      ['系统关系', '按系统查看设备关联与运行信息。'],
    ],
  },
};
