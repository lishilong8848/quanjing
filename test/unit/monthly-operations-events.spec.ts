import {
  mapMonthlyEvents,
  mergeMonthlyEventSources,
  eventFinalLevel,
} from '../../server/modules/bitable-sync/monthly-operations-events.model';
import {
  DEFAULT_EVENT_FILTERS,
  filterEvents,
  eventPrioritySummary,
  eventRepeatOccurrences,
  eventDeviceOccurrences,
  eventMonthlyTrend,
  eventMetricRecords,
} from '../../client/src/pages/MonthlyOperations/event-model';
const occurred = Date.parse('2026-09-12T17:10:00+08:00');
const row = (id: string, fields: Record<string, unknown> = {}) => ({
  record_id: id,
  fields: {
    事件发生时间: occurred,
    事件等级: 'I3',
    机楼: 'A楼',
    专业: '电气',
    告警描述: '设备告警',
    最终状态: '事件闭环转检修中',
    是否转检修: true,
    持续时间: { type: 2, value: [2] },
    '事件发现来源（统一）': { type: 1, value: ['BMS系统'] },
    ...fields,
  },
});
describe('月览真实事件', () => {
  it('补充表只增强同一事件，并映射人工复盘标记与两次复盘报告', () => {
    const result = mergeMonthlyEventSources(
      [
        row('primary', {
          事件编号: 'SJ260413-101',
          告警描述: '方舟平台报多个冷冻水供回水温度异常',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
      ],
      [
        row('supplement', {
          事件编号: 'SJ260413-101',
          告警描述: '方舟平台报多个冷冻水供回水温度异常',
          需回溯: true,
          '1-回溯报告':
            '[A楼夜班模式切换事件报告](https://vnet.feishu.cn/wiki/P2klwb3Y0i8M4gk5kl7cYQ8nnbe)',
          '2-回溯报告':
            'https://vnet.feishu.cn/wiki/Z5Yyw0mo7inn8MkO66ZcMEptnP3',
          事件发生原因: '模式调整导致水温异常',
          事件解决措施: '调整运行模式并加强观察',
        }),
      ],
      '2026-09-13',
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: 'primary',
      needsReview: true,
      cause: '模式调整导致水温异常',
      resolution: '调整运行模式并加强观察',
      reviewReports: [
        {
          label: '首次复盘',
          title: 'A楼夜班模式切换事件报告',
          url: 'https://vnet.feishu.cn/wiki/P2klwb3Y0i8M4gk5kl7cYQ8nnbe',
        },
        {
          label: '二次复盘',
          title: '二次复盘报告',
          url: 'https://vnet.feishu.cn/wiki/Z5Yyw0mo7inn8MkO66ZcMEptnP3',
        },
      ],
    });
    const priority = eventPrioritySummary(result.records, '2026-09-13');
    expect(priority.review.map((record) => record.id)).toEqual(['primary']);
    expect(priority.records.map((record) => record.id)).toEqual(['primary']);
    expect(priority.reasons.primary).toEqual(['需复盘']);
  });

  it('补充表中没有主表对应项的人工重点仍保留，危险外链不进入报告弹窗', () => {
    const result = mergeMonthlyEventSources(
      [],
      [
        row('manual-only', {
          事件编号: 'SJ260501-201',
          需回溯: true,
          '1-回溯报告': '[错误链接](https://example.com/report)',
        }),
      ],
      '2026-09-13',
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: 'manual-only',
      needsReview: true,
      reviewReports: [],
    });
  });

  it('解析飞书 mention 形式的复盘文档和文件链接', () => {
    const result = mapMonthlyEvents(
      [
        row('mention-report', {
          需回溯: true,
          '1-回溯报告': {
            link: 'https://vnet.feishu.cn/docx/CNLGdCHqHozkj2xcL32cavvBnCd?dcuId=7185010722303475713',
            text: 'C楼支路开关事件回顾',
            token: 'CNLGdCHqHozkj2xcL32cavvBnCd',
            type: 'mention',
          },
          '2-回溯报告': {
            link: 'https://vnet.feishu.cn/file/Ii4RbU6WGopA6GxLUPXclODln5c?from=from_copylink',
            text: 'C楼事件回溯.docx',
            token: 'Ii4RbU6WGopA6GxLUPXclODln5c',
            type: 'mention',
          },
        }),
      ],
      '2026-09-13',
    );

    expect(result.records[0].reviewReports).toEqual([
      {
        label: '首次复盘',
        title: 'C楼支路开关事件回顾',
        url: 'https://vnet.feishu.cn/docx/CNLGdCHqHozkj2xcL32cavvBnCd?dcuId=7185010722303475713',
      },
      {
        label: '二次复盘',
        title: 'C楼事件回溯.docx',
        url: 'https://vnet.feishu.cn/file/Ii4RbU6WGopA6GxLUPXclODln5c?from=from_copylink',
      },
    ]);
  });

  it('指标卡与清单共用记录口径，区分年度、周期、历史存量和全量重点事件', () => {
    const records = mapMonthlyEvents(
      [
        row('month'),
        row('earlier', {
          事件发生时间: Date.parse('2026-02-01T10:00:00+08:00'),
          事件等级: 'I2',
        }),
        row('history', {
          事件发生时间: Date.parse('2025-12-01T10:00:00+08:00'),
          最终状态: '',
          事件状态: '响应跟进',
        }),
        row('unknown', { 最终状态: '', 是否转检修: false }),
        row('other-building', { 机楼: 'B楼' }),
        row('future', {
          事件发生时间: Date.parse('2026-10-01T10:00:00+08:00'),
        }),
      ],
      '2026-12-31',
    ).records.filter((r) => r.building === 'A楼');
    const groups = eventMetricRecords(records, '2026-09-01', '2026-09-13');
    const ids = (key: keyof typeof groups) =>
      groups[key].map((r) => r.id).sort();
    expect(ids('year')).toEqual(['earlier', 'month', 'unknown']);
    expect(ids('period')).toEqual(['month', 'unknown']);
    expect(ids('open')).toEqual(['history']);
    expect(ids('key')).toEqual(['earlier']);
    expect(ids('active')).toEqual(['earlier', 'month']);
    expect(ids('priority')).toEqual(['earlier', 'history']);
    const custom = eventMetricRecords(records, '2026-01-01', '2026-03-01');
    expect(custom.period.map((r) => r.id)).toEqual(['earlier']);
    expect(eventMetricRecords([], '2026-09-01', '2026-09-13')).toEqual({
      year: [],
      period: [],
      open: [],
      key: [],
      active: [],
      priority: [],
    });
  });
  it('重点事件按全量历史合并同点位三次故障、I2+与逾7天未闭环或检修中，并标注原因', () => {
    const records = mapMonthlyEvents(
      [
        row('repeat-a', {
          告警描述: 'E-211-CRAH-03空调过滤网堵塞',
          机楼: 'E楼',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('repeat-b', {
          事件发生时间: Date.parse('2026-03-01T10:00:00+08:00'),
          告警描述: '巡检发现E-211-CRAH-03滤网脏堵',
          机楼: 'E楼',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('repeat-c', {
          事件发生时间: Date.parse('2025-12-01T10:00:00+08:00'),
          告警描述: 'BMS报E-211-CRAH-03过滤器堵塞告警',
          机楼: 'E楼',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('level', {
          事件发生时间: Date.parse('2025-12-01T10:00:00+08:00'),
          告警描述: '独立高等级事件',
          事件等级: 'I2',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('long-open', {
          事件发生时间: Date.parse('2026-08-01T10:00:00+08:00'),
          告警描述: '长期未闭环事件',
          最终状态: '',
          事件状态: '响应跟进',
          是否转检修: false,
          持续时间: { type: 2, value: [12] },
        }),
        row('long-repair', {
          事件发生时间: Date.parse('2026-08-20T10:00:00+08:00'),
          告警描述: '长期检修事件',
          持续时间: null,
        }),
        row('recent-repair', { 告警描述: '近期检修事件', 持续时间: null }),
      ],
      '2026-09-13',
    ).records;
    const result = eventPrioritySummary(records, '2026-09-13');
    expect(result.records.map((record) => record.id).sort()).toEqual([
      'level',
      'long-open',
      'long-repair',
      'repeat-a',
    ]);
    expect(result.repeatGroupCount).toBe(1);
    expect(result.repeated.map((record) => record.id)).toEqual(['repeat-a']);
    expect(result.reasons['repeat-a']).toEqual(['重复出现', '同设备多发']);
    expect(result.reasons.level).toEqual(['I2及以上']);
    expect(result.reasons['long-open']).toEqual(['未闭环超过7天']);
    expect(result.reasons['long-repair']).toEqual(['检修中超过7天']);
  });
  it('不同漏水点位不能合并；同点位不足三次不能算重复', () => {
    const records = mapMonthlyEvents(
      [
        row('e-151-a', {
          机楼: '',
          告警描述: 'BMS报E-151-LEAK-01漏水报警: 告警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('e-151-b', {
          机楼: '',
          告警描述: 'E-151-LEAK-01漏水告警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('e-450', {
          机楼: '',
          告警描述: 'BMS报E-450-LEAK-01漏水报警: 告警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('a-151', {
          机楼: '',
          告警描述: 'BMS报A-151-LEAK-01漏水报警: 告警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
      ],
      '2026-09-13',
    ).records;
    expect(records.map((record) => [record.id, record.building])).toEqual([
      ['a-151', 'A楼'],
      ['e-151-a', 'E楼'],
      ['e-151-b', 'E楼'],
      ['e-450', 'E楼'],
    ]);
    expect(eventPrioritySummary(records, '2026-09-13').repeated).toEqual([]);
  });
  it('同设备编号的不同故障出现两次单独计为多发设备，不改变同故障三次口径', () => {
    const closed = { 最终状态: '事件闭环未转检修', 是否转检修: false };
    const records = mapMonthlyEvents(
      [
        row('first', {
          ...closed,
          事件发生时间: Date.parse('2026-07-01T09:00:00+08:00'),
          告警描述: 'BMS报C-311-LEAK-01漏水报警',
          机楼: 'C楼',
        }),
        row('second', {
          ...closed,
          告警描述: '巡检发现C－311－LEAK－01通信异常',
          机楼: 'C楼',
        }),
        row('other-device', {
          ...closed,
          告警描述: 'C-311-LEAK-02漏水报警',
          机楼: 'C楼',
        }),
        row('no-code', { ...closed, 告警描述: 'C楼漏水报警', 机楼: 'C楼' }),
        row('future', {
          ...closed,
          事件发生时间: Date.parse('2026-09-20T09:00:00+08:00'),
          告警描述: 'C-311-LEAK-01再次报警',
          机楼: 'C楼',
        }),
      ],
      '2026-09-30',
    ).records;
    const summary = eventPrioritySummary(records, '2026-09-13');
    expect(summary.deviceRepeated.map((record) => record.id)).toEqual([
      'second',
    ]);
    expect(summary.repeated).toEqual([]);
    expect(summary.records.map((record) => record.id)).toEqual(['second']);
    expect(summary.reasons.second).toEqual(['同设备多发']);
    expect(
      eventDeviceOccurrences(
        records,
        records.find((record) => record.id === 'second')!,
        '2026-09-13',
      ).map((record) => record.id),
    ).toEqual(['first', 'second']);
  });
  it('重复事件详情按发生先后列出同点位记录和各次处理状态，不混入其他设备或未来事件', () => {
    const records = mapMonthlyEvents(
      [
        row('third', {
          告警描述: 'BMS报E-211-CRAH-03过滤器堵塞告警',
          机楼: 'E楼',
          事件目前进展: '已更换滤网',
          事件恢复时间: Date.parse('2026-09-12T18:00:00+08:00'),
        }),
        row('first', {
          事件发生时间: Date.parse('2026-07-01T09:00:00+08:00'),
          告警描述: 'E-211-CRAH-03空调过滤网堵塞',
          机楼: 'E楼',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('second', {
          事件发生时间: Date.parse('2026-08-01T10:00:00+08:00'),
          告警描述: '巡检发现E-211-CRAH-03滤网脏堵',
          机楼: 'E楼',
        }),
        row('other-device', {
          告警描述: 'E-212-CRAH-03过滤网堵塞',
          机楼: 'E楼',
        }),
        row('future', {
          事件发生时间: Date.parse('2026-09-20T10:00:00+08:00'),
          告警描述: 'E-211-CRAH-03过滤网堵塞',
          机楼: 'E楼',
        }),
      ],
      '2026-09-30',
    ).records;
    const selected = records.find((record) => record.id === 'third')!;
    const occurrences = eventRepeatOccurrences(records, selected, '2026-09-13');
    expect(occurrences.map((record) => record.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(occurrences.map((record) => record.status)).toEqual([
      '事件闭环未转检修',
      '事件闭环转检修中',
      '事件闭环转检修中',
    ]);
    expect(occurrences[2].progress).toBe('已更换滤网');
    expect(occurrences[2].recoveredAt).toBeTruthy();
    expect(
      eventRepeatOccurrences(
        records,
        records.find((record) => record.id === 'other-device')!,
        '2026-09-13',
      ),
    ).toEqual([]);
  });
  it('缺少可靠点位时不把同类告警并组，仅待标注不计入重点事件', () => {
    const records = mapMonthlyEvents(
      [
        row('unknown-a', {
          机楼: '',
          专业: '',
          告警描述: '漏水报警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('unknown-b', {
          机楼: '',
          专业: '',
          告警描述: '漏水告警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
        row('unknown-c', {
          机楼: '',
          专业: '',
          告警描述: 'BMS报漏水报警',
          最终状态: '事件闭环未转检修',
          是否转检修: false,
        }),
      ],
      '2026-09-13',
    ).records;
    const summary = eventPrioritySummary(records, '2026-09-13');
    expect(summary.repeated).toEqual([]);
    expect(summary.unlabeled.map((record) => record.id)).toEqual([
      'unknown-a',
      'unknown-b',
      'unknown-c',
    ]);
    expect(summary.records).toEqual([]);
    expect(summary.reasons['unknown-a']).toBeUndefined();
  });
  it('源字段缺失时按设备和故障对象补充专业，并保留已有专业', () => {
    const records = mapMonthlyEvents(
      [
        row('generator', {
          机楼: '',
          专业: '',
          告警描述: 'BMS报柴发并机系统通信中断',
        }),
        row('cooling', {
          机楼: '',
          专业: '',
          告警描述: '巡检发现E楼5#制冷单元阀控柜电源检测模块故障',
        }),
        row('ups', {
          机楼: '',
          专业: '',
          告警描述: 'BMS报E-416-UPS-2组电池温度过高报警',
        }),
        row('power', {
          机楼: '',
          专业: '',
          告警描述: 'BMS报C-124控制柜主用电源状态告警',
        }),
        row('leak', {
          机楼: '',
          专业: '',
          告警描述: 'BMS报E-151-LEAK-01漏水报警',
        }),
        row('fire', {
          机楼: '',
          专业: '',
          告警描述: '巡检发现D-127冷冻站智能消防排烟窗控制器故障',
        }),
        row('weak', {
          机楼: '',
          专业: '',
          告警描述: '巡检发现门禁服务器告警灯闪烁',
        }),
        row('entered', { 专业: '消防', 告警描述: 'A-211-CRAH-03空调告警' }),
        row('ambiguous', { 机楼: '', 专业: '', 告警描述: 'BMS报通信中断' }),
      ],
      '2026-09-13',
    ).records;
    const byId = (id: string) => records.find((record) => record.id === id);
    expect(byId('generator')).toMatchObject({
      building: '未标注',
      specialty: '电气',
    });
    expect(byId('cooling')).toMatchObject({
      building: 'E楼',
      specialty: '暖通',
    });
    expect(byId('ups')).toMatchObject({ building: 'E楼', specialty: '电气' });
    expect(byId('power')).toMatchObject({ building: 'C楼', specialty: '电气' });
    expect(byId('leak')).toMatchObject({ building: 'E楼', specialty: '暖通' });
    expect(byId('fire')).toMatchObject({ building: 'D楼', specialty: '消防' });
    expect(byId('weak')?.specialty).toBe('弱电');
    expect(byId('entered')?.specialty).toBe('消防');
    expect(byId('ambiguous')?.specialty).toBe('未标注');
  });
  it('三个月内发生至少三次的故障优先排序并标识，跨年历史故障仍参与判断', () => {
    const closed = { 最终状态: '事件闭环未转检修', 是否转检修: false };
    const records = mapMonthlyEvents(
      [
        row('slow-new', {
          ...closed,
          告警描述: 'E-450-LEAK-01漏水报警',
          事件发生时间: Date.parse('2026-09-12T09:00:00+08:00'),
        }),
        row('slow-mid', {
          ...closed,
          告警描述: 'E-450-LEAK-01漏水报警',
          事件发生时间: Date.parse('2026-01-12T09:00:00+08:00'),
        }),
        row('slow-old', {
          ...closed,
          告警描述: 'E-450-LEAK-01漏水报警',
          事件发生时间: Date.parse('2025-01-12T09:00:00+08:00'),
        }),
        row('fast-new', {
          ...closed,
          告警描述: 'C-311-LEAK-01漏水报警',
          事件发生时间: Date.parse('2025-03-01T09:00:00+08:00'),
        }),
        row('fast-mid', {
          ...closed,
          告警描述: 'C-311-LEAK-01漏水报警',
          事件发生时间: Date.parse('2025-02-01T09:00:00+08:00'),
        }),
        row('fast-old', {
          ...closed,
          告警描述: 'C-311-LEAK-01漏水报警',
          事件发生时间: Date.parse('2025-01-01T09:00:00+08:00'),
        }),
      ],
      '2026-09-18',
    ).records;
    const summary = eventPrioritySummary(records, '2026-09-18');
    expect(summary.rapidRepeatGroupCount).toBe(1);
    expect(summary.repeated.map((record) => record.id)).toEqual([
      'fast-new',
      'slow-new',
    ]);
    expect(summary.reasons['fast-new']).toEqual([
      '重复出现',
      '3个月内重复',
      '同设备多发',
    ]);
    expect(summary.reasons['slow-new']).toEqual(['重复出现', '同设备多发']);
    expect(summary.reasons['fast-mid']).toBeUndefined();
  });
  it('排除不计入、未来、无日期并去重，保留统一来源与持续时长', () => {
    const data = mapMonthlyEvents(
      [
        row('a'),
        row('a'),
        row('b', { 不计入事件: true }),
        row('c', { 事件发生时间: null }),
        row('d', { 事件发生时间: occurred + 86400000 * 2 }),
      ],
      '2026-09-13',
    );
    expect(data.records).toHaveLength(1);
    expect(data).toMatchObject({ excluded: 1, invalid: 1 });
    expect(data.records[0]).toMatchObject({
      source: 'BMS系统',
      durationDays: 2,
      closed: true,
      repair: 'active',
      date: '2026-09-12',
    });
  });
  it('转检修与事件闭环是不同维度，未知状态不假装未闭环', () => {
    const data = mapMonthlyEvents(
      [
        row('a'),
        row('b', { 最终状态: '', 事件状态: '响应跟进' }),
        row('c', { 最终状态: '', 是否转检修: false }),
      ],
      '2026-09-13',
    ).records;
    expect(data.find((r) => r.id === 'b')?.closed).toBe(false);
    expect(data.find((r) => r.id === 'c')?.closed).toBeNull();
    expect(data.find((r) => r.id === 'c')?.repair).toBe('none');
  });
  it('等级按变更后等级判断，不把降为 I3 的事件算作 I2+', () => {
    expect(eventFinalLevel('I2→I3（降级）')).toBe('I3');
    expect(eventFinalLevel('I3→I2（升级）')).toBe('I2');
    const data = mapMonthlyEvents(
      [row('a', { 事件等级: 'I2→I3（降级）' }), row('b', { 事件等级: 'E2' })],
      '2026-09-13',
    );
    expect(data.records.map((r) => [r.id, r.keyEvent])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });
  it('历史检修存量可跨月查看；搜索、专业、日期、楼栋过滤共同生效', () => {
    const data = mapMonthlyEvents(
      [
        row('a'),
        row('b', {
          事件发生时间: Date.parse('2026-08-01T10:00:00+08:00'),
          专业: '暖通',
        }),
      ],
      '2026-09-13',
    ).records;
    expect(
      filterEvents(data, DEFAULT_EVENT_FILTERS, '2026-09-01', '2026-09-13'),
    ).toHaveLength(2);
    expect(
      filterEvents(
        data,
        {
          ...DEFAULT_EVENT_FILTERS,
          scope: 'period',
          specialty: '电气',
          query: '设备',
          date: '2026-09-12',
          building: 'A楼',
        },
        '2026-09-01',
        '2026-09-13',
      ),
    ).toHaveLength(1);
    expect(
      filterEvents(
        data,
        { ...DEFAULT_EVENT_FILTERS, state: 'open' },
        '2026-09-01',
        '2026-09-13',
      ),
    ).toHaveLength(0);
  });
  it('月趋势恰好12个月，空月为0，包含本月并跨年', () => {
    const data = mapMonthlyEvents([row('a')], '2026-09-13').records;
    const result = eventMonthlyTrend(data, '2026-09-13');
    expect(result).toHaveLength(12);
    expect(result[0]).toEqual({ name: '2025-10', total: 0 });
    expect(result[11]).toEqual({ name: '2026-09', total: 1 });
  });
});
