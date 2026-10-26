import {
  ArrowUpRight,
  CalendarClock,
  FilePlus2,
  ListTodo,
  Plus,
  ClipboardList,
} from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type { MeetingSummary } from '../../../../shared/meeting-management.interface';
import type { WeeklyWorkspace } from '../../../../shared/weekly-workspace.interface';
import './weekly-workbench.css';

export function WeeklyWorkbenchControls({
  records,
  record,
  selected,
  blockReason,
  data,
  onSelect,
  onOpen,
  onAction,
}: {
  records: MeetingSummary[];
  record?: MeetingSummary;
  selected: string;
  blockReason: string;
  data: WeeklyWorkspace | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onAction: (action: 'ali' | 'local' | 'generate' | 'create-row') => void;
}) {
  const { role } = useAccess();
  const editable = role === 'admin' || role === 'editor' || (role === 'professional_admin' || role === 'professional_engineer');
  const blocked = Boolean(blockReason);
  const writeReason = !editable ? '当前角色仅可读取' : !data
    ? '正在读取周会状态'
    : data.writeAccess?.enabled === false
      ? data.writeAccess.message || '当前为只读预览，无法提交'
      : '';
  const todoReason =
    writeReason ||
    (blocked
      ? blockReason
      : !record || record.id === 'new'
        ? '请先选择已有周报，或新建条目'
        : '');
  const generateReason =
    writeReason ||
    (blocked
      ? blockReason
      : !record?.date || record.id === 'new'
        ? '请先新建条目，再选择已有条目生成周报'
        : !data
          ? '正在读取生成状态'
          : !data.runtime.ready
            ? data.runtime.message || '周报生成暂不可用'
            : '');
  const commonReason =
    writeReason ||
    (blocked
      ? todoReason
      : !record
        ? '请选择目标周报，或新建条目'
        : record.id === 'new'
          ? '新建条目后即可填写会议待办'
          : '');
  return (
    <>
      <div className="weekly-console-heading">
        <h2>
          <CalendarClock />
          周报工作台
        </h2>
        {data?.writeAccess && (
          <Badge variant={data.writeAccess.enabled ? 'secondary' : 'outline'}>
            {data.writeAccess.enabled ? '飞书同步已连接' : '只读预览'}
          </Badge>
        )}
      </div>
      <div className="weekly-console-target">
        <label>
          <span>目标周报</span>
          <NativeSelect
            aria-label="目标周报"
            value={selected}
            onChange={(event) => onSelect(event.target.value)}
          >
            <NativeSelectOption value="">选择目标周报</NativeSelectOption>
            <NativeSelectOption value="new">新建周报条目</NativeSelectOption>
            {records.map((item, index) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.date} · {item.title} · 记录{index + 1}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <div className="weekly-console-target-actions">
          {record &&
            record.id !== 'new' &&
            !record.id.startsWith('pending:') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpen(record.id)}
              >
                查看内容
                <ArrowUpRight />
              </Button>
            )}
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(writeReason)}
            onClick={() => onAction('create-row')}
          >
            <Plus />
            新建条目
          </Button>
        </div>
      </div>
      <div className="weekly-console-actions">
        {(
          [
            {
              key: 'ali',
              title: '阿里待办',
              detail: '待办内容 · 示例人员019 · 附件',
              Icon: ListTodo,
              reason: todoReason,
            },
            {
              key: 'local',
              title: '属地周会待办',
              detail: '待办内容 · 示例人员019 · 附件',
              Icon: ClipboardList,
              reason: todoReason,
            },
            {
              key: 'generate',
              title: '生成周报',
              detail: '调整起止周期 · 生成内容',
              Icon: FilePlus2,
              reason: generateReason,
            },
          ] as const
        ).map((action) => (
          <div
            key={action.key}
            className={`weekly-console-action weekly-console-${action.key}`}
          >
            <Button
              variant="outline"
              aria-label={action.title}
              aria-describedby={
                action.reason
                  ? commonReason &&
                    (action.key !== 'generate' || blocked || !record?.date)
                    ? 'weekly-console-notice'
                    : `weekly-console-${action.key}-reason`
                  : undefined
              }
              disabled={Boolean(action.reason)}
              onClick={() => onAction(action.key)}
            >
              <span className="weekly-console-icon">
                <action.Icon />
              </span>
              <span className="weekly-console-action-text">
                <strong>{action.title}</strong>
                <small>{action.detail}</small>
              </span>
              <ArrowUpRight className="weekly-console-arrow" />
            </Button>
            {action.reason &&
              (!commonReason ||
                (action.key === 'generate' && !blocked && record?.date)) && (
                <span
                  id={`weekly-console-${action.key}-reason`}
                  className="weekly-console-reason"
                >
                  {action.reason}
                </span>
              )}
          </div>
        ))}
      </div>
      {commonReason && (
        <p
          id="weekly-console-notice"
          className="weekly-console-notice"
          role="status"
        >
          {commonReason}
        </p>
      )}
      {data && (
        <p className="weekly-muted">
          定时新建：
          {data.creationSchedule?.enabled
            ? '每月最后一天 02:00 预建下月条目'
            : '未开启'}
          {' · '}定时生成：{data.schedule.enabled ? '每周四 08:30' : '未开启'}
        </p>
      )}
      {data?.creationSchedule?.message && (
        <p role="alert" className="weekly-error">
          {data.creationSchedule.message}
        </p>
      )}
    </>
  );
}
