import type { WeatherGuardLevel } from './weather-warning-rules';

const ACTION_TEMPLATES: Record<WeatherGuardLevel, readonly string[]> = {
  一级戒备: [
    '相关人员Stand by，要求相关设备供应商指定1名及以上应急人员Stand by；',
    '在“重要事件通报群”飞书群进行预警通报（注意：预警首次通报结束后，直至真实发生前，无需进行反复通报），并将重保戒备检查结果在群内进行同步；',
    '现场关键设备备件物资清点；填写《重保戒备检查表-物资检查清单》；',
    '协调设备供应商在附近或同地的供应商库房进行定向备件储备（如：空调，UPS，配电柜等相关备件）；',
    '按需进行关键应急物资区域借调/采购；',
  ],
  二级戒备: [
    '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
    '现场团队进行内部预警通报；',
    '明确现场 5*8 岗人员备份情况，如有值守要求，明确排班信息，无特殊情况不得随意调换班/请假；',
    '对现场在用/摆放物资进行清点盘查，如相关安全防护用品、常用仪表及仪器；',
  ],
  三级戒备: [
    '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
    '现场团队进行内部预警通报；',
    '明确戒备期间相关人员，填写《重保戒备检查表-重保联络清单》，启动重保戒备检查，填写《重保戒备检查表》中对应检查页，并排查问题清零；',
    '明确戒备期间现场 7*24 岗值班人员排班信息，无特殊情况不得随意调换班/请假；',
    '应急储备物资清点，填写《重保戒备检查表-物资检查清单》，应急物资可用性检查、物资排查问题清零；',
  ],
};

export function getWeatherWarningActionTemplate(
  guardLevel: WeatherGuardLevel | null | undefined,
): string[] {
  if (
    typeof guardLevel !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ACTION_TEMPLATES, guardLevel)
  ) {
    return [];
  }

  return [...ACTION_TEMPLATES[guardLevel]];
}
