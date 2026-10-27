import type { WeatherWarningSnapshot } from '../../shared/api.interface';
import {
  buildWeatherWarningCard,
  buildWeatherWarningReminderCard,
  buildWeatherWarningResolvedCard,
  escapeLarkMarkdown,
} from '../../server/modules/weather-warning/weather-warning-card';

type JsonObject = Record<string, unknown>;

const CHECKLIST_URL = 'https://vnet.feishu.cn/wiki/Hs4fwlplAijAgskmBnkcEDMvnKc';
const LEGACY_APPROVAL_URL =
  'https://vnet.feishu.cn/share/base/form/shrcneofD8Ahc8650YU6hIuPpTe';
const REGISTRATION_URL =
  'https://app.sjhl.online/nantong/monthly-schedule?weatherGuardRegistration=1&warningId=warning-high-temperature-orange&source=feishu-card';

const levelOneActions = [
  '相关人员Stand by，要求相关设备供应商指定1名及以上应急人员Stand by；',
  '在“重要事件通报群”飞书群进行预警通报，并将重保戒备检查结果在群内进行同步；',
  '现场关键设备备件物资清点；填写《重保戒备检查表-物资检查清单》；',
  '协调设备供应商在附近或同地的供应商库房进行定向备件储备（如：空调，UPS，配电柜等相关备件）；',
  '按需进行关键应急物资区域借调/采购；',
] as const;

const levelTwoActions = [
  '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
  '现场团队进行内部预警通报；',
  '明确现场5*8岗人员备份情况，如有值守要求，明确排班信息，无特殊情况不得随意调换班/请假；',
  '对现场在用/摆放物资进行清点盘查，如相关安全防护用品、常用仪表及仪器；',
] as const;

const levelThreeSnapshot: WeatherWarningSnapshot = {
  status: 'active',
  sourceState: 'fresh',
  snapshotAt: '2026-08-04T08:00:00+08:00',
  lastSuccessAt: '2026-08-04T08:00:00+08:00',
  guardLevel: '三级戒备',
  matchedWarnings: [
    {
      id: 'warning-high-temperature-orange',
      title: '南通市气象台发布高温橙色预警',
      type: '高温',
      color: 'orange',
      guardLevel: '三级戒备',
      startTime: '2026-08-04T07:00:00+08:00',
      endTime: '2026-08-05T07:00:00+08:00',
    },
  ],
  unmatchedWarnings: [],
  actions: [
    '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
    '现场团队进行内部预警通报；',
    '明确戒备期间相关人员，填写《重保戒备检查表-重保联络清单》，启动重保戒备检查，填写《重保戒备检查表》中对应检查页，并排查问题清零；',
    '明确戒备期间现场7*24岗值班人员排班信息，无特殊情况不得随意调换班/请假；',
    '应急储备物资清点，填写《重保戒备检查表-物资检查清单》，应急物资可用性检查、物资排查问题清零；',
  ],
  weather: {
    temperature: '31°C',
    feelsLike: '34°C',
    humidity: '75%',
    windDirection: '东风',
    windScale: '3级',
    observedAt: '2026-08-04T08:00:00+08:00',
  },
  checkSummary: {
    device: 'completed',
    environment: 'pending',
    disaster: 'completed',
    materials: 'completed',
    contacts: 'completed',
    managerConfirmation: 'pending',
    abnormalSummaries: [],
  },
  requiredCheckKeys: [
    'device',
    'environment',
    'disaster',
    'materials',
    'contacts',
    'managerConfirmation',
  ],
  canSendTest: true,
};

const completedChecks = {
  device: 'completed',
  environment: 'completed',
  disaster: 'completed',
  materials: 'completed',
  contacts: 'completed',
  managerConfirmation: 'completed',
} as const;

const levelThreeBuildingProgress: NonNullable<
  WeatherWarningSnapshot['buildingProgress']
> = {
  available: true,
  buildings: [
    {
      building: 'H楼',
      recordAt: '2026-08-04T08:05:00+08:00',
      checks: {
        ...completedChecks,
        environment: 'abnormal',
        disaster: 'pending',
      },
      abnormalSummaries: ['环境温度偏高'],
    },
    {
      building: 'A楼',
      recordAt: '2026-08-04T08:01:00+08:00',
      checks: completedChecks,
      abnormalSummaries: [],
    },
    {
      building: 'C楼',
      recordAt: '2026-08-04T08:03:00+08:00',
      checks: {
        ...completedChecks,
        device: 'abnormal',
        environment: 'pending',
        contacts: 'not_started',
      },
      abnormalSummaries: ['设备告警待处理'],
    },
    {
      building: 'B楼',
      recordAt: '2026-08-04T08:02:00+08:00',
      checks: {
        ...completedChecks,
        managerConfirmation: 'pending',
      },
      abnormalSummaries: [],
    },
    {
      building: '110站',
      recordAt: '2026-08-04T08:06:00+08:00',
      checks: completedChecks,
      abnormalSummaries: [],
    },
  ],
  missingRegistrationBuildings: ['D楼', 'E楼'],
  unassignedRecordCount: 0,
  incompleteItems: [
    {
      building: 'B楼',
      key: 'managerConfirmation',
      label: '机房经理确认',
      state: 'pending',
    },
    {
      building: 'C楼',
      key: 'device',
      label: '设备安全',
      state: 'abnormal',
      detail: '设备告警待处理',
    },
    {
      building: 'C楼',
      key: 'environment',
      label: '环境安全',
      state: 'pending',
    },
    {
      building: 'C楼',
      key: 'contacts',
      label: '联络清单',
      state: 'not_started',
    },
    {
      building: 'D楼',
      key: 'registration',
      label: '未提交戒备登记',
      state: 'missing_registration',
    },
    {
      building: 'E楼',
      key: 'registration',
      label: '未提交戒备登记',
      state: 'missing_registration',
    },
    {
      building: 'H楼',
      key: 'environment',
      label: '环境安全',
      state: 'abnormal',
      detail: '环境温度偏高',
    },
    {
      building: 'H楼',
      key: 'disaster',
      label: '灾害专项',
      state: 'pending',
    },
  ],
};

function collectByTag(value: unknown, tag: string): JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectByTag(item, tag));
  }
  if (!value || typeof value !== 'object') return [];

  const object = value as JsonObject;
  return [
    ...(object.tag === tag ? [object] : []),
    ...Object.values(object).flatMap((item) => collectByTag(item, tag)),
  ];
}

function collectContent(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectContent);
  if (!value || typeof value !== 'object') return [];

  const object = value as JsonObject;
  return [
    ...(typeof object.content === 'string' ? [object.content] : []),
    ...Object.values(object).flatMap(collectContent),
  ];
}

function cardWithGuardLevel(
  guardLevel: WeatherWarningSnapshot['guardLevel'],
): WeatherWarningSnapshot {
  return {
    ...levelThreeSnapshot,
    guardLevel,
  };
}

describe('weather warning Card 2.0', () => {
  it('renders a first-alert-only card while registration and progress are paused', () => {
    const card = buildWeatherWarningCard({
      snapshot: levelThreeSnapshot,
      testMessage: false,
      showProgress: false,
    });
    const content = collectContent(card).join('\n');

    expect(content).toContain('南通市气象台发布高温橙色预警');
    expect(content).toContain(escapeLarkMarkdown('相关人员7*24 On call'));
    expect(content).toContain('下载重保检查单');
    expect(content).not.toContain('提交戒备登记');
    expect(content).not.toContain('执行进度');
    expect(content).not.toContain('最近登记');
    expect(JSON.stringify(card)).not.toContain('weatherGuardRegistration');
  });

  it('renders the compact initial level-three warning hierarchy for a test message', () => {
    const card = buildWeatherWarningCard({
      snapshot: levelThreeSnapshot,
      testMessage: true,
      registrationUrl: REGISTRATION_URL,
    });
    const content = collectContent(card).join('\n');

    expect(card).toMatchObject({
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
        enable_forward: false,
      },
      header: {
        template: 'yellow',
        title: {
          content: '南通天气预警 · 三级戒备',
        },
        subtitle: {
          content: '首次通报 · 08-04 08:00',
        },
      },
    });
    expect(
      ((card.config as JsonObject).summary as JsonObject).content as string,
    ).toBe('【测试】南通天气预警 · 三级戒备');
    const header = card.header as JsonObject;
    const textTags = header.text_tag_list as JsonObject[];
    expect(
      textTags.map((tag) => (tag.text as JsonObject).content as string),
    ).toEqual(['测试', '高温橙色预警']);
    expect(content).toContain('测试');
    expect(content).toContain('高温');
    expect(content).toContain('橙色');
    expect(content).toContain('31℃');
    expect(content).toContain('75%');
    expect(content).toContain('东风 3级');
    expect(content).toContain('08&#45;04 07&#58;00');
    expect(content).toContain('预警开始');
    expect(content).not.toContain('体感');
    for (const action of levelThreeSnapshot.actions) {
      expect(content).toContain(escapeLarkMarkdown(action));
    }
    expect(content).toContain('环境待补充');
    expect(content).toContain('机房经理待确认');
    expect(content).toContain('执行进度');
    expect(content).toContain('最近登记');
    expect(content).toContain('已完成 4/6');
    expect(content).not.toContain('规则：重保类型对应表');
    expect(content).not.toContain('状态：');
    expect(content).not.toContain('2026-08-04T08:00:00+08:00');
    expect(collectByTag(card, 'collapsible_panel')).toEqual([
      expect.objectContaining({
        expanded: false,
        background_color: 'grey-50',
      }),
    ]);
    const bodyElements = ((card.body as JsonObject).elements ??
      []) as JsonObject[];
    expect(bodyElements.map((element) => element.tag)).toEqual([
      'div',
      'div',
      'column_set',
      'collapsible_panel',
    ]);
    expect(card.body).toMatchObject({
      padding: '12px',
      vertical_spacing: '8px',
    });
    expect(
      collectByTag(card, 'standard_icon').map((icon) => icon.token),
    ).toEqual(['warning_outlined', 'done_outlined']);
    expect(JSON.stringify(card).length).toBeLessThan(30_000);
  });

  it('renders a compact green resolved card without status prose, actions, or buttons', () => {
    const card = buildWeatherWarningResolvedCard({
      warning: levelThreeSnapshot.matchedWarnings[0],
      firstNotifiedAt: '2026-08-04T00:10:00.000Z',
      closedAt: '2026-08-04T06:20:00.000Z',
      highestGuardLevel: '三级戒备',
      testMessage: true,
    });
    const content = collectContent(card).join('\n');
    const header = card.header as JsonObject;

    expect(card).toMatchObject({
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
        enable_forward: false,
      },
      header: {
        template: 'green',
        title: { content: '南通天气预警 · 已结束' },
        subtitle: { content: '结束通报 · 08-04 14:20' },
        icon: { token: 'done_outlined' },
      },
      body: {
        padding: '12px',
        vertical_spacing: '8px',
      },
    });
    expect(((card.config as JsonObject).summary as JsonObject).content).toBe(
      '【测试】南通天气预警 · 已结束',
    );
    expect(
      (header.text_tag_list as JsonObject[]).map(
        (tag) => (tag.text as JsonObject).content,
      ),
    ).toEqual(['测试', '已结束', '高温橙色预警', '三级戒备']);
    expect(content).toContain('南通市气象台发布高温橙色预警');
    expect(content).toContain('08&#45;04 08&#58;10');
    expect(content).toContain('08&#45;04 14&#58;20');
    expect(content).toContain('6小时10分');
    expect(content).toContain('最高戒备');
    expect(content).not.toContain('当前状态');
    expect(content).not.toContain('如后续再次触发');
    expect(content).not.toContain('戒备要求');
    expect(collectByTag(card, 'button')).toHaveLength(0);
    expect(collectByTag(card, 'collapsible_panel')).toHaveLength(0);
    expect(JSON.stringify(card).length).toBeLessThan(12_000);
  });

  it('adds canonical temperature and humidity units without duplicating them', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        weather: {
          ...levelThreeSnapshot.weather,
          temperature: '27',
          feelsLike: '28°C',
          humidity: '95',
        },
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const content = collectContent(card).join('\n');

    expect(content).toContain('27℃');
    expect(content).toContain('95%');
    expect(content).not.toContain('28℃');
    expect(content).not.toContain('28°C℃');
    expect(content).not.toContain('95%%');
  });

  it.each([
    ['一级戒备', 'red'],
    ['二级戒备', 'orange'],
    ['三级戒备', 'yellow'],
  ] as const)('uses a %s semantic header', (guardLevel, template) => {
    const card = buildWeatherWarningCard({
      snapshot: cardWithGuardLevel(guardLevel),
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });

    expect((card.header as JsonObject).template).toBe(template);
  });

  it('uses neutral header tags for null and unknown warning colors', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        guardLevel: null,
        matchedWarnings: [
          { ...levelThreeSnapshot.matchedWarnings[0], color: null },
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            id: 'warning-unknown-color',
            color: 'violet' as never,
          },
        ],
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const header = card.header as JsonObject;
    const textTags = header.text_tag_list as JsonObject[];

    expect(header.template).toBe('grey');
    expect(textTags.map((tag) => tag.color)).toEqual(['neutral', 'neutral']);
    expect(textTags.map((tag) => tag.color)).not.toContain('grey');
  });

  it('rejects calendar-invalid ISO timestamps instead of displaying a normalized date', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        snapshotAt: '2026-02-30T08:00:00+08:00',
        lastSuccessAt: '2026-02-30T08:00:00+08:00',
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const header = card.header as JsonObject;
    const content = collectContent(card).join('\n');

    expect((header.subtitle as JsonObject).content).toBe(
      '首次通报 · 时间未获取',
    );
    expect(content).not.toContain('2026-02-30');
    expect(content).not.toContain('2026&#45;02&#45;30');
  });

  it('renders UTC timestamps in Asia/Shanghai and handles a day rollover', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        snapshotAt: '2026-08-04T20:30:00.000Z',
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });

    expect(((card.header as JsonObject).subtitle as JsonObject).content).toBe(
      '首次通报 · 08-05 04:30',
    );
  });

  it('renders full level-one and level-two action templates with abnormal and not-started checks', () => {
    const scenarios = [
      {
        guardLevel: '一级戒备' as const,
        template: 'red',
        actions: levelOneActions,
      },
      {
        guardLevel: '二级戒备' as const,
        template: 'orange',
        actions: levelTwoActions,
      },
    ] as const;

    for (const scenario of scenarios) {
      const card = buildWeatherWarningCard({
        snapshot: {
          ...levelThreeSnapshot,
          guardLevel: scenario.guardLevel,
          actions: [...scenario.actions],
          requiredCheckKeys: ['materials', 'managerConfirmation'],
          checkSummary: {
            ...levelThreeSnapshot.checkSummary,
            materials: 'abnormal',
            managerConfirmation: 'not_started',
          },
        },
        testMessage: false,
        registrationUrl: REGISTRATION_URL,
      });
      const content = collectContent(card).join('\n');

      expect((card.header as JsonObject).template).toBe(scenario.template);
      for (const action of scenario.actions) {
        expect(content).toContain(escapeLarkMarkdown(action));
      }
      expect(content).toContain('重保物资异常待处理');
      expect(content).toContain('机房经理未启动');
      expect(content).toContain('已完成 0/2');
      expect(content).not.toContain('设备已完成');
      expect(content).not.toContain('环境待补充');
    }
  });

  it('renders all seven buildings in fixed order with a compact aggregate and per-building status', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        buildingProgress: levelThreeBuildingProgress,
      },
      testMessage: true,
      registrationUrl: REGISTRATION_URL,
    });
    const progress = collectByTag(card, 'div').find((element) =>
      collectContent(element).some((content) => content.includes('已登记 5/7')),
    );
    const content = collectContent(progress).join('\n');

    expect(progress).toBeDefined();
    expect(content).toContain('楼栋进度');
    expect(content).toContain('已登记 5/7 · 完成 24/42 · 异常 2');
    expect(progress?.fields as JsonObject[]).toHaveLength(7);
    expect(collectContent(progress?.fields)).toEqual([
      expect.stringContaining('A楼 6/6'),
      expect.stringContaining('B楼 5/6'),
      expect.stringContaining('C楼 3/6'),
      expect.stringContaining('D楼 0/6'),
      expect.stringContaining('E楼 0/6'),
      expect.stringContaining('H楼 4/6'),
      expect.stringContaining('110站 6/6'),
    ]);
    expect(content).toContain('B楼 5/6 · 待办 1');
    expect(content).toContain('C楼 3/6 · 异常 1 · 待办 2');
    expect(content).toContain('D楼 0/6 · 未登记');
    expect(content).toContain('H楼 4/6 · 异常 1 · 待办 1');
    expect(content).not.toContain('设备已完成');
    expect(JSON.stringify(card).length).toBeLessThan(30_000);
  });

  it('excludes not-required environment checks from building totals and status', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        requiredCheckKeys: [
          'device',
          'disaster',
          'materials',
          'contacts',
          'managerConfirmation',
        ],
        buildingProgress: levelThreeBuildingProgress,
      },
      registrationUrl: REGISTRATION_URL,
    });

    const content = collectContent(card).join('\n');
    expect(content).toContain('H楼 4/5 · 待办 1');
    expect(content).not.toContain('H楼 4/6 · 异常 1 · 待办 1');
    expect(content).toContain('完成 21/35');
  });

  it('infers a legacy snapshot check scope from warning type and color instead of guard level', () => {
    const legacySnapshot: WeatherWarningSnapshot = {
      ...levelThreeSnapshot,
      requiredCheckKeys: undefined,
    };
    const legacyCard = buildWeatherWarningCard({
      snapshot: legacySnapshot,
      registrationUrl: REGISTRATION_URL,
    });
    const buildingCard = buildWeatherWarningCard({
      snapshot: {
        ...legacySnapshot,
        buildingProgress: levelThreeBuildingProgress,
      },
      registrationUrl: REGISTRATION_URL,
    });

    const legacyContent = collectContent(legacyCard).join('\n');
    const buildingContent = collectContent(buildingCard).join('\n');
    expect(legacyContent).toContain('已完成 4/5');
    expect(legacyContent).not.toContain('环境待补充');
    expect(buildingContent).toContain('H楼 4/5 · 待办 1');
    expect(buildingContent).toContain('完成 21/35');
    expect(buildingContent).not.toContain('H楼 4/6 · 异常 1 · 待办 1');
  });

  it('renders an explicit not-required check as no check instead of not started', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        checkSummary: {
          ...levelThreeSnapshot.checkSummary,
          environment: 'not_required',
        },
      },
      registrationUrl: REGISTRATION_URL,
    });

    const content = collectContent(card).join('\n');
    expect(content).toContain('环境无需检查');
    expect(content).not.toContain('环境未启动');
  });

  it('shows an unavailable building-progress state without inventing zero progress', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        buildingProgress: {
          available: false,
          buildings: [],
          missingRegistrationBuildings: [],
          unassignedRecordCount: 0,
          incompleteItems: [],
        },
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const content = collectContent(card).join('\n');

    expect(content).toContain('楼栋进度暂不可用');
    expect(content).not.toContain('已登记 0/7');
    expect(content).not.toContain('已完成 4/6');
  });

  it('renders only the checklist and guard-registration open-url buttons in business order', () => {
    const card = buildWeatherWarningCard({
      snapshot: levelThreeSnapshot,
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const buttons = collectByTag(card, 'button');

    expect(buttons).toHaveLength(2);
    expect(
      buttons.map((button) => (button.text as JsonObject).content),
    ).toEqual(['提交戒备登记', '下载重保检查单']);
    expect(buttons.map((button) => button.type)).toEqual([
      'primary_filled',
      'default',
    ]);
    expect(buttons.map((button) => button.behaviors)).toEqual([
      [{ type: 'open_url', default_url: REGISTRATION_URL }],
      [{ type: 'open_url', default_url: CHECKLIST_URL }],
    ]);
    expect(JSON.stringify(card)).toContain(CHECKLIST_URL);
    expect(JSON.stringify(card)).toContain(REGISTRATION_URL);
    expect(JSON.stringify(card)).not.toContain(LEGACY_APPROVAL_URL);
    expect(collectByTag(card, 'form')).toHaveLength(0);
    expect(collectByTag(card, 'person')).toHaveLength(0);
    expect(JSON.stringify(card)).not.toContain('callback');
    expect(
      collectByTag(card, 'column').map((column) => ({
        width: column.width,
        weight: column.weight,
      })),
    ).toEqual([
      { width: 'weighted', weight: 1 },
      { width: 'weighted', weight: 1 },
    ]);
  });

  it('uses only supported Card 2.0 properties on column elements', () => {
    const card = buildWeatherWarningCard({
      snapshot: levelThreeSnapshot,
      testMessage: true,
      registrationUrl: REGISTRATION_URL,
    });
    const columns = collectByTag(card, 'column');

    expect(columns.length).toBeGreaterThan(0);
    expect(
      columns.every(
        (column) =>
          !Object.prototype.hasOwnProperty.call(column, 'corner_radius'),
      ),
    ).toBe(true);
  });

  it('renders a compact test reminder card with concrete building and incomplete item details', () => {
    const card = buildWeatherWarningReminderCard({
      snapshot: levelThreeSnapshot,
      testMessage: true,
      reminderAt: '2026-08-04T14:00:00.000Z',
      registrationUrl: REGISTRATION_URL,
      incompleteItems: [
        {
          building: 'A栋',
          label: '环境安全',
          state: 'pending',
        },
        {
          building: 'A栋',
          label: '灾害专项',
          state: 'not_started',
        },
        {
          building: 'H栋',
          label: '物资清单',
          state: 'abnormal',
          detail: '备用电池数量不足',
        },
      ],
    });
    const content = collectContent(card).join('\n');
    const buttons = collectByTag(card, 'button');

    expect(card).toMatchObject({
      schema: '2.0',
      header: {
        template: 'yellow',
        title: {
          content: '重保检查催办 · 三级戒备',
        },
        subtitle: {
          content: '仍有 3 项未完成 · 08-04 22:00',
        },
      },
    });
    expect(
      ((card.config as JsonObject).summary as JsonObject).content as string,
    ).toBe('【测试】重保检查催办 · 三级戒备');
    expect(
      ((card.header as JsonObject).text_tag_list as JsonObject[]).map(
        (tag) => (tag.text as JsonObject).content as string,
      ),
    ).toEqual(['测试', '高温橙色预警']);
    expect(content).toContain('测试');
    expect(content).toContain('A栋');
    expect(content).toContain('环境安全');
    expect(content).toContain('待检查');
    expect(content).toContain('灾害专项');
    expect(content).toContain('未开始');
    expect(content.match(/A栋/gu)).toHaveLength(1);
    expect(content).toContain('H栋');
    expect(content).toContain('物资清单');
    expect(content).toContain('存在异常');
    expect(content).toContain('备用电池数量不足');
    expect(
      buttons.map((button) => (button.text as JsonObject).content),
    ).toEqual(['提交戒备登记', '下载重保检查单']);
    expect(buttons.map((button) => button.behaviors)).toEqual([
      [{ type: 'open_url', default_url: REGISTRATION_URL }],
      [{ type: 'open_url', default_url: CHECKLIST_URL }],
    ]);
    expect(JSON.stringify(card)).toContain(CHECKLIST_URL);
    expect(JSON.stringify(card)).toContain(REGISTRATION_URL);
    expect(JSON.stringify(card)).not.toContain(LEGACY_APPROVAL_URL);
    expect(JSON.stringify(card).length).toBeLessThan(30_000);
    expect(
      (((card.body as JsonObject).elements ?? []) as JsonObject[]).map(
        (element) => element.tag,
      ),
    ).toEqual(['markdown', 'column_set', 'markdown']);
    expect(content).not.toContain('规则：重保类型对应表');
    expect(content).not.toContain('状态：');
  });

  it('keeps multiple-warning metadata compact and omits count chatter', () => {
    const dangerousType = '<at id=all></at> [x](https://x.y)';
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        matchedWarnings: [
          levelThreeSnapshot.matchedWarnings[0],
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            id: 'warning-thunder-yellow',
            type: dangerousType,
            color: 'yellow',
          },
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            id: 'warning-rain-blue',
            type: '\u66b4\u96e8',
            color: 'blue',
          },
        ],
        unmatchedWarnings: [
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            id: 'warning-unmatched-wind',
            type: '\u5927\u98ce',
            color: 'blue',
            guardLevel: null,
          },
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            id: 'warning-unmatched-rain',
            type: '\u66b4\u96e8',
            color: 'yellow',
            guardLevel: null,
          },
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            id: 'warning-unmatched-lightning',
            type: '\u96f7\u7535',
            color: 'orange',
            guardLevel: null,
          },
        ],
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const content = collectContent(card).join('\n');

    expect(content).not.toContain(
      '\u53e6\u6709 1 \u6761\u89c4\u5219\u547d\u4e2d\u9884\u8b66\uff0c\u5df2\u7eb3\u5165\u5224\u5b9a',
    );
    expect(content).not.toContain(
      '\u53e6\u6709 3 \u6761\u672a\u547d\u4e2d\u89c4\u5219\u9884\u8b66\uff0c\u4ec5\u4f9b\u5173\u6ce8',
    );
    expect(content).toContain(escapeLarkMarkdown(dangerousType));
    expect(content).not.toContain('<at');
    expect(content).not.toContain('&#38;#60;');
    expect(JSON.stringify(card).length).toBeLessThan(30_000);
  });

  it('escapes untrusted warning text exactly once without creating mentions or links', () => {
    const dangerousText = '<at id=all></at> [链接](https://bad.example)';
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        matchedWarnings: [
          {
            ...levelThreeSnapshot.matchedWarnings[0],
            title: dangerousText,
          },
        ],
        actions: [dangerousText],
        weather: { ...levelThreeSnapshot.weather, temperature: dangerousText },
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const content = collectContent(card).join('\n');
    const escaped =
      '&#60;at id=all&#62;&#60;/at&#62; &#91;链接&#93;&#40;https&#58;//bad.example&#41;';

    expect(escapeLarkMarkdown(dangerousText)).toBe(escaped);
    expect(content).toContain(escaped);
    expect(content).not.toContain('<at');
    expect(content).not.toContain('[链接]');
    expect(content).not.toContain('(https://bad.example)');
    expect(content).not.toContain('&#38;#60;');
    expect(content).not.toContain('https://bad.example');
  });

  it('does not expose an invalid runtime guard-level value in the card header', () => {
    const card = buildWeatherWarningCard({
      snapshot: {
        ...levelThreeSnapshot,
        guardLevel: '<at id=all></at>' as never,
        snapshotAt: '<at id=all></at>',
      },
      testMessage: false,
      registrationUrl: REGISTRATION_URL,
    });
    const header = card.header as JsonObject;

    expect((header.title as JsonObject).content).toBe(
      '南通天气预警 · 未匹配戒备等级',
    );
    expect((header.subtitle as JsonObject).content).toBe(
      '首次通报 · 时间未获取',
    );
    expect(collectContent(card).join('\n')).not.toContain('<at');
  });
});
