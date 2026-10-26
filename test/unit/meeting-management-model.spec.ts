import {
  filterMeetings,
  meetingMetrics,
  meetingPage,
  sortMeetings,
  meetingActivityGroups,
} from '../../client/src/pages/MeetingManagement/model';
import type { MeetingSummary } from '../../shared/meeting-management.interface';

const row = (
  id: string,
  date: string | null,
  title: string,
): MeetingSummary => ({
  id,
  date,
  title,
  weekLabel: '2026年第10周',
  scope: '机房',
  nature: '管理类',
  source: 'nantong-weekly',
  documentUrl: null,
  updatedAt: null,
  hasActions: false,
  sectionTitles: ['专业线'],
  searchText: `${title} 电气 更换电池`,
});
describe('会议清单本地筛选', () => {
  const records = [
    row('recA', null, '未填日期'),
    row('recB', '2026-03-05', '周报乙'),
    row('recC', '2026-04-02', '周报丙'),
  ];
  it('倒序且日期缺失排后，关键词搜索正文索引', () => {
    expect(
      filterMeetings(sortMeetings(records), { query: '电气 电池' }).map(
        (item) => item.id,
      ),
    ).toEqual(['recC', 'recB', 'recA']);
  });
  it('范围、性质和年份取交集，未接入分类保持空', () => {
    expect(filterMeetings(records, { scope: '客户' })).toEqual([]);
    expect(filterMeetings(records, { nature: '专业类' })).toEqual([]);
    expect(filterMeetings(records, { year: '2025' })).toEqual([]);
    expect(
      filterMeetings(records, { year: '2026', nature: '管理类' }),
    ).toHaveLength(2);
  });
  it('周次只计一次，归档记录仍保留全部', () => {
    expect(meetingMetrics(records)).toMatchObject({
      records: 3,
      weeks: 1,
      documents: 0,
      withActions: 0,
    });
  });
  it('来源和月份共同筛选，会议链接不冒充资料，附件计入资料覆盖', () => {
    const rows: MeetingSummary[] = [
      {
        ...records[1],
        source: 'training',
        resources: [
          {
            kind: 'meeting',
            label: '会议链接',
            url: 'https://example.feishu.cn/vc/PUBLIC_EXAMPLE_SOURCE',
          },
        ],
      },
      {
        ...records[2],
        id: 'ali-meeting:recC',
        source: 'ali-meeting',
        attachmentNames: ['截图.png'],
      },
    ];
    expect(
      filterMeetings(rows, {
        source: 'ali-meeting',
        month: '2026-04',
        content: 'documents',
      }),
    ).toHaveLength(1);
    expect(
      filterMeetings(rows, { source: 'training', content: 'documents' }),
    ).toEqual([]);
    expect(meetingMetrics(rows).documents).toBe(1);
  });
  it('业务活动维度遵循同一筛选，客户与培训可交叉，未知性质不推断成专业', () => {
    const rows: MeetingSummary[] = [
      {
        ...records[1],
        scope: '客户',
        nature: '培训类',
        source: 'ali-meeting',
        hasActions: false,
      },
      {
        ...records[2],
        nature: '专业类',
        source: 'ali-meeting',
        documentUrl: null,
      },
      { ...records[1], id: 'recUnknown', nature: '未分类', hasActions: true },
    ];
    expect(meetingActivityGroups(rows).map((g) => g.rows.length)).toEqual([
      3, 1, 1, 1,
    ]);
    const filtered = filterMeetings(rows, { month: '2026-03' });
    expect(meetingActivityGroups(filtered).map((g) => g.rows.length)).toEqual([
      2, 1, 0, 1,
    ]);
    expect(meetingActivityGroups([]).every((g) => g.rows.length === 0)).toBe(
      true,
    );
  });
  it('大列表只渲染一页，过滤变少后页面不越界', () => {
    const many = Array.from({ length: 10000 }, (_, i) =>
      row(`rec${i}`, '2026-03-05', `周报${i}`),
    );
    expect(meetingPage(many, 400, 20).records).toHaveLength(20);
    expect(meetingPage(records, 400, 20)).toMatchObject({ page: 1, pages: 1 });
  });
});
