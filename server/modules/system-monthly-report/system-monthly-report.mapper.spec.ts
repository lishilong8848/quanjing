import {
  buildBitableOptionMaps,
  buildSystemMonthlyReportWorkdayMilestones,
  findSystemMonthlyReportSubmissionRecordIds,
  mapLatestFinalReportRecords,
  mapSystemMonthlyReportSources,
  normalizeBitableDate,
} from './system-monthly-report.mapper';

describe('system monthly report mapper', () => {
  it('finds only matching room, month and stage attachment records', () => {
    const records = [
      {
        record_id: 'rec-aug-b-initial',
        fields: {
          机房: '南通-B',
          月报月份: 8,
          创建时间: 1788192000000,
          初版月报: [{ file_token: 'box-1' }],
        },
      },
      {
        record_id: 'rec-aug-b-final',
        fields: {
          机房: '南通-B',
          月报月份: 8,
          创建时间: 1788192000000,
          终版月报: [{ file_token: 'box-2' }],
        },
      },
      {
        record_id: 'rec-aug-c-initial',
        fields: {
          机房: '南通-C',
          月报月份: 8,
          创建时间: 1788192000000,
          初版月报: [{ file_token: 'box-3' }],
        },
      },
      {
        record_id: 'rec-jul-b-initial',
        fields: {
          机房: '南通-B',
          月报月份: 7,
          创建时间: 1788192000000,
          初版月报: [{ file_token: 'box-4' }],
        },
      },
    ];

    expect(
      findSystemMonthlyReportSubmissionRecordIds(records, {
        room: '南通-B',
        reportYear: 2026,
        reportMonth: 8,
        stage: 'initial',
      }),
    ).toEqual(['rec-aug-b-initial']);
  });

  it('decodes formula select ids and Excel serial dates from the real monthly table shape', () => {
    const optionMaps = buildBitableOptionMaps([
      {
        field_name: '月报月份',
        property: {
          type: {
            ui_property: {
              options: [{ id: 'optEdXMPwe', name: '7月' }],
            },
          },
        },
      },
    ]);

    expect(optionMaps['月报月份']?.get('optEdXMPwe')).toBe('7月');
    expect(normalizeBitableDate(46264)).toBe('2026-08-30');
  });

  it('derives the five-stage room lifecycle, current review task, schedule, history and standards warning', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-10T04:00:00.000Z'),
      currentFields: [
        {
          field_name: '月报月份',
          property: {
            type: {
              ui_property: {
                options: [{ id: 'optEdXMPwe', name: '7月' }],
              },
            },
          },
        },
      ],
      scheduleFields: [
        {
          field_name: '审核年份',
          property: {
            type: {
              ui_property: {
                options: [{ id: 'optyutOQF8', name: '2026' }],
              },
            },
          },
        },
      ],
      currentRecords: [
        {
          record_id: 'rec-current-b',
          fields: {
            月报编码: [{ text: '南通-B--01', type: 'text' }],
            机房: '南通-B',
            月报月份: ['optEdXMPwe'],
            月报提醒日期: 46264,
            初版提交日期: 46266,
            复核需求提交日期: 46267,
            最终版提交日期: 46268,
            初审人员: { users: [{ id: 'ou_initial', name: '杨占山' }] },
            二次复核人员: { users: [{ id: 'ou_recheck', name: '顾晓磊' }] },
            初版月报提交的最新时间: 1786073940000,
            初审意见提交的最新时间: 1786160340000,
            复审月报提交最新日期: 1787116500000,
          },
        },
      ],
      scheduleRecords: [
        {
          record_id: 'rec-schedule-recheck-b',
          fields: {
            审核年份: ['optyutOQF8'],
            审核月份: '7月',
            审核轮次: '复审',
            审核机房: '南通-B',
            所属机房: '昆山',
            审核人: { users: [{ id: 'ou_recheck', name: '顾晓磊' }] },
          },
        },
      ],
      collectionRecords: [
        {
          record_id: 'rec-history-b',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: 1786073940000,
            终版月报: [
              { file_token: 'box-final', name: '南通-B-7月终版.xlsx' },
            ],
          },
        },
      ],
      standardRecords: [
        {
          record_id: 'rec-standard-event',
          fields: { 板块: '事件管理', 占比: 0.2, 评分细则: '事件标准' },
        },
        {
          record_id: 'rec-standard-risk',
          fields: { 板块: '风险管理', 占比: 0.2, 评分细则: '风险标准' },
        },
      ],
    });

    expect(dashboard.period).toMatchObject({
      year: 2026,
      month: 7,
      label: '2026年7月体系月报',
      reminderDate: '2026-08-30',
    });
    expect(dashboard.rooms).toHaveLength(1);
    expect(dashboard.rooms[0]).toMatchObject({
      recordId: 'rec-current-b',
      room: '南通-B',
      code: '南通-B--01',
      status: 'completed',
      currentOwnerRole: '归档人',
      currentOwnerName: '待认领',
      initialReviewer: { openId: 'ou_initial', name: '杨占山' },
      recheckReviewer: { openId: 'ou_recheck', name: '顾晓磊' },
    });
    expect(dashboard.rooms[0].steps.map((step) => step.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(dashboard.schedule).toEqual([
      expect.objectContaining({
        round: 'recheck',
        room: '南通-B',
        reviewer: { openId: 'ou_recheck', name: '顾晓磊' },
      }),
    ]);
    expect(dashboard.history).toEqual([
      expect.objectContaining({
        year: 2026,
        month: 7,
        room: '南通-B',
        finalAttachmentCount: 1,
      }),
    ]);
    expect(dashboard.warnings).not.toContain(
      '审核表单中的“其他问题”与评分标准中的“风险管理”不是同一字段，请审核人按风险标准检查后记录在其他问题中。',
    );
  });

  it('switches to the calendar month after the 15th without carrying the previous month progress forward', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-30T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [
        {
          record_id: 'rec-current-kunshan',
          fields: {
            机房: '昆山',
            月报月份: 7,
            月报提醒日期: '2026-08-30',
            初版月报提交的最新时间: '2026-08-03T09:00:00+08:00',
            初审意见提交的最新时间: '2026-08-04T09:00:00+08:00',
            复审月报提交最新日期: '2026-08-05T09:00:00+08:00',
            复审意见提交最新日期: '2026-08-06T09:00:00+08:00',
            最终月报提交最新日期: '2026-08-07T09:00:00+08:00',
          },
        },
      ],
      personnelRecords: [
        {
          record_id: 'rec-personnel-kunshan',
          fields: {
            机房: '昆山',
            负责人: { users: [{ id: 'ou_gu', name: '顾晓磊' }] },
            十夫长: { users: [{ id: 'ou_dingxin', name: '丁心团' }] },
          },
        },
      ],
      scheduleRecords: [],
      collectionRecords: [
        {
          record_id: 'rec-july-final-kunshan',
          fields: {
            机房: '昆山',
            月报月份: 7,
            创建时间: '2026-08-07T09:00:00+08:00',
            终版月报: [{ file_token: 'box-july-final' }],
          },
        },
      ],
      standardRecords: [],
    });

    expect(dashboard.period).toMatchObject({
      year: 2026,
      month: 8,
      label: '2026年8月体系月报',
    });
    expect(dashboard.rooms[0]).toMatchObject({
      room: '昆山',
      status: 'initial_pending',
      currentOwnerName: '顾晓磊',
    });
    expect(dashboard.rooms[0].steps.map((step) => step.state)).toEqual([
      'current',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(dashboard.monthlySnapshots).toContainEqual(
      expect.objectContaining({
        year: 2026,
        month: 8,
        totalRooms: 1,
        completedRooms: 0,
        stageCompletedRooms: {
          initial_submit: 0,
          initial_review: 0,
          recheck_submit: 0,
          recheck_review: 0,
          final_submit: 0,
        },
      }),
    );
    expect(dashboard.monthlySnapshots).toContainEqual(
      expect.objectContaining({
        year: 2026,
        month: 7,
        totalRooms: 1,
        completedRooms: 1,
      }),
    );
  });

  it('uses the next month first five China workdays as the only stage deadlines', () => {
    expect(
      buildSystemMonthlyReportWorkdayMilestones(2026, 7).map((item) => ({
        key: item.key,
        date: item.date,
      })),
    ).toEqual([
      { key: 'initial_submit', date: '2026-08-03' },
      { key: 'initial_review', date: '2026-08-04' },
      { key: 'recheck_submit', date: '2026-08-05' },
      { key: 'recheck_review', date: '2026-08-06' },
      { key: 'final_submit', date: '2026-08-07' },
    ]);
  });

  it('keeps the room leader and submitters as distinct roles', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-03T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [
        {
          record_id: 'rec-current-role',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            月报提醒日期: '2026-08-01',
            十夫长: { users: [{ id: 'ou_leader', name: '梅冰冰' }] },
            可提报人员: { users: [{ id: 'ou_submitter', name: '陈继猛' }] },
          },
        },
      ],
      scheduleRecords: [],
      collectionRecords: [],
      standardRecords: [],
    });

    expect(dashboard.rooms[0]).toMatchObject({
      leader: { openId: 'ou_leader', name: '梅冰冰' },
      submitters: [{ openId: 'ou_submitter', name: '陈继猛' }],
      currentOwnerRole: '可提报人员',
      currentOwnerName: '陈继猛',
    });
  });

  it('keeps every room leader from a multi-person field', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-03T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [
        {
          record_id: 'rec-current-multi-leader',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            月报提醒日期: '2026-08-01',
            十夫长: {
              users: [
                { id: 'ou_mei', name: '梅冰冰' },
                { id: 'ou_ma', name: '马进宇' },
              ],
            },
          },
        },
      ],
      scheduleRecords: [],
      collectionRecords: [],
      standardRecords: [],
    });

    expect(dashboard.rooms[0]).toMatchObject({
      leader: { openId: 'ou_mei', name: '梅冰冰' },
      leaders: [
        { openId: 'ou_mei', name: '梅冰冰' },
        { openId: 'ou_ma', name: '马进宇' },
      ],
    });
  });

  it('uses the monthly personnel matrix and the organization directory instead of the schedule source room', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-03T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [
        {
          record_id: 'rec-current-b',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            月报提醒日期: '2026-08-01',
            可提报人员: {
              users: [{ id: 'ou_stale_submitter', name: '旧提报人' }],
            },
            十夫长: { users: [{ id: 'ou_stale_leader', name: '旧十夫长' }] },
          },
        },
      ],
      personnelRecords: [
        {
          record_id: 'rec-personnel-b',
          fields: {
            机房: '南通-B',
            负责人: { users: [{ id: 'ou_chen', name: '陈继猛' }] },
            十夫长: {
              users: [
                { id: 'ou_mei', name: '梅冰冰' },
                { id: 'ou_ma', name: '马进宇' },
              ],
            },
          },
        },
      ],
      organizationPeople: [
        { openId: 'ou_ding', name: '丁晓杰', rooms: ['E楼'] },
      ],
      scheduleRecords: [
        {
          record_id: 'rec-schedule-b',
          fields: {
            审核年份: '2026',
            审核月份: '7月',
            审核轮次: '初审',
            审核机房: '南通-B',
            所属机房: '南通-H',
            审核人: { users: [{ id: 'ou_ding', name: '丁晓杰' }] },
          },
        },
      ],
      collectionRecords: [],
      standardRecords: [],
    });

    expect(dashboard.rooms[0]).toMatchObject({
      submitters: [{ openId: 'ou_chen', name: '陈继猛' }],
      leaders: [
        { openId: 'ou_mei', name: '梅冰冰' },
        { openId: 'ou_ma', name: '马进宇' },
      ],
      leader: { openId: 'ou_mei', name: '梅冰冰' },
    });
    expect(dashboard.schedule).toEqual([
      expect.objectContaining({
        reviewer: { openId: 'ou_ding', name: '丁晓杰' },
        reviewerRoom: '南通-E',
      }),
    ]);
  });

  it('keeps a current report period closed when the collection table has its final report', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-10T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [
        {
          record_id: 'rec-current-reset-b',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            月报提醒日期: '2026-08-01',
          },
        },
      ],
      scheduleRecords: [],
      collectionRecords: [
        {
          record_id: 'rec-final-b',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-07T16:20:00+08:00',
            终版月报: [
              { file_token: 'box-final', name: '南通-B-7月终版.xlsx' },
            ],
          },
        },
      ],
      standardRecords: [],
    });

    expect(dashboard.rooms[0]).toMatchObject({ status: 'completed' });
    expect(dashboard.rooms[0].steps.map((step) => step.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(dashboard.monthlySnapshots).toContainEqual(
      expect.objectContaining({
        year: 2026,
        month: 7,
        totalRooms: 1,
        completedRooms: 1,
        stageCompletedRooms: {
          initial_submit: 1,
          initial_review: 1,
          recheck_submit: 1,
          recheck_review: 1,
          final_submit: 1,
        },
      }),
    );
  });

  it('selects only the last final attachment record for each room and month', () => {
    const result = mapLatestFinalReportRecords([
      {
        record_id: 'rec-b-early',
        fields: {
          机房: '南通-B',
          月报月份: 7,
          创建时间: '2026-08-06T09:00:00+08:00',
          终版月报: [
            {
              file_token: 'box-early',
              name: '南通-B-7月终版-v1.xlsx',
              size: 120,
            },
          ],
        },
      },
      {
        record_id: 'rec-b-latest',
        fields: {
          机房: '南通-B',
          月报月份: 7,
          创建时间: '2026-08-07T16:20:00+08:00',
          终版月报: [
            {
              file_token: 'box-latest',
              name: '南通-B-7月终版.xlsx',
              size: 180,
            },
          ],
        },
      },
      {
        record_id: 'rec-c',
        fields: {
          机房: '南通-C',
          月报月份: 7,
          创建时间: '2026-08-07T15:00:00+08:00',
          终版月报: [
            { file_token: 'box-c', name: '南通-C-7月终版.xlsx', size: 160 },
          ],
        },
      },
      {
        record_id: 'rec-b-recheck-only',
        fields: {
          机房: '南通-B',
          月报月份: 7,
          创建时间: '2026-08-08T09:00:00+08:00',
          复审月报: [{ file_token: 'box-recheck' }],
        },
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((item) => item.room === '南通-B')).toMatchObject({
      recordId: 'rec-b-latest',
      submittedAt: '2026-08-07T08:20:00.000Z',
      attachments: [
        {
          fileToken: 'box-latest',
          name: '南通-B-7月终版.xlsx',
          size: 180,
        },
      ],
    });
  });

  it('keeps explicit completion times for every room and stage in monthly snapshots', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-21T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [],
      scheduleRecords: [],
      standardRecords: [],
      collectionRecords: [
        {
          record_id: 'rec-stage-initial',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-03T09:10:00+08:00',
            初版月报: [{ file_token: 'box-initial' }],
          },
        },
        {
          record_id: 'rec-stage-initial-review',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-04T10:20:00+08:00',
            初审确认提交: '是',
          },
        },
        {
          record_id: 'rec-stage-recheck',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-05T11:30:00+08:00',
            复审月报: [{ file_token: 'box-recheck' }],
          },
        },
        {
          record_id: 'rec-stage-recheck-review',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-06T12:40:00+08:00',
            复审确认提交: '是',
          },
        },
        {
          record_id: 'rec-stage-final',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-07T13:50:00+08:00',
            终版月报: [{ file_token: 'box-final' }],
          },
        },
      ],
    });

    const room = dashboard.monthlySnapshots[0].rooms[0];
    expect(room.room).toBe('南通-B');
    expect(room.stages).toEqual({
      initial_submit: {
        completed: true,
        completedAt: '2026-08-03T01:10:00.000Z',
      },
      initial_review: {
        completed: true,
        completedAt: '2026-08-04T02:20:00.000Z',
      },
      recheck_submit: {
        completed: true,
        completedAt: '2026-08-05T03:30:00.000Z',
      },
      recheck_review: {
        completed: true,
        completedAt: '2026-08-06T04:40:00.000Z',
      },
      final_submit: {
        completed: true,
        completedAt: '2026-08-07T05:50:00.000Z',
      },
    });
  });

  it('uses the latest confirmed review opinion per room and round with reviewer text and images', () => {
    const dashboard = mapSystemMonthlyReportSources({
      now: new Date('2026-08-21T04:00:00.000Z'),
      currentFields: [],
      scheduleFields: [],
      currentRecords: [],
      scheduleRecords: [],
      standardRecords: [],
      collectionRecords: [
        {
          record_id: 'rec-review-old',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-04T08:00:00+08:00',
            初审确认提交: '是',
            初审意见: '旧意见',
          },
        },
        {
          record_id: 'rec-review-latest',
          fields: {
            机房: '南通-B',
            月报月份: 7,
            创建时间: '2026-08-04T10:20:00+08:00',
            初审确认提交: '是',
            提交人: { users: [{ id: 'ou_reviewer', name: '杨占山' }] },
            初审意见: '事件管理：告警闭环截图缺少时间戳',
            '初审：事件模块': '告警闭环截图缺少时间戳',
            初审问题截图: [
              { file_token: 'box-review-1', name: '问题截图.png', size: 128 },
            ],
          },
        },
      ],
    });

    expect(dashboard.reviewOpinions).toEqual([
      expect.objectContaining({
        recordId: 'rec-review-latest',
        year: 2026,
        month: 7,
        room: '南通-B',
        round: 'initial',
        reviewer: { openId: 'ou_reviewer', name: '杨占山' },
        submittedAt: '2026-08-04T02:20:00.000Z',
        summary: '事件管理：告警闭环截图缺少时间戳',
        conclusion: 'has_issues',
        issues: [
          expect.objectContaining({
            key: 'event',
            description: '告警闭环截图缺少时间戳',
          }),
        ],
        images: [
          expect.objectContaining({
            name: '问题截图.png',
            size: 128,
            status: 'pending',
          }),
        ],
      }),
    ]);
  });
});
