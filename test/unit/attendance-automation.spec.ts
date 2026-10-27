import {
  buildAttendanceAutomationIdempotencyKey,
  buildLiveAttendanceWindow,
  buildYesterdayAttendanceWindow,
  getDueAttendanceAutomationRuns,
  getNextAttendanceAutomationRun,
} from '../../server/modules/duty-schedule/attendance-automation.scheduler';
import {
  classifyAttendanceExpectations,
  type AttendanceExpectation,
} from '../../server/modules/duty-schedule/attendance-automation.rules';
import {
  buildAttendanceAnomalyCard,
  buildPersonalAttendanceAnomalyCard,
} from '../../server/modules/duty-schedule/attendance-automation.card';
import {
  buildAttendanceExpectationPlan,
  buildDailyAttendanceExpectationPlan,
  buildFinalAttendanceExpectationPlan,
  matchDingTalkResultsToExpectations,
} from '../../server/modules/duty-schedule/attendance-automation.expectations';

describe('attendance automation scheduler', () => {
  it('runs the yesterday archive at 00:30 Asia/Shanghai', () => {
    const next = getNextAttendanceAutomationRun(
      new Date('2026-08-29T16:20:00.000Z'),
    );

    expect(next).toEqual({
      task: 'archive-yesterday',
      date: '2026-08-29',
      scheduledAt: new Date('2026-08-29T16:30:00.000Z'),
    });
    expect(buildYesterdayAttendanceWindow('2026-08-29')).toEqual({
      businessDate: '2026-08-29',
      start: '2026-08-29 00:00:00',
      end: '2026-08-29 23:59:59',
    });
  });

  it('runs the four live tasks in order at their Asia/Shanghai times', () => {
    expect(
      getNextAttendanceAutomationRun(new Date('2026-08-29T16:31:00.000Z')),
    ).toEqual({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      scheduledAt: new Date('2026-08-30T00:55:00.000Z'),
    });

    expect(
      getNextAttendanceAutomationRun(new Date('2026-08-30T00:55:00.000Z')),
    ).toEqual({
      task: 'morning-off-duty-check',
      date: '2026-08-30',
      scheduledAt: new Date('2026-08-30T01:30:00.000Z'),
    });

    expect(
      getNextAttendanceAutomationRun(new Date('2026-08-30T01:30:00.000Z')),
    ).toEqual({
      task: 'evening-on-duty-reminder',
      date: '2026-08-30',
      scheduledAt: new Date('2026-08-30T09:55:00.000Z'),
    });

    expect(
      getNextAttendanceAutomationRun(new Date('2026-08-30T09:55:00.000Z')),
    ).toEqual({
      task: 'evening-off-duty-check',
      date: '2026-08-30',
      scheduledAt: new Date('2026-08-30T10:35:00.000Z'),
    });

    expect(
      getNextAttendanceAutomationRun(new Date('2026-08-30T10:35:00.000Z')),
    ).toEqual({
      task: 'archive-yesterday',
      date: '2026-08-30',
      scheduledAt: new Date('2026-08-30T16:30:00.000Z'),
    });
  });

  it('marks each live task due only after its scheduled boundary', () => {
    const beforeEveningReminder = getDueAttendanceAutomationRuns(
      new Date('2026-08-30T09:54:59.000Z'),
      0,
    );
    expect(beforeEveningReminder.map((run) => run.task)).not.toContain(
      'evening-on-duty-reminder',
    );

    const atEveningReminder = getDueAttendanceAutomationRuns(
      new Date('2026-08-30T09:55:00.000Z'),
      0,
    );
    expect(atEveningReminder.map((run) => run.task)).toContain(
      'evening-on-duty-reminder',
    );
    expect(atEveningReminder.map((run) => run.task)).not.toContain(
      'evening-off-duty-check',
    );

    const beforeEveningCheck = getDueAttendanceAutomationRuns(
      new Date('2026-08-30T10:34:59.000Z'),
      0,
    );
    expect(beforeEveningCheck.map((run) => run.task)).not.toContain(
      'evening-off-duty-check',
    );

    const atEveningCheck = getDueAttendanceAutomationRuns(
      new Date('2026-08-30T10:35:00.000Z'),
      0,
    );
    expect(atEveningCheck.map((run) => run.task)).toContain(
      'evening-off-duty-check',
    );
  });

  it('queries the two final daily checks through 09:30 and 18:35', () => {
    expect(
      buildLiveAttendanceWindow('morning-off-duty-check', '2026-09-07'),
    ).toEqual({
      start: '2026-09-07 00:00:00',
      end: '2026-09-07 09:30:59',
    });
    expect(
      buildLiveAttendanceWindow('evening-off-duty-check', '2026-09-07'),
    ).toEqual({
      start: '2026-09-07 00:00:00',
      end: '2026-09-07 18:35:59',
    });
  });

  it('keeps reminder and check idempotency keys distinct', () => {
    expect(
      buildAttendanceAutomationIdempotencyKey(
        'morning-on-duty-reminder',
        '2026-08-31',
        'ou_recipient',
      ),
    ).not.toBe(
      buildAttendanceAutomationIdempotencyKey(
        'morning-off-duty-check',
        '2026-08-31',
        'ou_recipient',
      ),
    );
  });

  it('keeps every delivery idempotency key within the Feishu 50 character limit', () => {
    const key = buildAttendanceAutomationIdempotencyKey(
      'evening-off-duty-check',
      '2026-08-30',
      'ou_recipient',
    );
    expect(key.length).toBeLessThanOrEqual(50);
    expect(key).toBe(
      buildAttendanceAutomationIdempotencyKey(
        'evening-off-duty-check',
        '2026-08-30',
        'ou_recipient',
      ),
    );
  });

  it('never schedules business dates before the 2026-08-28 effective boundary', () => {
    const due = (
      getDueAttendanceAutomationRuns as unknown as (
        now: Date,
        lookbackDays: number,
        effectiveFrom: string,
      ) => ReturnType<typeof getDueAttendanceAutomationRuns>
    )(new Date('2026-08-30T12:30:00.000Z'), 5, '2026-08-28');

    expect(due.length).toBeGreaterThan(0);
    expect(due.every((run) => run.date >= '2026-08-28')).toBe(true);
  });

  it('does not replay expired live cards when the service starts late', () => {
    const due = (
      getDueAttendanceAutomationRuns as unknown as (
        now: Date,
        lookbackDays: number,
        effectiveFrom: string,
        reconcileStartedAt: Date,
        liveCatchUpMinutes: number,
      ) => ReturnType<typeof getDueAttendanceAutomationRuns>
    )(
      new Date('2026-08-30T12:30:00.000Z'),
      0,
      '2026-08-28',
      new Date('2026-08-30T12:30:00.000Z'),
      30,
    );

    expect(due).toEqual([]);
  });
});

describe('attendance automation expectation plan', () => {
  const previousNight = {
    id: 'prev-night',
    recordId: 'prev-night',
    dutyCode: 'prev-night',
    scheduleDate: '2026-08-29',
    code: null,
    building: 'building_c',
    team: 'team_1',
    shift: 'night',
    personText: '吴亚兵',
    dutyStaffReference: ['吴亚兵'],
    dutyStaffActual: ['潘佩胜'],
    remark: '',
    emergencyDuty: '',
    emergencyDutySchedule: '',
    leaveStaff: ['吴亚兵'],
    substituteStaff: ['潘佩胜'],
    actualDutyStaff: '潘佩胜',
    buildingText: 'C楼',
    teamText: '一班',
    shiftText: '夜班',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const currentWhite = {
    ...previousNight,
    id: 'current-white',
    recordId: 'current-white',
    dutyCode: 'current-white',
    scheduleDate: '2026-08-30',
    shift: 'white',
    shiftText: '白班',
    personText: '蒋杰',
    dutyStaffReference: ['蒋杰'],
    dutyStaffActual: ['顾晓磊'],
    leaveStaff: ['蒋杰'],
    substituteStaff: ['顾晓磊'],
    actualDutyStaff: '顾晓磊',
  };

  it('builds the split morning scopes from previous night, current white and long-white staff', () => {
    const onDutyPlan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [previousNight, currentWhite],
      longWhiteBuildings: [
        { building: 'building_a', buildingName: 'A楼', staff: ['张三'] },
      ],
    });
    const offDutyPlan = buildAttendanceExpectationPlan({
      task: 'morning-off-duty-check',
      date: '2026-08-30',
      schedules: [previousNight, currentWhite],
      longWhiteBuildings: [],
    });
    const plan = {
      expectations: [...offDutyPlan.expectations, ...onDutyPlan.expectations],
      excludedCount: offDutyPlan.excludedCount + onDutyPlan.excludedCount,
    };

    expect(
      plan.expectations.map((item) => [
        item.name,
        item.direction,
        item.expectedAt,
        item.status,
      ]),
    ).toEqual([
      ['潘佩胜', 'OffDuty', '2026-08-30 09:00:00', 'substitute'],
      ['顾晓磊', 'OnDuty', '2026-08-30 09:00:00', 'substitute'],
      ['张三', 'OnDuty', '2026-08-30 09:00:00', 'on_duty'],
    ]);
    expect(plan.excludedCount).toBe(2);
  });

  it('rechecks both card directions in each final page snapshot', () => {
    const morning = buildFinalAttendanceExpectationPlan({
      task: 'morning-off-duty-check',
      date: '2026-08-30',
      schedules: [previousNight, currentWhite],
      longWhiteBuildings: [
        { building: 'building_a', buildingName: 'A楼', staff: ['张三'] },
      ],
    });
    const evening = buildFinalAttendanceExpectationPlan({
      task: 'evening-off-duty-check',
      date: '2026-08-30',
      schedules: [previousNight, currentWhite],
      longWhiteBuildings: [
        { building: 'building_a', buildingName: 'A楼', staff: ['张三'] },
      ],
    });

    expect(
      morning.expectations.map((item) => [item.name, item.direction]),
    ).toEqual(
      expect.arrayContaining([
        [currentWhite.dutyStaffActual[0], 'OnDuty'],
        [previousNight.dutyStaffActual[0], 'OffDuty'],
        ['张三', 'OnDuty'],
      ]),
    );
    expect(
      evening.expectations.map((item) => [item.name, item.direction]),
    ).toEqual(
      expect.arrayContaining([
        [currentWhite.dutyStaffActual[0], 'OffDuty'],
        ['张三', 'OffDuty'],
      ]),
    );
  });

  it('keeps 110 expectation timing distinct from campus timing', () => {
    const stationWhite = {
      ...currentWhite,
      building: 'station_110',
      buildingText: '110站',
      dutyStaffActual: ['陈建峰'],
      leaveStaff: [],
      substituteStaff: [],
    };
    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [currentWhite, stationWhite],
      longWhiteBuildings: [],
    });

    expect(plan.expectations).toHaveLength(2);
    expect(
      plan.expectations.find(
        (item) => item.building === stationWhite.buildingText,
      ),
    ).toMatchObject({
      name: '陈建峰',
      building: '110站',
      direction: 'OnDuty',
      expectedAt: '2026-08-30 08:00:00',
    });
  });

  it('checks the 110 white-shift off-duty card in the next 00:30 archive only', () => {
    const stationWhite = {
      ...currentWhite,
      building: 'station_110',
      buildingText: '110站',
      dutyStaffActual: ['陈建峰'],
      leaveStaff: [],
      substituteStaff: [],
    };
    const livePlan = buildAttendanceExpectationPlan({
      task: 'evening-off-duty-check',
      date: '2026-08-30',
      schedules: [stationWhite],
      longWhiteBuildings: [],
    });
    const archivePlan = buildDailyAttendanceExpectationPlan({
      date: '2026-08-30',
      schedules: [stationWhite],
      longWhiteBuildings: [],
    });

    expect(livePlan.expectations).toEqual([]);
    expect(archivePlan.expectations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '陈建峰',
          building: '110站',
          direction: 'OffDuty',
          expectedAt: '2026-08-30 20:00:00',
        }),
      ]),
    );
  });

  it('checks the 110 night-shift on-duty card in the next 00:30 archive only', () => {
    const stationNight = {
      ...previousNight,
      id: 'station-night',
      recordId: 'station-night',
      dutyCode: 'station-night',
      scheduleDate: '2026-08-30',
      building: 'station_110',
      buildingText: '110站',
      dutyStaffReference: ['陈建峰'],
      dutyStaffActual: ['陈建峰'],
      leaveStaff: [],
      substituteStaff: [],
      actualDutyStaff: '陈建峰',
    };
    const reminderPlan = buildAttendanceExpectationPlan({
      task: 'evening-on-duty-reminder',
      date: '2026-08-30',
      schedules: [stationNight],
      longWhiteBuildings: [],
    });
    const finalPlan = buildFinalAttendanceExpectationPlan({
      task: 'evening-off-duty-check',
      date: '2026-08-30',
      schedules: [stationNight],
      longWhiteBuildings: [],
    });
    const archivePlan = buildDailyAttendanceExpectationPlan({
      date: '2026-08-30',
      schedules: [stationNight],
      longWhiteBuildings: [],
    });

    expect(reminderPlan.expectations).toEqual([]);
    expect(finalPlan.expectations).toEqual([]);
    expect(archivePlan.expectations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '陈建峰',
          building: '110站',
          direction: 'OnDuty',
          expectedAt: '2026-08-30 20:00:00',
        }),
      ]),
    );
  });

  it('excludes approved leave staff and verifies substitutes even when actual staff is stale', () => {
    const staleLeaveSchedule = {
      ...currentWhite,
      id: 'leave-with-substitute',
      recordId: 'leave-with-substitute',
      dutyCode: 'leave-with-substitute',
      dutyStaffReference: ['陈思凯', '曹雷'],
      dutyStaffActual: ['陈思凯', '曹雷'],
      leaveStaff: ['陈思凯', '曹雷'],
      substituteStaff: ['曹毅', '王强'],
      actualDutyStaff: '陈思凯、曹雷',
    };

    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [staleLeaveSchedule],
      longWhiteBuildings: [],
    });

    expect(plan.expectations.map((item) => item.name)).toEqual([
      '曹毅',
      '王强',
    ]);
    expect(
      plan.expectations.every((item) => item.status === 'substitute'),
    ).toBe(true);
    expect(plan.excludedCount).toBe(2);
  });

  it('excludes business travelers from attendance checks and keeps their active substitutes', () => {
    const travelSchedule = {
      ...currentWhite,
      id: 'travel-with-substitute',
      recordId: 'travel-with-substitute',
      dutyCode: 'travel-with-substitute',
      dutyStaffReference: ['差旅人员', '正常人员'],
      dutyStaffActual: ['差旅人员', '正常人员', '替班人员'],
      leaveStaff: [],
      substituteStaff: ['替班人员'],
      travelStaff: ['差旅人员'],
      actualDutyStaff: '差旅人员、正常人员、替班人员',
    };

    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [travelSchedule],
      longWhiteBuildings: [],
    });

    expect(plan.expectations.map((item) => item.name)).toEqual([
      '正常人员',
      '替班人员',
    ]);
    expect(plan.expectations.some((item) => item.name === '差旅人员')).toBe(
      false,
    );
    expect(plan.excludedCount).toBe(1);
  });

  it('matches live DingTalk results by stable user id, direction and expected time', () => {
    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [currentWhite],
      longWhiteBuildings: [],
    });
    const matched = matchDingTalkResultsToExpectations(
      plan.expectations,
      [{ userId: 'ding-gu', name: '顾晓磊' }],
      [
        {
          id: 101,
          userId: 'ding-gu',
          checkType: 'OnDuty',
          baseCheckTime: Date.parse('2026-08-30T01:00:00.000Z'),
          userCheckTime: null,
          timeResult: 'NotSigned',
          workDate: Date.parse('2026-08-30T00:00:00.000Z'),
        },
      ],
    );

    expect(matched).toEqual([
      expect.objectContaining({
        expectationKey: plan.expectations[0].key,
        timeResult: 'NotSigned',
        userCheckTime: null,
        userId: 'ding-gu',
      }),
    ]);
  });

  it('uses direct DingTalk punch details as a normal fallback when the result list is empty', () => {
    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [currentWhite],
      longWhiteBuildings: [],
    });
    const matched = matchDingTalkResultsToExpectations(
      plan.expectations,
      [{ userId: 'ding-gu', name: '顾晓磊' }],
      [],
      [
        {
          id: 201,
          userId: 'ding-gu',
          checkType: 'OnDuty',
          baseCheckTime: Date.parse('2026-08-30T01:00:00.000Z'),
          userCheckTime: Date.parse('2026-08-30T00:58:00.000Z'),
          workDate: Date.parse('2026-08-30T00:00:00.000Z'),
          timeResult: null,
          locationResult: 'Normal',
          userAddress: null,
          userLongitude: null,
          userLatitude: null,
          outsideRemark: null,
          invalidRecordMsg: null,
          deviceId: null,
          sourceType: null,
          original: {},
        },
      ],
    );

    expect(matched[0]).toMatchObject({
      expectationKey: plan.expectations[0].key,
      timeResult: 'Normal',
      userCheckTime: '2026-08-30 08:58:00',
    });
  });

  it('uses a valid punch detail when the summary result is still NotSigned', () => {
    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [currentWhite],
      longWhiteBuildings: [],
    });
    const matched = matchDingTalkResultsToExpectations(
      plan.expectations,
      [{ userId: 'ding-gu', name: '顾晓磊' }],
      [
        {
          id: 101,
          userId: 'ding-gu',
          checkType: 'OnDuty',
          baseCheckTime: Date.parse('2026-08-30T01:00:00.000Z'),
          userCheckTime: null,
          timeResult: 'NotSigned',
          workDate: Date.parse('2026-08-30T00:00:00.000Z'),
        },
      ],
      [
        {
          id: 201,
          userId: 'ding-gu',
          checkType: 'OnDuty',
          baseCheckTime: Date.parse('2026-08-30T01:00:00.000Z'),
          userCheckTime: Date.parse('2026-08-30T00:58:00.000Z'),
          workDate: Date.parse('2026-08-30T00:00:00.000Z'),
          timeResult: null,
          locationResult: 'Normal',
          userAddress: null,
          userLongitude: null,
          userLatitude: null,
          outsideRemark: null,
          invalidRecordMsg: null,
          deviceId: null,
          sourceType: null,
          original: {},
        },
      ],
    );

    expect(matched[0]).toMatchObject({
      expectationKey: plan.expectations[0].key,
      timeResult: 'Normal',
      userCheckTime: '2026-08-30 08:58:00',
    });
  });

  it('marks a late raw punch as late even when listRecord omits timeResult', () => {
    const plan = buildAttendanceExpectationPlan({
      task: 'morning-on-duty-reminder',
      date: '2026-08-30',
      schedules: [currentWhite],
      longWhiteBuildings: [],
    });
    const matched = matchDingTalkResultsToExpectations(
      plan.expectations,
      [{ userId: 'ding-gu', name: '顾晓磊' }],
      [],
      [
        {
          id: 202,
          userId: 'ding-gu',
          checkType: 'OnDuty',
          baseCheckTime: null,
          userCheckTime: Date.parse('2026-08-30T01:07:00.000Z'),
          workDate: Date.parse('2026-08-30T00:00:00.000Z'),
          timeResult: null,
          locationResult: 'Normal',
          userAddress: null,
          userLongitude: null,
          userLatitude: null,
          outsideRemark: null,
          invalidRecordMsg: null,
          deviceId: null,
          sourceType: null,
          original: {},
        },
      ],
    );

    expect(matched[0]).toMatchObject({
      expectationKey: plan.expectations[0].key,
      timeResult: 'Late',
      userCheckTime: '2026-08-30 09:07:00',
    });
    expect(
      classifyAttendanceExpectations(plan.expectations, matched).anomalies,
    ).toEqual([expect.objectContaining({ reason: '迟到' })]);
  });
});

describe('attendance anomaly classification', () => {
  const expectations: AttendanceExpectation[] = [
    {
      key: 'c-gu-on',
      name: '顾晓磊',
      building: 'C楼',
      shiftLabel: '白班',
      direction: 'OnDuty',
      expectedAt: '2026-08-30 09:00:00',
      status: 'substitute',
    },
    {
      key: 'b-li-on',
      name: '李磊',
      building: 'B楼',
      shiftLabel: '夜班',
      direction: 'OnDuty',
      expectedAt: '2026-08-30 18:00:00',
      status: 'on_duty',
    },
    {
      key: 'd-leave-on',
      name: '江亮',
      building: 'D楼',
      shiftLabel: '白班',
      direction: 'OnDuty',
      expectedAt: '2026-08-30 09:00:00',
      status: 'leave',
    },
  ];

  it('marks explicit NotSigned and absent results as anomalies', () => {
    const result = classifyAttendanceExpectations(expectations, [
      {
        expectationKey: 'c-gu-on',
        timeResult: 'NotSigned',
        userCheckTime: null,
      },
    ]);

    expect(result.anomalies.map((item) => item.name)).toEqual([
      '顾晓磊',
      '李磊',
    ]);
    expect(result.excluded.map((item) => item.name)).toEqual(['江亮']);
  });

  it('classifies every due expectation as either normal or anomalous', () => {
    const result = classifyAttendanceExpectations(expectations.slice(1, 2), []);
    expect(result.anomalies).toHaveLength(1);
    expect(result.normal).toHaveLength(0);
    expect(result.anomalies[0].reason).toBe('未查询到有效打卡');
  });

  it('keeps an approved correction as normal while evidence sync is handled separately', () => {
    const result = classifyAttendanceExpectations(expectations.slice(0, 1), [
      {
        expectationKey: 'c-gu-on',
        timeResult: 'Normal',
        userCheckTime: '2026-08-30 09:00:00',
        sourceType: 'APPROVE',
        correctionEvidenceStatus: 'missing',
      },
    ]);

    expect(result.normal).toHaveLength(1);
    expect(result.anomalies).toHaveLength(0);
  });

  it('accepts an approved correction only when photo evidence is present', () => {
    const result = classifyAttendanceExpectations(expectations.slice(0, 1), [
      {
        expectationKey: 'c-gu-on',
        timeResult: 'Normal',
        userCheckTime: '2026-08-30 09:00:00',
        sourceType: 'APPROVE',
        correctionEvidenceStatus: 'present',
      },
    ]);

    expect(result.normal).toHaveLength(1);
    expect(result.anomalies).toHaveLength(0);
  });
});

describe('attendance anomaly card', () => {
  it('builds a read-only test card with direct DingTalk provenance', () => {
    const anomaly: AttendanceExpectation = {
      key: 'c-gu-on',
      name: '顾晓磊',
      building: 'C楼',
      shiftLabel: '白班',
      direction: 'OnDuty',
      expectedAt: '2026-08-30 09:00:00',
      status: 'substitute',
    };
    const normal: AttendanceExpectation = {
      key: 'b-li-on',
      name: '李磊',
      building: 'B楼',
      shiftLabel: '夜班',
      direction: 'OnDuty',
      expectedAt: '2026-08-30 18:00:00',
      status: 'on_duty',
    };
    const card = buildAttendanceAnomalyCard({
      date: '2026-08-30',
      fetchedAt: '2026-08-30 19:29',
      label: '测试',
      dueSlots: ['08:55', '09:30', '17:55', '18:35'],
      futureSlots: [],
      anomalies: [
        {
          ...anomaly,
          reason: '未打卡',
        },
      ],
      normalCount: 1,
      excludedCount: 1,
      scheduleUrl: 'https://example.test/schedule',
    });
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe('2.0');
    expect(serialized).toContain('考勤异常');
    expect(serialized).not.toContain('数据来源');
    expect(serialized).not.toContain('待核对');
    expect(serialized).not.toContain(normal.name);
    expect(serialized).not.toContain('callback');
    expect(serialized).toContain('open_url');
  });

  it('labels a zero-anomaly yesterday summary as attendance normal', () => {
    const card = buildAttendanceAnomalyCard({
      date: '2026-09-04',
      fetchedAt: '2026-09-05 00:31',
      label: '09:30 · 昨日考勤',
      summaryPeriod: 'yesterday',
      dueSlots: ['00:30 归档'],
      futureSlots: [],
      anomalies: [],
      normalCount: 12,
      scheduleUrl: 'https://ops.example.com/monthly-schedule',
    });

    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('考勤正常');
    expect(JSON.stringify(card)).toContain('本时段考勤正常');
    expect(JSON.stringify(card)).not.toContain('南通园区考勤异常');
  });

  it('builds one concise personal card for all anomalies of the employee', () => {
    const card = buildPersonalAttendanceAnomalyCard({
      date: '2026-08-31',
      fetchedAt: '2026-08-31 09:30',
      label: '09:30 个人',
      recipientName: '曹毅',
      anomalies: [
        {
          key: 'cao-off',
          name: '曹毅',
          building: 'C楼',
          shiftLabel: '夜班',
          direction: 'OffDuty',
          expectedAt: '2026-08-31 09:00:00',
          status: 'substitute',
          reason: '未查询到有效打卡',
        },
        {
          key: 'cao-on',
          name: '曹毅',
          building: 'C楼',
          shiftLabel: '白班',
          direction: 'OnDuty',
          expectedAt: '2026-08-31 09:00:00',
          status: 'on_duty',
          reason: '未查询到有效打卡',
        },
      ],
      scheduleUrl: 'https://example.test/schedule',
      leaveRequestUrl: 'https://example.test/monthly-schedule/apply/leave',
      dingTalkCorrectionUrl:
        'https://applink.dingtalk.com/action/openapp?container_type=work_platform&app_id=158',
    });
    const serialized = JSON.stringify(card);
    const buttons = card.body.elements.flatMap((element: any) => {
      if (element.tag === 'button') return [element];
      if (element.tag !== 'column_set') return [];
      return element.columns.flatMap((column: any) =>
        column.elements.filter((child: any) => child.tag === 'button'),
      );
    });

    expect(serialized).toContain('曹毅');
    expect(serialized).toContain('2 项考勤异常');
    expect(serialized).toContain('上班卡');
    expect(serialized).toContain('下班卡');
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button: any) => button.text.content)).toEqual([
      '前往钉钉补卡',
      '补提请休假',
      '查看实际排班',
    ]);
    expect(buttons[0]).toMatchObject({
      type: 'primary_filled',
      behaviors: [
        {
          type: 'open_url',
          default_url:
            'https://applink.dingtalk.com/action/openapp?container_type=work_platform&app_id=158',
        },
      ],
    });
    expect(buttons[1]).toMatchObject({
      type: 'default',
      behaviors: [
        {
          type: 'open_url',
          default_url: 'https://example.test/monthly-schedule/apply/leave',
        },
      ],
    });
    expect(buttons[2]).toMatchObject({
      type: 'default',
      behaviors: [
        {
          type: 'open_url',
          default_url: 'https://example.test/schedule',
        },
      ],
    });
    expect(serialized).toContain('进入钉钉后选择“补卡申请”');
    expect(serialized).not.toContain('数据来源');
    expect(serialized).not.toContain('callback');
  });
});
