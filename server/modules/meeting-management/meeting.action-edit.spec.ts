import { prepareActionEdit } from './meeting.action-edit';
import type { EditMeetingAction } from '../../../shared/weekly-workspace.interface';
const original =
  'A楼：\n1）检查液位\n与唐工确认\n\n2. 相邻事项\nB楼：\n1. 更换电池';
const input: EditMeetingAction = {
  clientMutationId: 'edit-12345678',
  targetRecordId: 'recExample',
  actionId: 'recExample:current-actions:0',
  expectedContent: '检查液位\n与唐工确认',
  content: '检查液位并调整\n与唐工确认',
};
describe('单项待办修改', () => {
  it('只修改复选框段落，保留其他段落、复选框和空行', () => {
    const text = '☐ 接油盘采购\n☐ 工具研发\n\n独立事项';
    expect(
      prepareActionEdit(
        {
          ...input,
          actionId: 'recExample:current-actions:1',
          expectedContent: '工具研发',
          content: '工具研发并测试',
        },
        text,
      ).desiredText,
    ).toBe('☐ 接油盘采购\n☐ 工具研发并测试\n\n独立事项');
  });
  it('只替换目标，保留编号、楼栋、空行及相邻事项', () => {
    const result = prepareActionEdit(input, original);
    expect(result.field).toBe('本周代办');
    expect(result.desiredText).toBe(
      original.replace('检查液位', '检查液位并调整'),
    );
  });
  it('原文已改变或行序改变拒绝覆盖', () => {
    expect(() =>
      prepareActionEdit(input, original.replace('检查液位', '已检查液位')),
    ).toThrow('已被修改');
    expect(() =>
      prepareActionEdit(
        { ...input, actionId: 'recExample:current-actions:1' },
        original,
      ),
    ).toThrow('已被修改');
  });
  it('选择员工使用稳定身份，正文只写姓名', () => {
    const assignee = {
      kind: 'employee' as const,
      name: '马进宇',
      openId: 'ou_12345678901',
    };
    const result = prepareActionEdit({ ...input, assignee }, original);
    expect(result.assignee).toEqual(assignee);
    expect(result.desiredText).toContain('责任人：马进宇');
    expect(result.desiredText).not.toContain('ou_');
  });
  it('自定义身份独立，替换责任人保留截止与状态', () => {
    const text = '1. 检查（责任人：张三；截止：2026-10-10；状态：待办）';
    const result = prepareActionEdit(
      {
        ...input,
        expectedContent: text.slice(3),
        content: text.slice(3),
        assignee: { kind: 'custom', name: '唐工' },
      },
      text,
    );
    expect(result.desiredText).toBe(text.replace('张三', '唐工'));
  });
  it('清除责任人且保留句子', () => {
    const text = '1. 由张三负责调整';
    expect(
      prepareActionEdit(
        {
          ...input,
          expectedContent: '由张三负责调整',
          content: '由张三负责调整',
          assignee: { kind: 'unassigned' },
        },
        text,
      ).desiredText,
    ).toBe('1. 由待明确负责调整');
  });
  it('不能把多条事项或楼栋标题塞进单项编辑', () => {
    for (const content of ['检查\n2. 其他事项', '检查\nC楼：\n调整'])
      expect(() => prepareActionEdit({ ...input, content }, original)).toThrow(
        '单项修改',
      );
  });
  it('非法字段、空内容、伪造员工标识拒绝', () => {
    expect(() =>
      prepareActionEdit(
        { ...input, actionId: 'recExample:professional:0' },
        original,
      ),
    ).toThrow('来源无效');
    expect(() =>
      prepareActionEdit({ ...input, content: '' }, original),
    ).toThrow('内容无效');
    expect(() =>
      prepareActionEdit(
        {
          ...input,
          assignee: { kind: 'employee', name: '马进宇', openId: '马进宇' },
        },
        original,
      ),
    ).toThrow('有效的');
  });
});
