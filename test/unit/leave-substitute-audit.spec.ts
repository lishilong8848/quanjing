import {
  buildLeaveSubstituteRepairPlan,
  getShanghaiWeekRange,
  inferTemporarySubstituteStaff,
} from '../../server/modules/duty-schedule/leave-substitute-audit';

describe('leave substitute audit', () => {
  it('builds a 2026 repair item from schedule actual staff and matching leave record', () => {
    const result = buildLeaveSubstituteRepairPlan({
      scanStartDate: '2026-05-18',
      scanEndDate: '2026-05-24',
      year: 2026,
      scheduleRecords: [
        {
          record_id: 'schedule-20260519-b-a-white',
          fields: {
            fldITqhd37: '20260519-B楼-A班-白-3160',
            fldZSaDbGf: '2026-05-19',
            fldnP4gXMn: 'B楼',
            fldE9Gwnk7: 'A班',
            fldqPpOgW5: '白',
            fldJi5bxBG: '顾晓磊 李松奇',
            fld4xMPICY: '李松奇',
            fldZnstUS3: '高子魏',
            '值班人员（实际）程序修改': '顾晓磊 章富权',
          },
        },
      ],
      leaveRecords: [
        {
          record_id: 'rec27ltiqzUf0Y',
          fields: {
            fldCBykrmQ: 'XJ-650-李松奇',
            fldV79GRbE: 46161,
            fldInfluwF: 'B楼',
            fldQJiJPd0: 'A班',
            fldcbi40pZ: '白',
            fldoiQwQuq: '李松奇',
            fld7noByKE: true,
            fldpUkeEzS: '高子魏',
          },
        },
      ],
    });

    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({
      scheduleRecordId: 'schedule-20260519-b-a-white',
      leaveRecordId: 'rec27ltiqzUf0Y',
      date: '2026-05-19',
      leaveName: '李松奇',
      currentSubstitute: '高子魏',
      suggestedSubstitute: '章富权',
      patch: {
        fld7noByKE: true,
        fldpUkeEzS: '章富权',
      },
    });
    expect(result.manualReviews).toHaveLength(0);
  });

  it('repairs an empty substitute field when actual staff reveals the substitute', () => {
    const result = buildLeaveSubstituteRepairPlan({
      scanStartDate: '2026-05-25',
      scanEndDate: '2026-05-31',
      year: 2026,
      scheduleRecords: [
        {
          record_id: 'schedule-20260529-a-c-white',
          fields: {
            fldITqhd37: '20260529-A楼-C班-白-3102',
            fldZSaDbGf: '2026-05-29',
            fldnP4gXMn: 'A楼',
            fldE9Gwnk7: 'C班',
            fldqPpOgW5: '白',
            fldJi5bxBG: '曾小庆 李董',
            fld4xMPICY: '李董',
            fldZnstUS3: '',
            '值班人员（实际）程序修改': '曾小庆 何洪',
          },
        },
      ],
      leaveRecords: [
        {
          record_id: 'leave-20260529-a-c-white-lidong',
          fields: {
            fldCBykrmQ: 'XJ-725-李董',
            fldV79GRbE: '2026-05-29',
            fldInfluwF: 'A楼',
            fldQJiJPd0: 'C班',
            fldcbi40pZ: '白',
            fldoiQwQuq: '李董',
            fld7noByKE: false,
            fldpUkeEzS: '',
          },
        },
      ],
    });

    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({
      scheduleRecordId: 'schedule-20260529-a-c-white',
      leaveRecordId: 'leave-20260529-a-c-white-lidong',
      date: '2026-05-29',
      leaveName: '李董',
      currentSubstitute: '',
      suggestedSubstitute: '何洪',
      patch: {
        fld7noByKE: true,
        fldpUkeEzS: '何洪',
      },
    });
    expect(result.manualReviews).toHaveLength(0);
  });

  it('infers temporary substitute staff when actual staff fills a short-handed shift without leave', () => {
    expect(
      inferTemporarySubstituteStaff({
        plannedStaff: ['章富权'],
        leaveStaff: [],
        actualStaff: ['章富权', '曹雷'],
      }),
    ).toEqual(['曹雷']);
  });

  it('ignores 2025 records even when they are mismatched', () => {
    const result = buildLeaveSubstituteRepairPlan({
      scanStartDate: '2025-12-08',
      scanEndDate: '2025-12-14',
      year: 2026,
      scheduleRecords: [
        {
          record_id: 'schedule-20251209-h-d-white',
          fields: {
            fldZSaDbGf: '2025-12-09',
            fldnP4gXMn: 'H楼',
            fldE9Gwnk7: 'D班',
            fldqPpOgW5: '白',
            fldJi5bxBG: '祁金鹰 陈建峰',
            fld4xMPICY: '陈建峰',
            fldZnstUS3: '朱春建',
            '值班人员（实际）程序修改': '祁金鹰 张岳军',
          },
        },
      ],
      leaveRecords: [],
    });

    expect(result.checkedSchedules).toBe(0);
    expect(result.repairs).toHaveLength(0);
    expect(result.manualReviews).toHaveLength(0);
  });

  it('does not repair when the leave substitute is already in actual staff', () => {
    const result = buildLeaveSubstituteRepairPlan({
      scanStartDate: '2026-05-18',
      scanEndDate: '2026-05-24',
      year: 2026,
      scheduleRecords: [
        {
          record_id: 'schedule-ok',
          fields: {
            fldZSaDbGf: '2026-05-19',
            fldnP4gXMn: 'B楼',
            fldE9Gwnk7: 'A班',
            fldqPpOgW5: '白',
            fldJi5bxBG: '顾晓磊 李松奇',
            fld4xMPICY: '李松奇',
            fldZnstUS3: '章富权',
            '值班人员（实际）程序修改': '顾晓磊 章富权',
          },
        },
      ],
      leaveRecords: [],
    });

    expect(result.checkedSchedules).toBe(1);
    expect(result.mismatches).toHaveLength(0);
    expect(result.repairs).toHaveLength(0);
  });

  it('calculates the Shanghai Monday-Sunday week range', () => {
    expect(getShanghaiWeekRange(new Date('2026-05-19T12:00:00+08:00'))).toEqual({
      startDate: '2026-05-18',
      endDate: '2026-05-24',
    });
  });
});
