import {
  excelSerialToDate,
  mapCampusTrainingDashboard,
  type TrainingDashboardSources,
} from './training-dashboard.mapper';

let recordSequence = 0;

function record(fields: Record<string, unknown>, last_modified_time?: number) {
  return {
    record_id: `rec-training-${(recordSequence += 1)}`,
    fields,
    ...(last_modified_time === undefined ? {} : { last_modified_time }),
  };
}

function emptySources(
  overrides: Partial<TrainingDashboardSources> = {},
): TrainingDashboardSources {
  return {
    activeStats: [],
    activeScores: [],
    activePlans: [],
    newHireScores: [],
    newHireCourses: [],
    newHirePlans: [],
    sharingSessions: [],
    sharingScores: [],
    sharingInterests: [],
    ...overrides,
  };
}

describe('training-dashboard.mapper', () => {
  describe('active employee text field compatibility', () => {
    const textField = '员工 （文本）';
    const score = (fields: Record<string, unknown>) =>
      record({
        楼栋: 'A楼',
        '月份（计划）': '2026-07',
        课程: '应急管理',
        签到: true,
        考试分数: 90,
        ...fields,
      });
    const mapScores = (
      activeScores: TrainingDashboardSources['activeScores'],
    ) =>
      mapCampusTrainingDashboard(
        emptySources({
          activeScores,
          activePlans: ['A楼', 'B楼'].map((building) =>
            record({
              培训课程名称: '应急管理',
              培训年份: '2026',
              培训月份: '07',
              '楼栋/专业': building,
            }),
          ),
        }),
        '2026-07',
        '2026-07-18T03:00:00.000Z',
      );

    it('uses complete new text in summary, participation, course counts and drill-down without mutating sources', () => {
      const activeScores = [
        score({
          [textField]: [
            { type: 'text', text: ' 员工' },
            { type: 'text', text: '甲 ' },
          ],
        }),
        score({ [textField]: '员工甲' }),
        score({ [textField]: '员工甲', 课程: '消防培训' }),
      ];
      activeScores[0].last_modified_time = Date.parse('2026-07-17T08:30:00.000Z');
      const original = JSON.parse(JSON.stringify(activeScores));
      const result = mapScores(activeScores);

      expect(result.summary.monthlyParticipants).toBe(1);
      expect(
        result.participation.find(({ building }) => building === 'A楼')?.people,
      ).toBe(1);
      expect(result.details.participants).toEqual([
        expect.objectContaining({
          name: '员工甲',
          building: 'A楼',
          totalCourses: 2,
        }),
      ]);
      expect(
        result.details.activeCoursePlans.find(
          ({ building }) => building === 'A楼',
        )?.actualParticipants,
      ).toBe(1);
      expect(result.sourceUpdatedAt).toBe('2026-07-17T08:30:00.000Z');
      expect(activeScores).toEqual(original);
    });

    it('keeps text-only names in different buildings separate while deduplicating repeated courses', () => {
      const result = mapScores([
        score({ [textField]: '同名员工' }),
        score({ [textField]: '同名员工', 楼栋: 'B楼' }),
        score({ [textField]: '同名员工', 楼栋: 'B楼' }),
      ]);

      expect(result.summary.monthlyParticipants).toBe(2);
      expect(
        result.details.participants.map(({ name, building, totalCourses }) => ({
          name,
          building,
          totalCourses,
        })),
      ).toEqual([
        { name: '同名员工', building: 'A楼', totalCourses: 1 },
        { name: '同名员工', building: 'B楼', totalCourses: 1 },
      ]);
      expect(
        result.details.activeCoursePlans.map(
          ({ actualParticipants }) => actualParticipants,
        ),
      ).toEqual([1, 1]);
    });

    it('preserves distinct matching stable identities and deduplicates their repeated courses', () => {
      const result = mapScores([
        score({
          [textField]: ' 同名员工 ',
          员工: [{ id: 'ou-first', name: '同名员工' }],
        }),
        score({
          [textField]: '同名员工',
          员工: [{ open_id: 'ou-second', name: '同名员工' }],
        }),
        score({
          [textField]: '同名员工',
          员工: [{ user_id: 'ou-first', name: '同名员工' }],
          课程: '消防培训',
        }),
      ]);

      expect(result.summary.monthlyParticipants).toBe(2);
      expect(result.details.participants).toHaveLength(2);
      expect(
        result.details.participants
          .map(({ totalCourses }) => totalCourses)
          .sort(),
      ).toEqual([1, 2]);
      expect(
        result.details.activeCoursePlans.find(
          ({ building }) => building === 'A楼',
        )?.actualParticipants,
      ).toBe(2);
      expect(JSON.stringify(result)).not.toContain('ou-first');
      expect(JSON.stringify(result)).not.toContain('ou-second');
    });

    it('retains both real identities when a single legacy personnel cell contains same-name people', () => {
      const result = mapScores([
        score({
          [textField]: '同名员工',
          员工: [
            { id: 'ou-first', name: '同名员工' },
            { id: 'ou-second', name: '同名员工' },
            { id: 'ou-first', name: '同名员工' },
          ],
        }),
      ]);

      expect(result.summary.monthlyParticipants).toBe(2);
      expect(result.details.participants.map(({ name }) => name)).toEqual([
        '同名员工',
        '同名员工',
      ]);
      expect(
        result.details.activeCoursePlans.find(
          ({ building }) => building === 'A楼',
        )?.actualParticipants,
      ).toBe(2);
    });

    it('does not attach an unrelated or unnamed legacy ID to a new employee name', () => {
      const result = mapScores([
        score({
          [textField]: '新员工甲',
          员工: [{ id: 'ou-old', name: '旧员工' }],
        }),
        score({
          [textField]: '新员工乙',
          员工: [{ id: 'ou-old', name: '旧员工' }],
        }),
        score({ [textField]: '新员工丙', 员工: [{ id: 'ou-old' }] }),
        score({
          [textField]: '新员工甲',
          员工: [{ id: 'ou-other', name: '另一个旧员工' }],
        }),
      ]);

      expect(result.summary.monthlyParticipants).toBe(3);
      expect(
        result.details.participants.map(({ name }) => name).sort(),
      ).toEqual(['新员工丙', '新员工乙', '新员工甲'].sort());
      expect(
        result.details.activeCoursePlans.find(
          ({ building }) => building === 'A楼',
        )?.actualParticipants,
      ).toBe(3);
      expect(JSON.stringify(result)).not.toContain('旧员工');
    });

    it.each([undefined, null, '', ' \t ', [{ type: 'text', text: ' ' }]])(
      'falls back to legacy identities when new text is empty (%j)',
      (emptyText) => {
        const result = mapScores([
          score({
            [textField]: emptyText,
            员工: [{ id: 'ou-legacy-first', name: '同名员工' }],
          }),
          score({
            [textField]: emptyText,
            员工: [{ id: 'ou-legacy-second', name: '同名员工' }],
          }),
          score({
            [textField]: emptyText,
            员工: [{ id: 'ou-legacy-first', name: '同名员工' }],
          }),
        ]);

        expect(result.summary.monthlyParticipants).toBe(2);
        expect(result.details.participants).toHaveLength(2);
        expect(
          result.details.activeCoursePlans.find(
            ({ building }) => building === 'A楼',
          )?.actualParticipants,
        ).toBe(2);
      },
    );
  });

  it('converts Excel serial dates with the 1899-12-30 epoch', () => {
    expect(excelSerialToDate(46026)).toBe('2026-01-04');
    expect(excelSerialToDate(46300)).toBe('2026-10-05');
  });

  it('builds sanitized drill-down lists for every dashboard metric card', () => {
    const privatePerson = {
      id: 'ou-private-active-person',
      open_id: 'ou-private-active-open-id',
      union_id: 'on-private-active-union-id',
      user_id: 'private-active-user-id',
      name: '员工甲',
      email: 'private-active-person@example.com',
    };
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'A楼',
            本月需考核课程数量: 1,
            已完成考核的课程数量: 4,
            '培训人数（2026）': 1,
            '累计-已完成培训数量': 22,
          }),
        ],
        activeScores: [
          record({
            员工: [privatePerson],
            课程: '及格课程',
            考试分数: { type: 2, value: [80] },
            签到: true,
            楼栋: 'A楼',
            月份: '07',
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [privatePerson],
            课程: '未通过课程',
            考试分数: { type: 2, value: [79] },
            签到: true,
            楼栋: 'A楼',
            月份: '07',
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [privatePerson],
            课程: '待考核课程',
            签到: true,
            楼栋: 'A楼',
            月份: '07',
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [privatePerson],
            课程: '缺席课程',
            考试分数: 100,
            签到: false,
            楼栋: 'A楼',
            月份: '07',
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [privatePerson],
            课程: '签到未知有分课程',
            考试分数: 100,
            楼栋: 'A楼',
            月份: '07',
            '月份（计划）': '2026-07',
          }),
        ],
        activePlans: [
          record({
            培训课程名称: '年度已完成课程',
            培训年份: '2026',
            培训月份: '01',
            '楼栋/专业': 'A楼',
            '培训状态（此格为系统修改）': '已完成培训考核',
          }),
          record({
            培训课程名称: '七月计划课程',
            培训年份: '2026',
            培训月份: '07',
            '楼栋/专业': 'A楼',
            在岗员工培训对应人员: [privatePerson],
          }),
        ],
        newHireScores: [
          record({
            人员: [
              {
                id: 'ou-private-july-hire',
                open_id: 'ou-private-july-hire-open-id',
                name: '七月新人',
                email: 'july-hire@example.com',
              },
            ],
            楼栋: 'A楼',
            入职日期: '2026-07-10',
            计划考核截止日期: '2026-09-23',
            需培训课程数量: 27,
            已培训课程数量: 3,
          }),
          record({
            人员: [
              {
                id: 'ou-private-june-hire',
                name: '六月新人',
                email: 'june-hire@example.com',
              },
            ],
            楼栋: 'B楼',
            入职日期: '2026-06-20',
            计划考核截止日期: '2026-08-31',
            需培训课程数量: 27,
            已培训课程数量: 6,
          }),
        ],
        sharingSessions: [
          record({
            分享主题: '已完成分享会',
            分享类型: '技术经验分享',
            '会议进度（勿动）': '会议已结束',
            开始时间: '2026-07-05T09:00:00+08:00',
            结束时间: '2026-07-05T10:00:00+08:00',
            分享人: [
              {
                id: 'ou-private-presenter',
                union_id: 'on-private-presenter-union-id',
                name: '分享人甲',
                email: 'presenter@example.com',
              },
            ],
            '参会人 (人员 )': [privatePerson],
          }),
          record({
            分享主题: '七月计划分享会',
            分享类型: '故障案例分析',
            '会议进度（勿动）': '会议审核&制定中',
            月度: '2026-07',
            分享人: [
              {
                id: 'ou-private-planned-presenter',
                name: '分享人乙',
                email: 'planned-presenter@example.com',
              },
            ],
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );
    const { details } = result;

    expect(details.assessmentPassScore).toBe(80);
    expect(details.participants).toHaveLength(1);
    expect(details.participants[0]).toMatchObject({
      name: '员工甲',
      building: 'A楼',
      averageScore: 79.5,
      assessments: expect.arrayContaining([
        expect.objectContaining({
          course: '及格课程',
          score: 80,
          signedIn: true,
          status: 'passed',
        }),
        expect.objectContaining({
          course: '未通过课程',
          score: 79,
          signedIn: true,
          status: 'failed',
        }),
        expect.objectContaining({
          course: '待考核课程',
          score: null,
          signedIn: true,
          status: 'pending',
        }),
        expect.objectContaining({
          course: '缺席课程',
          score: 100,
          signedIn: false,
          status: 'absent',
        }),
        expect.objectContaining({
          course: '签到未知有分课程',
          score: 100,
          signedIn: null,
          status: 'pending',
        }),
      ]),
    });

    expect(details.activeCoursePlans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          course: '七月计划课程',
          month: '2026-07',
          building: 'A楼',
        }),
        expect.objectContaining({
          course: '年度已完成课程',
          month: '2026-01',
          building: 'A楼',
        }),
      ]),
    );
    expect(details.sharingSessions.map(({ topic }) => topic)).toEqual(
      expect.arrayContaining(['已完成分享会', '七月计划分享会']),
    );
    expect(details.newHires.map(({ name }) => name)).toEqual(['七月新人']);
    expect(details.reconciliationNotes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/22.*1|1.*22/),
        expect.stringMatching(
          /统计表楼栋完成合计=4.*计划表楼栋×课程完成标记=0.*无法逐项追溯/,
        ),
      ]),
    );

    const serializedResult = JSON.stringify(result);
    expect(serializedResult).toContain('员工甲');
    for (const privateValue of [
      'private-active-person@example.com',
      'ou-private-active-person',
      'ou-private-active-open-id',
      'on-private-active-union-id',
      'private-active-user-id',
      'july-hire@example.com',
      'ou-private-july-hire',
      'ou-private-july-hire-open-id',
      'presenter@example.com',
      'ou-private-presenter',
      'on-private-presenter-union-id',
    ]) {
      expect(serializedResult).not.toContain(privateValue);
    }
    for (const privateField of [
      '"email"',
      '"open_id"',
      '"union_id"',
      '"user_id"',
    ]) {
      expect(serializedResult).not.toContain(privateField);
    }
  });

  it('backfills actual course participants from signed score rows without counting absences', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activePlans: [
          record({
            培训课程名称: '应急管理制度',
            培训年份: '2026',
            培训月份: '07',
            '楼栋/专业': 'A楼',
          }),
        ],
        activeScores: [
          record({
            员工: [{ id: 'ou-signed-participant', name: '同名员工' }],
            课程: '应急管理制度',
            签到: true,
            楼栋: 'A楼',
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [{ id: 'ou-second-signed-participant', name: '同名员工' }],
            课程: '应急管理制度',
            签到: true,
            楼栋: 'A楼',
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [{ id: 'ou-absent-participant', name: '未签到员工' }],
            课程: '应急管理制度',
            签到: false,
            楼栋: 'A楼',
            '月份（计划）': '2026-07',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.details.activeCoursePlans).toEqual([
      expect.objectContaining({
        month: '2026-07',
        building: 'A楼',
        course: '应急管理制度',
        actualParticipants: 2,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('ou-signed-participant');
    expect(JSON.stringify(result)).not.toContain(
      'ou-second-signed-participant',
    );
    expect(JSON.stringify(result)).not.toContain('ou-absent-participant');
  });

  it('reconciles monthly completion at the same building-by-course grain', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'A楼',
            已完成考核的课程数量: 1,
          }),
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'B楼',
            已完成考核的课程数量: 1,
          }),
        ],
        activePlans: [
          record({
            培训课程名称: '同名课程',
            培训年份: '2026',
            培训月份: '07',
            '楼栋/专业': 'A楼',
            '培训状态（此格为系统修改）': '已完成培训考核',
          }),
          record({
            培训课程名称: '同名课程',
            培训年份: '2026',
            培训月份: '07',
            '楼栋/专业': 'B楼',
            '培训状态（此格为系统修改）': '已完成培训考核',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(
      result.details.reconciliationNotes.some((note) =>
        note.includes('本月考核进展'),
      ),
    ).toBe(false);
  });

  it('does not count terminated plans as traceable monthly planned courses', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'A楼',
            本月培训课程数量: 1,
          }),
        ],
        activePlans: [
          record({
            培训课程名称: '有效计划',
            培训年份: '2026',
            培训月份: '07',
            '楼栋/专业': 'A楼',
          }),
          record({
            培训课程名称: '已取消计划',
            培训年份: '2026',
            培训月份: '07',
            '楼栋/专业': 'A楼',
            '培训状态（此格为系统修改）': '已取消',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.details.activeCoursePlans).toHaveLength(2);
    expect(result.details.reconciliationNotes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/本月计划性培训课程.*统计卡=2.*当前可追溯明细=1/),
      ]),
    );
  });

  it('does not turn negative millisecond timestamps into an impossible five-digit year', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        newHireScores: [
          record({
            人员: [{ id: 'ou-negative-timestamp', name: '日期回归员工' }],
            楼栋: 'A楼',
            入职日期: '2026-07-10',
            计划考核截止日期: {
              type: 5,
              value: [-2_202_710_743_000],
            },
            需培训课程数量: 27,
            已培训课程数量: 0,
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.summary.monthlyNewHires).toBe(1);
    expect(JSON.stringify(result)).not.toContain('67833');
  });

  it('aggregates July active-training progress, plans, and unique participants', () => {
    const stats = [
      ['A楼', 4, 10, 11],
      ['B楼', 0, 9, 9],
      ['C楼', 0, 10, 10],
      ['D楼', 5, 6, 7],
      ['E楼', 3, 7, 7],
      ['H楼', 0, 7, 16],
    ] as const;

    const activeStats = stats.map(
      ([building, completed, people, target], index) =>
        record({
          年份: index % 2 === 0 ? ['2026'] : '2026',
          月份: index % 2 === 0 ? '07' : ['07'],
          楼栋: index % 2 === 0 ? [building] : building,
          本月需考核课程数量: index % 2 === 0 ? ['12'] : '12',
          本月培训课程数量: index % 2 === 0 ? 12 : ['12'],
          已完成培训课程数量:
            index % 2 === 0 ? [String(completed)] : String(completed),
          '培训人数（2026）': index % 2 === 0 ? people : [String(people)],
          '🧑在岗员工培训人数': index % 2 === 0 ? [String(target)] : target,
          培训完成率:
            index === 0 ? 0.3333333333333333 : index === 3 ? '41.6667%' : null,
          考核达标率: index === 0 ? 0.8 : index === 3 ? { value: '50%' } : null,
          '累计-已完成培训数量': index % 2 === 0 ? [22] : '22',
        }),
    );

    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats,
        activePlans: [
          record({
            培训课程名称: ['月度安全培训'],
            培训年份: '2026',
            培训月份: ['07'],
            '楼栋/专业': 'A楼',
          }),
          record({
            培训课程名称: '月度安全培训',
            培训年份: ['2026'],
            培训月份: '07',
            '楼栋/专业': ['B楼'],
          }),
        ],
        activeScores: [
          record({
            员工: [{ id: 'ou-active-a', name: '员工甲' }],
            课程: ['安全基础'],
            楼栋: ['A楼'],
            月份: '07',
            '月份（计划）': ['2026-07'],
          }),
          record({
            员工: [{ id: 'ou-active-a', name: '员工甲' }],
            课程: '应急处置',
            楼栋: 'A楼',
            月份: ['07'],
            '月份（计划）': '2026-07',
          }),
          record({
            员工: [{ id: 'ou-active-b', name: '员工乙' }],
            课程: ['安全基础'],
            楼栋: ['B楼'],
            月份: '07',
            '月份（计划）': ['2026-07'],
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.month).toBe('2026-07');
    expect(result.summary.monthlyPlannedCourses).toBe(1);
    expect(result.summary.annualCompletedCourses).toBe(22);
    expect(result.progress).toHaveLength(6);
    expect(result.progress.find(({ building }) => building === 'A楼')).toEqual({
      building: 'A楼',
      planned: 12,
      completed: 4,
      rate: 33.3,
    });

    expect(
      result.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({
      people: 1,
      target: 11,
      trainingCompletionRate: 33.3,
      assessmentPassRate: 80,
    });
    expect(
      result.participation.find(({ building }) => building === 'B楼'),
    ).toMatchObject({
      people: 1,
      target: 9,
      trainingCompletionRate: 0,
      assessmentPassRate: null,
    });
    expect(
      result.participation.find(({ building }) => building === 'C楼'),
    ).toMatchObject({
      people: 10,
      target: 10,
      trainingCompletionRate: 0,
      assessmentPassRate: null,
    });
    expect(
      result.participation.find(({ building }) => building === 'D楼'),
    ).toMatchObject({
      trainingCompletionRate: 41.7,
      assessmentPassRate: 50,
    });
    expect(result.summary.monthlyParticipants).toBe(1 + 1 + 10 + 6 + 7 + 7);

    for (const item of result.progress) {
      expect(Number.isFinite(item.rate)).toBe(true);
    }
    for (const item of result.participation) {
      expect(Number.isFinite(item.trainingCompletionRate)).toBe(true);
      expect(
        item.assessmentPassRate === null ||
          Number.isFinite(item.assessmentPassRate),
      ).toBe(true);
    }
  });

  it('maps the current July active assessment and training summary fields without crossing their metrics', () => {
    const sourceRows = [
      ['A楼', 4, 11, 33.3],
      ['B楼', 4, 10, 33.3],
      ['C楼', 5, 11, 41.7],
      ['D楼', 5, 13, 41.7],
      ['E楼', 6, 13, 50],
      ['H楼', 5, 9, 41.7],
    ] as const;
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: sourceRows.map(
          ([building, completedAssessment, people, assessmentRate]) =>
            record({
              年份: '2026',
              月份: '07',
              楼栋: building,
              本月需考核课程数量: 12,
              已完成考核的课程数量: completedAssessment,
              '考试人数（2026）': people + 100,
              考核达标率: assessmentRate / 100,
              已完成培训课程数量: 12,
              '培训人数（2026）': people,
              培训完成率: 1,
            }),
        ),
      }),
      '2026-07',
      '2026-07-28T05:46:54.120Z',
    );

    expect(result.progress).toEqual(
      sourceRows.map(([building, completedAssessment, , assessmentRate]) => ({
        building,
        planned: 12,
        completed: completedAssessment,
        rate: assessmentRate,
      })),
    );
    expect(result.participation).toEqual(
      sourceRows.map(([building, , people, assessmentRate]) => ({
        building,
        people,
        target: 0,
        trainingCompletionRate: 100,
        assessmentPassRate: assessmentRate,
      })),
    );
    expect(result.summary.monthlyParticipants).toBe(67);
  });

  it('uses non-additive stats fallback and deduplicates completed plan business keys', () => {
    const statsWithoutCumulative = [
      'A楼',
      'B楼',
      'C楼',
      'D楼',
      'E楼',
      'H楼',
    ].map((building, index) =>
      record({
        年份: index % 2 === 0 ? '2026' : ['2026'],
        月份: index % 2 === 0 ? ['07'] : '07',
        楼栋: index % 2 === 0 ? building : [building],
        本月需考核课程数量: index % 2 === 0 ? [12] : '12',
        本月培训课程数量: 12,
        已完成培训课程数量: 0,
        '培训人数（2026）': 0,
        '🧑在岗员工培训人数': 0,
      }),
    );

    const statsFallback = mapCampusTrainingDashboard(
      emptySources({
        activeStats: statsWithoutCumulative,
        activePlans: [],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(statsFallback.summary.monthlyPlannedCourses).toBe(12);

    const completedPlanFields = {
      培训课程名称: '消防基础',
      培训年份: ['2026'],
      培训月份: '06',
      '楼栋/专业': ['A楼'],
      在岗员工培训对应人员: [{ id: 'ou-plan-a', name: '员工甲' }],
      '培训状态（此格为系统修改）': ['已完成培训考核'],
      培训考核完成时间: '2026-06-20',
    };
    const annualFallback = mapCampusTrainingDashboard(
      emptySources({
        activeStats: statsWithoutCumulative,
        activePlans: [
          record(completedPlanFields),
          record({
            ...completedPlanFields,
            培训课程名称: ['消防基础'],
            培训年份: '2026',
            培训月份: ['06'],
            '楼栋/专业': 'A楼',
            '培训状态（此格为系统修改）': '已完成培训考核',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(annualFallback.summary.annualCompletedCourses).toBe(1);
  });

  it('falls back to completed plans when cumulative stats are only negative', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'A楼',
            '累计-已完成培训数量': -5,
          }),
        ],
        activePlans: [
          record({
            培训课程名称: '负累计回退课程',
            培训年份: '2026',
            培训月份: '06',
            '楼栋/专业': 'A楼',
            '培训状态（此格为系统修改）': '已完成培训考核',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.summary.annualCompletedCourses).toBe(1);
  });

  it('uses the synchronized current month by default even when source data only has past and future months', () => {
    const secondTimestamp = Date.parse('2026-07-17T00:00:00.000Z') / 1000;
    const millisecondTimestamp = Date.parse('2026-07-18T00:00:00.000Z');
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record(
            {
              年份: ['2026'],
              月份: '06',
              楼栋: ['A楼'],
              本月需考核课程数量: 3,
              本月培训课程数量: 3,
              已完成培训课程数量: 1,
            },
            secondTimestamp,
          ),
        ],
        activePlans: [
          record(
            {
              培训课程名称: '八月安全培训',
              培训年份: '2026',
              培训月份: ['08'],
              '楼栋/专业': 'B楼',
            },
            millisecondTimestamp,
          ),
        ],
      }),
      undefined,
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.month).toBe('2026-07');
    expect(result.availableMonths).toEqual(['2026-07', '2026-06']);
    expect(result.sourceUpdatedAt).toBe('2026-07-18T00:00:00.000Z');

    const emptyResult = mapCampusTrainingDashboard(
      emptySources(),
      undefined,
      '2026-09-15T03:00:00.000Z',
    );
    expect(emptyResult.month).toBe('2026-09');
    expect(emptyResult.sourceUpdatedAt).toBeNull();
    expect(emptyResult.dataStatus).toBe('empty');

    for (const dashboard of [result, emptyResult]) {
      expect(Object.keys(dashboard.metricTrends)).toHaveLength(6);
      for (const trend of Object.values(dashboard.metricTrends)) {
        expect(trend).toHaveLength(5);
        expect(trend.every(Number.isFinite)).toBe(true);
      }

      expect(Object.keys(dashboard.metricComparisons)).toHaveLength(6);
      for (const comparison of Object.values(dashboard.metricComparisons)) {
        expect(Number.isFinite(comparison.change)).toBe(true);
      }
    }
  });

  it('defaults to the synced current month instead of a future active plan', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activePlans: [
          record({
            培训课程名称: '七月安全培训',
            培训年份: '2026',
            培训月份: '07',
          }),
          record({
            培训课程名称: '十二月安全培训',
            培训年份: '2026',
            培训月份: '12',
          }),
        ],
      }),
      undefined,
      '2026-07-19T03:00:00.000Z',
    );

    expect(result.availableMonths).toEqual(['2026-07']);
    expect(result.availableMonths).not.toContain('2026-12');
    expect(result.month).toBe('2026-07');
  });

  it('does not invent 2001 available months for yearless active plans', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activePlans: [
          record({
            培训课程名称: '一月安全培训',
            培训年份: '',
            培训月份: '1月',
          }),
          record({
            培训课程名称: '七月安全培训',
            培训年份: '',
            培训月份: '7月',
          }),
        ],
      }),
      undefined,
      '2026-07-19T03:00:00.000Z',
    );

    expect(
      result.availableMonths.filter((month) => month.startsWith('2001-')),
    ).toEqual([]);
  });

  it('preserves an explicitly requested month with any four-digit year', () => {
    const result = mapCampusTrainingDashboard(
      emptySources(),
      '2100-01',
      '2026-07-19T03:00:00.000Z',
    );

    expect(result.month).toBe('2100-01');
  });

  it('appends unknown buildings in source order without dropping progress or participants', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'Z楼',
            本月培训课程数量: 4,
            已完成培训课程数量: 2,
            培训人数: 3,
            '🧑在岗员工培训人数': 4,
          }),
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'F楼',
            本月培训课程数量: 2,
            已完成培训课程数量: 1,
            培训人数: 2,
            '🧑在岗员工培训人数': 3,
          }),
        ],
        activeScores: [
          record({
            员工: [{ id: 'ou-unknown-y', name: '未知楼栋员工' }],
            楼栋: 'Y楼',
            月份: '07',
            '月份（计划）': '2026-07',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    const expectedBuildings = [
      'A楼',
      'B楼',
      'C楼',
      'D楼',
      'E楼',
      'H楼',
      'Z楼',
      'F楼',
      'Y楼',
    ];
    expect(result.progress.map(({ building }) => building)).toEqual(
      expectedBuildings,
    );
    expect(result.participation.map(({ building }) => building)).toEqual(
      expectedBuildings,
    );
    expect(
      result.progress.find(({ building }) => building === 'Z楼'),
    ).toMatchObject({ planned: 4, completed: 2 });
    expect(
      result.participation.find(({ building }) => building === 'Y楼'),
    ).toMatchObject({ people: 1, target: 0 });
    expect(result.summary.monthlyParticipants).toBe(6);
  });

  it('uses the year-specific people field only for 2026 stats', () => {
    const sources = emptySources({
      activeStats: [
        record({
          年份: '2025',
          月份: '07',
          楼栋: 'A楼',
          培训人数: 5,
          '培训人数（2026）': 99,
          '🧑在岗员工培训人数': 10,
        }),
        record({
          年份: '2026',
          月份: '07',
          楼栋: 'A楼',
          培训人数: 6,
          '培训人数（2026）': 8,
          '🧑在岗员工培训人数': 10,
        }),
      ],
    });

    const result2025 = mapCampusTrainingDashboard(
      sources,
      '2025-07',
      '2026-07-18T03:00:00.000Z',
    );
    const result2026 = mapCampusTrainingDashboard(
      sources,
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(
      result2025.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({ people: 5 });
    expect(
      result2026.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({ people: 8 });
  });

  it('derives score months from explicit plan years and exposes them as available', () => {
    const sources = emptySources({
      activeStats: [
        record({
          年份: '2025',
          月份: '07',
          楼栋: 'A楼',
          培训人数: 0,
          '🧑在岗员工培训人数': 2,
        }),
      ],
      activeScores: [
        record({
          员工: [{ id: 'ou-score-2026', name: '跨年员工' }],
          楼栋: 'A楼',
          月份: '07',
          '月份（计划）': { value: '2026-07' },
        }),
      ],
    });

    const selected2025 = mapCampusTrainingDashboard(
      sources,
      '2025-07',
      '2026-09-18T03:00:00.000Z',
    );
    expect(selected2025.availableMonths).toEqual([
      '2026-09',
      '2026-07',
      '2025-07',
    ]);
    expect(
      selected2025.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({ people: 0 });

    const latest = mapCampusTrainingDashboard(
      sources,
      undefined,
      '2026-09-18T03:00:00.000Z',
    );
    expect(latest.month).toBe('2026-09');
    expect(latest.availableMonths).toEqual(['2026-09', '2026-07', '2025-07']);
    expect(
      latest.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({ people: 0 });
  });

  it('prefers a full planned month over a conflicting full actual month', () => {
    const sources = emptySources({
      activeScores: [
        record({
          员工: [{ id: 'ou-plan-month-wins', name: '计划月份员工' }],
          楼栋: 'A楼',
          月份: '2025-07',
          '月份（计划）': '2026-07',
        }),
      ],
    });

    const latest = mapCampusTrainingDashboard(
      sources,
      undefined,
      '2026-09-18T03:00:00.000Z',
    );
    expect(latest.availableMonths).toEqual(['2026-09', '2026-07']);
    expect(latest.month).toBe('2026-09');
    expect(
      latest.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({ people: 0 });

    const selected2025 = mapCampusTrainingDashboard(
      sources,
      '2025-07',
      '2026-09-18T03:00:00.000Z',
    );
    expect(
      selected2025.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({ people: 0 });
  });

  it('unwraps link, url, and href field wrappers', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activePlans: [
          record({
            培训课程名称: { link: { text: '链接包装课程' } },
            培训年份: { url: '2026' },
            培训月份: { href: ['07'] },
            '楼栋/专业': 'A楼',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.summary.monthlyPlannedCourses).toBe(1);
  });

  it('clamps progress, completion, and assessment rates to the zero-to-one-hundred range', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'A楼',
            本月培训课程数量: 4,
            已完成培训课程数量: 8,
            '培训人数（2026）': 3,
            '🧑在岗员工培训人数': 1,
            培训完成率: 4,
            考核达标率: 1.5,
          }),
          record({
            年份: '2026',
            月份: '07',
            楼栋: 'B楼',
            本月需考核课程数量: -7,
            本月培训课程数量: -4,
            已完成培训课程数量: -1,
            '培训人数（2026）': -2,
            '🧑在岗员工培训人数': -1,
            '累计-已完成培训数量': -5,
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(
      result.progress.find(({ building }) => building === 'A楼')?.rate,
    ).toBe(100);
    expect(
      result.participation.find(({ building }) => building === 'A楼'),
    ).toMatchObject({
      trainingCompletionRate: 4,
      assessmentPassRate: 1.5,
    });
    expect(
      result.progress.find(({ building }) => building === 'B楼')?.rate,
    ).toBe(0);
    expect(
      result.progress.find(({ building }) => building === 'B楼'),
    ).toMatchObject({ planned: 0, completed: 0 });
    expect(
      result.participation.find(({ building }) => building === 'B楼'),
    ).toMatchObject({
      people: 0,
      target: 0,
      trainingCompletionRate: 0,
      assessmentPassRate: null,
    });
    expect(result.summary.monthlyPlannedCourses).toBe(0);
    expect(result.summary.monthlyParticipants).toBeGreaterThanOrEqual(0);
    expect(result.summary.annualCompletedCourses).toBe(0);
  });

  it('rejects impossible hand-written calendar dates', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        activeStats: [
          record({
            年份: '2026',
            月份: '2026-99-01',
            楼栋: 'A楼',
          }),
          record({
            年份: '2026',
            月份: '2026-02-31',
            楼栋: 'B楼',
          }),
        ],
      }),
      undefined,
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.availableMonths).toEqual(['2026-07']);
    expect(result.month).toBe('2026-07');
    expect(result.dataStatus).toBe('empty');
  });

  it('maps new hires by joined month, training window, stable identity, and selected-year progress', () => {
    const sunJoinedMilliseconds = Date.parse('2026-07-17T00:00:00+08:00');
    const sources = emptySources({
      newHireScores: [
        record({
          人员: [{ id: 'ou-new', name: '孙文' }],
          楼栋: ['A楼'],
          入职日期: sunJoinedMilliseconds,
          计划考核截止日期: '46300',
          需培训课程数量: 27,
          已培训课程数量: 20,
          '培训进度（2026）': 0.75,
          最终考核成绩: 100.2,
        }),
        record({
          新员工: { users: [{ id: 'ou-new', name: '孙文' }] },
          楼栋: 'A楼',
          入职日期: sunJoinedMilliseconds,
          计划考核截止日期: '46300',
          需培训课程数量: 27,
          已培训课程数量: 20,
          '培训进度（2026）': '75%',
        }),
        record({
          '人员（文本）': '孙文',
          楼栋: 'A楼',
          入职日期: '2026-07-17',
          计划考核截止日期: '46300',
        }),
        record({
          人员: '谢鹏',
          楼栋: 'B楼',
          入职日期: '2026-06-25',
          计划考核截止日期: '2026-09-21',
          需培训课程数量: 12,
          已培训课程数量: 3,
        }),
        record({
          人员: { id: 'ou-2025', name: '往届员工' },
          楼栋: 'C楼',
          入职日期: '2025-07-08',
          计划考核截止日期: '2025-09-21',
          需培训课程数量: 4,
          已培训课程数量: 1,
          '培训进度（2026）': 0.9,
        }),
        record({
          '人员（文本）': '   ',
          楼栋: 'D楼',
          入职日期: '2026-08-01',
          计划考核截止日期: '2027-12-01',
        }),
      ],
    });

    const july = mapCampusTrainingDashboard(
      sources,
      undefined,
      '2026-07-18T03:00:00.000Z',
    );

    expect(july.month).toBe('2026-07');
    expect(july.availableMonths).toEqual(['2026-07', '2026-06', '2025-07']);
    expect(july.availableMonths).not.toContain('2026-10');
    expect(july.summary.monthlyNewHires).toBe(1);
    expect(july.metricTrends.monthlyNewHires).toEqual([0, 0, 0, 1, 1]);
    expect(Object.values(july.metricTrends).flat().every(Number.isFinite)).toBe(
      true,
    );
    expect(july.dataStatus).toBe('ready');
    expect(july.newHirePlans).toHaveLength(2);
    expect(july.newHirePlans.map(({ name }) => name)).toEqual(['孙文', '谢鹏']);
    expect(july.newHirePlans.find(({ name }) => name === '孙文')).toMatchObject(
      {
        id: 'new-hire-1',
        building: 'A楼',
        joinedAt: '2026-07-17',
        assessmentDueAt: '2026-10-05',
        requiredCourses: 27,
        completedCourses: 20,
        progress: 75,
        finalScore: 100.2,
      },
    );

    const july2025 = mapCampusTrainingDashboard(
      sources,
      '2025-07',
      '2026-07-18T03:00:00.000Z',
    );
    expect(july2025.summary.monthlyNewHires).toBe(1);
    expect(
      july2025.newHirePlans.find(({ name }) => name === '往届员工'),
    ).toMatchObject({ progress: 25 });
  });

  it('maps the legacy final-score field used by current live Base records', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        newHireScores: [
          record({
            人员: [{ id: 'ou-legacy-score', name: '旧成绩员工' }],
            楼栋: 'A楼',
            入职日期: '2026-07-01',
            计划考核截止日期: '2026-09-01',
            '最终考核成绩（旧）': 88,
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.newHirePlans).toEqual([
      expect.objectContaining({
        name: '旧成绩员工',
        finalScore: 88,
      }),
    ]);
  });

  it('sorts new-hire plans by joined date, name, stable id, and source order', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        newHireScores: [
          record({
            人员: [{ id: 'ou-older', name: 'Older' }],
            入职日期: '2026-06-01',
          }),
          record({
            人员: [{ id: 'ou-null-date', name: 'NoDate' }],
            计划考核截止日期: '2026-10-01',
          }),
          record({
            人员: [{ id: 'ou-b', name: 'SameName' }],
            入职日期: '2026-07-10',
          }),
          record({
            人员: [{ id: 'ou-a', name: 'SameName' }],
            入职日期: '2026-07-10',
          }),
          record({
            人员: [{ id: 'ou-alpha', name: 'Alpha' }],
            入职日期: '2026-07-10',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.newHirePlans.map(({ id }) => id)).toEqual([
      'new-hire-1',
      'new-hire-2',
      'new-hire-3',
      'new-hire-4',
      'new-hire-5',
    ]);
  });

  it('joins new-hire course configuration and deduplicates completion by learner-course-week', () => {
    const sources = emptySources({
      newHirePlans: [
        record({
          学员: [{ id: 'ou-new', name: '孙文' }],
          '培训课程名称（考核类型为理论考核的需与题库中的名称一致）':
            '消防系统',
          '新员工第（）周培训': '第1周',
          流程状态: '培训中',
        }),
        record({
          学员: [{ id: 'ou-new', name: '孙文' }],
          '培训课程名称（考核类型为理论考核的需与题库中的名称一致）':
            '消防系统',
          '新员工第（）周培训': '第1周',
          培训考核完成时间: '2026-07-18',
        }),
        record({
          '学员名字（文本）': '谢鹏',
          '培训课程名称（考核类型为理论考核的需与题库中的名称一致）':
            '消防系统',
          '新员工第（）周培训': '第1周',
          流程状态: '培训中',
        }),
        record({
          '学员名字（文本）': '周敏',
          '培训课程名称（考核类型为理论考核的需与题库中的名称一致）':
            '消防系统',
          '新员工第（）周培训': '第3周',
          流程状态: '培训中',
          培训考核完成时间: { value: null },
        }),
        record({
          学员: '李华',
          培训课程: '安全规范',
          '新员工第（）周培训': '第2周',
          课程大类: '通用课',
          流程状态: '已通过',
        }),
        record({
          学员: '赵六',
          培训课程: ' ',
          '新员工第（）周培训': '第1周',
          流程状态: '考核结束',
        }),
      ],
      newHireCourses: [
        record({
          培训课程名称: '消防系统',
          课程大类: '专业课',
          讲师: [{ id: 'ou-teacher-zhang', name: '张老师' }],
        }),
      ],
    });
    const result = mapCampusTrainingDashboard(
      sources,
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.courses).toEqual([
      {
        id: expect.any(String),
        rank: 1,
        category: '通用课',
        course: '安全规范',
        instructor: '',
        completionRate: 100,
      },
      {
        id: expect.any(String),
        rank: 2,
        category: '专业课',
        course: '消防系统',
        instructor: '张老师',
        completionRate: 33.3,
      },
    ]);
    const repeated = mapCampusTrainingDashboard(
      sources,
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );
    expect(result.courses.map(({ id }) => id)).toEqual(
      repeated.courses.map(({ id }) => id),
    );
    expect(new Set(result.courses.map(({ id }) => id)).size).toBe(2);
    expect(
      result.courses.every(
        ({ rank, completionRate }) =>
          Number.isFinite(rank) && Number.isFinite(completionRate),
      ),
    ).toBe(true);
  });

  it('aggregates sharing sessions, ratings, materials, and interests with strict status and identity matching', () => {
    const mayStart = Date.parse('2026-05-12T09:00:00+08:00');
    const juneStartSeconds = Date.parse('2026-06-18T13:30:00+08:00') / 1000;
    const sources = emptySources({
      sharingSessions: [
        record({
          分享主题: '故障案例分析',
          分享类型: ['故障案例分析'],
          '会议进度（勿动）': ['已结束'],
          开始时间: mayStart,
          结束时间: mayStart + 60 * 60 * 1000,
          月度: ['05'],
          '参会人 (人员 )': [{ id: 'ou-may', name: '五月参会人' }],
        }),
        record({
          分享主题: ['技术交流'],
          分享类型: '技术交流',
          '会议进度（勿动）': '已结束',
          开始时间: juneStartSeconds,
          结束时间: juneStartSeconds + 90 * 60,
          月度: '06',
          分享人: [{ id: 'ou-tech', name: '技术分享人' }],
          '参会人 (人员 )': [{ id: 'ou-june', name: '六月参会人' }],
          '会议回放&妙记链接': {
            value: '[会议回放](https://example.invalid/june-replay)',
          },
        }),
        record({
          分享主题: 'UPS故障复盘',
          分享类型: ['故障案例分析'],
          '会议进度（勿动）': ['已结束'],
          开始时间: '2026-07-08T09:00:00+08:00',
          结束时间: '2026-07-08T11:00:00+08:00',
          月度: ['07'],
          分享人: [{ id: 'ou-share', name: '七月分享人' }],
          '参会人 (人员 )': [
            { id: 'ou-july-1', name: '七月参会人甲' },
            { id: 'ou-july-2', name: '七月参会人乙' },
          ],
          '演示文档/PPT（链接）':
            '[演示文档](https://example.invalid/july-presentation)',
        }),
        record({
          分享主题: '安全专题',
          分享类型: '专题研讨',
          '会议进度（勿动）': '未开始',
          开始时间: '2026-07-25T09:00:00+08:00',
          结束时间: '2026-07-25T10:00:00+08:00',
          月度: '07',
        }),
        record({
          分享主题: '已取消专题',
          分享类型: '技术交流',
          '会议进度（勿动）': '已终止',
          开始时间: '2026-07-26T09:00:00+08:00',
          结束时间: '2026-07-26T10:00:00+08:00',
          月度: ['07'],
        }),
        record({
          分享主题: ' ',
          分享类型: '技术交流',
          '会议进度（勿动）': '已结束',
          开始时间: '2026-07-27T09:00:00+08:00',
          结束时间: '2026-07-27T10:00:00+08:00',
          月度: '07',
        }),
      ],
      sharingScores: [
        record({
          主题名: 'UPS故障复盘',
          分享人: [{ id: 'ou-share', name: '七月分享人' }],
          评分: '8分',
        }),
        record({
          主题名: ['UPS故障复盘'],
          分享人: { users: [{ id: 'ou-share', name: '七月分享人' }] },
          评分: ['10分'],
        }),
        record({
          主题名: 'UPS故障复盘',
          分享人: [{ id: 'ou-wrong', name: '错误分享人' }],
          评分: 6,
        }),
        record({
          主题名: '故障案例分析',
          评分: ['6分'],
        }),
        record({
          主题名: '无关主题',
          评分: '10分',
        }),
      ],
      sharingInterests: [
        record({
          兴趣板块: ['安全'],
          提交人: [{ id: 'ou-interest-1', name: '兴趣提交人甲' }],
        }),
        record({
          兴趣板块: '安全',
          提交人: [{ id: 'ou-interest-2', name: '兴趣提交人乙' }],
        }),
        record({
          兴趣板块: { value: '技术' },
          提交人: [{ id: 'ou-interest-3', name: '兴趣提交人丙' }],
        }),
        record({
          兴趣板块: ' ',
          提交人: [{ id: 'ou-interest-4', name: '兴趣提交人丁' }],
        }),
      ],
    });

    const result = mapCampusTrainingDashboard(
      sources,
      undefined,
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.month).toBe('2026-07');
    expect(result.availableMonths).toEqual(['2026-07', '2026-06', '2026-05']);
    expect(result.summary.historicalSharingSessions).toBe(3);
    expect(result.summary.monthlyPlannedSharingSessions).toBe(2);
    expect(result.metricTrends.historicalSharingSessions).toEqual([
      0, 0, 1, 2, 3,
    ]);
    expect(result.metricTrends.monthlyPlannedSharingSessions).toEqual([
      0, 0, 1, 1, 2,
    ]);
    expect(result.sharing.categories).toEqual([
      {
        key: expect.any(String),
        label: '故障案例分析',
        sessions: 2,
        percentage: 66.7,
        tone: 'blue',
      },
      {
        key: expect.any(String),
        label: '技术交流',
        sessions: 1,
        percentage: 33.3,
        tone: 'teal',
      },
    ]);
    expect(result.sharing.trend).toEqual([
      { month: '2月', sessions: 0 },
      { month: '3月', sessions: 0 },
      { month: '4月', sessions: 0 },
      { month: '5月', sessions: 1 },
      { month: '6月', sessions: 1 },
      { month: '7月', sessions: 1 },
    ]);
    expect(result.sharing).toMatchObject({
      participants: 4,
      totalHours: 4.5,
      satisfaction: 80,
      materials: 2,
      interests: [
        { label: '安全', submissions: 2 },
        { label: '技术', submissions: 1 },
      ],
    });
    expect(result.dataStatus).toBe('ready');

    const repeated = mapCampusTrainingDashboard(
      sources,
      undefined,
      '2026-07-18T03:00:00.000Z',
    );
    const categoryKeys = result.sharing.categories.map(({ key }) => key);
    expect(categoryKeys).toEqual(
      repeated.sharing.categories.map(({ key }) => key),
    );
    expect(categoryKeys.every(Boolean)).toBe(true);
    expect(new Set(categoryKeys).size).toBe(categoryKeys.length);

    const numericValues = [
      ...Object.values(result.summary),
      ...Object.values(result.metricComparisons).map(({ change }) => change),
      ...Object.values(result.metricTrends).flat(),
      ...result.sharing.categories.flatMap(({ sessions, percentage }) => [
        sessions,
        percentage,
      ]),
      ...result.sharing.trend.map(({ sessions }) => sessions),
      result.sharing.participants,
      result.sharing.totalHours,
      result.sharing.satisfaction,
      result.sharing.materials,
      ...result.sharing.interests.map(({ submissions }) => submissions),
    ];
    expect(numericValues.every(Number.isFinite)).toBe(true);

    const withoutInterests = mapCampusTrainingDashboard(
      { ...sources, sharingInterests: [] },
      undefined,
      '2026-07-18T03:00:00.000Z',
    );
    expect(withoutInterests.sharing.interests).toEqual([]);
  });

  it('normalizes production sharing statuses for historical, planned, and available month metrics', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        sharingSessions: [
          record({
            分享主题: '五月已结束分享',
            '会议进度（勿动）': '会议已结束',
            月度: '2026-05',
          }),
          record({
            分享主题: '六月已终止分享',
            '会议进度（勿动）': ['会议已终止'],
            月度: '2026-06',
          }),
          record({
            分享主题: '七月制定中分享',
            '会议进度（勿动）': '会议审核&制定中',
            月度: '2026-07',
          }),
          record({
            分享主题: '七月已终止分享',
            '会议进度（勿动）': '会议已终止',
            月度: '2026-07',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect({
      historicalSharingSessions: result.summary.historicalSharingSessions,
      monthlyPlannedSharingSessions:
        result.summary.monthlyPlannedSharingSessions,
      availableMonths: result.availableMonths,
    }).toEqual({
      historicalSharingSessions: 1,
      monthlyPlannedSharingSessions: 1,
      availableMonths: ['2026-07', '2026-05'],
    });
  });

  it('keeps legacy unprefixed sharing terminal statuses compatible', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        sharingSessions: [
          record({
            分享主题: '旧结束状态分享',
            '会议进度（勿动）': '已结束',
            月度: '2026-07',
          }),
          record({
            分享主题: '旧终止状态分享',
            '会议进度（勿动）': '已终止',
            月度: '2026-07',
          }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.summary).toMatchObject({
      historicalSharingSessions: 1,
      monthlyPlannedSharingSessions: 1,
    });
  });

  it('treats a valid raw sharing month as a schedule without timestamps', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        sharingSessions: [
          record({
            分享主题: '八月排期',
            '会议进度（勿动）': '未开始',
            月度: '08',
          }),
        ],
      }),
      '2026-08',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.summary.monthlyPlannedSharingSessions).toBe(1);
    expect(result.dataStatus).toBe('ready');
  });

  it('excludes future terminated sharing months from available months and default selection', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        sharingSessions: [
          record({
            分享主题: '七月有效排期',
            '会议进度（勿动）': '未开始',
            月度: '2026-07',
          }),
          record({
            分享主题: '九月终止排期',
            '会议进度（勿动）': '已终止',
            月度: '2026-09',
          }),
        ],
      }),
      undefined,
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.availableMonths).toEqual(['2026-07']);
    expect(result.month).toBe('2026-07');
  });

  it('falls back to topic matching when either sharing side lacks ids and only accepts 6/8/10 ratings', () => {
    const result = mapCampusTrainingDashboard(
      emptySources({
        sharingSessions: [
          record({
            分享主题: '无ID分享',
            '会议进度（勿动）': '已结束',
            开始时间: '2026-07-10T09:00:00+08:00',
            结束时间: '2026-07-10T10:00:00+08:00',
            分享人: '文本分享人',
          }),
        ],
        sharingScores: [
          record({
            主题名: '无ID分享',
            分享人: [{ id: 'ou-rating-id', name: '评分身份' }],
            评分: 8,
          }),
          record({
            主题名: '无ID分享',
            分享人: '不同文本姓名',
            评分: 10,
          }),
          record({ 主题名: '无ID分享', 评分: 5 }),
          record({ 主题名: '无ID分享', 评分: 7 }),
          record({ 主题名: '无ID分享', 评分: 80 }),
        ],
      }),
      '2026-07',
      '2026-07-18T03:00:00.000Z',
    );

    expect(result.sharing.satisfaction).toBe(90);
  });
});
