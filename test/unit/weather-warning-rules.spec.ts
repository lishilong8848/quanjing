import { getWeatherWarningActionTemplate } from '../../server/modules/weather-warning/weather-warning-action-templates';
import type { QWeatherWarningItem } from '../../server/modules/bitable-sync/bitable-sync.service';
import {
  isActiveWeatherWarning,
  normalizeWeatherWarningColor,
  normalizeWeatherWarningType,
  selectWeatherGuardDecision,
  type WeatherWarningRule,
} from '../../server/modules/weather-warning/weather-warning-rules';

const NOW_MS = Date.parse('2026-08-04T00:00:00.000Z');

function weatherWarning(overrides: Record<string, string | undefined> = {}) {
  return {
    id: 'warning-default',
    type: '高温',
    level: '橙色',
    status: '发布',
    pubTime: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('weather warning guard rules', () => {
  it('maps a high-temperature orange warning to level three guard', () => {
    const rules: WeatherWarningRule[] = [
      { warningType: '高温', warningColor: 'orange', guardLevel: '三级戒备' },
    ];

    const decision = selectWeatherGuardDecision(
      [
        weatherWarning({
          id: 'high-temp-orange',
          type: ' 高 温 预警 ',
          level: ' Orange ',
        }),
      ],
      rules,
      NOW_MS,
    );

    expect(decision.guardLevel).toBe('三级戒备');
    expect(decision.matchedWarnings).toEqual([
      expect.objectContaining({
        id: 'high-temp-orange',
        type: '高温',
        color: 'orange',
        guardLevel: '三级戒备',
      }),
    ]);
  });

  it('maps a rainstorm red warning to level one while leaving unmapped yellow active', () => {
    const rules: WeatherWarningRule[] = [
      { warningType: '暴雨', warningColor: 'red', guardLevel: '一级戒备' },
    ];

    const decision = selectWeatherGuardDecision(
      [
        weatherWarning({ id: 'rainstorm-red', type: '暴雨', level: '红色' }),
        weatherWarning({ id: 'high-temp-yellow', type: '高温', level: '黄色' }),
      ],
      rules,
      NOW_MS,
    );

    expect(decision.guardLevel).toBe('一级戒备');
    expect(decision.matchedWarnings.map((warning) => warning.id)).toEqual([
      'rainstorm-red',
    ]);
    expect(decision.unmatchedWarnings.map((warning) => warning.id)).toEqual([
      'high-temp-yellow',
    ]);
    expect(decision.activeWarnings.map((warning) => warning.id)).toEqual([
      'rainstorm-red',
      'high-temp-yellow',
    ]);
  });

  it('does not select a guard level for empty warnings or rules', () => {
    expect(selectWeatherGuardDecision([], [], NOW_MS)).toMatchObject({
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [],
      activeWarnings: [],
    });
    expect(
      selectWeatherGuardDecision([weatherWarning()], [], NOW_MS),
    ).toMatchObject({
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [expect.objectContaining({ id: 'warning-default' })],
      activeWarnings: [expect.objectContaining({ id: 'warning-default' })],
    });
  });

  it.each([
    '解除',
    '已解除',
    '失效',
    '已失效',
    '取消',
    '撤销',
    '终止',
    '结束',
    '过期',
    'cancelled',
    'expired',
  ])('treats terminal status %s as inactive', (status) => {
    expect(isActiveWeatherWarning(weatherWarning({ status }), NOW_MS)).toBe(
      false,
    );
  });

  it('does not treat active English status text containing terminal words as terminal', () => {
    expect(
      isActiveWeatherWarning(weatherWarning({ status: 'released' }), NOW_MS),
    ).toBe(true);
    expect(
      isActiveWeatherWarning(
        weatherWarning({ status: 'not cancelled' }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it('treats a missing status as active but rejects invalid, elapsed, and current end times', () => {
    expect(
      isActiveWeatherWarning(weatherWarning({ status: undefined }), NOW_MS),
    ).toBe(true);
    expect(
      isActiveWeatherWarning(
        weatherWarning({
          endTime: '2026-08-04T00:00:01.000Z',
        }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      isActiveWeatherWarning(
        weatherWarning({
          endTime: '2026-08-04T00:00:00.000Z',
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      isActiveWeatherWarning(
        weatherWarning({
          endTime: '2026-08-03T23:59:59.000Z',
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      isActiveWeatherWarning(weatherWarning({ endTime: '待定' }), NOW_MS),
    ).toBe(false);
  });

  it('rejects invalid or timezone-free timestamps while accepting zone-qualified QWeather ISO timestamps', () => {
    expect(
      isActiveWeatherWarning(
        weatherWarning({ endTime: '2026-02-30T00:00:00.000Z' }),
        Date.parse('2026-02-01T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isActiveWeatherWarning(
        weatherWarning({ endTime: '2026-08-03T10:00:00' }),
        Date.parse('2026-08-03T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isActiveWeatherWarning(
        weatherWarning({ endTime: '2026-08-03T10:00+08:00' }),
        Date.parse('2026-08-03T00:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('returns false for invalid warning records and filters invalid warning and rule entries', () => {
    const invalidWarning = null as unknown as QWeatherWarningItem;
    const invalidRule = null as unknown as WeatherWarningRule;

    expect(isActiveWeatherWarning(invalidWarning, NOW_MS)).toBe(false);
    expect(
      selectWeatherGuardDecision([invalidWarning], [invalidRule], NOW_MS),
    ).toEqual({
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [],
      activeWarnings: [],
    });
  });

  it('normalizes warning colors and types before matching Base rules', () => {
    expect(normalizeWeatherWarningColor(' 红色预警 ')).toBe('red');
    expect(normalizeWeatherWarningColor('ORANGE')).toBe('orange');
    expect(normalizeWeatherWarningColor(' yellow ')).toBe('yellow');
    expect(normalizeWeatherWarningColor('蓝色')).toBe('blue');
    expect(normalizeWeatherWarningColor('紫色')).toBeNull();
    expect(normalizeWeatherWarningType(' 高 温 预 警 ')).toBe('高温');
    expect(normalizeWeatherWarningType('  暴  雨  ')).toBe('暴雨');
  });

  it('retains and sorts every matched warning with its own guard level independently of incoming Base record order', () => {
    const rules: WeatherWarningRule[] = [
      { warningType: '暴雨', warningColor: 'red', guardLevel: '一级戒备' },
      { warningType: '大风', warningColor: 'red', guardLevel: '一级戒备' },
      { warningType: '雷电', warningColor: 'red', guardLevel: '一级戒备' },
      { warningType: '高温', warningColor: 'orange', guardLevel: '一级戒备' },
      { warningType: '台风', warningColor: 'red', guardLevel: '二级戒备' },
    ];
    const warnings = [
      weatherWarning({
        id: 'wind-red-z',
        type: '大风',
        level: '红色',
        pubTime: '2026-08-04T01:00:00.000Z',
      }),
      weatherWarning({
        id: 'storm-red-b',
        type: '暴雨',
        level: '红色',
        pubTime: '2026-08-04T02:00:00.000Z',
      }),
      weatherWarning({
        id: 'storm-red-a',
        type: '雷电',
        level: '红色',
        pubTime: '2026-08-04T02:00:00.000Z',
      }),
      weatherWarning({
        id: 'high-temp-orange',
        type: '高温',
        level: '橙色',
        pubTime: '2026-08-04T05:00:00.000Z',
      }),
      weatherWarning({
        id: 'typhoon-red-level-two',
        type: '台风',
        level: '红色',
        pubTime: '2026-08-04T06:00:00.000Z',
      }),
      weatherWarning({
        id: 'unmapped-blue',
        type: '冰雹',
        level: '蓝色',
        pubTime: '2026-08-04T07:00:00.000Z',
      }),
    ];

    const decision = selectWeatherGuardDecision(warnings, rules, NOW_MS);
    const reversedDecision = selectWeatherGuardDecision(
      [...warnings].reverse(),
      rules,
      NOW_MS,
    );

    expect(decision.guardLevel).toBe('一级戒备');
    expect(decision.matchedWarnings.map((warning) => warning.id)).toEqual([
      'storm-red-a',
      'storm-red-b',
      'wind-red-z',
      'high-temp-orange',
      'typhoon-red-level-two',
    ]);
    expect(
      decision.matchedWarnings.map((warning) => warning.guardLevel),
    ).toEqual(['一级戒备', '一级戒备', '一级戒备', '一级戒备', '二级戒备']);
    expect(
      reversedDecision.matchedWarnings.map((warning) => warning.id),
    ).toEqual(decision.matchedWarnings.map((warning) => warning.id));
    expect(decision.unmatchedWarnings.map((warning) => warning.id)).toEqual([
      'unmapped-blue',
    ]);
    expect(decision.activeWarnings.map((warning) => warning.id)).toEqual(
      warnings.map((warning) => warning.id),
    );
  });

  it('breaks otherwise-equal matched warning ties by typeName independently of input order', () => {
    const rules: WeatherWarningRule[] = [
      { warningType: '暴雨', warningColor: 'red', guardLevel: '一级戒备' },
    ];
    const alpha = weatherWarning({
      id: 'same-warning',
      type: '暴雨',
      typeName: 'alpha',
      level: '红色',
      title: '同一预警',
      startTime: '2026-08-04T01:00:00.000Z',
      pubTime: '2026-08-04T02:00:00.000Z',
    });
    const beta = weatherWarning({
      ...alpha,
      typeName: 'beta',
    });

    const decision = selectWeatherGuardDecision([beta, alpha], rules, NOW_MS);
    const reversedDecision = selectWeatherGuardDecision(
      [alpha, beta],
      rules,
      NOW_MS,
    );

    expect(decision.matchedWarnings.map((warning) => warning.typeName)).toEqual(
      ['alpha', 'beta'],
    );
    expect(
      reversedDecision.matchedWarnings.map((warning) => warning.typeName),
    ).toEqual(decision.matchedWarnings.map((warning) => warning.typeName));
  });
});

describe('weather warning action templates', () => {
  it('returns the confirmed level one actions in order', () => {
    expect(getWeatherWarningActionTemplate('一级戒备')).toEqual([
      '相关人员Stand by，要求相关设备供应商指定1名及以上应急人员Stand by；',
      '在“重要事件通报群”飞书群进行预警通报（注意：预警首次通报结束后，直至真实发生前，无需进行反复通报），并将重保戒备检查结果在群内进行同步；',
      '现场关键设备备件物资清点；填写《重保戒备检查表-物资检查清单》；',
      '协调设备供应商在附近或同地的供应商库房进行定向备件储备（如：空调，UPS，配电柜等相关备件）；',
      '按需进行关键应急物资区域借调/采购；',
    ]);
  });

  it('returns the confirmed level two actions in order', () => {
    expect(getWeatherWarningActionTemplate('二级戒备')).toEqual([
      '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
      '现场团队进行内部预警通报；',
      '明确现场 5*8 岗人员备份情况，如有值守要求，明确排班信息，无特殊情况不得随意调换班/请假；',
      '对现场在用/摆放物资进行清点盘查，如相关安全防护用品、常用仪表及仪器；',
    ]);
  });

  it('returns the confirmed level three actions in order', () => {
    expect(getWeatherWarningActionTemplate('三级戒备')).toEqual([
      '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
      '现场团队进行内部预警通报；',
      '明确戒备期间相关人员，填写《重保戒备检查表-重保联络清单》，启动重保戒备检查，填写《重保戒备检查表》中对应检查页，并排查问题清零；',
      '明确戒备期间现场 7*24 岗值班人员排班信息，无特殊情况不得随意调换班/请假；',
      '应急储备物资清点，填写《重保戒备检查表-物资检查清单》，应急物资可用性检查、物资排查问题清零；',
    ]);
  });

  it('returns independent arrays and no actions for an unknown or empty level', () => {
    const initial = getWeatherWarningActionTemplate('一级戒备');
    initial[0] = '已修改';

    expect(getWeatherWarningActionTemplate('一级戒备')[0]).toBe(
      '相关人员Stand by，要求相关设备供应商指定1名及以上应急人员Stand by；',
    );
    expect(getWeatherWarningActionTemplate(null)).toEqual([]);
    expect(getWeatherWarningActionTemplate('未知' as never)).toEqual([]);
    expect(getWeatherWarningActionTemplate('__proto__' as never)).toEqual([]);
    expect(getWeatherWarningActionTemplate('constructor' as never)).toEqual([]);
  });
});
