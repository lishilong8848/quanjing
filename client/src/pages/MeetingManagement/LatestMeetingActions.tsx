import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ClipboardList, UserRound, Pencil } from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type {
  MeetingLatestActions,
  MeetingAction,
} from '../../../../shared/meeting-management.interface';
import type { WeeklyJob } from '../../../../shared/weekly-workspace.interface';
import { MeetingActionEditDialog } from './MeetingActionEditDialog';
import { useActionEditSync } from './use-action-edit-sync';
import './meeting-action-edit.css';

export function LatestMeetingActions({
  data,
  loading,
  onOpenRecord,
  onSynced,
  onDeferred,
}: {
  data: MeetingLatestActions | null | undefined;
  loading: boolean;
  onOpenRecord: (id: string) => void;
  onSynced: (job: WeeklyJob) => void;
  onDeferred: (job: WeeklyJob) => void;
}) {
  const { role, principalFingerprint } = useAccess();
  const editable = (role === 'admin' || (role === 'professional_admin' || role === 'professional_engineer')) || role === 'editor';
  const [editing, setEditing] = useState<MeetingAction | null>(null);
  const { sync, tasks } = useActionEditSync(principalFingerprint || role);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const task of tasks) {
      if (
        task.job &&
        ['success', 'error'].includes(task.phase) &&
        !seen.current.has(task.job.id + task.phase)
      ) {
        seen.current.add(task.job.id + task.phase);
        onDeferred(task.job);
        if (task.phase === 'success') onSynced(task.job);
      }
      if (task.phase === 'success') {
        const actual = data?.items.find((item) => item.id === task.item.id);
        if (
          actual?.content ===
          (task.job?.actionResult?.content || task.command.content)
        )
          sync.acknowledge(task.command.clientMutationId);
      }
    }
  }, [tasks, sync, data, onSynced, onDeferred]);
  const overrides = useMemo(
    () =>
      Object.fromEntries(
        tasks.map((task) => {
          const owner =
            task.job?.actionResult?.assignee || task.command.assignee;
          return [
            task.item.id,
            task.phase === 'error'
              ? { pending: false, error: task.error, task }
              : {
                  content:
                    task.job?.actionResult?.content || task.command.content,
                  responsible:
                    owner?.kind === 'unassigned'
                      ? null
                      : owner && 'name' in owner
                        ? owner.name
                        : task.item.responsible,
                  ...(owner ? { assignee: owner } : {}),
                  pending: task.phase !== 'success',
                  task,
                },
          ];
        }),
      ),
    [tasks],
  );
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const unassigned =
    data?.items.filter(
      (item) => !{ ...item, ...overrides[item.id] }.responsible,
    ).length || 0;
  const rows = useMemo(
    () =>
      data?.items
        .map((item) => ({ ...item, ...overrides[item.id] }))
        .filter((item) => !onlyUnassigned || !item.responsible) || [],
    [data, onlyUnassigned, overrides],
  );
  return (
    <Card className="meeting-latest-actions">
      <div className="meeting-actions-heading">
        <div>
          <span className="meeting-actions-heading-icon">
            <ClipboardList />
          </span>
          <h2>最新收录待办</h2>
          <Badge variant="secondary">真实数据</Badge>
        </div>
        <span>
          {data
            ? `${data.items.length} 项 · ${data.date || '日期未填写'}`
            : loading
              ? '正在读取'
              : '暂无收录'}
        </span>
      </div>
      {data && (
        <div className="meeting-actions-toolbar">
          <div>
            <Button
              size="sm"
              variant={!onlyUnassigned ? 'default' : 'ghost'}
              aria-pressed={!onlyUnassigned}
              onClick={() => setOnlyUnassigned(false)}
            >
              全部事宜 {data.items.length}
            </Button>
            <Button
              size="sm"
              variant={onlyUnassigned ? 'default' : 'ghost'}
              aria-pressed={onlyUnassigned}
              onClick={() => setOnlyUnassigned(true)}
            >
              示例人员019未注明 {unassigned}
            </Button>
          </div>
          {data.newestReportDate !== data.date && (
            <p>最新周报未填写待办，当前展示最近有事项的周报。</p>
          )}
        </div>
      )}
      {loading && !data ? (
        <div className="meeting-empty" role="status">
          正在读取最新待办…
        </div>
      ) : !data ? (
        <div className="meeting-empty">周报尚未收录有效待办</div>
      ) : (
        <>
          <div className="meeting-action-labels" aria-hidden="true">
            <span>事宜</span>
            <span>示例人员019员</span>
            <span>来源</span>
          </div>
          <ol className="meeting-action-list">
            {rows.map((item, index) => (
              <li key={item.id}>
                <span className="meeting-action-number">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="meeting-action-subject">
                  <div
                    className={
                      expanded.has(item.id)
                        ? 'meeting-action-text'
                        : 'meeting-action-text meeting-action-clamped'
                    }
                  >
                    {item.content}
                  </div>
                  <div className="meeting-action-tags">
                    {editable && (
                      <button
                        disabled={overrides[item.id]?.pending}
                        onClick={() => setEditing(item)}
                        aria-label={`修改待办${index + 1}`}
                      >
                        <Pencil /> 修改
                      </button>
                    )}
                    {overrides[item.id]?.pending && (
                      <span role="status">
                        {overrides[item.id]?.task.phase === 'waiting'
                          ? '后台处理中'
                          : '同步中'}
                      </span>
                    )}
                    {overrides[item.id]?.task.phase === 'success' && (
                      <span role="status">已同步</span>
                    )}
                    {overrides[item.id]?.error && (
                      <span role="alert">
                        同步失败：{overrides[item.id].error}
                      </span>
                    )}
                    {['error', 'waiting'].includes(
                      overrides[item.id]?.task.phase || '',
                    ) && (
                      <button
                        onClick={() => sync.resume(overrides[item.id].task)}
                      >
                        {overrides[item.id]?.task.phase === 'waiting'
                          ? '查看结果'
                          : '重试同步'}
                      </button>
                    )}
                    <Badge variant="outline">{item.sectionTitle}</Badge>
                    {item.buildings.map((building) => (
                      <Badge key={building} variant="secondary">
                        {building}
                      </Badge>
                    ))}
                    {item.dueText && (
                      <span className="meeting-action-due">
                        截止 {item.dueText}
                      </span>
                    )}
                    {(item.content.length > 100 ||
                      item.content.includes('\n')) && (
                      <button
                        aria-expanded={expanded.has(item.id)}
                        onClick={() =>
                          setExpanded((previous) => {
                            const next = new Set(previous);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                      >
                        {expanded.has(item.id) ? '收起' : '展开'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="meeting-action-person">
                  <strong
                    className={
                      item.responsible
                        ? 'meeting-action-owner'
                        : 'meeting-action-unassigned'
                    }
                  >
                    <UserRound />
                    {item.responsible || '未注明示例人员019'}
                    {editable && (
                      <button
                        disabled={overrides[item.id]?.pending}
                        aria-label={`修改示例人员019${index + 1}`}
                        onClick={() => setEditing(item)}
                      >
                        <Pencil />
                      </button>
                    )}
                  </strong>
                  {item.assignee?.kind === 'custom' && <span>自定义人员</span>}
                  {item.assignee?.kind === 'employee' && <span>在职员工</span>}
                  {item.mentionedPeople.length > 0 && (
                    <span>
                      涉及人员：<b>{item.mentionedPeople.join('、')}</b>
                    </span>
                  )}
                </div>
                <button
                  className="meeting-action-source"
                  onClick={() => onOpenRecord(item.sourceRecordId)}
                  aria-label={`查看${item.sourceTitle}待办来源`}
                >
                  <strong>
                    {item.sourceTitle.match(/第\d+周/)?.[0] || item.sourceTitle}
                  </strong>
                  <span>{item.sourceDate || '日期未填写'}</span>
                  <ArrowRight />
                </button>
              </li>
            ))}
          </ol>
          {!rows.length && (
            <div className="meeting-empty">没有符合条件的待办</div>
          )}
        </>
      )}
      {editing && (
        <MeetingActionEditDialog
          item={editing}
          draft={
            overrides[editing.id]?.task.phase === 'error'
              ? overrides[editing.id].task.command
              : undefined
          }
          onClose={() => setEditing(null)}
          onSubmit={(command) => {
            sync.submit(editing, command);
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}
