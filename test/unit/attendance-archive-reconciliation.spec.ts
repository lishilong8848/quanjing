import {
  reconcileAttendanceRows,
  attendanceBusinessKey,
} from '../../server/modules/duty-schedule/attendance-archive-reconciliation';

const row = (status: string, actual?: number, id = 'u1') => ({
  key: `old-${status}`,
  fields: {
    记录唯一键: `old-${status}`,
    记录类型: '考勤结果',
    钉钉员工ID: id,
    工作日期: Date.parse('2026-09-07T00:00:00+08:00'),
    打卡类型: '下班',
    时间状态: status,
    ...(actual ? { 实际打卡时间: actual } : {}),
    应打卡时间: Date.parse('2026-09-07T18:00:00+08:00'),
    原始记录JSON: JSON.stringify({
      expectationKey: '2026-09-07:building_h:white:OffDuty:测试',
    }),
  },
});

describe('attendance archive business identity', () => {
  it('keeps one row per person/date/shift and retains every raw punch', () => {
    const onDuty = row('正常', Date.parse('2026-09-07T08:51:00+08:00'));
    onDuty.fields.打卡类型 = '上班';
    onDuty.fields.应打卡时间 = Date.parse('2026-09-07T09:00:00+08:00');
    onDuty.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-07:building_h:white:OnDuty:测试',
      attendanceChecks: [
        {
          expectation: {
            key: '2026-09-07:building_h:white:OnDuty:测试',
            name: '测试',
            building: 'H楼',
            shiftLabel: '白班',
            direction: 'OnDuty',
            expectedAt: '2026-09-07 09:00:00',
            status: 'on_duty',
          },
          timeResult: 'Normal',
          userCheckTime: '2026-09-07 08:51:00',
        },
      ],
      rawPunches: [
        {
          recordId: 'punch-on-2',
          direction: 'OnDuty',
          userCheckTime: '2026-09-07 08:51:00',
        },
        {
          recordId: 'punch-on-1',
          direction: 'OnDuty',
          userCheckTime: '2026-09-07 08:49:00',
        },
      ],
    });
    const offDuty = row('正常', Date.parse('2026-09-07T18:14:00+08:00'));
    offDuty.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-07:building_h:white:OffDuty:测试',
      attendanceChecks: [
        {
          expectation: {
            key: '2026-09-07:building_h:white:OffDuty:测试',
            name: '测试',
            building: 'H楼',
            shiftLabel: '白班',
            direction: 'OffDuty',
            expectedAt: '2026-09-07 18:00:00',
            status: 'on_duty',
          },
          timeResult: 'Normal',
          userCheckTime: '2026-09-07 18:14:00',
        },
      ],
      rawPunches: [
        {
          recordId: 'punch-off-1',
          direction: 'OffDuty',
          userCheckTime: '2026-09-07 18:14:00',
        },
      ],
    });

    const plan = reconcileAttendanceRows([onDuty, offDuty], []);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].fields).toMatchObject({
      班次: '白班',
      打卡类型: '班次汇总',
      上班打卡时间: Date.parse('2026-09-07T08:49:00+08:00'),
      下班打卡时间: Date.parse('2026-09-07T18:14:00+08:00'),
      打卡次数: 3,
      全部打卡时间: '08:49:00、08:51:00、18:14:00',
      上班状态: '正常',
      下班状态: '正常',
    });
    expect(
      JSON.parse(String(plan.rows[0].fields.原始记录JSON)).attendanceChecks,
    ).toHaveLength(2);
  });

  it('keeps different shifts for the same person and date separate', () => {
    const white = row('正常', Date.parse('2026-09-07T08:49:00+08:00'));
    white.fields.打卡类型 = '上班';
    white.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-07:building_h:white:OnDuty:测试',
    });
    const night = row('正常', Date.parse('2026-09-07T18:01:00+08:00'));
    night.fields.打卡类型 = '上班';
    night.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-07:building_h:night:OnDuty:测试',
    });

    expect(reconcileAttendanceRows([white, night], []).rows).toHaveLength(2);
  });

  it('keeps distinct regular and overtime checks in one daily direction row', () => {
    const regular = row('正常', Date.parse('2026-09-07T18:06:00+08:00'));
    const overtime = row('未打卡');
    const check = (key: string, status: string) => ({
      expectation: { key },
      timeResult: status,
      userCheckTime: status === 'Normal' ? '2026-09-07 18:06:00' : null,
    });
    regular.fields.原始记录JSON = JSON.stringify({
      attendanceChecks: [check('regular', 'Normal')],
    });
    overtime.fields.原始记录JSON = JSON.stringify({
      attendanceChecks: [check('overtime', 'NotSigned')],
    });
    const result = reconcileAttendanceRows([regular, overtime], []);
    expect(result.rows).toHaveLength(1);
    expect(
      JSON.parse(String(result.rows[0].fields.原始记录JSON)).attendanceChecks,
    ).toHaveLength(2);
  });
  it('collapses missing and signed versions to one user/date/direction record', () => {
    const signed = row('正常', Date.parse('2026-09-07T18:06:00+08:00'));
    const plan = reconcileAttendanceRows([row('未打卡'), signed], []);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].fields.时间状态).toBe('正常');
    expect(plan.rows[0].key).toBe(attendanceBusinessKey(signed.fields));
  });

  it('does not let a stale missing punch overwrite an existing actual punch', () => {
    const signed = row('迟到', Date.parse('2026-09-07T18:06:00+08:00'));
    const plan = reconcileAttendanceRows(
      [row('未打卡')],
      [{ record_id: 'rec-kept', fields: signed.fields }],
    );
    expect(plan.rows[0].recordId).toBe('rec-kept');
    expect(plan.rows[0].fields.时间状态).toBe('迟到');
  });

  it('normalizes Feishu text values and removes read-only fields before update', () => {
    const existing = row('正常', Date.parse('2026-09-07T18:06:00+08:00'));
    const existingFields: Record<string, unknown> = {
      ...existing.fields,
      姓名: [{ type: 'text', text: '测试' }],
      钉钉员工ID: [{ type: 'text', text: 'u1' }],
      钉钉记录ID: [{ type: 'text', text: 'ding-record-1' }],
      打卡地址: [{ type: 'text', text: '测试地址' }],
      外勤备注: [{ type: 'text', text: '测试备注' }],
      设备ID: [{ type: 'text', text: 'device-1' }],
      创建人: [{ id: 'creator' }],
      创建时间: Date.parse('2026-09-07T18:07:00+08:00'),
      员工姓名: ['测试'],
      楼栋: ['H楼'],
      示例人员001: [{ id: 'manager' }],
    };

    const plan = reconcileAttendanceRows(
      [row('未打卡')],
      [{ record_id: 'rec-kept', fields: existingFields }],
    );

    expect(plan.rows[0].fields).toMatchObject({
      姓名: '测试',
      钉钉员工ID: 'u1',
      钉钉记录ID: 'ding-record-1',
      打卡地址: '测试地址',
      外勤备注: '测试备注',
      设备ID: 'device-1',
    });
    expect(plan.rows[0].fields).not.toHaveProperty('创建人');
    expect(plan.rows[0].fields).not.toHaveProperty('创建时间');
    expect(plan.rows[0].fields).not.toHaveProperty('员工姓名');
    expect(plan.rows[0].fields).not.toHaveProperty('楼栋');
    expect(plan.rows[0].fields).not.toHaveProperty('示例人员001');
    expect(plan.rows[0].fields).not.toHaveProperty('经度');
    expect(plan.rows[0].fields).not.toHaveProperty('纬度');
  });

  it('explicitly clears a stale on-duty summary time', () => {
    const existing = row('正常', Date.parse('2026-09-07T18:06:00+08:00'));
    const existingFields: Record<string, unknown> = {
      ...existing.fields,
      上班打卡时间: Date.parse('2026-09-07T09:01:00+08:00'),
    };

    const plan = reconcileAttendanceRows(
      [row('未打卡')],
      [{ record_id: 'rec-kept', fields: existingFields }],
    );

    expect(plan.rows[0].fields).toHaveProperty('上班打卡时间', null);
  });

  it('reclassifies a stale missing off-duty row when an actual punch exists', () => {
    const stale = row('未打卡', Date.parse('2026-09-07T18:05:00+08:00'));

    const plan = reconcileAttendanceRows([stale], []);

    expect(plan.rows[0].fields).toMatchObject({
      时间状态: '正常',
      下班状态: '正常',
      是否合法: '是',
    });
    expect(plan.rows[0].fields.文本).toContain('正常');
  });

  it('reclassifies a stale missing on-duty row as late from its actual punch', () => {
    const stale = row('未打卡', Date.parse('2026-09-07T09:05:00+08:00'));
    stale.fields.打卡类型 = '上班';
    stale.fields.应打卡时间 = Date.parse('2026-09-07T09:00:00+08:00');
    stale.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-07:building_h:white:OnDuty:测试',
    });

    const plan = reconcileAttendanceRows([stale], []);

    expect(plan.rows[0].fields).toMatchObject({
      时间状态: '迟到',
      上班状态: '迟到',
      是否合法: '是',
    });
  });

  it('keeps invalid unclassified punches and marks the shift as attendance anomaly', () => {
    const stale = row('未打卡', Date.parse('2026-09-14T08:04:38+08:00'));
    stale.fields.打卡类型 = '班次汇总';
    stale.fields.班次 = '夜班';
    stale.fields.应打卡时间 = Date.parse('2026-09-14T08:00:00+08:00');
    stale.fields.工作日期 = Date.parse('2026-09-14T00:00:00+08:00');
    stale.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-14:station_110:night:OffDuty:测试',
      attendanceShiftKey: '2026-09-14:station_110:night',
      attendanceChecks: [
        {
          expectation: {
            key: '2026-09-14:station_110:night:OffDuty:测试',
            direction: 'OffDuty',
            expectedAt: '2026-09-14 08:00:00',
          },
          timeResult: 'NotSigned',
          userCheckTime: null,
        },
      ],
      rawPunches: [
        {
          direction: null,
          userCheckTime: Date.parse('2026-09-14T08:04:05+08:00'),
          invalidReason: '当前不在可打卡的时间范围，请和管理员联系',
        },
        {
          direction: null,
          userCheckTime: Date.parse('2026-09-14T08:04:38+08:00'),
          invalidReason: '当前不在可打卡的时间范围，请和管理员联系',
        },
      ],
    });

    const plan = reconcileAttendanceRows([stale], []);

    expect(plan.rows[0].fields).toMatchObject({
      时间状态: '考勤异常',
      下班状态: '考勤异常',
      下班打卡时间: Date.parse('2026-09-14T08:04:38+08:00'),
      实际打卡时间: Date.parse('2026-09-14T08:04:38+08:00'),
      打卡次数: 2,
      全部打卡时间: '08:04:05、08:04:38',
      是否合法: '否',
    });
  });

  it('keeps a row missing when no actual punch exists', () => {
    const plan = reconcileAttendanceRows([row('未打卡')], []);

    expect(plan.rows[0].fields).toMatchObject({
      时间状态: '未打卡',
      下班状态: '未打卡',
      是否合法: '否',
    });
  });

  it('plans explicitly requested legacy duplicate removal but leaves correction approvals alone', () => {
    const signed = row('正常', Date.parse('2026-09-07T18:06:00+08:00'));
    const records = [
      { record_id: 'rec-missing', fields: row('未打卡').fields },
      { record_id: 'rec-signed', fields: signed.fields },
      {
        record_id: 'rec-approval',
        fields: { ...signed.fields, 记录类型: '补卡审批' },
      },
    ];
    const plan = reconcileAttendanceRows([], records, {
      includeExistingOnlyDuplicates: true,
    });
    expect(plan.rows).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].record_id).not.toBe('rec-approval');
    expect(plan.originals).toHaveLength(2);
    expect(plan.rows[0].fields.实际打卡时间).toBe(signed.fields.实际打卡时间);
  });

  it('removes an unresolved legacy row when its raw punch is now owned by a canonical shift', () => {
    const canonical = row(
      '正常',
      Date.parse('2026-09-16T17:20:00+08:00'),
      'u1',
    );
    canonical.fields.工作日期 = Date.parse('2026-09-16T00:00:00+08:00');
    canonical.fields.打卡类型 = '上班';
    canonical.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-16:building_a:night:OnDuty:李董',
      attendanceShiftKey: '2026-09-16:building_a:night',
      rawPunches: [
        {
          recordId: 'repeat-on-duty',
          direction: 'OnDuty',
          userCheckTime: '2026-09-16 17:21:30',
          invalidReason: '已经打过卡了，上班时间以最早打卡时间为准',
        },
      ],
    });
    const canonicalKey = attendanceBusinessKey(canonical.fields)!;
    canonical.fields.记录唯一键 = canonicalKey;
    const orphan = {
      ...canonical.fields,
      记录唯一键: 'attendance-ambiguous-incoming-repeat-on-duty',
      班次: '',
      打卡类型: '班次汇总',
      时间状态: '',
      原始记录JSON: JSON.stringify({
        rawPunches: [
          {
            recordId: 'repeat-on-duty',
            direction: null,
            userCheckTime: '2026-09-16 17:21:30',
            invalidReason: '已经打过卡了，上班时间以最早打卡时间为准',
          },
        ],
      }),
    };

    const plan = reconcileAttendanceRows(
      [canonical],
      [
        { record_id: 'rec-canonical', fields: canonical.fields },
        { record_id: 'rec-orphan', fields: orphan },
      ],
    );

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].recordId).toBe('rec-canonical');
    expect(plan.duplicates.map((record) => record.record_id)).toEqual([
      'rec-orphan',
    ]);
  });

  it('does not expand a daily sync into unrelated historical duplicate cleanup', () => {
    const current = row(
      '正常',
      Date.parse('2026-09-08T18:06:00+08:00'),
      'u-current',
    );
    current.fields.工作日期 = Date.parse('2026-09-08T00:00:00+08:00');
    current.fields.原始记录JSON = JSON.stringify({
      expectationKey: '2026-09-08:building_h:white:OffDuty:当前人员',
    });
    const historicalSigned = row(
      '正常',
      Date.parse('2026-09-07T18:06:00+08:00'),
      'u-history',
    );
    const historicalMissing = row('未打卡', undefined, 'u-history');

    const plan = reconcileAttendanceRows(
      [current],
      [
        { record_id: 'rec-history-signed', fields: historicalSigned.fields },
        { record_id: 'rec-history-missing', fields: historicalMissing.fields },
      ],
    );

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].key).toBe(attendanceBusinessKey(current.fields));
    expect(plan.duplicates).toEqual([]);
    expect(plan.originals).toEqual([]);
  });

  it('keeps different IDs and dates separate while merging directions', () => {
    const a = row('未打卡');
    const b = row('未打卡', undefined, 'u2');
    const c = { ...a, fields: { ...a.fields, 打卡类型: '上班' } };
    const d = {
      ...a,
      fields: {
        ...a.fields,
        工作日期: Date.parse('2026-09-08T00:00:00+08:00'),
      },
    };
    expect(reconcileAttendanceRows([a, b, c, d], []).rows).toHaveLength(3);
  });

  it('preserves expectation metadata and evidence when the real result has a different record ID', () => {
    const old = row('未打卡');
    const signed = row('正常', Date.parse('2026-09-07T18:06:00+08:00'));
    signed.fields.原始记录JSON = JSON.stringify({ id: 'new-dingtalk-id' });
    const plan = reconcileAttendanceRows(
      [signed],
      [
        {
          record_id: 'rec-old',
          fields: { ...old.fields, 补卡举证材料: [{ file_token: 'evidence' }] },
        },
      ],
    );
    expect(
      JSON.parse(String(plan.rows[0].fields.原始记录JSON)).expectationKey,
    ).toContain('2026-09-07:');
    expect(plan.rows[0].fields.补卡举证材料).toEqual([
      { file_token: 'evidence' },
    ]);
  });
});
