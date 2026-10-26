import { mapWeeklyMeeting, summarizeMeeting } from './meeting.mapper';

describe('属地周会源字段适配', () => {
  it('保留源日期和周次并正确解析飞书富文本及 Markdown 链接', () => {
    const item = mapWeeklyMeeting({
      record_id: 'recA',
      fields: {
        日期: Date.parse('2026-03-05T00:00:00+08:00'),
        第几周: [{ text: '2026年第10周-运维周报' }],
        链接: '[周报](https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE)',
        专业线: [{ text: '电气' }, { text: '\n更换电池' }],
        本周代办: '跟进供应商',
      },
    });
    expect(item).toMatchObject({
      id: 'recA',
      date: '2026-03-05',
      scope: '机房',
      nature: '管理类',
      documentUrl: 'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE',
    });
    expect(
      item.sections.find((section) => section.key === 'professional')?.content,
    ).toBe('电气\n更换电池');
    expect(
      item.sections.find((section) => section.key === 'current-actions')?.title,
    ).toBe('本周待办');
    expect(summarizeMeeting(item).hasActions).toBe(true);
  });

  it('同周不同记录独立保留，日期缺失不拿创建时间代替', () => {
    const fields = { 第几周: '2026年第11周-运维周报', 创建时间: Date.now() };
    const a = mapWeeklyMeeting({ record_id: 'recA', fields });
    const b = mapWeeklyMeeting({ record_id: 'recB', fields });
    expect(a.id).not.toBe(b.id);
    expect(a.weekLabel).toBe(b.weekLabel);
    expect(a.date).toBeNull();
    expect(a.sections).toEqual([]);
  });

  it.each([
    'javascript:alert(1)',
    'https://evil.test/report',
    'https://vnet.feishu.cn.evil.test/docx/x',
    'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE',
  ])('拒绝不安全文档链接 %s', (url) => {
    expect(
      mapWeeklyMeeting({ record_id: 'recA', fields: { 链接: url } })
        .documentUrl,
    ).toBeNull();
  });

  it('没有稳定记录 ID 时拒绝适配，不制造记录', () => {
    expect(() => mapWeeklyMeeting({ fields: {} })).toThrow('缺少记录 ID');
  });

  it('摘要不包含详细正文，空标题可读，数值不当作文本正文', () => {
    const item = mapWeeklyMeeting({
      record_id: 'recA',
      fields: { 专业线: 42, 运营线: '真实正文' },
    });
    expect(item.title).toBe('未命名周报');
    expect(item.sections).toHaveLength(1);
    expect(summarizeMeeting(item)).not.toHaveProperty('sections');
  });
});
