import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  EditMeetingAction,
  PreparedActionEdit,
} from '../../../shared/weekly-workspace.interface';
import { ACTION_MARKER, splitActions } from './meeting.actions';

const FIELDS: Record<string, string> = {
  'current-actions': '本周代办',
  'previous-actions': '上周周会待办',
  carryover: '上周遗留项',
  'customer-actions': '阿里会议待办',
};
export function validateActionEdit(command: EditMeetingAction) {
  if (
    !command ||
    !/^rec[A-Za-z0-9]{1,100}$/.test(command.targetRecordId || '') ||
    typeof command.content !== 'string' ||
    !command.content.trim() ||
    command.content.length > 10000 ||
    typeof command.expectedContent !== 'string' ||
    command.expectedContent.length > 100000
  )
    throw new BadRequestException('待办内容无效，最多10000字');
  const match = command.actionId?.match(/^([^:]+):([^:]+):(\d+)$/);
  const field = match && FIELDS[match[2]];
  if (!match || !field || match[1] !== command.targetRecordId)
    throw new BadRequestException('待办来源无效');
  const assignee = command.assignee;
  if (
    assignee &&
    (!['employee', 'custom', 'unassigned'].includes(assignee.kind) ||
      (assignee.kind !== 'unassigned' &&
        (typeof assignee.name !== 'string' ||
          !assignee.name.trim() ||
          assignee.name.length > 100 ||
          /[\s，,。；;（）()\r\n]/.test(assignee.name))) ||
      (assignee.kind === 'employee' &&
        !/^ou_[A-Za-z0-9]{10,100}$/.test(assignee.openId || '')))
  )
    throw new BadRequestException('请选择在职员工或填写有效的自定义人员');
  return { field, index: Number(match[3]) };
}
export function prepareActionEdit(
  command: EditMeetingAction,
  original: string,
): PreparedActionEdit {
  const { field, index } = validateActionEdit(command);
  const items = splitActions(original);
  const item = items[index];
  if (!item || item.content !== command.expectedContent)
    throw new ConflictException('待办已被修改，请重新打开核对；草稿已保留');
  let content = command.content.trim().replace(/\r\n/g, '\n');
  const assignee = command.assignee;
  if (assignee) {
    const name = assignee.kind === 'unassigned' ? '待明确' : assignee.name;
    const explicit =
      /((?:示例人员019|负责人|示例人员019员|责任部门)[:：]\s*)([^\s，,。；;（）()]+)/g;
    if (explicit.test(content))
      content = content.replace(explicit, (_all, label) => `${label}${name}`);
    else if (/由[\u4e00-\u9fa5]{2,4}负责/.test(content))
      content = content.replace(/由[\u4e00-\u9fa5]{2,4}负责/g, `由${name}负责`);
    else if (assignee.kind !== 'unassigned') content += `（示例人员019：${name}）`;
  }
  const lines = original.split(/\r?\n/);
  const prefix = lines[item.start].match(ACTION_MARKER)?.[0] || '';
  lines.splice(item.start, item.end - item.start + 1, `${prefix}${content}`);
  const desiredText = lines.join(original.includes('\r\n') ? '\r\n' : '\n');
  const next = splitActions(desiredText);
  if (
    next.length !== items.length ||
    next[index]?.content !== content ||
    next.some(
      (row, i) =>
        row.building !== items[i].building ||
        (i !== index && row.content !== items[i].content),
    )
  )
    throw new BadRequestException(
      '单项修改不能新增编号或楼栋标题，请使用整段待办编辑',
    );
  return {
    ...command,
    field,
    expectedText: original,
    desiredText,
    desiredContent: content,
  };
}
