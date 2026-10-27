import { HttpService } from '@nestjs/axios';
import { documentSections, WeeklyDocumentReader } from './meeting.document';
import { mapWeeklyMeeting } from './meeting.mapper';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
jest.mock('../../common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('qa-token'),
}));
const heading = (id: string, value: string) => ({
  block_id: id,
  block_type: 4,
  heading2: { elements: [{ text_run: { content: value } }] },
});
const line = (id: string, value: string) => ({
  block_id: id,
  block_type: 2,
  text: { elements: [{ text_run: { content: value } }] },
});
const blocks = [
  {
    block_id: 'docQA',
    block_type: 1,
    children: ['todo', 't1', 'management', 'm1', 'professional', 'p1'],
  },
  heading('todo', '上周内部周会待办'),
  line('t1', '1. 跟进维保'),
  heading('management', '管理线：'),
  line('m1', 'A楼：风险处置'),
  heading('professional', '专业线：'),
  line('p1', '电气维护'),
];
describe('原始周报缺失分区补读', () => {
  it('v3编号章节可下钻，待办不混入概况，专业线不混入运营线', () => {
    const mainHeading = (id: string, value: string) => ({
      block_id: id,
      block_type: 3,
      heading1: { elements: [{ text_run: { content: value } }] },
    });
    const children = [
      mainHeading('todos', '一、本周待办'),
      heading('ali', '1. 阿里周会待办'),
      line('a', '检查UPS（责任人：老马）'),
      heading('previous', '2. 上周内部周会待办'),
      line('p', '复核冷机'),
      mainHeading('content', '二、本周周会内容'),
      heading('overview', '整体概况'),
      line('summary', '本月演练完成率'),
      heading('management', '管理线'),
      line('m', 'A楼变更维护演练'),
      mainHeading('professional', '三、专业线'),
      heading('electric', '电气专业线'),
      line('e', '继承电气事项'),
      mainHeading('operations', '四、运营线'),
      heading('costs', '成本支出'),
      line('c', '继承成本事项'),
    ];
    const sections = documentSections(
      [
        {
          block_id: 'v3',
          block_type: 1,
          children: children.map((b) => b.block_id),
        },
        ...children,
      ],
      'v3',
    );
    expect(sections.map((section) => section.key)).toEqual([
      'customer-actions',
      'previous-actions',
      'management',
      'professional',
      'operations',
    ]);
    expect(sections[1].content).toBe('复核冷机');
    expect(sections[3].content).toContain('继承电气事项');
    expect(sections[3].content).not.toContain('成本');
    expect(sections[4].content).toContain('继承成本事项');
  });
  it('复选待办保留完成状态，按稳定人员 ID 回填姓名', () => {
    const content = documentSections(
      [
        { block_id: 'docQA', block_type: 1, children: ['todo', 'task'] },
        heading('todo', '上周内部周会待办'),
        {
          block_id: 'task',
          block_type: 17,
          todo: {
            elements: [
              { text_run: { content: '复核维保 ' } },
              { mention_user: { user_id: 'ou_qa' } },
            ],
            style: { done: true },
          },
        },
      ],
      'docQA',
      new Map([['ou_qa', '验收人员']]),
    );
    expect(content[0].content).toBe('☑ 已完成 · 复核维保 @验收人员');
  });
  it('按文档层级顺序提取，不混入相邻专业线', () => {
    expect(
      documentSections([blocks[0], ...blocks.slice(1).reverse()], 'docQA'),
    ).toEqual([
      {
        key: 'previous-actions',
        title: '上周周会待办',
        content: '1. 跟进维保',
        isAction: true,
        origin: 'document',
      },
      {
        key: 'management',
        title: '管理线',
        content: 'A楼：风险处置',
        isAction: false,
        origin: 'document',
      },
      {
        key: 'professional',
        title: '专业线',
        content: '电气维护',
        isAction: false,
        origin: 'document',
      },
    ]);
  });
  it('缺失子块或重复引用拒绝形成不完整正文', () => {
    expect(() => documentSections(blocks.slice(0, -1), 'docQA')).toThrow(
      '不完整',
    );
    expect(() =>
      documentSections(
        [{ ...blocks[0], children: ['todo', 'todo'] }, blocks[1]],
        'docQA',
      ),
    ).toThrow('重复');
  });
  it('初次立即返回，合并并发补读，恢复旧接口丢失的链接', async () => {
    const request = jest.fn(async (options) =>
      options.method === 'POST'
        ? {
            data: {
              code: 0,
              data: {
                record_id_list: ['recQA'],
                fields: ['链接'],
                data: [['[原文](https://vnet.feishu.cn/docx/docQA)']],
              },
            },
          }
        : { data: { code: 0, data: { items: blocks, has_more: false } } },
    );
    const reader = new WeeklyDocumentReader(
      { axiosRef: { request } } as unknown as HttpService,
      { appToken: 'baseQA', tableId: 'tableQA' },
    );
    const meeting = mapWeeklyMeeting({
      record_id: 'recQA',
      fields: { 专业线: '已归档专业线' },
    });
    const first = reader.get(meeting);
    expect(first.state).toBe('loading');
    expect(reader.get(meeting)).toBe(first);
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.state).toBe('ready');
    expect(first.url).toBe('https://vnet.feishu.cn/docx/docQA');
    expect(first.sections).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(2);
    expect(getTenantAccessToken).toHaveBeenCalled();
  });
  it('分页重复或外部失败可见终态，不返回部分内容', async () => {
    const request = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: { items: [], has_more: true, page_token: 'same' },
      },
    });
    const reader = new WeeklyDocumentReader(
      { axiosRef: { request } } as unknown as HttpService,
      { appToken: 'baseQA', tableId: 'tableQA' },
    );
    const meeting = mapWeeklyMeeting({
      record_id: 'recQA',
      fields: { 链接: 'https://vnet.feishu.cn/docx/docQA' },
    });
    const result = reader.get(meeting);
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.state).toBe('error');
    expect(result.sections).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
