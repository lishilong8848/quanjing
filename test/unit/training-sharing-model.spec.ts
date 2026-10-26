import type { MeetingSummary } from '../../shared/meeting-management.interface';
import { meetingPage } from '../../client/src/pages/MeetingManagement/model';
import {
  completedTraining,
  filterTraining,
  isTrainingBuilding,
  rankTrainingPeople,
  trainingAttendance,
  trainingInsights,
} from '../../client/src/pages/MeetingManagement/training-model';

const row = (
  id: string,
  patch: Partial<MeetingSummary> = {},
): MeetingSummary => ({
  id,
  title: id,
  date: '2026-07-01',
  weekLabel: null,
  scope: '机房',
  nature: '培训类',
  source: 'training',
  documentUrl: null,
  updatedAt: null,
  hasActions: false,
  sectionTitles: [],
  searchText: `${id} 电气`,
  status: '会议已结束',
  participantCount: 20,
  ...patch,
});
const person = (id: string, name = id) => ({ id, name });
describe('培训分享统计', () => {
  it('楼栋不计专业，多专业分别归组，未填写记录不丢失', () => {
    const rows = [
      row('a', { specialties: ['A楼', '电气', '消防', '电气'] }),
      row('b', { specialties: ['B楼'] }),
      row('c'),
    ];
    const result = trainingInsights(rows);
    expect(
      result.groups.map((g) => [g.label, g.rows.map((r) => r.id)]),
    ).toEqual([
      ['电气', ['a']],
      ['消防', ['a']],
    ]);
    expect(result.ungrouped.map((r) => r.id)).toEqual(['b', 'c']);
    expect(isTrainingBuilding('A楼')).toBe(true);
    expect(isTrainingBuilding('消防')).toBe(false);
  });
  it('人气只统计完成分享，共同分享全额关联；每条稳定ID只计一次', () => {
    const rows = [
      row('a', {
        participantCount: 30,
        presenters: [
          person('id1', '同名'),
          person('id1', '同名'),
          person('id2', '同名'),
        ],
      }),
      row('b', {
        status: '会议评分中',
        participantCount: 10,
        presenters: [person('id1', '同名')],
      }),
      row('stop', {
        status: '会议已终止',
        participantCount: 999,
        presenters: [person('stopped')],
      }),
      row('plan', {
        status: '会议未开始',
        participantCount: 999,
        presenters: [person('planned')],
      }),
    ];
    const result = trainingInsights(rows);
    expect(result.rows).toHaveLength(4);
    expect(result.completed).toHaveLength(2);
    expect(result.participants).toBe(40);
    expect(result.people).toHaveLength(4);
    expect(
      rankTrainingPeople(result.ranking, 'participants').map((r) => [
        r.person.id,
        r.shares,
        r.participants,
      ]),
    ).toEqual([
      ['id1', 2, 40],
      ['id2', 1, 30],
    ]);
    expect(
      result.ranking.reduce((sum, r) => sum + (r.participants || 0), 0),
    ).toBe(70);
    expect(completedTraining(row('unknown', { status: undefined }))).toBe(
      false,
    );
  });
  it('缺失人数不冒充零，真实零仍可排名；非法负数、浮点数不纳入人次', () => {
    const result = trainingInsights([
      row('missing', {
        participantCount: null,
        presenters: [person('missing')],
      }),
      row('zero', { participantCount: 0, presenters: [person('zero')] }),
      row('negative', { participantCount: -1 }),
      row('fraction', { participantCount: 2.5 }),
    ]);
    expect(result.participants).toBe(0);
    expect(result.missingAttendance).toBe(3);
    expect(
      rankTrainingPeople(result.ranking, 'participants').map((r) => [
        r.person.id,
        r.participants,
      ]),
    ).toEqual([
      ['zero', 0],
      ['missing', null],
    ]);
    expect(
      trainingInsights([row('unknown', { participantCount: undefined })])
        .participants,
    ).toBeNull();
    expect(
      trainingAttendance(row('nan', { participantCount: NaN })),
    ).toBeNull();
  });
  it('次数与人气可独立排序，人数相同按次数和稳定ID确定顺序', () => {
    const result = trainingInsights([
      row('a', { participantCount: 50, presenters: [person('a')] }),
      row('b1', { participantCount: 10, presenters: [person('b')] }),
      row('b2', { participantCount: 10, presenters: [person('b')] }),
    ]);
    expect(
      rankTrainingPeople(result.ranking, 'participants')[0].person.id,
    ).toBe('a');
    expect(rankTrainingPeople(result.ranking, 'shares')[0].person.id).toBe('b');
  });
  it('专业、楼栋、人员、年份、类型和关键词取交集；时间轴倒序且缺日期排后', () => {
    const rows = [
      row('a', {
        date: '2026-07-02',
        specialties: ['A楼', '电气'],
        subtype: '案例',
        presenters: [person('p')],
      }),
      row('b', {
        date: '2026-06-02',
        specialties: ['B楼', '电气'],
        subtype: '案例',
        presenters: [person('p')],
      }),
      row('c', { date: null, specialties: ['A楼', '弱电'] }),
    ];
    expect(
      filterTraining(rows, {
        year: '2026',
        specialty: '电气',
        building: 'A楼',
        presenter: 'p',
        subtype: '案例',
        query: 'a 电气',
      }).map((r) => r.id),
    ).toEqual(['a']);
    const result = trainingInsights(rows);
    expect(result.timeline.map((g) => g.month)).toEqual([
      '2026-07',
      '2026-06',
      '日期未填写',
    ]);
    expect(result.timeline.flatMap((g) => g.rows)).toHaveLength(3);
  });
  it('空集和大清单有界分页，不改写输入', () => {
    const empty = trainingInsights([]);
    expect(empty).toMatchObject({
      rows: [],
      groups: [],
      ranking: [],
      timeline: [],
      participants: null,
    });
    const rows = Array.from({ length: 1000 }, (_, i) =>
      row(String(i), { presenters: [person(String(i))] }),
    );
    const result = trainingInsights(rows);
    expect(meetingPage(result.ranking, 999, 5).records).toHaveLength(5);
    expect(meetingPage(result.rows, 1, 6).records).toHaveLength(6);
    expect(rows[0].id).toBe('0');
  });
});
