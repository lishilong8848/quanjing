import type {
  WeeklyMeetingInput,
  WeeklyMeetingKind,
} from './weekly-workspace.interface';
import type { MeetingSection } from './meeting-management.interface';

export const WEEKLY_EMPTY_TODOS_MESSAGE =
  '阿里和属地周会待办均为空，请先填写，或确认本期无待办后生成';
export function weeklyTodosEmpty(sections: MeetingSection[]): boolean {
  return !sections.some(
    (section) =>
      ['customer-actions', 'previous-actions'].includes(section.key) &&
      section.origin !== 'document' &&
      Boolean(section.content.trim()),
  );
}

export function nextMonthWeeklyPeriods(today: string) {
  const first = new Date(`${today}T00:00:00Z`);
  first.setUTCDate(1);
  first.setUTCMonth(first.getUTCMonth() + 1);
  const month = first.getUTCMonth();
  first.setUTCDate(1 + ((4 - first.getUTCDay() + 7) % 7));
  const periods: ReturnType<typeof weeklyPeriod>[] = [];
  while (first.getUTCMonth() === month) {
    periods.push(weeklyPeriod(first.toISOString().slice(0, 10)));
    first.setUTCDate(first.getUTCDate() + 7);
  }
  return periods;
}

export const WEEKLY_TODO_FIELDS: Record<WeeklyMeetingKind, string> = {
  ali: '阿里会议待办',
  local: '上周周会待办',
};
export function validWeeklyDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function weeklyPeriod(today: string): {
  startDate: string;
  endDate: string;
} {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 4) % 7));
  const endDate = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() - 6);
  return { startDate: date.toISOString().slice(0, 10), endDate };
}
export function weeklyTodoText(meeting: WeeklyMeetingInput): string {
  if (meeting.rawText !== undefined) return meeting.rawText;
  return meeting.todos
    .map(
      (todo, i) =>
        `${i + 1}. ${todo.content}（责任人：${todo.ownerName || '待明确'}；截止：${todo.dueDate || '未设置'}；状态：${todo.status === 'done' ? '已完成' : '待办'}）`,
    )
    .join('\n');
}
export function validateWeeklyMeeting(
  value: WeeklyMeetingInput,
): string | null {
  if (!value || !/^rec[A-Za-z0-9]{1,100}$/.test(value.targetRecordId || ''))
    return '请选择目标周报';
  if (!['ali', 'local'].includes(value.kind)) return '会议类型无效';
  if (!['planned', 'held', 'postponed', 'cancelled'].includes(value.status))
    return '会议状态无效';
  if (!validWeeklyDate(value.plannedDate)) return '计划会议日期无效';
  if (
    typeof value.actualDate !== 'string' ||
    (value.actualDate && !validWeeklyDate(value.actualDate))
  )
    return '实际或调整日期无效';
  if (['held', 'postponed'].includes(value.status) && !value.actualDate)
    return '请填写实际或调整日期';
  if (typeof value.note !== 'string' || value.note.length > 2000)
    return '备注不能超过2000字';
  if (['cancelled', 'postponed'].includes(value.status) && !value.note.trim())
    return '请填写取消或延期原因';
  if (!Array.isArray(value.todos) || value.todos.length > 100)
    return '待办最多100项';
  if (
    value.rawText !== undefined &&
    (typeof value.rawText !== 'string' || value.rawText.length > 100000)
  )
    return '整段待办最多100000字';
  if (value.rawText !== undefined && value.todos.length)
    return '整段待办与逐项待办不能同时提交';
  const ids = new Set<string>();
  for (const todo of value.todos) {
    if (
      !todo ||
      typeof todo.id !== 'string' ||
      !/^[A-Za-z0-9-]{1,80}$/.test(todo.id) ||
      ids.has(todo.id)
    )
      return '待办编号无效或重复';
    ids.add(todo.id);
    if (
      typeof todo.content !== 'string' ||
      !todo.content.trim() ||
      todo.content.length > 2000
    )
      return '请填写事宜，最多2000字';
    if (
      typeof todo.ownerOpenId !== 'string' ||
      (todo.ownerOpenId && !/^ou_[A-Za-z0-9]{10,100}$/.test(todo.ownerOpenId))
    )
      return '责任人标识无效';
    if (
      typeof todo.ownerName !== 'string' ||
      todo.ownerName.length > 100 ||
      Boolean(todo.ownerName) !== Boolean(todo.ownerOpenId)
    )
      return '请从人员列表选择责任人';
    if (
      typeof todo.dueDate !== 'string' ||
      (todo.dueDate && !validWeeklyDate(todo.dueDate))
    )
      return '待办截止日期无效';
    if (!['pending', 'done'].includes(todo.status)) return '待办状态无效';
  }
  if (value.status !== 'held' && value.todos.length)
    return '未召开、延期或取消的会议不能新增待办；请先保留原待办再调整状态';
  return null;
}
