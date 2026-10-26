import { detectAlarmTagRuleIssues } from './today-operations-alarm-tag-rules';

describe('alarm tag rules', () => {
  it('accepts a later confirmed self-control system fault for a status alarm', () => {
    const issues = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '【设备故障】人员已去现场',
      confirmationDescription:
        '【设备故障】现场确认燃油自控系统故障，已联系工程师检修',
    });
    expect(issues.filter((issue) => issue.code === 'vague')).toEqual([]);
  });

  it('does not treat an operation and recovery alone as proof of a device fault', () => {
    const issues = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '【设备故障】人员已去现场查看',
      confirmationDescription: '【设备故障】手动开启均充后，电池电压恢复正常，告警恢复',
    });
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vague', side: 'acceptance' }),
    ]));
  });

  it('reports each missing side independently for handled alarms', () => {
    const issues = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '',
      confirmationDescription: ' ',
    });
    expect(issues.map((issue) => [issue.code, issue.side])).toEqual([
      ['missing', 'acceptance'],
      ['missing', 'confirmation'],
    ]);
  });

  it('flags malformed or placeholder descriptions without treating the other side as a repair', () => {
    const issues = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '【维护 已处理 TODO',
      confirmationDescription: '【维护】现场正常',
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'format', side: 'acceptance' }),
    ]);
  });

  it('flags vague text when neither side describes a fault, but accepts a stated fault', () => {
    const bare = detectAlarmTagRuleIssues({
      processingStatus: '处理中',
      acceptanceDescription: '【设备故障】',
      confirmationDescription: '【设备故障】现场查看',
    });
    expect(
      bare.filter((issue) => issue.code === 'vague').map((issue) => issue.side),
    ).toEqual(['acceptance', 'confirmation']);
    const generic = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '【设备故障】设备故障产生的告警',
      confirmationDescription: '【设备故障】传感器失效，已联系厂家维修',
    });
    expect(generic.some((issue) => issue.code === 'vague')).toBe(false);
  });

  it('keeps nonofficial tags and repair suggestions separate for each side', () => {
    const issues = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '【设备检修】计划检修',
      confirmationDescription: '【通信故障】传输链路断开',
    });
    expect(issues.filter((issue) => issue.code === 'nonOfficial')).toEqual([
      expect.objectContaining({ side: 'acceptance', suggestedTag: '检修' }),
      expect.objectContaining({
        side: 'confirmation',
        suggestedTag: '通讯故障',
      }),
    ]);
  });

  it('marks the accepted repair versus confirmed change as pending review', () => {
    const issues = detectAlarmTagRuleIssues({
      processingStatus: '已处理',
      acceptanceDescription: '【检修】设备检修',
      confirmationDescription: '【变更】变更窗口测试',
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'pending', side: 'both' }),
    ]);
  });
});
