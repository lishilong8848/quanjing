import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type {
  MeetingDetail,
  MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import type {
  SaveWeeklyMeeting,
  WeeklyJob,
  WeeklyMeetingEntry,
  WeeklyMeetingInput,
  WeeklyMeetingKind,
  WeeklyWorkspace,
} from '../../../../shared/weekly-workspace.interface';
import {
  validateWeeklyMeeting,
  WEEKLY_TODO_FIELDS,
  weeklyTodoText,
} from '../../../../shared/weekly-workspace.rules';
import { meetingError } from './api';
import {
  weeklyMutation,
  weeklyFormRecord,
  weeklyAttachImages,
} from './weekly-api';
import { WeeklyImagePicker } from './WeeklyImagePicker';
import { mergeWeeklyFiles } from './weekly-files';

export function WeeklyMeetingDialog({
  record,
  kind,
  entry,
  people,
  onClose,
  onAccepted,
}: {
  record: MeetingSummary;
  kind: WeeklyMeetingKind;
  entry?: WeeklyMeetingEntry;
  people: WeeklyWorkspace['people'];
  onClose: () => void;
  onAccepted: (job: WeeklyJob, additional?: WeeklyJob[]) => void;
}) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [input, setInput] = useState<WeeklyMeetingInput>(
    entry
      ? { ...entry, status: 'held', todos: entry.todos }
      : {
          targetRecordId: record.id,
          kind,
          plannedDate: record.date || today,
          actualDate: record.date || today,
          status: 'held',
          note: '',
          todos: [],
          rawText: '',
        },
  );
  const [state, setState] = useState<
    'loading' | 'ready' | 'submitting' | 'error'
  >('loading');
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const baseJob = useRef<WeeklyJob | null>(null);
  const attachmentIds = useRef(new Map<File, string>());
  const acceptedFiles = useRef(new Map<File, WeeklyJob>());
  const [fileProgress, setFileProgress] = useState('');
  const mutation = useRef<SaveWeeklyMeeting | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const original =
    detail?.sections.find((s) => s.title === WEEKLY_TODO_FIELDS[kind])
      ?.content || '';
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    weeklyFormRecord(record.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetail(result.meeting);
        if (!entry) {
          const text =
            result.meeting.sections.find(
              (s) => s.title === WEEKLY_TODO_FIELDS[kind],
            )?.content || '';
          const todos: WeeklyMeetingInput['todos'] = [];
          setInput((value) => ({
            ...value,
            todos,
            rawText: text,
          }));
        }
        setState('ready');
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setState('error');
          setError(meetingError(reason));
        }
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [record.id, kind, entry]);
  const change = (value: Partial<WeeklyMeetingInput>) => {
    setInput((current) => ({ ...current, ...value }));
    mutation.current = null;
    setError(null);
  };
  const save = async () => {
    if (inFlight.current || !detail) return;
    const validation = validateWeeklyMeeting(input);
    if (validation) {
      setError(validation);
      return;
    }
    inFlight.current = true;
    setState('submitting');
    setError(null);
    setFileProgress('');
    const command = mutation.current || {
      todoOnly: true,
      clientMutationId: crypto.randomUUID(),
      expectedVersion: entry?.version || 0,
      expectedText: original,
      meeting: input,
    };
    mutation.current = command;
    try {
      const job =
        baseJob.current || (await weeklyMutation('meetings', command));
      baseJob.current = job;
      if (input.status === 'held') {
        for (const [index, file] of files.entries()) {
          if (acceptedFiles.current.has(file)) continue;
          if (mounted.current)
            setFileProgress(
              `正在提交附件 ${index + 1}/${files.length}：${file.name}`,
            );
          let id = attachmentIds.current.get(file);
          if (!id) {
            id = crypto.randomUUID();
            attachmentIds.current.set(file, id);
          }
          try {
            const attachment = await weeklyAttachImages(
              {
                clientMutationId: id,
                targetRecordId: record.id,
                kind,
                baseJobId: job.id,
              },
              [file],
            );
            acceptedFiles.current.set(file, attachment);
          } catch (reason) {
            throw new Error(`${file.name}：${meetingError(reason)}`);
          }
        }
      }
      if (mounted.current) onAccepted(job, [...acceptedFiles.current.values()]);
    } catch (reason) {
      if (mounted.current) {
        setState('error');
        setError(meetingError(reason));
      }
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state !== 'submitting') {
          if (baseJob.current)
            onAccepted(baseJob.current, [...acceptedFiles.current.values()]);
          else onClose();
        }
      }}
    >
      <DialogContent
        className="weekly-dialog"
        onPaste={(event) => {
          if (
            state === 'submitting' ||
            baseJob.current ||
            input.status !== 'held'
          )
            return;
          const incoming = [...event.clipboardData.files];
          if (!incoming.length) return;
          if (!event.clipboardData.getData('text/plain'))
            event.preventDefault();
          try {
            setFiles(mergeWeeklyFiles(files, incoming));
            setError(null);
          } catch (reason) {
            setError((reason as Error).message);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {kind === 'ali' ? '阿里会议待办' : '属地周会待办'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            填写待办内容、示例人员019及附件
          </DialogDescription>
        </DialogHeader>
        <div className="weekly-target">
          <strong>{record.title}</strong>
          <span>{record.date} · 目标周报</span>
        </div>
        {state === 'loading' && <p role="status">正在读取当前待办…</p>}
        {error && (
          <p role="alert" className="weekly-error">
            {error}
          </p>
        )}
        {baseJob.current && state === 'error' && (
          <p role="status">
            待办已受理；附件已受理 {acceptedFiles.current.size}/{files.length}{' '}
            个，重试继续提交剩余附件。
          </p>
        )}
        {input.status === 'held' && (
          <div className="weekly-todo-editor">
            <div className="weekly-input-mode">
              <Button
                size="sm"
                variant={input.rawText !== undefined ? 'default' : 'outline'}
                disabled={state === 'submitting' || !!baseJob.current}
                onClick={() =>
                  change({ rawText: weeklyTodoText(input), todos: [] })
                }
              >
                整段粘贴
              </Button>
              <Button
                size="sm"
                variant={input.rawText === undefined ? 'default' : 'outline'}
                disabled={state === 'submitting' || !!baseJob.current}
                onClick={() => {
                  if ((input.rawText || '').length > 2000) {
                    setError('大段内容请保留整段模式，单项待办最多2000字');
                    return;
                  }
                  change({
                    rawText: undefined,
                    todos: input.rawText?.trim()
                      ? [
                          {
                            id: crypto.randomUUID(),
                            content: input.rawText,
                            ownerName: '',
                            ownerOpenId: '',
                            dueDate: '',
                            status: 'pending',
                          },
                        ]
                      : input.todos,
                  });
                }}
              >
                逐项填写
              </Button>
            </div>
            {input.rawText !== undefined && (
              <label>
                待办内容
                <Textarea
                  aria-label="整段待办内容"
                  className="weekly-bulk-todo"
                  placeholder="粘贴完整会议待办，保留编号和换行"
                  value={input.rawText}
                  maxLength={100000}
                  disabled={state === 'submitting' || !!baseJob.current}
                  onChange={(event) => change({ rawText: event.target.value })}
                />
              </label>
            )}
            {input.todos.map((todo, index) => (
              <div className="weekly-todo-edit" key={todo.id}>
                <label className="weekly-todo-content">
                  事宜 {index + 1}
                  <Textarea
                    aria-label={`事宜 ${index + 1}`}
                    value={todo.content}
                    maxLength={2000}
                    disabled={state === 'submitting' || !!baseJob.current}
                    onChange={(e) =>
                      change({
                        todos: input.todos.map((t) =>
                          t.id === todo.id
                            ? { ...t, content: e.target.value }
                            : t,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  示例人员019
                  <NativeSelect
                    aria-label="示例人员019"
                    value={todo.ownerOpenId}
                    disabled={state === 'submitting' || !!baseJob.current}
                    onChange={(e) => {
                      const person = people.find(
                        (p) => p.openId === e.target.value,
                      );
                      change({
                        todos: input.todos.map((t) =>
                          t.id === todo.id
                            ? {
                                ...t,
                                ownerOpenId: person?.openId || '',
                                ownerName: person?.name || '',
                              }
                            : t,
                        ),
                      });
                    }}
                  >
                    <NativeSelectOption value="">待明确</NativeSelectOption>
                    {todo.ownerOpenId &&
                      !people.some((p) => p.openId === todo.ownerOpenId) && (
                        <NativeSelectOption value={todo.ownerOpenId}>
                          {todo.ownerName}（原示例人员019）
                        </NativeSelectOption>
                      )}
                    {people.map((p) => (
                      <NativeSelectOption key={p.openId} value={p.openId}>
                        {p.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  截止日期
                  <Input
                    type="date"
                    value={todo.dueDate}
                    disabled={state === 'submitting' || !!baseJob.current}
                    onChange={(e) =>
                      change({
                        todos: input.todos.map((t) =>
                          t.id === todo.id
                            ? { ...t, dueDate: e.target.value }
                            : t,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  状态
                  <NativeSelect
                    aria-label={`事宜${index + 1}状态`}
                    value={todo.status}
                    disabled={state === 'submitting' || !!baseJob.current}
                    onChange={(e) =>
                      change({
                        todos: input.todos.map((t) =>
                          t.id === todo.id
                            ? {
                                ...t,
                                status: e.target.value as 'pending' | 'done',
                              }
                            : t,
                        ),
                      })
                    }
                  >
                    <NativeSelectOption value="pending">
                      待办
                    </NativeSelectOption>
                    <NativeSelectOption value="done">已完成</NativeSelectOption>
                  </NativeSelect>
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除事宜${index + 1}`}
                  disabled={state === 'submitting' || !!baseJob.current}
                  onClick={() =>
                    change({
                      todos: input.todos.filter((t) => t.id !== todo.id),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {input.rawText === undefined && (
              <Button
                variant="outline"
                disabled={
                  !detail || state === 'submitting' || input.todos.length >= 100
                }
                onClick={() =>
                  change({
                    todos: [
                      ...input.todos,
                      {
                        id: crypto.randomUUID(),
                        content: '',
                        ownerOpenId: '',
                        ownerName: '',
                        dueDate: '',
                        status: 'pending',
                      },
                    ],
                  })
                }
              >
                <Plus />
                新增事宜
              </Button>
            )}
            <WeeklyImagePicker
              files={files}
              disabled={state === 'submitting' || !!baseJob.current}
              onChange={setFiles}
              onError={setError}
            />
          </div>
        )}
        {original &&
          input.status === 'held' &&
          !input.todos.length &&
          !input.rawText?.trim() && (
            <p className="weekly-error">保存将清空此会议类型的原有待办。</p>
          )}
        <div className="weekly-dialog-footer">
          {state === 'submitting' && (
            <span role="status">{fileProgress || '正在保存待办…'}</span>
          )}
          <Button
            variant="outline"
            disabled={state === 'submitting'}
            onClick={() =>
              baseJob.current
                ? onAccepted(baseJob.current, [
                    ...acceptedFiles.current.values(),
                  ])
                : onClose()
            }
          >
            取消
          </Button>
          <Button
            disabled={!detail || state === 'submitting'}
            onClick={() => void save()}
          >
            {state === 'submitting' ? '正在提交…' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
