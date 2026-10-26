import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, X } from 'lucide-react';
import type {
  MeetingDetailResponse,
  MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getMeetingDetail, meetingError } from './api';
import { MeetingResourceLinks } from './MeetingSourceBoard';

interface Props {
  id: string;
  summary?: MeetingSummary;
  snapshotId: string;
  cache: Map<string, MeetingDetailResponse>;
  onClose: () => void;
}

export function MeetingDetailDialog({
  id,
  summary,
  snapshotId,
  cache,
  onClose,
}: Props) {
  const cached = cache.get(id);
  const [result, setResult] = useState<MeetingDetailResponse | null>(
    cached?.snapshotId === snapshotId ? cached : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [section, setSection] = useState('');

  useEffect(() => {
    const existing = cache.get(id);
    if (
      existing?.snapshotId === snapshotId &&
      existing.documentState !== 'loading'
    ) {
      setResult(existing);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    setResult(null);
    setError(null);
    const load = () =>
      void getMeetingDetail(id, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          cache.set(id, data);
          setResult(data);
          if (data.documentState === 'loading' && polls++ < 30)
            timer = setTimeout(load, 800);
          else if (data.documentState === 'loading')
            setError('原始周报读取尚未完成，请重新加载');
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(meetingError(reason));
        });
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, snapshotId, cache, attempt]);

  const meeting = result?.meeting;
  const activeSection = section || 'all';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="meeting-detail" showCloseButton={false}>
        <DialogHeader className="meeting-detail-header">
          <DialogTitle>
            {meeting?.title || summary?.title || '会议记录'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            查看本次会议收录的周报内容与待办。
          </DialogDescription>
          <div className="meeting-detail-meta">
            <span>{meeting?.date || summary?.date || '日期未填写'}</span>
            <Badge variant="secondary">
              {meeting?.scope || summary?.scope || '机房'}
            </Badge>
            <Badge variant="secondary">
              {meeting?.nature || summary?.nature || '管理类'}
            </Badge>
          </div>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="meeting-close"
              aria-label="关闭"
            >
              <X />
            </Button>
          </DialogClose>
        </DialogHeader>
        {!meeting && !error && (
          <div className="meeting-empty" role="status">
            <Loader2 className="animate-spin" />
            正在读取会议内容…
          </div>
        )}
        {error && (
          <div className="meeting-empty" role="alert">
            <p>{error}</p>
            <Button onClick={() => setAttempt((value) => value + 1)}>
              重新加载
            </Button>
          </div>
        )}
        {meeting && (
          <>
            {meeting.sections.length > 0 && (
              <nav className="meeting-section-nav" aria-label="会议内容分区">
                <Button
                  size="sm"
                  variant={activeSection === 'all' ? 'default' : 'ghost'}
                  aria-pressed={activeSection === 'all'}
                  onClick={() => setSection('all')}
                >
                  全部内容
                </Button>
                {meeting.sections.map((item) => (
                  <Button
                    key={item.key}
                    size="sm"
                    variant={activeSection === item.key ? 'default' : 'ghost'}
                    aria-pressed={activeSection === item.key}
                    onClick={() => setSection(item.key)}
                  >
                    {item.title}
                  </Button>
                ))}
              </nav>
            )}
            <div className="meeting-detail-scroll">
              {result?.documentState === 'loading' && (
                <p className="weekly-muted" role="status">
                  正在补读原始周报…
                </p>
              )}
              {result?.documentMessage && (
                <p className="weekly-error" role="alert">
                  {result.documentMessage}
                </p>
              )}
              {meeting.source !== 'nantong-weekly' && (
                <section className="meeting-content-section meeting-source-detail">
                  <h3>{meeting.subtype || '会议信息'}</h3>
                  <dl>
                    <div>
                      <dt>开始时间</dt>
                      <dd>
                        {meeting.startAt
                          ? new Date(meeting.startAt).toLocaleString('zh-CN', {
                              timeZone: 'Asia/Shanghai',
                              hour12: false,
                            })
                          : '未填写'}
                      </dd>
                    </div>
                    <div>
                      <dt>结束时间</dt>
                      <dd>
                        {meeting.endAt
                          ? new Date(meeting.endAt).toLocaleString('zh-CN', {
                              timeZone: 'Asia/Shanghai',
                              hour12: false,
                            })
                          : '未填写'}
                      </dd>
                    </div>
                    {meeting.source === 'training' && (
                      <>
                        <div>
                          <dt>分享人</dt>
                          <dd>
                            {meeting.presenters
                              ?.map((p) => p.name)
                              .join('、') || '待填写'}
                          </dd>
                        </div>
                        <div>
                          <dt>负责人</dt>
                          <dd>
                            {meeting.owners?.map((p) => p.name).join('、') ||
                              '待填写'}
                          </dd>
                        </div>
                        <div>
                          <dt>楼栋 / 专业</dt>
                          <dd>
                            {meeting.specialties?.join(' · ') || '未填写'}
                          </dd>
                        </div>
                        <div>
                          <dt>参与人数</dt>
                          <dd>{meeting.participantCount ?? '未填写'}</dd>
                        </div>
                        <div>
                          <dt>会议状态</dt>
                          <dd>{meeting.status || '未填写'}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  <MeetingResourceLinks item={{ ...meeting, searchText: '' }} />
                  {meeting.attachmentNames?.length ? (
                    <div className="meeting-source-attachments">
                      <h3>会议附件</h3>
                      {meeting.attachmentNames.map((name, i) => (
                        <p key={i}>{name}</p>
                      ))}
                      {meeting.sourceUrl && (
                        <a
                          href={meeting.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          到源表查看附件
                          <ExternalLink />
                        </a>
                      )}
                    </div>
                  ) : null}
                  {meeting.warnings?.map((w) => (
                    <p role="note" className="meeting-source-warning" key={w}>
                      {w}
                    </p>
                  ))}
                </section>
              )}
              {meeting.sections.length ? (
                meeting.sections
                  .filter(
                    (item) =>
                      activeSection === 'all' || activeSection === item.key,
                  )
                  .map((item) => (
                    <section key={item.key} className="meeting-content-section">
                      <h3>{item.title}</h3>
                      <div className="meeting-content-text">{item.content}</div>
                    </section>
                  ))
              ) : (
                <div className="meeting-empty">
                  <p>这条记录尚未收录正文</p>
                  {meeting.documentUrl && <span>可打开关联资料查看。</span>}
                </div>
              )}
            </div>
            <div className="meeting-detail-footer">
              <span>
                {meeting.updatedAt
                  ? `记录更新：${new Date(meeting.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
                  : ''}
              </span>
              {meeting.documentUrl ? (
                <Button asChild>
                  <a
                    href={meeting.documentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink />
                    {meeting.source === 'nantong-weekly'
                      ? '打开原始周报'
                      : '打开关联资料'}
                  </a>
                </Button>
              ) : (
                <span>
                  {meeting.source === 'nantong-weekly'
                    ? '未关联原始周报'
                    : '未关联资料'}
                </span>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
