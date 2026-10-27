import {
  buildAliMonthlyReportAutomationCard,
  buildAliMonthlyReportManualSuccessCard,
} from '../../server/modules/ali-monthly-report/ali-monthly-report-feishu';

function visibleText(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(visibleText);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    if (key === 'content' && typeof child === 'string') {
      return [child];
    }
    return visibleText(child);
  });
}

describe('阿里月报飞书互动卡片', () => {
  it('构造手动上传成功卡片并用按钮打开资料管理记录', () => {
    const recordUrl =
      'https://vnet.feishu.cn/base/MliKbC3fXa8PXrsndKscmxjdn1g?table=tbl3KED5CdvNSCwT&view=vewrHJHl3v&recordId=rec_test';
    const card = buildAliMonthlyReportManualSuccessCard({
      year: 2026,
      month: 7,
      reportTypeLabel: '月度告警分析',
      fileName: 'EA118机房2026年7月告警分析表.xlsx',
      recordUrl,
      completedAt: '2026-08-03 13:13',
    });

    expect(card).toMatchObject({
      schema: '2.0',
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '阿里月报上传成功' },
      },
    });
    expect(card.body.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'markdown',
          content: expect.stringContaining('统计月份：2026年7月'),
        }),
        expect.objectContaining({
          tag: 'button',
          text: { tag: 'plain_text', content: '打开多维表记录' },
          behaviors: [{ type: 'open_url', default_url: recordUrl }],
        }),
      ]),
    );
    expect(visibleText(card).join('\n')).toContain('月度告警分析');
    expect(visibleText(card).join('\n')).toContain(
      'EA118机房2026年7月告警分析表.xlsx',
    );
    expect(visibleText(card).join('\n')).not.toContain('https://');
  });

  it.each([
    'https://vnet.feishu.cn/base/base_token',
    'https://vnet.feishu.cn/base/base_token?table=tbl_test',
    'https://vnet.feishu.cn/base/base_token?recordId=rec_test',
  ])('拒绝未指向具体多维表记录的地址：%s', (recordUrl) => {
    expect(() =>
      buildAliMonthlyReportManualSuccessCard({
        year: 2026,
        month: 7,
        reportTypeLabel: '月度告警分析',
        fileName: '告警分析.xlsx',
        recordUrl,
      }),
    ).toThrow(/多维表记录地址/);
  });

  it('构造三项全部成功的自动任务卡片并提供三个记录按钮', () => {
    const urls = {
      alarm:
        'https://vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
      power:
        'https://vnet.feishu.cn/base/base_power?table=tbl_power&recordId=rec_power',
      staff:
        'https://vnet.feishu.cn/base/base_staff?table=tbl_staff&recordId=rec_staff',
    };
    const card = buildAliMonthlyReportAutomationCard({
      year: 2026,
      month: 7,
      scheduledAt: '2026-08-03 09:00',
      durationMs: 402_000,
      taskId: 'AMR-202607-202608030900',
      items: [
        {
          type: 'alarm_analysis',
          status: 'success',
          fileName: 'EA118机房2026年7月告警分析表.xlsx',
          recordUrl: urls.alarm,
        },
        {
          type: 'over_power',
          status: 'success',
          fileName: 'EA118机柜超功耗告警统计7月份.xlsx',
          recordUrl: urls.power,
        },
        {
          type: 'staff_roster',
          status: 'success',
          fileName: '南通机房2026年7月人员变动.xlsx',
          recordUrl: urls.staff,
        },
      ],
    });

    expect(card.header).toEqual({
      template: 'green',
      title: { tag: 'plain_text', content: '阿里月报自动任务｜全部成功' },
    });
    const text = visibleText(card).join('\n');
    expect(text).toContain('统计月份：2026年7月');
    expect(text).toContain('计划时间：2026-08-03 09:00');
    expect(text).toContain('执行结果：3/3 成功');
    expect(text).toContain('总耗时：06分42秒');
    expect(text).toContain('✅ 告警分析｜已上传');
    expect(text).toContain('✅ 超功率｜已上传');
    expect(text).toContain('✅ 人员变动｜已上传');
    expect(text).toContain('任务编号：AMR-202607-202608030900');
    expect(text).not.toContain('https://');

    const buttons = card.body.elements.filter(
      (element) => element.tag === 'button',
    );
    expect(buttons).toHaveLength(3);
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: { tag: 'plain_text', content: '打开告警分析记录' },
          behaviors: [{ type: 'open_url', default_url: urls.alarm }],
        }),
        expect.objectContaining({
          text: { tag: 'plain_text', content: '打开超功率记录' },
          behaviors: [{ type: 'open_url', default_url: urls.power }],
        }),
        expect.objectContaining({
          text: { tag: 'plain_text', content: '打开人员变动记录' },
          behaviors: [{ type: 'open_url', default_url: urls.staff }],
        }),
      ]),
    );
  });

  it('构造部分失败卡片并只为成功项提供记录按钮', () => {
    const card = buildAliMonthlyReportAutomationCard({
      year: 2026,
      month: 7,
      scheduledAt: '2026-08-03 09:00',
      durationMs: 90_000,
      taskId: 'AMR-202607-202608030900',
      items: [
        {
          type: 'alarm_analysis',
          status: 'success',
          fileName: '告警分析.xlsx',
          recordUrl:
            'https://vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
        },
        {
          type: 'over_power',
          status: 'success',
          fileName: '超功率.xlsx',
          recordUrl:
            'https://vnet.feishu.cn/base/base_power?table=tbl_power&recordId=rec_power',
        },
        {
          type: 'staff_roster',
          status: 'failed',
          failureStage: '资料管理多维表上传',
          failureReason: '目标字段不可写',
        },
      ],
    });

    expect(card.header).toEqual({
      template: 'yellow',
      title: { tag: 'plain_text', content: '阿里月报自动任务｜部分失败' },
    });
    const text = visibleText(card).join('\n');
    expect(text).toContain('执行结果：2/3 成功，1项失败');
    expect(text).toContain('❌ 人员变动｜上传失败');
    expect(text).toContain('失败阶段：资料管理多维表上传');
    expect(text).toContain('失败原因：目标字段不可写');
    expect(text).toContain('任务编号：AMR-202607-202608030900');
    expect(text).not.toContain('https://');

    const buttons = card.body.elements.filter(
      (element) => element.tag === 'button',
    );
    expect(buttons).toHaveLength(2);
    expect(visibleText(buttons).join('\n')).not.toContain('人员变动');
  });

  it('构造三项全部失败的红色卡片且不生成记录按钮', () => {
    const card = buildAliMonthlyReportAutomationCard({
      year: 2026,
      month: 7,
      scheduledAt: '2026-08-03 09:00',
      durationMs: 12_000,
      taskId: 'AMR-202607-202608030900',
      items: [
        {
          type: 'alarm_analysis',
          status: 'failed',
          failureStage: '依赖检查',
          failureReason: 'Python 运行环境未就绪',
        },
        {
          type: 'over_power',
          status: 'failed',
          failureStage: '依赖检查',
          failureReason: 'Python 运行环境未就绪',
        },
        {
          type: 'staff_roster',
          status: 'failed',
          failureStage: '依赖检查',
          failureReason: 'Python 运行环境未就绪',
        },
      ],
    });

    expect(card.header).toEqual({
      template: 'red',
      title: { tag: 'plain_text', content: '阿里月报自动任务｜执行失败' },
    });
    const text = visibleText(card).join('\n');
    expect(text).toContain('执行结果：0/3 成功，3项失败');
    expect(text).toContain('❌ 告警分析｜执行失败');
    expect(text).toContain('❌ 超功率｜执行失败');
    expect(text).toContain('❌ 人员变动｜执行失败');
    expect(text).toContain('失败阶段：依赖检查');
    expect(text).toContain('失败原因：Python 运行环境未就绪');
    expect(text).toContain('任务编号：AMR-202607-202608030900');
    expect(
      card.body.elements.filter((element) => element.tag === 'button'),
    ).toHaveLength(0);
  });

  it('转义动态文本中的飞书 Markdown 链接和格式控制字符', () => {
    const card = buildAliMonthlyReportManualSuccessCard({
      year: 2026,
      month: 7,
      reportTypeLabel: '告警[伪造入口](https://evil.example)',
      fileName: '**伪造加粗**.xlsx',
      recordUrl:
        'https://vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
      completedAt: '`2026-08-03 13:13`',
    });

    const text = visibleText(card).join('\n');
    expect(text).not.toContain('[伪造入口](');
    expect(text).not.toContain('**伪造加粗**');
    expect(text).not.toContain('`2026-08-03 13:13`');
    expect(text).not.toContain('https://');
    expect(text).toContain('&#91;伪造入口&#93;');
  });

  it.each([
    'http://vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
    'https://evil.example/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
    'https://vnet.feishu.cn.evil.example/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
    'https://user:password@vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_alarm',
    'https://vnet.feishu.cn/wiki/base_alarm?table=tbl_alarm&recordId=rec_alarm',
    'https://vnet.feishu.cn/base/***?table=tbl_alarm&recordId=rec_alarm',
    'https://vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_alarm#fragment',
    'https://vnet.feishu.cn/base/base_alarm?table=tbl_one&table=tbl_two&recordId=rec_alarm',
    'https://vnet.feishu.cn/base/base_alarm?table=tbl_alarm&recordId=rec_one&recordId=rec_two',
  ])('拒绝非白名单或含歧义参数的多维表地址：%s', (recordUrl) => {
    expect(() =>
      buildAliMonthlyReportManualSuccessCard({
        year: 2026,
        month: 7,
        reportTypeLabel: '月度告警分析',
        fileName: '告警分析.xlsx',
        recordUrl,
      }),
    ).toThrow(/多维表记录地址/);
  });

  it('把超长失败原因缩短到 160 个字符以内', () => {
    const longReason = '服务器返回异常'.repeat(40);
    const card = buildAliMonthlyReportAutomationCard({
      year: 2026,
      month: 7,
      scheduledAt: '2026-08-03 09:00',
      durationMs: 12_000,
      taskId: 'AMR-202607-202608030900',
      items: [
        {
          type: 'alarm_analysis',
          status: 'failed',
          failureReason: longReason,
        },
        {
          type: 'over_power',
          status: 'failed',
          failureReason: '依赖未就绪',
        },
        {
          type: 'staff_roster',
          status: 'failed',
          failureReason: '依赖未就绪',
        },
      ],
    });

    const reasonLine = visibleText(card)
      .join('\n')
      .split('\n')
      .find((line) => line.startsWith('失败原因：服务器返回异常'));
    expect(reasonLine).toBeDefined();
    expect(
      Array.from(reasonLine?.replace('失败原因：', '') || ''),
    ).toHaveLength(160);
    expect(reasonLine?.endsWith('…')).toBe(true);
    expect(reasonLine).not.toContain(longReason);
  });

  it.each([
    [
      '计划时间',
      {
        scheduledAt: '2026-08-03 [伪造](https://evil.example)',
        taskId: 'AMR-202607-202608030900',
      },
    ],
    [
      '任务编号',
      {
        scheduledAt: '2026-08-03 09:00',
        taskId: 'AMR-[伪造](https://evil.example)',
      },
    ],
  ])('拒绝含可执行格式的%s', (_name, overrides) => {
    expect(() =>
      buildAliMonthlyReportAutomationCard({
        year: 2026,
        month: 7,
        scheduledAt: overrides.scheduledAt,
        durationMs: 12_000,
        taskId: overrides.taskId,
        items: [
          {
            type: 'alarm_analysis',
            status: 'failed',
            failureReason: '依赖未就绪',
          },
          {
            type: 'over_power',
            status: 'failed',
            failureReason: '依赖未就绪',
          },
          {
            type: 'staff_roster',
            status: 'failed',
            failureReason: '依赖未就绪',
          },
        ],
      }),
    ).toThrow(new RegExp(_name));
  });
});
