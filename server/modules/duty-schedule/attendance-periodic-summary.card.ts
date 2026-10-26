import type { AttendanceAnomaly } from './attendance-automation.rules';
import type { AttendancePeriodicSummaryPeriod } from './attendance-periodic-summary.scheduler';

export interface AttendancePeriodicSummaryCardInput {
  period: AttendancePeriodicSummaryPeriod;
  startDate: string;
  endDate: string;
  fetchedAt: string;
  checkedCount: number;
  anomalies: AttendanceAnomaly[];
  followUpUrl?: string;
}

interface AttendancePeriodicSummaryCard {
  schema: '2.0';
  config: {
    update_multi: true;
    width_mode: 'default';
    enable_forward: false;
  };
  header: {
    template: 'red' | 'green' | 'orange';
    title: { tag: 'plain_text'; content: string };
    icon: { tag: 'standard_icon'; token: 'warning_colorful' };
  };
  body: {
    direction: 'vertical';
    padding: '12px';
    vertical_spacing: '12px';
    elements: CardBlock[];
  };
}

type CategoryKey = 'late' | 'early' | 'missing' | 'other';
type CardElement =
  | {
      tag: 'markdown';
      content: string;
      text_size?: 'heading-3';
    }
  | {
      tag: 'button';
      type: 'primary_filled';
      width: 'fill';
      text: { tag: 'plain_text'; content: string };
      behaviors: Array<{ type: 'open_url'; default_url: string }>;
    };
type CardBlock = {
  tag: 'column_set';
  flex_mode: 'none';
  columns: [
    {
      tag: 'column';
      width: 'weighted';
      weight: 1;
      direction: 'vertical';
      vertical_spacing: '8px';
      padding: string;
      background_style?: 'grey-50';
      elements: CardElement[];
    },
  ];
};

const BUILDING_ORDER = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
const CATEGORY_ORDER: CategoryKey[] = ['late', 'early', 'missing', 'other'];
const CATEGORY_LABELS: Record<CategoryKey, string> = {
  late: '迟到',
  early: '早退',
  missing: '未打卡且未补卡',
  other: '其他待核验',
};
const MAX_VISIBLE_PEOPLE_PER_CATEGORY = 16;
const MAX_VISIBLE_BUILDINGS = 7;

export function buildAttendancePeriodicSummaryCard(
  input: AttendancePeriodicSummaryCardInput,
): AttendancePeriodicSummaryCard {
  assertInput(input);
  const categorized = input.anomalies.map((item) => ({
    item,
    category: categoryOf(item.reason),
  }));
  const people = new Set(
    input.anomalies.map((item) => `${item.building}\u0000${item.name}`),
  );
  const buildings = new Set(input.anomalies.map((item) => item.building));
  const categoryCounts = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [
      category,
      categorized.filter((item) => item.category === category).length,
    ]),
  ) as Record<CategoryKey, number>;
  const periodLabel = input.period === 'weekly' ? '上周' : '上月';
  const empty = input.checkedCount === 0;
  const normal = !empty && input.anomalies.length === 0;
  const elements: CardBlock[] = [
    block(
      [
        {
          tag: 'markdown',
          text_size: 'heading-3',
          content: empty
            ? '**暂无可核验记录**'
            : normal
              ? `**考勤正常 · 共核验 ${input.checkedCount} 项**`
              : `**异常 ${people.size} 人 · ${input.anomalies.length} 项 | 涉及 ${buildings.size} 个楼栋**`,
        },
        {
          tag: 'markdown',
          content: `<font color="grey">统计区间 ${plain(input.startDate)} 至 ${plain(input.endDate)} · 数据截至 ${plain(input.fetchedAt)}</font>`,
        },
        ...(empty
          ? [
              {
                tag: 'markdown' as const,
                content:
                  '<font color="orange">多维表中未找到该周期的有效考勤归档，请核查归档任务。</font>',
              },
            ]
          : normal
            ? [
                {
                  tag: 'markdown' as const,
                  content:
                    '<font color="green">未发现迟到、早退或未打卡且未补卡</font>',
                },
              ]
            : [
                {
                  tag: 'markdown' as const,
                  content: CATEGORY_ORDER.filter(
                    (category) => categoryCounts[category] > 0,
                  )
                    .map(
                      (category) =>
                        `**${CATEGORY_LABELS[category]} ${categoryCounts[category]}**`,
                    )
                    .join(' | '),
                },
              ]),
      ],
      true,
    ),
  ];

  if (input.anomalies.length > 0) {
    const visibleBuildings = [...buildings]
      .sort(compareBuildings)
      .slice(0, MAX_VISIBLE_BUILDINGS);
    for (const building of visibleBuildings) {
      const entries = categorized.filter(
        ({ item }) => item.building === building,
      );
      const buildingPeople = new Set(entries.map(({ item }) => item.name));
      const lines = CATEGORY_ORDER.flatMap((category) => {
        const matches = entries.filter((entry) => entry.category === category);
        if (matches.length === 0) return [];
        const counts = new Map<string, number>();
        matches.forEach(({ item }) =>
          counts.set(item.name, (counts.get(item.name) || 0) + 1),
        );
        const allPeople = [...counts].sort(([left], [right]) =>
          left.localeCompare(right, 'zh-CN'),
        );
        const visiblePeople = allPeople.slice(
          0,
          MAX_VISIBLE_PEOPLE_PER_CATEGORY,
        );
        const peopleText = [
          ...visiblePeople.map(([name, count]) =>
            count > 1 ? `${plain(name, 32)}×${count}` : plain(name, 32),
          ),
          ...(allPeople.length > visiblePeople.length
            ? [`另 ${allPeople.length - visiblePeople.length} 人`]
            : []),
        ].join('、');
        return [
          `**${CATEGORY_LABELS[category]} ${matches.length}** ${peopleText}`,
        ];
      });
      elements.push(
        block([
          {
            tag: 'markdown',
            content: [
              `**${plain(building, 40)} · ${buildingPeople.size} 人 / ${entries.length} 项**`,
              ...lines,
            ].join('\n'),
          },
        ]),
      );
    }
    if (buildings.size > visibleBuildings.length) {
      elements.push(
        block([
          {
            tag: 'markdown',
            content: `<font color="grey">另 ${buildings.size - visibleBuildings.length} 个楼栋未展开，异常数量已计入总体。</font>`,
          },
        ]),
      );
    }
  }

  elements.push(
    block([
      {
        tag: 'markdown',
        content:
          '<font color="grey">口径：查询考勤归档多维表的最新有效结果；已补卡并转为正常的记录不计入。</font>',
      },
    ]),
  );
  if (input.followUpUrl) {
    const followUpUrl = normalizeHttpUrl(input.followUpUrl);
    if (!followUpUrl) throw new Error('考勤通晒异常跟进链接无效');
    elements.push(
      block([
        {
          tag: 'button',
          type: 'primary_filled',
          width: 'fill',
          text: { tag: 'plain_text', content: '异常跟进' },
          behaviors: [{ type: 'open_url', default_url: followUpUrl }],
        },
      ]),
    );
  }

  const card: AttendancePeriodicSummaryCard = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
    },
    header: {
      template: empty ? 'orange' : normal ? 'green' : 'red',
      title: {
        tag: 'plain_text',
        content: `${periodLabel}考勤通晒 · ${input.startDate} 至 ${input.endDate}`,
      },
      icon: { tag: 'standard_icon', token: 'warning_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '12px',
      elements,
    },
  };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 30 * 1_024) {
    throw new Error('考勤通晒卡片超过消息大小限制');
  }
  return card;
}

function categoryOf(reason: AttendanceAnomaly['reason']): CategoryKey {
  if (reason === '迟到') return 'late';
  if (reason === '早退') return 'early';
  if (['未打卡', '未查询到有效打卡', '旷工'].includes(reason)) {
    return 'missing';
  }
  return 'other';
}

function compareBuildings(left: string, right: string): number {
  const leftIndex = BUILDING_ORDER.indexOf(left);
  const rightIndex = BUILDING_ORDER.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) {
    return (
      (leftIndex < 0 ? BUILDING_ORDER.length : leftIndex) -
      (rightIndex < 0 ? BUILDING_ORDER.length : rightIndex)
    );
  }
  return left.localeCompare(right, 'zh-CN');
}

function block(elements: CardElement[], shaded = false): CardBlock {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        direction: 'vertical',
        vertical_spacing: '8px',
        padding: shaded ? '10px' : '0px',
        ...(shaded ? { background_style: 'grey-50' as const } : {}),
        elements,
      },
    ],
  };
}

function assertInput(input: AttendancePeriodicSummaryCardInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.startDate)) {
    throw new Error('考勤通晒开始日期无效');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.endDate)) {
    throw new Error('考勤通晒结束日期无效');
  }
  if (!Number.isInteger(input.checkedCount) || input.checkedCount < 0) {
    throw new Error('考勤通晒核验数量无效');
  }
}

function plain(value: unknown, maxLength = 200): string {
  return String(value ?? '')
    .replace(/[<>*_`\[\]\\]/gu, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}
