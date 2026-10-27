import {
  validateWeeklyMeeting,
  weeklyTodoText,
} from '../../shared/weekly-workspace.rules';
import type { WeeklyMeetingInput } from '../../shared/weekly-workspace.interface';
const input: WeeklyMeetingInput = {
  targetRecordId: 'recExample',
  kind: 'ali',
  plannedDate: '2026-10-07',
  actualDate: '2026-10-07',
  status: 'held',
  note: '',
  todos: [],
  rawText: 'A楼：\n1. 第一条\n  补充内容\n\n2. 第二条（责任人：张三）',
};
describe('整段会议待办', () => {
  it('原文编号、空行、缩进保持，不自动按句拆分', () => {
    expect(validateWeeklyMeeting(input)).toBeNull();
    expect(weeklyTodoText(input)).toBe(input.rawText);
  });
  it('整段与逐项不能同时提交，超长拒绝', () => {
    expect(
      validateWeeklyMeeting({ ...input, rawText: 'a'.repeat(100001) }),
    ).toContain('100000');
    expect(
      validateWeeklyMeeting({
        ...input,
        todos: [
          {
            id: 'test',
            content: 'test',
            ownerOpenId: '',
            ownerName: '',
            dueDate: '',
            status: 'pending',
          },
        ],
      }),
    ).toContain('不能同时');
  });
  it('旧版逐项待办格式保持兼容', () => {
    const legacy = {
      ...input,
      rawText: undefined,
      todos: [
        {
          id: 'test',
          content: '检查',
          ownerOpenId: '',
          ownerName: '',
          dueDate: '',
          status: 'pending' as const,
        },
      ],
    };
    expect(validateWeeklyMeeting(legacy)).toBeNull();
    expect(weeklyTodoText(legacy)).toBe(
      '1. 检查（责任人：待明确；截止：未设置；状态：待办）',
    );
  });
});
