jest.mock('@server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('@server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  getTenantAccessToken: jest.fn(),
}));

import {
  fetchBitableRecords,
  getTenantAccessToken,
} from '../../server/common/feishu/bitable-direct-read';
import { AttendanceAutomationFeishuGateway } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';

describe('AttendanceAutomationFeishuGateway personal recipients', () => {
  it.each([undefined, []])('reads real legacy expectationKey evidence with checks=%p', async (attendanceChecks) => {
    const key='2026-10-03:building_a:night:OffDuty:测试甲';
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {record_id:'legacy-result',fields:{记录类型:'考勤结果',姓名:'测试甲',工作日期:Date.parse('2026-10-03T00:00:00+08:00'),应打卡时间:Date.parse('2026-10-04T09:00:00+08:00'),原始记录JSON:JSON.stringify({expectationKey:key,attendanceChecks,processInstanceId:'legacy-process',sourceType:'APPROVE'})}},
      {record_id:'approved',fields:{记录类型:'补卡审批',姓名:'测试甲',补卡审批实例ID:'legacy-process',补卡状态:'已通过',补卡举证材料:[{file_token:'legacy-photo'}]}},
    ] as never);
    const gateway=new AttendanceAutomationFeishuGateway({} as never);
    await expect(gateway.readCorrectionEvidence({businessDate:'2026-10-03',entryKey:key})).resolves.toMatchObject({imageCount:1,name:'测试甲',direction:'OffDuty'});
  });

  it('links an unnamed night correction by employee ID and exact punch time, not a guessed date', async () => {
    const key='2026-10-04:building_a:night:OffDuty:测试甲';
    const at=Date.parse('2026-10-04T09:00:00+08:00');
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {record_id:'result',fields:{记录类型:'考勤结果',钉钉员工ID:'employee-a',工作日期:Date.parse('2026-10-04T00:00:00+08:00'),原始记录JSON:JSON.stringify({attendanceChecks:[{expectation:{key,name:'测试甲',building:'A楼',shiftLabel:'夜班',direction:'OffDuty',expectedAt:'2026-10-04 09:00:00',status:'on_duty'},sourceType:'APPROVE'}]})}},
      {record_id:'approved',fields:{记录类型:'补卡审批',钉钉员工ID:'employee-a',工作日期:Date.parse('2026-10-03T00:00:00+08:00'),应打卡时间:at,打卡类型:'下班',补卡状态:'已通过',补卡审批实例ID:'process-a',补卡举证材料:[{file_token:'photo-a'}]}},
      {record_id:'other-person',fields:{记录类型:'补卡审批',姓名:'测试甲',钉钉员工ID:'employee-b',工作日期:Date.parse('2026-10-04T00:00:00+08:00'),应打卡时间:at,打卡类型:'下班',补卡状态:'已通过',补卡审批实例ID:'process-b',补卡举证材料:[{file_token:'photo-b'}]}},
    ] as never);
    const gateway=new AttendanceAutomationFeishuGateway({} as never, {
      getStored: async ({processInstanceId}: {processInstanceId:string}) => ({url:`https://cos.example/${processInstanceId}.jpg`,contentType:'image/jpeg',expiresAt:'2026-10-11T10:00:00Z'}),
    } as never);
    await expect(gateway.readCorrectionEvidence({businessDate:'2026-10-04',entryKey:key})).resolves.toMatchObject({imageCount:1,name:'测试甲',direction:'OffDuty',images:[{url:'https://cos.example/process-a.jpg'}]});
  });

  it('privately sends a sync failure to the confirmed manager without exposing it to a group', async () => {
    const previousAppId = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = 'cli_0831564613853b26';
    jest.mocked(getTenantAccessToken).mockResolvedValue('test-token');
    const post = jest.fn().mockResolvedValue({
      data: { code: 0, data: { message_id: 'om_sync_alert' } },
    });
    try {
      const gateway = new AttendanceAutomationFeishuGateway({
        axiosRef: { post },
      } as never);
      await (gateway as any).sendSyncFailureAlert({
        date: '2026-09-24',
        task: 'morning-off-duty-check',
        stage: 'archive',
        detail: '飞书回读超时',
      });
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining('receive_id_type=open_id'),
        expect.objectContaining({
          receive_id: 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID',
          msg_type: 'text',
          content: expect.stringContaining('飞书回读超时'),
        }),
        expect.any(Object),
      );
    } finally {
      if (previousAppId === undefined) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = previousAppId;
    }
  });

  it('keeps overtime missing separately from a normal regular punch in the single archived row', async () => {
    const base = {
      name: '测试甲',
      building: 'H楼',
      shiftLabel: '白班',
      direction: 'OffDuty',
      expectedAt: '2026-09-03 18:00:00',
      status: 'on_duty',
    };
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-one',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-03T00:00:00+08:00'),
          钉钉员工ID: 'u1',
          时间状态: '正常',
          原始记录JSON: JSON.stringify({
            attendanceChecks: [
              {
                expectation: { ...base, key: 'regular' },
                timeResult: 'Normal',
                userCheckTime: '2026-09-03 18:01:00',
              },
              {
                expectation: {
                  ...base,
                  key: 'overtime',
                  status: 'overtime',
                  shiftLabel: '夜班加班',
                  expectedAt: '2026-09-03 22:00:00',
                },
                timeResult: 'NotSigned',
                userCheckTime: null,
              },
            ],
          }),
        },
      },
    ]);
    const summary = await new AttendanceAutomationFeishuGateway(
      {} as never,
    ).readArchivedAttendanceSummary('2026-09-03');
    expect(summary.normal).toHaveLength(1);
    expect(summary.anomalies).toEqual([
      expect.objectContaining({ key: 'overtime', reason: '未打卡' }),
    ]);
  });
  afterEach(() => {
    jest.mocked(fetchBitableRecords).mockReset();
    jest.mocked(getTenantAccessToken).mockReset();
  });

  it('recognizes archive-yesterday on the latest result as a completed archive', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-archive',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-05T00:00:00+08:00'),
          同步时间: Date.parse('2026-09-06T00:31:00+08:00'),
          原始记录JSON: JSON.stringify({
            automationTask: 'archive-yesterday',
            attendanceChecks: [
              {
                expectation: {
                  key: '2026-09-05:building_h:white:OffDuty:测试甲',
                  name: '测试甲',
                  building: 'H楼',
                  shiftLabel: '白班',
                  direction: 'OffDuty',
                  expectedAt: '2026-09-05 18:00:00',
                  status: 'on_duty',
                },
                timeResult: 'Normal',
                userCheckTime: '2026-09-05 18:01:00',
              },
            ],
          }),
        },
      },
    ] as never);

    const summary = await new AttendanceAutomationFeishuGateway(
      {} as never,
    ).readArchivedAttendanceSummary('2026-09-05');

    expect(summary.hasArchivedResult).toBe(true);
    expect(summary.checkedTasks).toEqual([]);
    expect(summary.normal).toHaveLength(1);
  });

  it('resolves one stable Open ID per abnormal employee by name and building', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-cao-c',
        fields: {
          姓名: '示例人员011',
          员工姓名: [{ name: '示例人员011', open_id: 'ou_cao_c' }],
          '机楼/专业': 'C楼',
          岗位: '值班人员',
        },
      },
      {
        record_id: 'rec-cao-a',
        fields: {
          姓名: '示例人员011',
          员工姓名: [{ name: '示例人员011', open_id: 'ou_cao_a' }],
          '机楼/专业': 'A楼',
          岗位: '值班人员',
        },
      },
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    const recipients = await gateway.resolvePersonalRecipients([
      { name: '示例人员011', building: 'C楼' },
      { name: '示例人员011', building: 'C楼' },
    ]);

    expect(recipients).toEqual([{ openId: 'ou_cao_c', name: '示例人员011' }]);
  });

  it('skips an abnormal employee without a Feishu account while keeping valid recipients', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-cao-c',
        fields: {
          姓名: '示例人员011',
          员工姓名: [{ name: '示例人员011', open_id: 'ou_cao_c' }],
          '机楼/专业': 'C楼',
          岗位: '值班人员',
        },
      },
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    await expect(
      gateway.resolvePersonalRecipientsBestEffort([
        { name: '示例人员011', building: 'C楼' },
        { name: '陈奇', building: 'C楼' },
      ]),
    ).resolves.toEqual({
      recipients: [{ openId: 'ou_cao_c', name: '示例人员011' }],
      failures: [],
    });
  });

  it('fails closed instead of sending personal attendance to an ambiguous user', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-one',
        fields: {
          姓名: '同名人员',
          员工姓名: [{ name: '同名人员', open_id: 'ou_one' }],
        },
      },
      {
        record_id: 'rec-two',
        fields: {
          姓名: '同名人员',
          员工姓名: [{ name: '同名人员', open_id: 'ou_two' }],
        },
      },
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    await expect(
      gateway.resolvePersonalRecipients([
        { name: '同名人员', building: 'C楼' },
      ]),
    ).rejects.toThrow('匹配不唯一');
  });

  it('reads only yesterday result rows from the attendance Bitable and reconstructs building scopes', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-missing',
        fields: {
          记录类型: '考勤结果',
          姓名: '示例人员011',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          打卡类型: '上班',
          应打卡时间: Date.parse('2026-09-03T01:00:00.000Z'),
          时间状态: '未打卡',
          是否合法: '否',
          原始记录JSON: [
            {
              text: JSON.stringify({
                derived: true,
                expectationKey: '2026-09-03:building_c:white:OnDuty:示例人员011',
              }),
              type: 'text',
            },
          ],
          同步时间: Date.parse('2026-09-03T16:31:00.000Z'),
        },
      },
      {
        record_id: 'rec-late',
        fields: {
          记录类型: '考勤结果',
          姓名: '陈建峰',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          打卡类型: '上班',
          应打卡时间: Date.parse('2026-09-03T00:00:00.000Z'),
          实际打卡时间: Date.parse('2026-09-03T00:08:00.000Z'),
          时间状态: '迟到',
          是否合法: '是',
          原始记录JSON: JSON.stringify({
            expectationKey: '2026-09-03:station_110:white:OnDuty:陈建峰',
          }),
          同步时间: Date.parse('2026-09-03T16:31:00.000Z'),
        },
      },
      {
        record_id: 'rec-normal',
        fields: {
          记录类型: '考勤结果',
          姓名: '示例人员008',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          打卡类型: '下班',
          应打卡时间: Date.parse('2026-09-03T10:00:00.000Z'),
          实际打卡时间: Date.parse('2026-09-03T10:01:00.000Z'),
          时间状态: '正常',
          是否合法: '是',
          原始记录JSON: JSON.stringify({
            expectationKey: '2026-09-03:building_c:white:OffDuty:示例人员008',
          }),
          同步时间: Date.parse('2026-09-03T16:31:00.000Z'),
        },
      },
      {
        record_id: 'rec-correction-without-evidence',
        fields: {
          记录类型: '考勤结果',
          姓名: '支佳伟',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          打卡类型: '下班',
          应打卡时间: Date.parse('2026-09-03T01:00:00.000Z'),
          实际打卡时间: Date.parse('2026-09-03T01:03:00.000Z'),
          时间状态: '正常',
          是否合法: '否',
          补卡异常说明: '补卡未提供举证照片',
          原始记录JSON: JSON.stringify({
            expectationKey: '2026-09-03:building_h:night:OffDuty:支佳伟',
          }),
          同步时间: Date.parse('2026-09-03T16:31:00.000Z'),
        },
      },
      {
        record_id: 'rec-detail-must-not-count',
        fields: {
          记录类型: '打卡明细',
          姓名: '不应出现',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          时间状态: '未打卡',
        },
      },
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    const summary = await gateway.readArchivedAttendanceSummary('2026-09-03');

    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tbl01cda9acd2f8f',
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(
      jest.mocked(fetchBitableRecords).mock.calls[0]?.[1],
    ).not.toHaveProperty('filter');
    expect(summary.businessDate).toBe('2026-09-03');
    expect(summary.fetchedAt).toBe('2026-09-04 00:31');
    expect(summary.normalByBuilding).toEqual({ C楼: 1, H楼: 1 });
    expect(summary.anomalies).toEqual([
      expect.objectContaining({
        name: '示例人员011',
        building: 'C楼',
        shiftLabel: '白班',
        direction: 'OnDuty',
        reason: '未打卡',
      }),
      expect.objectContaining({
        name: '陈建峰',
        building: '110站',
        shiftLabel: '白班',
        direction: 'OnDuty',
        reason: '迟到',
      }),
    ]);
  });

  it('uses the newer normal result for one expectation instead of reporting an older anomaly', async () => {
    const expectationKey = '2026-09-03:building_c:white:OnDuty:示例人员011';
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-newer-normal',
        fields: {
          记录类型: '考勤结果',
          姓名: '示例人员011',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          打卡类型: '上班',
          应打卡时间: Date.parse('2026-09-03T01:00:00.000Z'),
          实际打卡时间: Date.parse('2026-09-03T01:01:00.000Z'),
          时间状态: '正常',
          是否合法: '是',
          原始记录JSON: JSON.stringify({ expectationKey }),
          同步时间: Date.parse('2026-09-03T16:35:00.000Z'),
        },
      },
      {
        record_id: 'rec-older-anomaly',
        fields: {
          记录类型: '考勤结果',
          姓名: '示例人员011',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          打卡类型: '上班',
          应打卡时间: Date.parse('2026-09-03T01:00:00.000Z'),
          时间状态: '未打卡',
          是否合法: '否',
          原始记录JSON: JSON.stringify({ expectationKey }),
          同步时间: Date.parse('2026-09-03T16:31:00.000Z'),
        },
      },
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    const summary = await gateway.readArchivedAttendanceSummary('2026-09-03');

    expect(summary.fetchedAt).toBe('2026-09-04 00:35');
    expect(summary.anomalies).toEqual([]);
    expect(summary.normal).toEqual([
      expect.objectContaining({
        key: expectationKey,
        name: '示例人员011',
        building: 'C楼',
        direction: 'OnDuty',
      }),
    ]);
    expect(summary.normalByBuilding).toEqual({ C楼: 1 });
  });

  it('reads all requested weekly coverage in one Feishu query', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-one',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
          姓名: '示例人员011',
          应打卡时间: Date.parse('2026-09-03T01:00:00.000Z'),
          原始记录JSON: JSON.stringify({
            expectationKey: '2026-09-03:building_c:white:OnDuty:示例人员011',
          }),
        },
      },
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    await expect(
      gateway.readArchivedAttendanceCoverage([
        '2026-09-02',
        '2026-09-03',
        '2026-09-03',
      ]),
    ).resolves.toEqual({
      '2026-09-02': [],
      '2026-09-03': ['2026-09-03:building_c:white:OnDuty:示例人员011'],
    });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
  });

  it('updates a legacy archive row by expectation key instead of creating a duplicate', async () => {
    const expectationKey = '2026-09-03:building_c:white:OnDuty:示例人员011';
    let verifiedFields: Record<string, unknown> | null = null;
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([
        {
          record_id: 'rec-legacy-result',
          fields: {
            记录唯一键: 'ding-r-legacy-record-key',
            记录类型: '考勤结果',
            钉钉员工ID: 'u1',
            姓名: '示例人员011',
            工作日期: Date.parse('2026-09-02T16:00:00.000Z'),
            打卡类型: '上班',
            应打卡时间: Date.parse('2026-09-03T01:00:00.000Z'),
            时间状态: '未打卡',
            是否合法: '否',
            原始记录JSON: JSON.stringify({
              derived: true,
              expectationKey,
            }),
            同步时间: Date.parse('2026-09-03T16:31:00.000Z'),
          },
        },
      ] as never)
      .mockImplementationOnce(async () =>
        verifiedFields
          ? ([
              {
                record_id: 'rec-legacy-result',
                fields: verifiedFields,
              },
            ] as never)
          : ([] as never),
      );
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    const post = jest.fn(async (url: string, body: any) => {
      if (url.includes('/batch_update')) {
        verifiedFields = body.records[0].fields;
      }
      return { data: { code: 0 } };
    });
    const gateway = new AttendanceAutomationFeishuGateway({
      axiosRef: { post },
    } as never);

    await expect(
      gateway.archiveAttendance({
        businessDate: '2026-09-03',
        users: [{ userId: 'u1', name: '示例人员011' }],
        results: [
          {
            id: 'new-dingtalk-result-id',
            userId: 'u1',
            checkType: 'OnDuty',
            baseCheckTime: Date.parse('2026-09-03T01:00:00.000Z'),
            userCheckTime: Date.parse('2026-09-03T01:01:00.000Z'),
            workDate: Date.parse('2026-09-02T16:00:00.000Z'),
            timeResult: 'Normal',
            locationResult: 'Normal',
            approveId: null,
            procInstId: null,
            sourceType: 'ATM',
            original: { derived: true, expectationKey },
          },
        ],
        details: [],
        corrections: [],
      }),
    ).resolves.toEqual({ total: 1, created: 0, updated: 1 });

    expect(post.mock.calls.some(([url]) => url.includes('/batch_create'))).toBe(
      false,
    );
    const updateCall = post.mock.calls.find(([url]) =>
      url.includes('/batch_update'),
    );
    expect(updateCall?.[1]).toEqual({
      records: [
        expect.objectContaining({
          record_id: 'rec-legacy-result',
          fields: expect.objectContaining({
            记录唯一键: expect.stringMatching(/^attendance-v4-/u),
            时间状态: '正常',
          }),
        }),
      ],
    });
  });

  it('archives one shift row with earliest on-duty, latest off-duty and every raw punch', async () => {
    let verifiedFields: Record<string, unknown> | null = null;
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () =>
        verifiedFields
          ? ([{ record_id: 'rec-shift', fields: verifiedFields }] as never)
          : ([] as never),
      );
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    const post = jest.fn(async (url: string, body: any) => {
      if (url.includes('/batch_create')) {
        verifiedFields = body.records[0].fields;
      }
      return { data: { code: 0 } };
    });
    const gateway = new AttendanceAutomationFeishuGateway({
      axiosRef: { post },
    } as never);
    const expectation = (
      direction: 'OnDuty' | 'OffDuty',
      expectedAt: string,
    ) => ({
      key: `2026-09-07:building_h:white:${direction}:测试`,
      name: '测试',
      building: 'H楼',
      shiftLabel: '白班',
      direction,
      expectedAt,
      status: 'on_duty',
    });

    await expect(
      gateway.archiveAttendance({
        businessDate: '2026-09-07',
        users: [{ userId: 'u1', name: '测试' }],
        results: [
          {
            id: 'derived-on',
            userId: 'u1',
            checkType: 'OnDuty',
            baseCheckTime: '2026-09-07 09:00:00',
            userCheckTime: '2026-09-07 08:51:00',
            workDate: '2026-09-07 00:00:00',
            timeResult: 'Normal',
            locationResult: 'Normal',
            approveId: null,
            procInstId: null,
            sourceType: 'SCHEDULE_COMPARISON',
            original: {
              derived: true,
              expectationKey: '2026-09-07:building_h:white:OnDuty:测试',
              attendanceChecks: [
                {
                  expectation: expectation('OnDuty', '2026-09-07 09:00:00'),
                  timeResult: 'Normal',
                  userCheckTime: '2026-09-07 08:51:00',
                },
              ],
            },
          },
          {
            id: 'derived-off',
            userId: 'u1',
            checkType: 'OffDuty',
            baseCheckTime: '2026-09-07 18:00:00',
            userCheckTime: '2026-09-07 18:14:00',
            workDate: '2026-09-07 00:00:00',
            timeResult: 'Normal',
            locationResult: 'Normal',
            approveId: null,
            procInstId: null,
            sourceType: 'SCHEDULE_COMPARISON',
            original: {
              derived: true,
              expectationKey: '2026-09-07:building_h:white:OffDuty:测试',
              attendanceChecks: [
                {
                  expectation: expectation('OffDuty', '2026-09-07 18:00:00'),
                  timeResult: 'Normal',
                  userCheckTime: '2026-09-07 18:14:00',
                },
              ],
            },
          },
        ],
        details: [
          ...['detail-on-a', 'detail-on-b'].map((id) => ({
            id,
            userId: 'u1',
            checkType: 'OnDuty',
            baseCheckTime: '2026-09-07 09:00:00',
            userCheckTime: '2026-09-07 08:49:00',
            workDate: '2026-09-07 00:00:00',
            timeResult: 'Normal',
            locationResult: 'Normal',
            userAddress: null,
            userLongitude: null,
            userLatitude: null,
            outsideRemark: null,
            invalidRecordMsg: null,
            deviceId: null,
            sourceType: 'ATM',
            original: {},
          })),
          {
            id: 'detail-off-a',
            userId: 'u1',
            checkType: 'OffDuty',
            baseCheckTime: '2026-09-07 18:00:00',
            userCheckTime: '2026-09-07 18:09:00',
            workDate: '2026-09-07 00:00:00',
            timeResult: 'Normal',
            locationResult: 'Normal',
            userAddress: null,
            userLongitude: null,
            userLatitude: null,
            outsideRemark: null,
            invalidRecordMsg: null,
            deviceId: null,
            sourceType: 'ATM',
            original: {},
          },
          {
            id: 'detail-off-b',
            userId: 'u1',
            checkType: 'OffDuty',
            baseCheckTime: '2026-09-07 18:00:00',
            userCheckTime: '2026-09-07 18:14:00',
            workDate: '2026-09-07 00:00:00',
            timeResult: 'Normal',
            locationResult: 'Normal',
            userAddress: null,
            userLongitude: null,
            userLatitude: null,
            outsideRemark: null,
            invalidRecordMsg: null,
            deviceId: null,
            sourceType: 'ATM',
            original: {},
          },
        ],
        corrections: [],
      }),
    ).resolves.toEqual({ total: 1, created: 1, updated: 0 });

    const createCall = post.mock.calls.find(([url]) =>
      url.includes('/batch_create'),
    );
    expect(createCall?.[1].records).toHaveLength(1);
    expect(createCall?.[1].records[0].fields).toMatchObject({
      班次: '白班',
      上班打卡时间: Date.parse('2026-09-07T08:49:00+08:00'),
      下班打卡时间: Date.parse('2026-09-07T18:14:00+08:00'),
      打卡次数: 4,
      全部打卡时间: '08:49:00、08:49:00、18:09:00、18:14:00',
    });
  });

  it('merges an unclassified repeated punch into the nearest shift instead of creating a pending row', async () => {
    let verifiedRecords: Array<{
      record_id: string;
      fields: Record<string, unknown>;
    }> = [];
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => verifiedRecords as never);
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    const post = jest.fn(async (url: string, body: any) => {
      if (url.includes('/batch_create')) {
        verifiedRecords = body.records.map(
          (record: { fields: Record<string, unknown> }, index: number) => ({
            record_id: `rec-${index + 1}`,
            fields: record.fields,
          }),
        );
      }
      return { data: { code: 0 } };
    });
    const gateway = new AttendanceAutomationFeishuGateway({
      axiosRef: { post },
    } as never);
    const result = (
      shift: 'white' | 'night',
      expectedAt: string,
      actualAt: string,
    ) => ({
      id: `derived-${shift}`,
      userId: 'u1',
      checkType: 'OnDuty',
      baseCheckTime: expectedAt,
      userCheckTime: actualAt,
      workDate: '2026-09-16 00:00:00',
      timeResult: 'Normal',
      locationResult: 'Normal',
      approveId: null,
      procInstId: null,
      sourceType: 'SCHEDULE_COMPARISON',
      original: {
        derived: true,
        expectationKey: `2026-09-16:building_a:${shift}:OnDuty:李董`,
        attendanceChecks: [
          {
            expectation: {
              key: `2026-09-16:building_a:${shift}:OnDuty:李董`,
              name: '李董',
              building: 'A楼',
              shiftLabel: shift === 'white' ? '白班' : '夜班',
              direction: 'OnDuty',
              expectedAt,
              status: 'on_duty',
            },
            timeResult: 'Normal',
            userCheckTime: actualAt,
          },
        ],
      },
    });

    await expect(
      gateway.archiveAttendance({
        businessDate: '2026-09-16',
        users: [{ userId: 'u1', name: '李董' }],
        results: [
          result('white', '2026-09-16 09:00:00', '2026-09-16 08:50:00'),
          result('night', '2026-09-16 18:00:00', '2026-09-16 17:20:00'),
        ],
        details: [
          {
            id: 'repeat-on-duty',
            userId: 'u1',
            checkType: null,
            baseCheckTime: null,
            userCheckTime: '2026-09-16 17:21:30',
            workDate: '2026-09-16 00:00:00',
            timeResult: null,
            locationResult: null,
            userAddress: null,
            userLongitude: null,
            userLatitude: null,
            outsideRemark: null,
            invalidRecordMsg: '已经打过卡了，上班时间以最早打卡时间为准',
            deviceId: null,
            sourceType: 'USER',
            original: {},
          },
        ],
        corrections: [],
      }),
    ).resolves.toEqual({ total: 2, created: 2, updated: 0 });

    const createCall = post.mock.calls.find(([url]) =>
      url.includes('/batch_create'),
    );
    expect(createCall?.[1].records).toHaveLength(2);
    const night = createCall?.[1].records.find(
      (record: { fields: Record<string, unknown> }) =>
        record.fields.班次 === '夜班',
    );
    expect(night?.fields).toMatchObject({
      上班打卡时间: Date.parse('2026-09-16T17:20:00+08:00'),
      打卡次数: 2,
      全部打卡时间: '17:20:00、17:21:30',
      时间状态: '正常',
    });
  });

  it('archives DingTalk correction photos as verified Feishu attachments', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          record_id: 'rec-correction',
          fields: {
            记录唯一键: 'ding-correction-process-1',
            补卡举证材料: [{ file_token: 'file-evidence' }],
          },
        },
      ] as never);
    const get = jest.fn().mockResolvedValue({
      data: Buffer.from('jpeg-content'),
      headers: { 'content-type': 'image/jpeg' },
    });
    const post = jest.fn(async (url: string) => {
      if (url.includes('/drive/v1/medias/upload_all')) {
        return { data: { code: 0, data: { file_token: 'file-evidence' } } };
      }
      return { data: { code: 0 } };
    });
    const gateway = new AttendanceAutomationFeishuGateway(
      {
        axiosRef: { get, post },
      } as never,
      {
        ensureStored: jest.fn(async (_reference, load) => {
          const source = await load();
          return {
            url: 'https://cos.example/correction-evidence.jpg?signed=1',
            contentType: source.contentType,
            expiresAt: '2026-09-20T02:05:00.000Z',
          };
        }),
      } as never,
    );

    await expect(
      gateway.archiveAttendance({
        businessDate: '2026-08-31',
        users: [{ userId: 'u1', name: '示例人员020' }],
        results: [],
        details: [],
        corrections: [
          {
            processInstanceId: 'process-1',
            userId: 'u1',
            status: 'COMPLETED',
            result: 'agree',
            correctionTime: Date.parse('2026-08-28T10:00:00.000Z'),
            workDate: Date.parse('2026-08-28T00:00:00.000Z'),
            planText: '周五下班缺卡',
            reason: '忘记打卡',
            photoUrls: ['https://static.dingtalk.com/media/evidence.jpg'],
            original: {},
          },
        ],
      }),
    ).resolves.toMatchObject({ total: 1, created: 1 });

    expect(get).toHaveBeenCalledWith(
      'https://static.dingtalk.com/media/evidence.jpg',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
    const createCall = post.mock.calls.find(([url]) =>
      url.includes('/batch_create'),
    );
    expect(createCall?.[1]).toEqual(
      expect.objectContaining({
        records: [
          expect.objectContaining({
            fields: expect.objectContaining({
              补卡审批实例ID: 'process-1',
              补卡举证材料: [{ file_token: 'file-evidence' }],
            }),
          }),
        ],
      }),
    );
  });

  it('returns signed COS evidence URLs without downloading Feishu media when COS is ready', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-result',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-18T00:00:00+08:00'),
          同步时间: Date.parse('2026-09-19T00:30:00+08:00'),
          原始记录JSON: JSON.stringify({
            attendanceChecks: [
              {
                expectation: {
                  key: '2026-09-18:building_h:white:OffDuty:韩珂岩',
                  name: '韩珂岩',
                  building: 'H楼',
                  shiftLabel: '白班',
                  direction: 'OffDuty',
                  expectedAt: '2026-09-18 18:00:00',
                  status: 'on_duty',
                },
                processInstanceId: 'process-han-off',
              },
            ],
          }),
        },
      },
      {
        record_id: 'rec-correction',
        fields: {
          记录类型: '补卡审批',
          补卡审批实例ID: 'process-han-off',
          姓名: '韩珂岩',
          工作日期: Date.parse('2026-09-18T00:00:00+08:00'),
          打卡类型: '下班',
          补卡状态: '已通过',
          补卡理由: '忘记打卡',
          补卡举证材料: [
            { file_token: 'file-evidence-1' },
            { file_token: 'file-evidence-2' },
          ],
        },
      },
    ] as never);
    const get = jest.fn().mockResolvedValue({
      data: Buffer.from('jpeg-content'),
      headers: { 'content-type': 'image/jpeg' },
    });
    const getStored = jest.fn(async () => ({
      url: 'https://cos.example/evidence.jpg?signed=1',
      contentType: 'image/jpeg',
      expiresAt: '2026-09-20T02:05:00.000Z',
    }));
    const ensureStored = jest.fn();
    const gateway = new AttendanceAutomationFeishuGateway(
      { axiosRef: { get } } as never,
      { getStored, ensureStored } as never,
    );
    const query = {
      businessDate: '2026-09-18',
      entryKey: '2026-09-18:building_h:white:OffDuty:韩珂岩',
    };

    await expect(gateway.readCorrectionEvidence(query)).resolves.toEqual({
      businessDate: '2026-09-18',
      entryKey: '2026-09-18:building_h:white:OffDuty:韩珂岩',
      name: '韩珂岩',
      direction: 'OffDuty',
      status: '已通过',
      reason: '忘记打卡',
      imageCount: 2,
      syncState: 'ready',
      images: [
        {
          url: 'https://cos.example/evidence.jpg?signed=1',
          contentType: 'image/jpeg',
          expiresAt: '2026-09-20T02:05:00.000Z',
        },
        {
          url: 'https://cos.example/evidence.jpg?signed=1',
          contentType: 'image/jpeg',
          expiresAt: '2026-09-20T02:05:00.000Z',
        },
      ],
    });
    expect(getStored).toHaveBeenCalledTimes(2);
    expect(ensureStored).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('links a legacy attendance result to its only approved correction when the process id is missing', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-result',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-04T00:00:00+08:00'),
          同步时间: Date.parse('2026-09-05T00:30:00+08:00'),
          原始记录JSON: JSON.stringify({
            attendanceChecks: [
              {
                expectation: {
                  key: '2026-09-04:building_a:night:OnDuty:徐志远',
                  name: '徐志远',
                  building: 'A楼',
                  shiftLabel: '夜班',
                  direction: 'OnDuty',
                  expectedAt: '2026-09-04 18:00:00',
                  status: 'on_duty',
                },
              },
            ],
          }),
        },
      },
      {
        record_id: 'rec-approved',
        fields: {
          记录类型: '补卡审批',
          姓名: '徐志远',
          工作日期: Date.parse('2026-09-04T00:00:00+08:00'),
          打卡类型: '上班',
          补卡状态: '已通过',
          补卡审批实例ID: 'process-approved',
          补卡理由: '忘记打卡',
          补卡举证材料: [{ file_token: 'file-approved' }],
          同步时间: Date.parse('2026-09-05T01:00:00+08:00'),
        },
      },
      {
        record_id: 'rec-rejected',
        fields: {
          记录类型: '补卡审批',
          姓名: '徐志远',
          工作日期: Date.parse('2026-09-04T00:00:00+08:00'),
          打卡类型: '上班',
          补卡状态: '已拒绝',
          补卡审批实例ID: 'process-rejected',
          补卡理由: '忘记打卡',
          补卡举证材料: [{ file_token: 'file-rejected' }],
          同步时间: Date.parse('2026-09-05T01:00:00+08:00'),
        },
      },
    ] as never);
    const storage = {
      getStored: jest.fn().mockResolvedValue({
        url: 'https://cos.example/approved.jpg?signed=1',
        contentType: 'image/jpeg',
        expiresAt: '2026-09-20T02:05:00.000Z',
      }),
      ensureStored: jest.fn(),
    };
    const gateway = new AttendanceAutomationFeishuGateway(
      { axiosRef: { get: jest.fn() } } as never,
      storage as never,
    );

    await expect(
      gateway.readCorrectionEvidence({
        businessDate: '2026-09-04',
        entryKey: '2026-09-04:building_a:night:OnDuty:徐志远',
      }),
    ).resolves.toMatchObject({
      name: '徐志远',
      direction: 'OnDuty',
      status: '已通过',
      imageCount: 1,
      syncState: 'ready',
    });
    expect(storage.getStored).toHaveBeenCalledWith({
      processInstanceId: 'process-approved',
      index: 0,
    });
  });

  it('rejects an ambiguous legacy correction association instead of showing the wrong evidence', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-result',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-04T00:00:00+08:00'),
          原始记录JSON: JSON.stringify({
            attendanceChecks: [
              {
                expectation: {
                  key: '2026-09-04:building_a:night:OnDuty:徐志远',
                  name: '徐志远',
                  building: 'A楼',
                  shiftLabel: '夜班',
                  direction: 'OnDuty',
                  expectedAt: '2026-09-04 18:00:00',
                  status: 'on_duty',
                },
              },
            ],
          }),
        },
      },
      ...['process-a', 'process-b'].map((processInstanceId) => ({
        record_id: `rec-${processInstanceId}`,
        fields: {
          记录类型: '补卡审批',
          姓名: '徐志远',
          工作日期: Date.parse('2026-09-04T00:00:00+08:00'),
          打卡类型: '上班',
          补卡状态: '已通过',
          补卡审批实例ID: processInstanceId,
          补卡举证材料: [{ file_token: `file-${processInstanceId}` }],
        },
      })),
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway(
      { axiosRef: { get: jest.fn() } } as never,
      { getStored: jest.fn(), ensureStored: jest.fn() } as never,
    );

    await expect(
      gateway.readCorrectionEvidence({
        businessDate: '2026-09-04',
        entryKey: '2026-09-04:building_a:night:OnDuty:徐志远',
      }),
    ).rejects.toThrow('补卡审批关联不唯一');
  });

  it('returns a syncing evidence manifest without waiting for historical COS migration', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-result',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-18T00:00:00+08:00'),
          同步时间: Date.parse('2026-09-19T00:30:00+08:00'),
          原始记录JSON: JSON.stringify({
            attendanceChecks: [
              {
                expectation: {
                  key: '2026-09-18:building_h:white:OffDuty:韩珂岩',
                  name: '韩珂岩',
                  building: 'H楼',
                  shiftLabel: '白班',
                  direction: 'OffDuty',
                  expectedAt: '2026-09-18 18:00:00',
                  status: 'on_duty',
                },
                processInstanceId: 'process-han-off',
              },
            ],
          }),
        },
      },
      {
        record_id: 'rec-correction',
        fields: {
          记录类型: '补卡审批',
          补卡审批实例ID: 'process-han-off',
          补卡状态: '已通过',
          补卡理由: '忘记打卡',
          补卡举证材料: [{ file_token: 'file-evidence-1' }],
        },
      },
    ] as never);
    const neverCompletes = new Promise<never>(() => undefined);
    const storage = {
      getStored: jest.fn().mockResolvedValue(null),
      ensureStored: jest.fn().mockReturnValue(neverCompletes),
    };
    const gateway = new AttendanceAutomationFeishuGateway(
      { axiosRef: { get: jest.fn() } } as never,
      storage as never,
    );
    const query = {
      businessDate: '2026-09-18',
      entryKey: '2026-09-18:building_h:white:OffDuty:韩珂岩',
    };

    const result = await Promise.race([
      gateway.readCorrectionEvidence(query),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 100),
      ),
    ]);

    expect(result).not.toBe('timeout');
    expect(result).toMatchObject({
      businessDate: query.businessDate,
      entryKey: query.entryKey,
      imageCount: 1,
      images: [{ transport: 'proxy', url: '' }],
      syncState: 'ready',
    });
    expect(storage.ensureStored).toHaveBeenCalledTimes(1);
  });

  it('downloads historical Base evidence with the attachment permission context before migrating it to COS', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-result',
        fields: {
          记录类型: '考勤结果',
          工作日期: Date.parse('2026-09-04T00:00:00+08:00'),
          原始记录JSON: JSON.stringify({
            attendanceChecks: [
              {
                expectation: {
                  key: '2026-09-04:building_a:night:OnDuty:徐志远',
                  name: '徐志远',
                  building: 'A楼',
                  shiftLabel: '夜班',
                  direction: 'OnDuty',
                  expectedAt: '2026-09-04 18:00:00',
                  status: 'on_duty',
                },
                processInstanceId: 'process-approved',
              },
            ],
          }),
        },
      },
      {
        record_id: 'rec-approved',
        fields: {
          记录类型: '补卡审批',
          补卡审批实例ID: 'process-approved',
          补卡状态: '已通过',
          补卡理由: '忘记打卡',
          补卡举证材料: [{ file_token: 'file-approved' }],
        },
      },
    ] as never);
    const get = jest.fn(async (url: string) => {
      if (url.includes('/fields')) {
        return {
          data: {
            code: 0,
            data: {
              items: [
                {
                  field_id: 'fldEvidence',
                  field_name: '补卡举证材料',
                  type: 17,
                },
              ],
              has_more: false,
            },
          },
        };
      }
      return {
        data: Buffer.from('jpeg-content'),
        headers: { 'content-type': 'image/jpeg' },
      };
    });
    const ensureStored = jest.fn(async (_reference, load) => {
      const source = await load();
      return {
        url: 'https://cos.example/approved.jpg?signed=1',
        contentType: source.contentType,
        expiresAt: '2026-09-20T02:05:00.000Z',
      };
    });
    const gateway = new AttendanceAutomationFeishuGateway(
      { axiosRef: { get } } as never,
      { getStored: jest.fn().mockResolvedValue(null), ensureStored } as never,
    );

    await expect(
      gateway.readCorrectionEvidence({
        businessDate: '2026-09-04',
        entryKey: '2026-09-04:building_a:night:OnDuty:徐志远',
      }),
    ).resolves.toMatchObject({ syncState: 'ready', images: [{ transport: 'proxy' }] });
    await ensureStored.mock.results[0].value;

    const mediaCall = get.mock.calls.find(([url]) =>
      url.includes('/drive/v1/medias/file-approved/download'),
    );
    expect(mediaCall?.[1]).toEqual(
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        params: {
          extra: JSON.stringify({
            bitablePerm: {
              tableId: 'tbl01cda9acd2f8f',
              attachments: {
                fldEvidence: { 'rec-approved': ['file-approved'] },
              },
            },
          }),
        },
        responseType: 'arraybuffer',
      }),
    );
  });

  it('replaces incomplete correction evidence and verifies every expected photo', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    let verifiedFields: Record<string, unknown> | null = null;
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([
        {
          record_id: 'rec-correction',
          fields: {
            记录唯一键: 'ding-correction-process-2',
            补卡举证材料: [{ file_token: 'old-evidence' }],
          },
        },
      ] as never)
      .mockImplementationOnce(async () =>
        verifiedFields
          ? ([{ record_id: 'rec-correction', fields: verifiedFields }] as never)
          : ([] as never),
      );
    const get = jest.fn().mockResolvedValue({
      data: Buffer.from('jpeg-content'),
      headers: { 'content-type': 'image/jpeg' },
    });
    let uploaded = 0;
    const post = jest.fn(async (url: string, body: any) => {
      if (url.includes('/drive/v1/medias/upload_all')) {
        uploaded += 1;
        return { data: { code: 0, data: { file_token: `new-${uploaded}` } } };
      }
      if (url.includes('/batch_update')) {
        verifiedFields = body.records[0].fields;
      }
      return { data: { code: 0 } };
    });
    const gateway = new AttendanceAutomationFeishuGateway(
      {
        axiosRef: { get, post },
      } as never,
      {
        ensureStored: jest.fn(async (_reference, load) => {
          const source = await load();
          return {
            url: 'https://cos.example/correction-evidence.jpg?signed=1',
            contentType: source.contentType,
            expiresAt: '2026-09-20T02:05:00.000Z',
          };
        }),
      } as never,
    );

    await expect(
      gateway.archiveAttendance({
        businessDate: '2026-09-08',
        users: [{ userId: 'u1', name: 'Test User' }],
        results: [],
        details: [],
        corrections: [
          {
            processInstanceId: 'process-2',
            userId: 'u1',
            status: 'COMPLETED',
            result: 'agree',
            correctionTime: Date.parse('2026-09-08T10:00:00.000Z'),
            workDate: Date.parse('2026-09-08T00:00:00.000Z'),
            planText: 'Off duty missing card',
            reason: 'Forgot to punch',
            photoUrls: [
              'https://static.dingtalk.com/media/evidence-1.jpg',
              'https://static.dingtalk.com/media/evidence-2.jpg',
            ],
            original: {},
          },
        ],
      }),
    ).resolves.toMatchObject({ total: 1, updated: 1 });

    expect(get).toHaveBeenCalledTimes(2);
    expect(verifiedFields?.补卡举证材料).toEqual([
      { file_token: 'new-1' },
      { file_token: 'new-2' },
    ]);
  });

  it('keeps an approved correction normal when evidence sync is incomplete', async () => {
    jest.mocked(getTenantAccessToken).mockResolvedValue('tenant-token');
    let createdFields: Record<string, unknown> | null = null;
    jest.mocked(fetchBitableRecords).mockImplementation(async () =>
      createdFields
        ? ([
            {
              record_id: 'rec-result',
              fields: createdFields,
            },
          ] as never)
        : [],
    );
    const post = jest.fn(async (url: string, body: any) => {
      if (url.includes('/batch_create')) {
        createdFields = body.records[0].fields;
      }
      return { data: { code: 0 } };
    });
    const gateway = new AttendanceAutomationFeishuGateway({
      axiosRef: { post },
    } as never);

    await gateway.archiveAttendance({
      businessDate: '2026-09-03',
      users: [{ userId: 'u1', name: '支佳伟' }],
      results: [
        {
          id: 1,
          userId: 'u1',
          checkType: 'OffDuty',
          baseCheckTime: Date.parse('2026-09-03T01:00:00.000Z'),
          userCheckTime: Date.parse('2026-09-03T01:02:00.000Z'),
          workDate: Date.parse('2026-09-02T16:00:00.000Z'),
          timeResult: 'Normal',
          locationResult: 'Normal',
          approveId: 'approve-1',
          procInstId: 'process-1',
          sourceType: 'APPROVE',
          correctionEvidenceStatus: 'missing',
          original: {},
        },
      ],
      details: [],
      corrections: [],
    });

    expect(createdFields).toMatchObject({
      是否合法: '是',
    });
    expect(createdFields).not.toHaveProperty('补卡异常说明');
  });
});
