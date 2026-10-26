import type {
  WeatherWarningBuildingProgressSummary,
  WeatherWarningCheckKey,
  WeatherWarningCheckState,
  WeatherWarningDisplayWarning,
  WeatherWarningGuardLevel,
  WeatherWarningSnapshot,
} from '@shared/api.interface';
import { resolveWeatherWarningCheckScope } from './weather-warning-check-scope';
import { WEATHER_GUARD_BUILDINGS } from './weather-warning-registration.rules';

const CHECKLIST_URL = 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const TEST_TAG_LABEL = '测试';
const MAX_WARNING_TAGS = 2;
const MAX_ACTIONS = 5;
const MAX_REMINDER_ITEMS = 20;
const LARK_MD_HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&#38;',
  '*': '&#42;',
  '~': '&#126;',
  '>': '&#62;',
  '<': '&#60;',
  '[': '&#91;',
  ']': '&#93;',
  '(': '&#40;',
  ')': '&#41;',
  '#': '&#35;',
  ':': '&#58;',
  _: '&#95;',
  '\\': '&#92;',
  '`': '&#96;',
  '{': '&#123;',
  '}': '&#125;',
  '!': '&#33;',
  '|': '&#124;',
  '+': '&#43;',
  '-': '&#45;',
};
const LARK_MD_SPECIAL_CHARACTER_PATTERN = /[&*~><[\]()#:_\\`{}!|+-]/gu;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

type CardTemplate = 'red' | 'orange' | 'yellow' | 'green' | 'grey';
type HeaderTextTagColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'neutral';

interface CardPalette {
  template: CardTemplate;
  tagColor: HeaderTextTagColor;
  background: string;
  border: string;
  text: 'red' | 'orange' | 'yellow' | 'grey';
}

interface CheckStatePresentation {
  label: string;
  color: 'green' | 'orange' | 'red' | 'grey';
}

export interface WeatherWarningReminderItem {
  building: string;
  label: string;
  state: WeatherWarningCheckState | 'missing_registration';
  detail?: string;
}

export function buildWeatherWarningCard(input: {
  snapshot: WeatherWarningSnapshot;
  testMessage: boolean;
  registrationUrl?: string;
  showProgress?: boolean;
  notificationKind?: 'initial' | 'upgrade';
}): Record<string, unknown> {
  const { snapshot, testMessage, registrationUrl } = input;
  const showProgress = input.showProgress !== false;
  const palette = getPalette(snapshot.guardLevel);
  const title = getCardTitle(snapshot.guardLevel);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
      summary: {
        content: buildCardSummary(title, testMessage),
      },
    },
    header: {
      template: palette.template,
      title: {
        tag: 'plain_text',
        content: title,
      },
      subtitle: {
        tag: 'plain_text',
        content: `${
          input.notificationKind === 'upgrade' ? '升级通报' : '首次通报'
        } · ${formatShanghaiTimestamp(snapshot.snapshotAt) || '时间未获取'}`,
      },
      icon: {
        tag: 'standard_icon',
        token: 'warning_outlined',
      },
      text_tag_list: buildHeaderTags(snapshot, testMessage),
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: [
        buildWarningBrief(snapshot),
        ...(showProgress ? [buildCheckProgress(snapshot)] : []),
        buildButtonBlock(registrationUrl),
        buildActionsPanel(snapshot.actions, palette),
      ],
    },
  };
}

export function buildWeatherWarningResolvedCard(input: {
  warning: WeatherWarningDisplayWarning;
  firstNotifiedAt: string;
  closedAt: string;
  highestGuardLevel: WeatherWarningGuardLevel;
  testMessage: boolean;
}): Record<string, unknown> {
  const title = '南通天气预警 · 已结束';
  const warning = isWeatherWarningDisplayWarning(input.warning)
    ? input.warning
    : {
        id: 'weather-warning',
        title: '天气预警',
        type: null,
        color: null,
        guardLevel: input.highestGuardLevel,
      };
  const firstNotifiedAt = formatShanghaiTimestamp(input.firstNotifiedAt);
  const closedAt = formatShanghaiTimestamp(input.closedAt);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
      summary: {
        content: buildCardSummary(title, input.testMessage),
      },
    },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: title,
      },
      subtitle: {
        tag: 'plain_text',
        content: `结束通报 · ${closedAt || '时间未获取'}`,
      },
      icon: {
        tag: 'standard_icon',
        token: 'done_outlined',
      },
      text_tag_list: buildResolvedHeaderTags(
        warning,
        input.highestGuardLevel,
        input.testMessage,
      ),
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${safeMarkdown(warning.title, '天气预警', 160)}**`,
          },
          fields: [
            metricField(
              '首次通报',
              safeMarkdown(firstNotifiedAt, '未获取', 40),
            ),
            metricField('结束确认', safeMarkdown(closedAt, '未获取', 40)),
            metricField(
              '持续时间',
              safeMarkdown(
                formatDuration(input.firstNotifiedAt, input.closedAt),
                '未获取',
                40,
              ),
            ),
            metricField(
              '最高戒备',
              safeMarkdown(input.highestGuardLevel, '未获取', 40),
            ),
          ],
        },
      ],
    },
  };
}

export function buildWeatherWarningReminderCard(input: {
  snapshot: WeatherWarningSnapshot;
  incompleteItems: readonly WeatherWarningReminderItem[];
  reminderAt?: string;
  testMessage: boolean;
  registrationUrl?: string;
}): Record<string, unknown> {
  const { snapshot, testMessage, registrationUrl } = input;
  const palette = getPalette(snapshot.guardLevel);
  const incompleteItems = Array.isArray(input.incompleteItems)
    ? input.incompleteItems
    : [];
  const items = incompleteItems.slice(0, MAX_REMINDER_ITEMS);
  const omittedCount = Math.max(0, incompleteItems.length - items.length);
  const reminderAt = formatShanghaiTimestamp(input.reminderAt);
  const title = `重保检查催办 · ${getGuardLevelLabel(snapshot.guardLevel)}`;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
      summary: {
        content: buildCardSummary(title, testMessage),
      },
    },
    header: {
      template: palette.template,
      title: {
        tag: 'plain_text',
        content: title,
      },
      subtitle: {
        tag: 'plain_text',
        content: `仍有 ${incompleteItems.length} 项未完成 · ${
          reminderAt || '时间未获取'
        }`,
      },
      icon: {
        tag: 'standard_icon',
        token: 'warning_outlined',
      },
      text_tag_list: buildHeaderTags(snapshot, testMessage),
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'markdown',
          content: `**当前预警**\n${safeMarkdown(
            toWarningList(snapshot.matchedWarnings)[0]?.title,
            '已命中天气预警',
            160,
          )}`,
          text_size: 'normal',
        },
        buildButtonBlock(registrationUrl),
        {
          tag: 'markdown',
          content:
            items.length > 0
              ? [
                  `**待办明细（${incompleteItems.length}项）**`,
                  ...formatReminderGroups(items),
                  ...(omittedCount > 0
                    ? [`另有 ${omittedCount} 项，请打开戒备登记查看。`]
                    : []),
                ].join('\n')
              : '**未完成检查**\n当前未取得可催办明细。',
          text_size: 'normal',
        },
      ],
    },
  };
}

export function escapeLarkMarkdown(value: unknown): string {
  return toPlainText(value).replace(
    LARK_MD_SPECIAL_CHARACTER_PATTERN,
    (character) => LARK_MD_HTML_ENTITIES[character],
  );
}

function buildHeaderTags(
  snapshot: WeatherWarningSnapshot,
  testMessage: boolean,
): Record<string, unknown>[] {
  const warningTags = toWarningList(snapshot.matchedWarnings)
    .slice(0, MAX_WARNING_TAGS)
    .map((warning) => ({
      tag: 'text_tag',
      text: {
        tag: 'plain_text',
        content: escapeLarkMarkdown(getWarningLabel(warning)),
      },
      color: getWarningTagColor(warning.color),
    }));

  return [
    ...(testMessage
      ? [
          {
            tag: 'text_tag',
            text: {
              tag: 'plain_text',
              content: TEST_TAG_LABEL,
            },
            color: 'blue',
          },
        ]
      : []),
    ...warningTags,
  ];
}

function buildResolvedHeaderTags(
  warning: WeatherWarningDisplayWarning,
  highestGuardLevel: WeatherWarningGuardLevel,
  testMessage: boolean,
): Record<string, unknown>[] {
  return [
    ...(testMessage
      ? [
          {
            tag: 'text_tag',
            text: { tag: 'plain_text', content: TEST_TAG_LABEL },
            color: 'blue',
          },
        ]
      : []),
    {
      tag: 'text_tag',
      text: { tag: 'plain_text', content: '已结束' },
      color: 'green',
    },
    {
      tag: 'text_tag',
      text: {
        tag: 'plain_text',
        content: toPlainText(getWarningLabel(warning), 80),
      },
      color: getWarningTagColor(warning.color),
    },
    {
      tag: 'text_tag',
      text: { tag: 'plain_text', content: highestGuardLevel },
      color: getPalette(highestGuardLevel).tagColor,
    },
  ];
}

function buildWarningBrief(
  snapshot: WeatherWarningSnapshot,
): Record<string, unknown> {
  const weather = isPlainRecord(snapshot.weather) ? snapshot.weather : {};
  const warning = toWarningList(snapshot.matchedWarnings)[0];
  const warningTitle = warning
    ? safeMarkdown(warning.title, '已命中天气预警', 160)
    : '暂无规则命中的天气预警';
  const temperature = safeMarkdown(
    normalizeTemperatureMetric(weather.temperature),
    '未获取',
    80,
  );
  const humidity = safeMarkdown(
    normalizeHumidityMetric(weather.humidity),
    '未获取',
    80,
  );
  const wind = formatWind(weather.windDirection, weather.windScale);
  const warningStartedAt = safeMarkdown(
    formatShanghaiTimestamp(warning?.startTime || warning?.pubTime),
    '未获取',
    80,
  );

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${warningTitle}**`,
    },
    fields: [
      metricField('温度', temperature),
      metricField('湿度', humidity),
      metricField('风力', wind),
      metricField('预警开始', warningStartedAt),
    ],
  };
}

function buildActionsPanel(
  actions: WeatherWarningSnapshot['actions'],
  palette: CardPalette,
): Record<string, unknown> {
  const items = toTextList(actions, MAX_ACTIONS, 420);

  return {
    tag: 'collapsible_panel',
    expanded: false,
    background_color: 'grey-50',
    border: {
      color: palette.border,
      corner_radius: '8px',
    },
    padding: '8px',
    vertical_spacing: '4px',
    header: {
      title: {
        tag: 'plain_text',
        content: `戒备要求 · ${items.length || 0}项`,
      },
      icon: {
        tag: 'standard_icon',
        token: 'done_outlined',
      },
      icon_position: 'left',
    },
    elements: [
      {
        tag: 'markdown',
        content:
          items.length > 0
            ? items
                .map(
                  (action, index) =>
                    `${index + 1}. ${escapeLarkMarkdown(action)}`,
                )
                .join('\n')
            : '当前未匹配到可执行的重保行动。',
        text_size: 'normal',
      },
    ],
  };
}

function buildCheckProgress(
  snapshot: WeatherWarningSnapshot,
): Record<string, unknown> {
  if (snapshot.buildingProgress) {
    return snapshot.buildingProgress.available
      ? buildBuildingProgress(snapshot, snapshot.buildingProgress)
      : buildUnavailableBuildingProgress();
  }

  return buildLegacyCheckProgress(snapshot);
}

function buildBuildingProgress(
  snapshot: WeatherWarningSnapshot,
  progress: WeatherWarningBuildingProgressSummary,
): Record<string, unknown> {
  const requiredKeys = getRequiredCheckKeys(snapshot);
  const progressByBuilding = new Map(
    progress.buildings.map((item) => [item.building, item] as const),
  );
  let registeredCount = 0;
  let completedCount = 0;
  let abnormalCount = 0;

  const fields = WEATHER_GUARD_BUILDINGS.map((building) => {
    const buildingProgress = progressByBuilding.get(building);
    if (!buildingProgress) {
      return buildingProgressField(
        `${building} 0/${requiredKeys.length} · 未登记`,
      );
    }

    registeredCount += 1;
    const completed = requiredKeys.filter(
      (key) => buildingProgress.checks[key] === 'completed',
    ).length;
    const abnormal = requiredKeys.filter(
      (key) => buildingProgress.checks[key] === 'abnormal',
    ).length;
    const pending = requiredKeys.length - completed - abnormal;
    completedCount += completed;
    abnormalCount += abnormal;

    const statuses = [
      ...(abnormal > 0 ? [`异常 ${abnormal}`] : []),
      ...(pending > 0 ? [`待办 ${pending}`] : []),
      ...(abnormal === 0 && pending === 0 ? ['完成'] : []),
    ];
    return buildingProgressField(
      `${building} ${completed}/${requiredKeys.length} · ${statuses.join(' · ')}`,
    );
  });

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**楼栋进度**　已登记 ${registeredCount}/${WEATHER_GUARD_BUILDINGS.length} · 完成 ${completedCount}/${
        WEATHER_GUARD_BUILDINGS.length * requiredKeys.length
      } · 异常 ${abnormalCount}`,
    },
    fields,
  };
}

function buildUnavailableBuildingProgress(): Record<string, unknown> {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: "**楼栋进度**　<font color='grey'>楼栋进度暂不可用</font>",
    },
  };
}

function buildingProgressField(content: string): Record<string, unknown> {
  return {
    is_short: true,
    text: {
      tag: 'lark_md',
      content,
    },
  };
}

function buildLegacyCheckProgress(
  snapshot: WeatherWarningSnapshot,
): Record<string, unknown> {
  const checkSummary: Record<string, unknown> = isPlainRecord(
    snapshot.checkSummary,
  )
    ? snapshot.checkSummary
    : {};
  const allFields = [
    ['device', '设备', checkSummary.device, false],
    ['environment', '环境', checkSummary.environment, false],
    ['disaster', '灾害专项', checkSummary.disaster, false],
    ['materials', '重保物资', checkSummary.materials, false],
    ['contacts', '重保联络', checkSummary.contacts, false],
    ['managerConfirmation', '机房经理', checkSummary.managerConfirmation, true],
  ] as const;
  const requiredKeys = new Set(getRequiredCheckKeys(snapshot));
  const fields = allFields.filter(([key]) => requiredKeys.has(key));
  const completedCount = fields.filter(
    ([, , state]) => state === 'completed',
  ).length;

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**执行进度 · 最近登记**　已完成 ${completedCount}/${fields.length}`,
    },
    fields: fields.map(([, label, state, isManager]) => {
      const presentation = getCheckStatePresentation(state, isManager);
      return {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `<font color='${presentation.color}'>${label}${presentation.label}</font>`,
        },
      };
    }),
  };
}

function buildButtonBlock(registrationUrl?: string): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: registrationUrl ? 'bisect' : 'none',
    horizontal_spacing: '8px',
    columns: [
      ...(registrationUrl
        ? [buttonColumn('提交戒备登记', 'primary_filled', registrationUrl)]
        : []),
      buttonColumn('下载重保检查单', 'default', CHECKLIST_URL),
    ],
  };
}

function metricField(label: string, value: string): Record<string, unknown> {
  return {
    is_short: true,
    text: {
      tag: 'lark_md',
      content: `**${value}**\n<font color='grey'>${label}</font>`,
    },
  };
}

function formatReminderGroups(
  items: readonly WeatherWarningReminderItem[],
): string[] {
  const groups = new Map<string, WeatherWarningReminderItem[]>();
  for (const item of items) {
    const building = toPlainText(item.building, 40) || '未登记楼栋';
    const group = groups.get(building) ?? [];
    group.push(item);
    groups.set(building, group);
  }

  const knownBuildingOrder = new Map<string, number>(
    WEATHER_GUARD_BUILDINGS.map((building, index) => [building, index]),
  );
  return [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = knownBuildingOrder.get(left);
      const rightIndex = knownBuildingOrder.get(right);
      if (leftIndex !== undefined && rightIndex !== undefined) {
        return leftIndex - rightIndex;
      }
      if (leftIndex !== undefined) return -1;
      if (rightIndex !== undefined) return 1;
      return 0;
    })
    .map(([building, group]) => {
      const details = group.map((item) => formatReminderItemDetail(item));
      return `- **${safeMarkdown(building, '未登记楼栋', 40)}**：${details.join(
        '、',
      )}`;
    });
}

function formatReminderItemDetail(item: WeatherWarningReminderItem): string {
  const stateLabel = getReminderStateLabel(item.state);
  const detail = toPlainText(item.detail, 180);
  return `${safeMarkdown(item.label, '未命名检查项', 60)}（${stateLabel}${
    detail ? `：${escapeLarkMarkdown(detail)}` : ''
  }）`;
}

function getReminderStateLabel(
  state: WeatherWarningReminderItem['state'],
): string {
  switch (state) {
    case 'pending':
      return '待检查';
    case 'abnormal':
      return '存在异常';
    case 'not_started':
      return '未开始';
    case 'missing_registration':
      return '未登记';
    case 'completed':
    default:
      return '已完成';
  }
}

function buttonColumn(
  label: string,
  type: 'primary_filled' | 'default',
  url: string,
): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        type,
        width: 'fill',
        text: { tag: 'plain_text', content: label },
        behaviors: [{ type: 'open_url', default_url: url }],
      },
    ],
  };
}

function getPalette(guardLevel: WeatherWarningGuardLevel | null): CardPalette {
  switch (guardLevel) {
    case '一级戒备':
      return {
        template: 'red',
        tagColor: 'red',
        background: 'red-50',
        border: 'red-100',
        text: 'red',
      };
    case '二级戒备':
      return {
        template: 'orange',
        tagColor: 'orange',
        background: 'orange-50',
        border: 'orange-100',
        text: 'orange',
      };
    case '三级戒备':
      return {
        template: 'yellow',
        tagColor: 'yellow',
        background: 'yellow-50',
        border: 'yellow-100',
        text: 'yellow',
      };
    default:
      return {
        template: 'grey',
        tagColor: 'neutral',
        background: 'grey-50',
        border: 'grey-100',
        text: 'grey',
      };
  }
}

function getCardTitle(guardLevel: WeatherWarningGuardLevel | null): string {
  return `南通天气预警 · ${getGuardLevelLabel(guardLevel)}`;
}

function buildCardSummary(title: string, testMessage: boolean): string {
  return testMessage ? `【测试】${title}` : title;
}

function getGuardLevelLabel(
  guardLevel: WeatherWarningGuardLevel | null,
): string {
  switch (guardLevel) {
    case '一级戒备':
    case '二级戒备':
    case '三级戒备':
      return guardLevel;
    default:
      return '未匹配戒备等级';
  }
}

function getWarningLabel(warning: WeatherWarningDisplayWarning): string {
  const type = toPlainText(warning.type, 40) || '天气';
  return `${type}${getWarningColorLabel(warning.color)}预警`;
}

function formatDuration(startValue: unknown, endValue: unknown): string {
  const start = formatTimestamp(startValue);
  const end = formatTimestamp(endValue);
  if (!start || !end) return '';

  const durationMilliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
    return '';
  }

  const totalMinutes = Math.floor(durationMilliseconds / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    ...(days > 0 ? [`${days}天`] : []),
    ...(hours > 0 ? [`${hours}小时`] : []),
    ...(minutes > 0 || (days === 0 && hours === 0) ? [`${minutes}分`] : []),
  ];
  return parts.join('');
}

function getWarningColorLabel(
  color: WeatherWarningDisplayWarning['color'],
): string {
  switch (color) {
    case 'red':
      return '红色';
    case 'orange':
      return '橙色';
    case 'yellow':
      return '黄色';
    case 'blue':
      return '蓝色';
    default:
      return '';
  }
}

function getWarningTagColor(
  color: WeatherWarningDisplayWarning['color'],
): HeaderTextTagColor {
  switch (color) {
    case 'red':
    case 'orange':
    case 'yellow':
    case 'blue':
      return color;
    default:
      return 'neutral';
  }
}

function getCheckStatePresentation(
  value: unknown,
  isManager: boolean,
): CheckStatePresentation {
  switch (value as WeatherWarningCheckState) {
    case 'completed':
      return { label: isManager ? '已确认' : '已完成', color: 'green' };
    case 'pending':
      return { label: isManager ? '待确认' : '待补充', color: 'orange' };
    case 'abnormal':
      return { label: '异常待处理', color: 'red' };
    case 'not_required':
      return { label: '无需检查', color: 'green' };
    case 'not_started':
    default:
      return { label: '未启动', color: 'grey' };
  }
}

function getRequiredCheckKeys(
  snapshot: WeatherWarningSnapshot,
): readonly WeatherWarningCheckKey[] {
  if (Array.isArray(snapshot.requiredCheckKeys)) {
    return snapshot.requiredCheckKeys;
  }
  const warning = snapshot.matchedWarnings[0];
  return warning
    ? resolveWeatherWarningCheckScope(warning).requiredCheckKeys
    : [];
}

function normalizeTemperatureMetric(value: unknown): string {
  const text = toPlainText(value, 80);
  if (!text) return '';
  const numeric = text.replace(/\s*(?:°\s*C|℃)\s*$/iu, '').trim();
  return isFiniteMetricNumber(numeric) ? `${numeric}℃` : text;
}

function normalizeHumidityMetric(value: unknown): string {
  const text = toPlainText(value, 80);
  if (!text) return '';
  const numeric = text.replace(/\s*%\s*$/u, '').trim();
  return isFiniteMetricNumber(numeric) ? `${numeric}%` : text;
}

function isFiniteMetricNumber(value: string): boolean {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) return false;
  return Number.isFinite(Number(value));
}

function formatWind(direction: unknown, scale: unknown): string {
  const values = [toPlainText(direction, 40), toPlainText(scale, 40)].filter(
    Boolean,
  );
  return safeMarkdown(values.join(' '), '未获取', 80);
}

function safeMarkdown(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  const text = toPlainText(value, maxLength) || fallback;
  return escapeLarkMarkdown(text);
}

function toTextList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => toPlainText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function toWarningList(value: unknown): WeatherWarningDisplayWarning[] {
  return Array.isArray(value)
    ? value.filter(isWeatherWarningDisplayWarning)
    : [];
}

function isWeatherWarningDisplayWarning(
  value: unknown,
): value is WeatherWarningDisplayWarning {
  return isPlainRecord(value) && typeof value.id === 'string';
}

function toPlainText(
  value: unknown,
  maxLength = Number.MAX_SAFE_INTEGER,
): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';

  return String(value)
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function formatTimestamp(value: unknown): string {
  const timestamp = toPlainText(value, 80);
  const match = ISO_TIMESTAMP_PATTERN.exec(timestamp);
  if (!match) {
    return '';
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = '0',
    ,
    timezoneHourText,
    timezoneMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const timezoneHour = timezoneHourText ? Number(timezoneHourText) : 0;
  const timezoneMinute = timezoneMinuteText ? Number(timezoneMinuteText) : 0;

  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    timezoneHour > 23 ||
    timezoneMinute > 59
  ) {
    return '';
  }
  return timestamp;
}

function formatShanghaiTimestamp(value: unknown): string {
  const timestamp = formatTimestamp(value);
  if (!timestamp) return '';

  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return '';

  const shanghaiTime = new Date(instant + 8 * 60 * 60 * 1000);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(shanghaiTime.getUTCMonth() + 1)}-${pad(
    shanghaiTime.getUTCDate(),
  )} ${pad(shanghaiTime.getUTCHours())}:${pad(shanghaiTime.getUTCMinutes())}`;
}

function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
