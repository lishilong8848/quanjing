import { PROFILE_CHANGE_PHOTO_MAX_BYTES } from '@shared/personnel-profile-change.interface';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAccess } from '@/access/AccessProvider';
import {
  listProfileChanges,
  submitProfileChange,
  reviewProfileChange,
  cancelProfileChange,
  recoverProfileChange,
  isProfileChangeRejected,
  profileChangesUrl,
} from '@/api/profile-changes';
import type {
  ProfileChange,
  ProfileChangeField,
  ReviewProfileChange,
} from '@shared/personnel-profile-change.interface';
const labels: Record<ProfileChangeField, string> = {
  phone: '手机号',
  email: '邮箱',
  photo: '照片',
};
const states: Record<ProfileChange['status'], string> = {
  pending: '待审核',
  approved: '已批准，等待同步',
  uploading: '照片同步中',
  writing: '资料同步中',
  completed: '已更新',
  rejected: '已拒绝',
  cancelled: '已撤回',
  conflict: '原资料已变化，请重新申请',
  reconciliation: '处理结果待核对',
};
export function ProfileChanges({
  admin = false,
  onCompleted,
  focusRequestId,
  focusNavigationKey,
}: {
  admin?: boolean;
  onCompleted?: () => void;
  focusRequestId?: string;
  focusNavigationKey?: string;
}) {
  const access = useAccess();
  return (
    <ProfileChangesContent
      key={`${access.principalFingerprint || access.accountId}:${admin}`}
      admin={admin}
      onCompleted={onCompleted}
      focusRequestId={admin ? focusRequestId : undefined}
      focusNavigationKey={focusNavigationKey}
    />
  );
}
function ProfileChangesContent({
  admin,
  onCompleted,
  focusRequestId,
  focusNavigationKey,
}: {
  admin: boolean;
  onCompleted?: () => void;
  focusRequestId?: string;
  focusNavigationKey?: string;
}) {
  const access = useAccess(),
    readOnly = !!access.impersonation;
  const completeCallback = useRef(onCompleted);
  completeCallback.current = onCompleted;
  const seenStatuses = useRef(new Map<string, ProfileChange['status']>());
  const [rows, setRows] = useState<ProfileChange[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [loadError, setLoadError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  const [focusedId, setFocusedId] = useState(admin ? focusRequestId || '' : '');
  const focusAnchor = useRef<HTMLDivElement | null>(null);
  const scrolledFocus = useRef('');
  const focusReadKey = useRef(`${admin}:${focusRequestId || ''}:${focusNavigationKey || ''}`);
  useEffect(() => {
    setFocusedId(admin ? focusRequestId || '' : '');
    setPage(0);
    scrolledFocus.current = '';
    const nextReadKey = `${admin}:${focusRequestId || ''}:${focusNavigationKey || ''}`;
    if (admin && focusRequestId && focusReadKey.current !== nextReadKey) setRetry(value => value + 1);
    focusReadKey.current = nextReadKey;
  }, [admin, focusRequestId, focusNavigationKey]);
  const visibleRows = focusedId ? rows.filter(row => row.id === focusedId) : rows;
  useEffect(() => {
    if (focusedId && loaded && visibleRows.length && scrolledFocus.current !== focusedId) {
      focusAnchor.current?.scrollIntoView({block:'start',behavior:'smooth'});
      scrolledFocus.current = focusedId;
    }
  }, [focusedId, loaded, rows]);
  const [enabled, setEnabled] = useState<ProfileChangeField[]>([]),
    [phone, setPhone] = useState(''),
    [email, setEmail] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [locked, setLocked] = useState(false);
  const [recovering, setRecovering] = useState<ProfileChange | null>(null),
    [uploadedPhotoToken, setUploadedPhotoToken] = useState('');
  const auxiliaryRequests = useRef(new Map<string, any>());
  const act = async (
    row: ProfileChange,
    action: 'cancel' | 'recheck' | 'resume',
  ) => {
    if (busy) return;
    setBusy(true);
    setError('');
    const key = `${row.id}:${action}`;
    let body = auxiliaryRequests.current.get(key);
    if (!body) {
      body = {
        requestId: row.id,
        expectedVersion: row.version,
        clientMutationId: crypto.randomUUID(),
        ...(action === 'cancel'
          ? {}
          : {
              confirmUnchanged: action === 'resume',
              ...(uploadedPhotoToken ? { uploadedPhotoToken } : {}),
            }),
      };
      auxiliaryRequests.current.set(key, body);
    }
    try {
      const next = await (action === 'cancel'
        ? cancelProfileChange(body)
        : recoverProfileChange(body));
      if (!mounted.current) return;
      update(next);
      auxiliaryRequests.current.delete(key);
      setRecovering(null);
      setUploadedPhotoToken('');
    } catch (e) {
      if (isProfileChangeRejected(e)) {
        auxiliaryRequests.current.delete(key);
        setRetry((v) => v + 1);
      }
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : '处理结果待确认，请重试原操作',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const storageKey = `profile-change-request:${access.accountId || ''}`;
  const readPending = () => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  };
  const [recoveringDraft, setRecoveringDraft] = useState(() => !!readPending());
  const remember = (id: string | null) => {
    try {
      if (id) sessionStorage.setItem(storageKey, id);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Session storage may be unavailable; the on-screen original request is still retained. */
    }
  };
  const mutation = useRef(readPending() || crypto.randomUUID()),
    request = useRef<FormData | null>(null),
    mounted = useRef(true);
  const [reviewing, setReviewing] = useState<ProfileChange | null>(null),
    [comment, setComment] = useState('');
  const reviewRequest = useRef<ReviewProfileChange | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (readOnly) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await listProfileChanges(admin, controller.signal);
        if (!controller.signal.aborted) {
          if (
            data.some(
              (row) =>
                row.status === 'completed' &&
                seenStatuses.current.has(row.id) &&
                seenStatuses.current.get(row.id) !== 'completed',
            )
          )
            completeCallback.current?.();
          seenStatuses.current = new Map(
            data.map((row) => [row.id, row.status]),
          );
          setRows(data);
          setRecovering((current) =>
            current &&
            ![...auxiliaryRequests.current.keys()].some((key) =>
              key.startsWith(current.id + ':'),
            )
              ? data.find((row) => row.id === current.id) || null
              : current,
          );
          setReviewing((current) =>
            current && !reviewRequest.current
              ? data.find((row) => row.id === current.id) || null
              : current,
          );
          setLoadError('');
          setLoaded(true);
          const original = data.find(
            (row) => row.clientMutationId === mutation.current,
          );
          if (original) {
            remember(null);
            request.current = null;
            mutation.current = crypto.randomUUID();
            setRecoveringDraft(false);
            setLocked(false);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setLoadError(e instanceof Error ? e.message : '记录读取失败');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(load, 15000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [admin, readOnly, retry]);
  const update = (row: ProfileChange) =>
    setRows((values) => [row, ...values.filter((v) => v.id !== row.id)]);
  const submit = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    setError('');
    try {
      if (!request.current) {
        if (
          enabled.includes('phone') &&
          !/^\+?[0-9 ()-]{6,30}$/.test(phone.trim())
        )
          throw new Error('请输入有效手机号');
        if (
          enabled.includes('email') &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
        )
          throw new Error('请输入有效邮箱');
        if (
          enabled.includes('photo') &&
          (!file || file.size > PROFILE_CHANGE_PHOTO_MAX_BYTES)
        )
          throw new Error('请选择不超过10MB的新照片');
        const data = new FormData();
        data.set('clientMutationId', mutation.current);
        if (enabled.includes('phone')) data.set('phone', phone.trim());
        if (enabled.includes('email')) data.set('email', email.trim());
        if (enabled.includes('photo')) {
          if (!file) throw new Error('请选择新照片');
          data.set('photo', file);
        }
        remember(mutation.current);
        request.current = data;
        setLocked(true);
      }
      const row = await submitProfileChange(request.current);
      if (!mounted.current) return;
      update(row);
      remember(null);
      setRecoveringDraft(false);
      request.current = null;
      mutation.current = crypto.randomUUID();
      setLocked(false);
      setEnabled([]);
      setPhone('');
      setEmail('');
      setFile(null);
    } catch (e) {
      if (isProfileChangeRejected(e)) {
        request.current = null;
        setLocked(false);
        setRetry((v) => v + 1);
      }
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : '提交结果待确认，请使用原申请重试',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const review = async (decision: 'approve' | 'reject') => {
    if (!reviewing || busy) return;
    setBusy(true);
    setError('');
    if (!reviewRequest.current)
      reviewRequest.current = {
        requestId: reviewing.id,
        expectedVersion: reviewing.version,
        clientMutationId: crypto.randomUUID(),
        decision,
        comment,
      };
    try {
      const row = await reviewProfileChange(reviewRequest.current);
      if (!mounted.current) return;
      update(row);
      reviewRequest.current = null;
      setReviewing(null);
      setComment('');
    } catch (e) {
      if (isProfileChangeRejected(e)) {
        reviewRequest.current = null;
        setRetry((v) => v + 1);
      }
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : '审核结果待确认，请重试原决定',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (readOnly)
    return (
      <p className="text-sm text-muted-foreground">
        代登录期间不能提交或审核资料变更。
      </p>
    );
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {admin ? '个人资料变更审批' : '申请修改基本资料'}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRetry((v) => v + 1)}
        >
          刷新记录
        </Button>
      </header>
      {admin && focusedId && <div ref={focusAnchor} role="status" className="scroll-mt-24 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-primary/5 p-3 text-sm">
        <p>{loaded && !visibleRows.length ? '未找到卡片中的资料变更申请，请刷新记录核对。' : '正在查看卡片中的资料变更申请；审核结果以当前记录为准，不会自动批准。'}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => {setFocusedId('');setPage(0);}}>查看全部申请</Button>
      </div>}
      {!admin && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            选择需要修改的资料，管理员审核通过后生效。其它档案问题请使用资料核对与反馈。
          </p>
          <div className="flex flex-wrap gap-4">
            {(['phone', 'email', 'photo'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled.includes(key)}
                  disabled={locked || busy}
                  onChange={(e) =>
                    setEnabled((v) =>
                      e.target.checked
                        ? [...v, key]
                        : v.filter((k) => k !== key),
                    )
                  }
                />
                {labels[key]}
              </label>
            ))}
          </div>
          {enabled.includes('phone') && (
            <label className="block space-y-1 text-sm">
              新手机号
              <Input
                type="tel"
                value={phone}
                maxLength={30}
                disabled={locked || busy}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
          )}
          {enabled.includes('email') && (
            <label className="block space-y-1 text-sm">
              新邮箱
              <Input
                type="email"
                value={email}
                maxLength={254}
                disabled={locked || busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          {enabled.includes('photo') && (
            <label className="block space-y-1 text-sm">
              新照片（PNG/JPEG/WebP，最大10MB）
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={locked || busy}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
          )}
          <Button
            disabled={busy || !loaded || (!locked && !enabled.length)}
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : locked ? '重试原申请' : '提交审核'}
          </Button>
          {locked && (
            <p role="status" className="text-sm text-amber-700">
              原申请已保留。请重试确认结果，勿重复创建。
            </p>
          )}
        </div>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          记录读取失败：{loadError}
        </p>
      )}
      {recoveringDraft && (
        <p role="status" className="text-sm text-amber-700">
          正在核对上次申请。若记录中尚未找到，请重新填写原内容并重新选择照片后重试。
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && <p role="status">正在读取申请…</p>}
      {!loading && !visibleRows.length && !focusedId && (
        <p className="text-sm text-muted-foreground">暂无资料变更申请</p>
      )}
      <div className="divide-y">
        {visibleRows.slice(page * 10, page * 10 + 10).map((row) => (
          <article key={row.id} data-profile-change-id={row.id} className="space-y-2 py-4">
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{row.applicantName}</strong>
              <span className="text-sm">{states[row.status]}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {new Date(row.createdAt).toLocaleString()}
            </p>
            {(Object.keys(row.changes) as ProfileChangeField[]).map((key) => (
              <div key={key} className="break-words text-sm">
                <span>
                  {labels[key]}：{row.before[key] || '未填写'} →{' '}
                  {row.changes[key]}
                </span>
                {key === 'photo' && row.before.photo === '已有照片' && (
                  <img
                    className="mt-2 max-h-48 max-w-full rounded border object-contain"
                    alt="修改前照片"
                    src={`${profileChangesUrl((admin ? 'configuration' : 'personal') + '/profile-changes/photo')}?id=${encodeURIComponent(row.id)}&variant=before`}
                  />
                )}
                {key === 'photo' && (
                  <img
                    className="mt-2 max-h-48 max-w-full rounded border object-contain"
                    alt="申请的新照片"
                    src={`${profileChangesUrl((admin ? 'configuration' : 'personal') + '/profile-changes/photo')}?id=${encodeURIComponent(row.id)}`}
                  />
                )}
              </div>
            ))}
            {row.comment && <p className="text-sm">审核意见：{row.comment}</p>}
            {row.message && (
              <p role="status" className="text-sm text-muted-foreground">
                {row.message}
              </p>
            )}
            {!admin && row.status === 'pending' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(row, 'cancel')}
              >
                撤回申请
              </Button>
            )}
            {admin && row.status === 'reconciliation' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setRecovering(row);
                  setError('');
                }}
              >
                核对处理结果
              </Button>
            )}
            {admin && row.status === 'pending' && (
              <Button
                size="sm"
                disabled={busy || row.accountId === access.accountId}
                onClick={() => {
                  reviewRequest.current = null;
                  setReviewing(row);
                  setComment('');
                }}
              >
                审核整单
              </Button>
            )}
          </article>
        ))}
      </div>
      {visibleRows.length > 10 && (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((v) => v - 1)}
          >
            上一页
          </Button>
          <span>
            {page + 1} / {Math.ceil(visibleRows.length / 10)}
          </span>
          <Button
            variant="outline"
            disabled={(page + 1) * 10 >= visibleRows.length}
            onClick={() => setPage((v) => v + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      {recovering && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="核对处理结果"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-5">
            <h3 className="text-lg font-semibold">
              核对 {recovering.applicantName} 的资料变更
            </h3>
            <p className="text-sm">
              先核对来源。已更新的申请只确认完成；仍为申请前内容时，可确认后继续原申请。来源出现其它变更时不会覆盖。
            </p>
            {recovering.changes.photo && (
              <label className="block space-y-2 text-sm">
                已上传照片标识（上传结果未知时填写，系统将核验与原照片一致）
                <Input
                  value={uploadedPhotoToken}
                  onChange={(e) => setUploadedPhotoToken(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRecovering(null)}
              >
                关闭
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(recovering, 'recheck')}
              >
                只核对结果
              </Button>
              <Button
                disabled={busy}
                onClick={() => void act(recovering, 'resume')}
              >
                确认未改变并继续原申请
              </Button>
            </div>
          </div>
        </div>
      )}
      {reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="审核资料变更"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-5">
            <h3 className="text-lg font-semibold">
              审核 {reviewing.applicantName} 的资料变更
            </h3>
            <p className="text-sm">
              本次提交的
              {Object.keys(reviewing.changes)
                .map((key) => labels[key as ProfileChangeField])
                .join('、')}
              将整单审核。
            </p>
            <label className="block space-y-2 text-sm">
              审核意见
              <Input
                value={comment}
                maxLength={1000}
                disabled={busy || !!reviewRequest.current}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy || !!reviewRequest.current}
                onClick={() => setReviewing(null)}
              >
                取消
              </Button>
              {reviewRequest.current ? (
                <Button
                  disabled={busy}
                  onClick={() => void review(reviewRequest.current!.decision)}
                >
                  重试原审核决定
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void review('reject')}
                  >
                    拒绝
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void review('approve')}
                  >
                    同意整单修改
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
