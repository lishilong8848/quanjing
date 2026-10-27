import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { MeetingAction } from '../../../../shared/meeting-management.interface';
import type {
  ActionAssignee,
  EditMeetingAction,
} from '../../../../shared/weekly-workspace.interface';
import { cachedWeeklyPeople, weeklyWorkspace } from './weekly-api';
import { meetingError } from './api';

export function MeetingActionEditDialog({
  item,
  onClose,
  onSubmit,
  draft,
}: {
  item: MeetingAction;
  onClose: () => void;
  onSubmit: (command: EditMeetingAction) => void;
  draft?: EditMeetingAction;
}) {
  const [content, setContent] = useState(draft?.content || item.content);
  const [owner, setOwner] = useState<ActionAssignee | undefined>(
    draft?.assignee || item.assignee,
  );
  const [mode, setMode] = useState<'employee' | 'custom'>(
    draft?.assignee?.kind === 'custom' ? 'custom' : 'employee',
  );
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState(cachedWeeklyPeople);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false);
  const disabled = false;
  useEffect(() => {
    const controller = new AbortController();
    if (!people.length)
      void weeklyWorkspace(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) {
            setPeople(data.people);
            setPeopleError(data.peopleError);
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setPeopleError(meetingError(reason));
        });
    return () => {
      controller.abort();
    };
  }, []);
  const matches = useMemo(
    () =>
      people
        .filter((p) =>
          p.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .slice(0, 12),
    [people, query],
  );
  const changeOwner = (value: ActionAssignee) => {
    setOwner(value);
    setError(null);
  };
  const save = () => {
    if (flight.current || !content.trim()) return;
    if (
      owner &&
      owner.kind !== 'unassigned' &&
      (!owner.name.trim() || /[\s，,。；;（）()\r\n]/.test(owner.name))
    ) {
      setError('请选择在职员工或填写有效的自定义人员');
      return;
    }
    flight.current = true;
    onSubmit({
      clientMutationId: crypto.randomUUID(),
      targetRecordId: item.sourceRecordId,
      actionId: item.id,
      expectedContent: item.content,
      content,
      ...(owner ? { assignee: owner } : {}),
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="weekly-dialog meeting-action-edit-dialog">
        <DialogHeader>
          <DialogTitle>修改待办</DialogTitle>
          <DialogDescription className="sr-only">
            修改事宜内容及责任人
          </DialogDescription>
        </DialogHeader>
        <div className="meeting-action-edit-source">
          {item.sourceTitle} · {item.sectionTitle}
        </div>
        {
          <>
            <label>
              事宜
              <Textarea
                aria-label="待办内容"
                value={content}
                maxLength={10000}
                rows={5}
                disabled={disabled}
                onChange={(event) => {
                  setContent(event.target.value);
                }}
              />
            </label>
            <div className="meeting-owner-picker">
              <strong>
                责任人：
                {owner?.kind === 'unassigned'
                  ? '未分配'
                  : owner && 'name' in owner
                    ? owner.name
                    : item.responsible || '未注明'}
              </strong>
              <div className="meeting-owner-tabs">
                <Button
                  size="sm"
                  variant={mode === 'employee' ? 'default' : 'outline'}
                  disabled={disabled}
                  onClick={() => setMode('employee')}
                >
                  在职员工
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'custom' ? 'default' : 'outline'}
                  disabled={disabled}
                  onClick={() => setMode('custom')}
                >
                  自定义人员
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => changeOwner({ kind: 'unassigned' })}
                >
                  清除责任人
                </Button>
              </div>
              {mode === 'employee' ? (
                <>
                  <Input
                    aria-label="搜索在职员工"
                    placeholder="输入姓名模糊查找"
                    value={query}
                    disabled={disabled}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {peopleError && (
                    <p role="alert" className="weekly-error">
                      {peopleError}
                    </p>
                  )}
                  <div className="meeting-owner-results">
                    {matches.map((person) => (
                      <Button
                        key={person.openId}
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        aria-pressed={
                          owner?.kind === 'employee' &&
                          owner.openId === person.openId
                        }
                        onClick={() =>
                          changeOwner({
                            kind: 'employee',
                            openId: person.openId,
                            name: person.name,
                          })
                        }
                      >
                        {person.name}
                        {(person.buildings?.length ||
                          person.position ||
                          person.employeeNo) && (
                          <span className="meeting-owner-context">
                            {[
                              person.buildings?.join(' / '),
                              person.position,
                              person.employeeNo,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                      </Button>
                    ))}
                  </div>
                  {!matches.length && (
                    <p>
                      {people.length
                        ? '未找到匹配的在职员工'
                        : peopleError
                          ? '在职员工暂不可用，可填写自定义人员'
                          : '正在读取在职员工…'}
                    </p>
                  )}
                </>
              ) : (
                <Input
                  aria-label="自定义责任人"
                  placeholder="填写人员姓名"
                  value={owner?.kind === 'custom' ? owner.name : ''}
                  disabled={disabled}
                  maxLength={100}
                  onChange={(e) =>
                    changeOwner({ kind: 'custom', name: e.target.value })
                  }
                />
              )}
            </div>
          </>
        }
        {error && (
          <p role="alert" className="weekly-error">
            {error}
          </p>
        )}
        <div className="weekly-dialog-footer">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!content.trim()} onClick={save}>
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
