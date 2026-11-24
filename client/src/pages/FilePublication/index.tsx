import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, Check, CheckCircle2, Clock3, CloudUpload, Download, FileText, History, Link2,
  Loader2, Megaphone, Pencil, Search, Send, ShieldCheck, Table2, Upload, X,
} from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  createPublicationRequestId, downloadPublicationFile, loadPublicationBatch, loadPublicationHistory, loadPublicationOptions,
  lookupPublicationSubmission, parsePublication, publicationError, publicationResultUncertain, publicationSchemaChanged,
  publicationVersionConflict, retryPublicationDeliveries, reviewPublication, submitPublication,
  type PublicationBatch, type PublicationDelivery, type PublicationFile, type PublicationGroup, type PublicationPreview,
  type PublicationSubmissionMode,
} from './api';
import RecordManager from './RecordManager';
import { readPublicationDraft, updatePublicationDraft, type PublicationDraft } from './publication-draft';
import './styles.css';
import './delivery-layout.css';

const DEFAULT_LIMITS = { maxFiles: 10, maxFileBytes: 20 * 1024 ** 2, maxTotalBytes: 50 * 1024 ** 2 };
const MAX_RECIPIENTS = 20;
const MAX_RECIPIENT_LENGTH = 128;
const PUBLICATION_UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.txt', '.md',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.zip', '.rar', '.7z',
];
const STATUS: Record<PublicationBatch['status'], string> = {
  syncing: '写入台账中',
  pending: '待审核',
  publishing: '发布中',
  published: '已发布',
  archived: '已保存到台账',
  rejected: '已驳回',
  failed: '待核对',
};
const PAGE_SIZE = 20;
const DELIVERY_STATUS: Record<PublicationDelivery['status'], string> = {
  pending: '待投递',
  sending: '投递中',
  sent: '已送达',
  failed: '投递失败',
  uncertain: '待核对',
  not_applicable: '无需投递',
};

type BatchMode = 'review' | 'download' | 'details';
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date);
}

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 2) return `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function fileKey(file: File) {
  return JSON.stringify([file.name, file.size, file.lastModified]);
}

function isFeishuLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^(?:[a-z0-9-]+\.)*feishu\.cn$/u.test(url.hostname) &&
      !url.username && !url.password && !url.port &&
      /^\/(base|wiki|bitable)\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname) &&
      /^tbl[A-Za-z0-9_-]+$/u.test(url.searchParams.get('table') || '') && url.searchParams.getAll('table').length === 1;
  } catch {
    return false;
  }
}

function recipientLabel(recipient: PublicationGroup) {
  return recipient.kind && recipient.name !== recipient.id ? `${recipient.name}（${recipient.id}）` : recipient.name;
}

function batchStatusLabel(batch: PublicationBatch) {
  return batch.status === 'published' && batch.error ? '已发布 · 通知待核对' : STATUS[batch.status];
}

function batchIsActive(batch?: PublicationBatch) {
  return !!batch && (batch.status === 'syncing' || batch.status === 'publishing');
}

export default function FilePublicationPage() {
  const access = useAccess();
  const scope = JSON.stringify([access.accountId, access.principalFingerprint, access.authorizationVersion]);
  const draftAccount = !access.impersonation ? access.accountId ?? null : null;
  return <PublicationView key={scope} scope={scope} draftAccount={draftAccount} />;
}

function PublicationView({ scope, draftAccount }: { scope: string; draftAccount: string | null }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedBatchId = searchParams.get('batch');
  const focusBatchId = requestedBatchId && PUBLICATION_UUID.test(requestedBatchId) ? requestedBatchId.toLowerCase() : null;
  const historyKey = ['file-publication', 'batches', scope];
  const options = useQuery({
    queryKey: ['file-publication', 'options', scope],
    queryFn: ({ signal }) => loadPublicationOptions(signal),
    retry: false,
  });
  const canReadPublication = options.data?.canReadPublication !== false;
  const canManageRecords = options.data?.canManageRecords === true;
  const picker = useRef<HTMLInputElement>(null);
  const parseRequest = useRef<AbortController>(null);
  const submitInFlight = useRef(false);
  const hadVisibleDraft = useRef(false);
  const requestId = useRef<string>(null);
  const [link, setLink] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [recipientText, setRecipientText] = useState('');
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [fieldEdits, setFieldEdits] = useState<Record<string, { name: string; value: string }>>({});
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [parsing, setParsing] = useState(false);
  const [schemaStale, setSchemaStale] = useState(false);
  const [sendingMode, setSendingMode] = useState<PublicationSubmissionMode | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<PublicationSubmissionMode>('release');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftResetting, setDraftResetting] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const [draftIssue, setDraftIssue] = useState('');
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dates, setDates] = useState({ from: '', to: '' });
  const [historyPage, setHistoryPage] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ batch: PublicationBatch; mode: BatchMode } | null>(null);
  const [tab, setTab] = useState('publication');
  const visibleTab = !canReadPublication ? 'records' : canManageRecords ? tab : 'publication';
  const rangeInvalid = !!dates.from && !!dates.to && dates.from > dates.to;
  const hasHistoryFilters = !!(search.trim() || statusFilter || dates.from || dates.to);
  const searchPending = search.trim() !== searchQuery;
  const historyParams = {
    page: historyPage ?? 1,
    pageSize: PAGE_SIZE,
    q: searchQuery || undefined,
    status: statusFilter || undefined,
    from: dates.from || undefined,
    to: dates.to || undefined,
    focus: historyPage == null && !hasHistoryFilters ? focusBatchId || undefined : undefined,
  };
  const history = useQuery({
    queryKey: [...historyKey, historyParams],
    queryFn: ({ signal }) => loadPublicationHistory(historyParams, signal),
    enabled: options.isSuccess && visibleTab === 'publication' && !rangeInvalid && !searchPending,
    retry: false,
    refetchInterval: query => query.state.data?.batches.some(batchIsActive) ? 4_000 : false,
  });

  const canPublish = options.data?.canPublish === true;
  const canArchive = options.data?.canArchive === true;
  const draftReady = !draftAccount || draftLoaded;
  const submitting = sendingMode !== null;
  const submitUncertain = pendingRequestId !== null;
  const locked = submitting || draftResetting || submitUncertain || !draftReady;
  const original = useQuery({
    queryKey: ['file-publication', 'submission', scope, pendingRequestId],
    queryFn: ({ signal }) => lookupPublicationSubmission(pendingRequestId!, signal),
    enabled: canPublish && draftReady && submitUncertain,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const groups = options.data?.groups || [];
  const sources = options.data?.sources || [];
  const limits = options.data?.limits || DEFAULT_LIMITS;
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const chosenGroups = groups.filter(group => groupIds.includes(group.id));
  const recipientInputs = [...new Set(recipientText.split(/\r?\n/u).map(value => value.trim()).filter(Boolean))];
  const recipientError = recipientInputs.length > MAX_RECIPIENTS
    ? `手动填写最多 ${MAX_RECIPIENTS} 个接收对象。`
    : recipientInputs.some(value => Array.from(value).length > MAX_RECIPIENT_LENGTH)
      ? `每个联系人姓名或 ID 最多 ${MAX_RECIPIENT_LENGTH} 个字符。`
      : '';
  const hasRecipients = chosenGroups.length > 0 || recipientInputs.length > 0;
  const metadata = Object.fromEntries((preview?.fields || []).map(field => [field.key, fieldEdits[field.key]?.value ?? field.value]));
  const oldEdits = preview
    ? Object.entries(fieldEdits).filter(([key]) => !Object.prototype.hasOwnProperty.call(metadata, key))
    : [];
  const missingTitle = preview?.fields.some(field => field.required && !metadata[field.key]?.trim()) ?? false;
  const submitDisabled = submitting || draftResetting || !draftReady || original.isFetching || !!original.data ||
    parsing || schemaStale || !preview || !files.length || missingTitle;
  const visible = !rangeInvalid && !searchPending ? history.data?.batches ?? [] : [];
  const total = history.data?.total ?? 0;
  const page = history.data?.page ?? 1;
  const pages = Math.max(1, Math.ceil(total / (history.data?.pageSize ?? PAGE_SIZE)));
  const hasFocusedBatch = visible.some(row => row.id === focusBatchId);
  const historyLoading = !rangeInvalid && (searchPending || options.isPending || (options.isSuccess && history.isPending));

  const restoreDraft = useCallback((draft: PublicationDraft) => {
    parseRequest.current?.abort();
    hadVisibleDraft.current = true;
    requestId.current = draft.pendingRequestId;
    setLink(draft.link);
    setFiles(draft.files);
    setGroupIds(draft.groupIds);
    setRecipientText(draft.recipientText);
    setPreview(draft.preview);
    setFieldEdits(draft.fieldEdits);
    setSchemaStale(draft.schemaStale);
    setPendingRequestId(draft.pendingRequestId);
    setPendingMode(draft.pendingMode === 'archive' && draft.pendingRequestId ? 'archive' : 'release');
    setParsing(false);
    setEditing(false);
    setFormError('');
    setDraftNotice(draft.pendingRequestId ? '已恢复原提交内容。' : '已恢复此浏览器中保存的草稿。');
  }, []);

  useEffect(() => {
    if (!canPublish || !draftAccount) return;
    let active = true;
    void readPublicationDraft(draftAccount).then(draft => {
      if (active && draft) restoreDraft(draft);
    }).catch(() => {
      if (active) setDraftIssue('无法读取本地草稿，请检查浏览器存储设置。');
    }).finally(() => {
      if (active) setDraftLoaded(true);
    });
    return () => { active = false; };
  }, [canPublish, draftAccount, restoreDraft]);

  useEffect(() => {
    if (!canPublish || !draftAccount || !draftReady || locked) return;
    const hasDraft = link || files.length || recipientText || groupIds.length;
    if (!hasDraft && !hadVisibleDraft.current) return;
    hadVisibleDraft.current = !!hasDraft;
    setDraftSaved(false);
    let active = true;
    void updatePublicationDraft(draftAccount, hasDraft ? {
      link, files, groupIds, recipientText, preview, fieldEdits, schemaStale: schemaStale || parsing, pendingRequestId: null,
    } : null).then(result => {
      if (!active) return;
      if (result.saved === false && result.draft) restoreDraft(result.draft);
      else {
        setDraftIssue('');
        setDraftSaved(!!hasDraft);
      }
    }).catch(() => {
      if (active) setDraftIssue('草稿暂未保存，请释放浏览器存储空间后重试。');
    });
    return () => { active = false; };
  }, [canPublish, draftAccount, draftReady, locked, link, files, groupIds, recipientText, preview, fieldEdits, schemaStale, parsing, restoreDraft]);

  const clearDraftState = useCallback(() => {
    parseRequest.current?.abort();
    hadVisibleDraft.current = false;
    requestId.current = null;
    setLink('');
    setFiles([]);
    setGroupIds([]);
    setRecipientText('');
    setFieldEdits({});
    setPendingRequestId(null);
    setPendingMode('release');
    setParsing(false);
    setPreview(null);
    setSchemaStale(false);
    setEditing(false);
    setFormError('');
    setDraftNotice('');
    setDraftSaved(false);
  }, []);

  const acceptSubmission = useCallback(async (id: string, mode: PublicationSubmissionMode, reconciled: boolean) => {
    if (draftAccount) {
      await updatePublicationDraft(draftAccount, null, id).catch(() => {
        setDraftIssue('已确认提交，浏览器未能立即清除原草稿。');
      });
    }
    clearDraftState();
    setSearch('');
    setStatusFilter('');
    setDates({ from: '', to: '' });
    setHistoryPage(1);
    setFeedback(reconciled ? '已核对原批次，服务器已受理。请在发布历史查看。' : mode === 'archive'
      ? '台账存入已受理，请在历史记录查看写入进度。'
      : '批次已提交，请在历史记录查看台账写入和审核进度。');
    await queryClient.invalidateQueries({ queryKey: ['file-publication', 'batches', scope] });
  }, [clearDraftState, draftAccount, queryClient, scope]);

  useEffect(() => {
    if (pendingRequestId && original.data) void acceptSubmission(pendingRequestId, pendingMode, true);
  }, [acceptSubmission, original.data, pendingMode, pendingRequestId]);

  useEffect(() => () => parseRequest.current?.abort(), []);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => { if (focusBatchId) setTab('publication'); }, [focusBatchId]);
  useEffect(() => {
    if (visibleTab === 'publication' && hasFocusedBatch && historyPage == null && focusBatchId) {
      document.getElementById(`file-publication-${focusBatchId}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusBatchId, hasFocusedBatch, historyPage, visibleTab]);

  function resetPreview() {
    parseRequest.current?.abort();
    setParsing(false);
    setSchemaStale(false);
    setPreview(null);
    setEditing(false);
  }

  function changeLink(value: string) {
    if (locked) return;
    setLink(value);
    requestId.current = null;
    setFormError('');
    setFeedback('');
    setFieldEdits({});
    resetPreview();
  }

  async function parse(nextLink = link, nextFiles = files) {
    const target = nextLink.trim();
    if (!target || locked) return;
    parseRequest.current?.abort();
    const request = new AbortController();
    parseRequest.current = request;
    requestId.current = null;
    setParsing(true);
    setFormError('');
    setFeedback('');
    setEditing(false);
    try {
      const result = await parsePublication(target, nextFiles, request.signal);
      if (request.signal.aborted) return;
      if (!result?.tableName || !Array.isArray(result.fields)) throw new Error('Invalid publication preview');
      setPreview(result);
      setSchemaStale(false);
    } catch (error) {
      if (!request.signal.aborted) {
        setSchemaStale(true);
        setFormError(publicationError(error, '解析失败，请核对多维表链接后重试。'));
      }
    } finally {
      if (!request.signal.aborted) setParsing(false);
    }
  }

  function replaceFiles(next: File[]) {
    setFiles(next);
    requestId.current = null;
    setFeedback('');
    setFormError('');
    if (link.trim()) void parse(link, next);
  }

  function addFiles(incoming: FileList | null) {
    if (!incoming?.length || locked) return;
    const next = new Map(files.map(file => [fileKey(file), file]));
    for (const file of incoming) next.set(fileKey(file), file);
    const list = Array.from(next.values());
    const invalid = list.find(file => {
      const name = file.name.trim().normalize('NFC');
      const separator = name.lastIndexOf('.');
      return separator < 1 || !EXTENSIONS.includes(name.slice(separator).toLowerCase()) || Array.from(name).length > 180 ||
        /[\\/\u0000-\u001f\u007f]/u.test(name) || file.size <= 0;
    });
    if (invalid) {
      setFormError(`“${invalid.name}”为空文件、名称超过 180 字符或格式不受支持。`);
      return;
    }
    if (list.length > limits.maxFiles ||
        list.some(file => file.size > limits.maxFileBytes) ||
        list.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) {
      setFormError(`每批最多 ${limits.maxFiles} 个文件，单个不超过 ${formatSize(limits.maxFileBytes)}，总计不超过 ${formatSize(limits.maxTotalBytes)}。`);
      return;
    }
    replaceFiles(list);
  }

  function dropFiles(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  function toggleGroup(id: string, checked: boolean) {
    requestId.current = null;
    setGroupIds(current => checked ? [...current, id] : current.filter(value => value !== id));
  }

  async function clearDraft() {
    if (locked) return;
    setDraftResetting(true);
    try {
      if (draftAccount) {
        const result = await updatePublicationDraft(draftAccount, null);
        if (result.saved === false && result.draft) {
          restoreDraft(result.draft);
          return;
        }
      }
      clearDraftState();
      setDraftIssue('');
    } catch {
      setDraftIssue('无法清除本地草稿，请稍后重试。');
    } finally {
      setDraftResetting(false);
    }
  }

  async function submit(mode: PublicationSubmissionMode) {
    if (!canPublish || (mode === 'archive' && !canArchive) ||
        (submitUncertain && mode !== pendingMode) || !draftReady || draftResetting || !preview || !files.length ||
        parsing || schemaStale || missingTitle || (mode === 'release' && recipientError) ||
        submitInFlight.current || original.isFetching || original.data) return;
    submitInFlight.current = true;
    setSendingMode(mode);
    setFormError('');
    setFeedback('');
    const id = requestId.current ?? createPublicationRequestId();
    requestId.current = id;
    const draft: PublicationDraft = {
      link, files, groupIds, recipientText, preview, fieldEdits, schemaStale, pendingRequestId: id, pendingMode: mode,
    };
    try {
      if (draftAccount) {
        try {
          const result = await updatePublicationDraft(draftAccount, draft, pendingRequestId);
          if (result.saved === false) {
            if (pendingRequestId) void original.refetch();
            else if (result.draft) restoreDraft(result.draft);
            return;
          }
          setDraftIssue('');
        } catch {
          setFormError('未能保存原批次，本次提交未发送。请检查浏览器存储空间后重试。');
          return;
        }
      }
      try {
        await submitPublication(id, link.trim(), groupIds, metadata, files, recipientInputs, preview.schemaVersion, mode);
      } catch (error) {
        const uncertain = submitUncertain || publicationResultUncertain(error) || publicationVersionConflict(error);
        const needsReparse = !uncertain && publicationSchemaChanged(error);
        if (uncertain) {
          setPendingMode(mode);
          setPendingRequestId(id);
          void queryClient.invalidateQueries({ queryKey: historyKey });
        } else {
          requestId.current = null;
          if (needsReparse) {
            setSchemaStale(true);
          }
          if (draftAccount) {
            const retryDraft = { ...draft, schemaStale: needsReparse, pendingRequestId: null, pendingMode: undefined };
            await updatePublicationDraft(draftAccount, retryDraft, id).catch(() => {
              setDraftIssue('浏览器未能保存草稿状态，请先核对原批次。');
              requestId.current = id;
              setPendingMode(mode);
              setPendingRequestId(id);
            });
          }
        }
        setFormError(publicationError(error, uncertain ? '暂未确认提交结果，请保留原批次并重试。' : '提交失败，请检查输入后重试。'));
        return;
      }
      await acceptSubmission(id, mode, false);
    } finally {
      submitInFlight.current = false;
      setSendingMode(null);
    }
  }

  return (
    <main className="file-publication">
      <Tabs value={visibleTab} onValueChange={setTab}>
      <header className="file-publication__command">
        <h1><Upload aria-hidden="true" />文件发布</h1>
        {canManageRecords && canReadPublication && (
          <TabsList className="file-publication__tablist" aria-label="文件发布操作">
            <TabsTrigger value="publication">提交与历史</TabsTrigger>
            <TabsTrigger value="records"><Table2 aria-hidden="true" />多维表记录</TabsTrigger>
          </TabsList>
        )}
        {canReadPublication && visibleTab === 'publication' && options.isSuccess && (
          <Button asChild variant="outline" size="sm" className="file-publication__history-link">
            <a href="#publication-history-title" aria-label="查看发布历史"><ArrowDown aria-hidden="true" />发布历史</a>
          </Button>
        )}
      </header>
      {options.isSuccess && sources.length === 0 && (
        <p className="file-publication__notice" role="status">尚未配置发布台账，请联系管理员登记多维表链接。</p>
      )}
      {canReadPublication && <TabsContent value="publication" forceMount className="file-publication__tab-content">
      <div className="file-publication__layout">
        <div className="file-publication__workspace" data-preview={canPublish}>
        {(canPublish || !options.isSuccess) && <section className="file-publication__panel">
          <h2 className="file-publication__heading"><CloudUpload aria-hidden="true" />新建发布</h2>
          {options.isPending && <p className="file-publication__state" role="status">正在读取发布配置…</p>}
          {options.isError && (
            <p className="file-publication__state" role="alert">
              {publicationError(options.error, '发布配置读取失败。')}
              <Button type="button" variant="link" onClick={() => void options.refetch()}>重新加载</Button>
            </p>
          )}
          {canPublish && (
            <form className="file-publication__form" onSubmit={event => { event.preventDefault(); void submit('release'); }}>
              {!draftReady && <p className="file-publication__state" role="status">正在读取本地草稿…</p>}
              {draftNotice && <p className="file-publication__state" role="status">{draftNotice}</p>}
              {draftSaved && !draftNotice && !submitUncertain &&
                <p className="file-publication__state" role="status">草稿已保存在此浏览器</p>}
              <fieldset disabled={locked}>
                 <legend className="file-publication__label">上传文件 <span>同批文件合并为一条发布记录</span></legend>
                <input
                  ref={picker} type="file" aria-label="选择上传文件" className="sr-only" tabIndex={-1}
                  accept={EXTENSIONS.join(',')} multiple
                  onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }}
                />
                <button
                  type="button" className="file-publication__drop" data-dragging={dragging}
                  onClick={() => picker.current?.click()} onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }}
                  onDragLeave={() => setDragging(false)} onDrop={dropFiles}
                >
                  <CloudUpload aria-hidden="true" />
                   <span className="file-publication__drop-copy">
                     <strong>{files.length ? '添加文件' : '选择文件或拖放到这里'}</strong>
                     <span>PDF、Word、Excel、图片或压缩包</span>
                     <span>最多 {limits.maxFiles} 个 · 单个 {formatSize(limits.maxFileBytes)} · 合计 {formatSize(limits.maxTotalBytes)}</span>
                   </span>
                </button>
                {files.length > 0 && (
                   <>
                   <p className="file-publication__file-total">已选 {files.length} 个文件 · 共 {formatSize(totalSize)}</p>
                  <ul className="file-publication__files" aria-label="本批次文件">
                    {files.map(file => (
                      <li key={fileKey(file)}>
                        <FileText aria-hidden="true" />
                        <span>{file.name}</span><small>{formatSize(file.size)}</small>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除 ${file.name}`}
                          onClick={() => replaceFiles(files.filter(item => item !== file))}><X aria-hidden="true" /></Button>
                      </li>
                    ))}
                  </ul>
                   </>
                )}
              </fieldset>

              <fieldset disabled={locked} className="file-publication__source">
                <label className="file-publication__label" htmlFor="publication-bitable">台账多维表 <span>用于保存发布记录</span></label>
                <div className="file-publication__source-input">
                  <Input
                     id="publication-bitable" type="url" value={link}
                    placeholder="粘贴飞书多维表链接" maxLength={1000}
                    onChange={event => changeLink(event.target.value)}
                    onPaste={event => {
                      const target = event.clipboardData.getData('text').trim();
                      if (locked || target.length > 1000 || !isFeishuLink(target)) return;
                      event.preventDefault();
                      changeLink(target);
                      void parse(target);
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (!parsing) void parse();
                      }
                    }}
                  />
                  <Button type="button" variant="outline" disabled={!link.trim() || parsing} onClick={() => void parse()}>
                    {parsing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
                    {parsing ? '解析中' : schemaStale ? '重新解析' : '解析链接'}
                  </Button>
                </div>
                 {sources.length === 1 && !link && <Button type="button" variant="link" className="file-publication__source-shortcut"
                  onClick={() => {
                    changeLink(sources[0].url);
                    void parse(sources[0].url);
                  }}>
                  使用{sources[0].label}
                </Button>}
                 {sources.length > 1 && <select className="file-publication__select file-publication__source-select"
                   aria-label="选择已登记台账" value={sources.some(source => source.url === link) ? link : ''}
                   onChange={event => {
                     const url = event.target.value;
                     if (!url || url === link) return;
                     changeLink(url);
                     void parse(url);
                   }}>
                   <option value="" disabled>选择已登记台账</option>
                   {sources.map(source => <option key={source.url} value={source.url}>{source.label}</option>)}
                 </select>}
                <div role="status">
                  {parsing ? <p className="file-publication__state">正在核对台账字段…</p> : preview && !schemaStale && (
                    <p className="file-publication__source-ready">
                      <CheckCircle2 aria-hidden="true" /><span>已解析 {preview.tableName}</span>
                      {isFeishuLink(preview.sourceUrl) && <a href={preview.sourceUrl} target="_blank" rel="noreferrer">打开飞书台账</a>}
                    </p>
                  )}
                </div>
                {schemaStale && formError && <p className="file-publication__alert" role="alert">{formError}</p>}
              </fieldset>

              {preview && !parsing && (
                <fieldset disabled={locked}>
                  <legend className="sr-only">台账写入预览</legend>
                  <div className="file-publication__metadata-heading">
                    <p className="file-publication__label">
                      台账写入预览 <span>{schemaStale ? '待重新解析' : editing ? '手动编辑' : '上传后可调整自动识别内容'}</span>
                    </p>
                    <Button type="button" size="sm" variant={editing ? 'outline' : 'ghost'} disabled={parsing || !preview.fields.length}
                      onClick={() => setEditing(value => !value)}>
                      {editing ? <Check aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                      {editing ? '完成编辑' : '编辑资料'}
                    </Button>
                  </div>
                  {preview.fields.length === 0 ? <p className="file-publication__state">该台账没有可预览的资料字段。</p> : (
                    <div className="file-publication__metadata">
                      {preview.fields.map((field, index) => {
                        const Editor = /备注|说明|描述/u.test(field.name) ? Textarea : Input;
                        return (
                          <div key={field.key} className="file-publication__metadata-field">
                            <label htmlFor={`publication-field-${index}`}>{field.name}{field.required && <span>（必填）</span>}</label>
                            <Editor id={`publication-field-${index}`} value={metadata[field.key] ?? ''}
                              readOnly={!editing} required={editing && field.required} maxLength={field.maxLength ?? 2000}
                              placeholder={files.length ? '空白' : '选择文件后自动填入'}
                              onChange={event => {
                                requestId.current = null;
                                const value = event.target.value;
                                setFieldEdits(current => ({ ...current, [field.key]: { name: field.name, value } }));
                              }} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {oldEdits.length > 0 && (
                    <div className="file-publication__alert" role="status">
                      <p>以下已编辑的字段已从台账写入预览移除，可复制到当前字段。</p>
                      <ul>{oldEdits.map(([key, field]) => <li key={key}>{field.name} · {field.value || '空白'}</li>)}</ul>
                    </div>
                  )}
                  <dl className="file-publication__write-target">
                    <div>
                      <dt>附件写入字段</dt>
                      <dd>{preview.attachmentField
                        ? <><strong>{preview.attachmentField.name}</strong><span>{files.length ? `本批 ${files.length} 个文件写入同一条记录` : '选择文件后可查看附件清单'}</span></>
                        : '当前服务未返回，无法预览附件列名称'}</dd>
                    </div>
                    {preview.attachmentField && !preview.codeFieldKey && preview.code && (
                      <div><dt>文件编号</dt><dd><strong>{preview.code}</strong><span>台账未配置编号列，此编号用于发布历史和通知。</span></dd></div>
                    )}
                    {preview.batchField && <div><dt>批次标识字段</dt><dd><strong>{preview.batchField.name}</strong><span>提交时自动填入</span></dd></div>}
                  </dl>
                  {files.length > 0 && missingTitle && <p className="file-publication__state" role="status">请填写必填的资料名称后提交。</p>}
                </fieldset>
              )}

              <fieldset disabled={locked}>
                <legend className="file-publication__label">通知对象 <span>可选</span></legend>
                {groups.length > 0 && <div className="file-publication__groups">
                  {groups.map(group => (
                    <label key={group.id}>
                      <input type="checkbox" checked={groupIds.includes(group.id)} onChange={event => toggleGroup(group.id, event.target.checked)} />
                      <span>{group.name}</span>
                    </label>
                  ))}
                </div>}
                <div className="file-publication__recipient-input">
                  <label htmlFor="publication-recipients">手动填写人员或群会话 ID</label>
                  <Textarea id="publication-recipients" rows={3} value={recipientText} autoComplete="off"
                    placeholder="每行一个姓名或飞书 ID" maxLength={MAX_RECIPIENTS * (MAX_RECIPIENT_LENGTH * 2 + 1) - 1}
                    aria-invalid={!!recipientError} aria-describedby={recipientError ? 'publication-recipient-error' : 'publication-recipient-help'}
                    onChange={event => { requestId.current = null; setRecipientText(event.target.value); }} />
                  <p id="publication-recipient-help" className="file-publication__state">
                    人员请填在职姓名或本应用的 Open ID（ou_ 开头），群会话 ID 以 oc_ 开头。提交时核对，留空且未选群组时不发通知。
                  </p>
                  {recipientError && <p id="publication-recipient-error" className="file-publication__alert" role="alert">{recipientError}</p>}
                </div>
              </fieldset>

              {!schemaStale && formError && <p className="file-publication__alert" role="alert">{formError}</p>}
              {draftIssue && !formError && <p className="file-publication__alert" role="alert">{draftIssue}</p>}
              {feedback && <p className="file-publication__success" role="status">{feedback}</p>}
              {submitUncertain && <div className="file-publication__state">
                <p role="status">{original.isFetching ? '正在核对原批次…' : original.isError
                  ? publicationError(original.error, '未能核对原批次，请重试。')
                  : original.data ? '服务器已受理原批次。' : '暂未查到原批次。重试时仍会使用同一个申请标识。'}</p>
                <Button type="button" variant="outline" size="sm" disabled={submitting || original.isFetching || !!original.data}
                  onClick={() => void original.refetch()}>核对原批次</Button>
              </div>}
              {canArchive && !submitUncertain && <p className="file-publication__state">
                直接存入台账仅保存文件和资料，无需审核，也不发送通知。
              </p>}
              <div className="file-publication__footer">
                 <span>
                   <ShieldCheck aria-hidden="true" />{hasRecipients ? '审核通过后向通知对象发送汇总卡片' : '本批次未选择通知对象'}
                   {hasRecipients && files.length > 0 && <a className="file-publication__preview-link" href="#publication-preview-title">预览通知</a>}
                 </span>
                <div>
                  <Button type="button" variant="outline" disabled={locked} onClick={() => { void clearDraft(); setFeedback(''); }}>重置</Button>
                  {(!submitUncertain || pendingMode === 'release') &&
                    <Button type="submit" disabled={submitDisabled || !!recipientError}>
                      {sendingMode === 'release' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                      {sendingMode === 'release' ? '提交中' : submitUncertain ? '重试提交原批次' : '提交发布'}
                    </Button>}
                  {((canArchive && !submitUncertain) || (submitUncertain && pendingMode === 'archive')) &&
                    <Button type="button" variant="outline" disabled={submitDisabled || !canArchive} onClick={() => void submit('archive')}>
                      {sendingMode === 'archive' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Table2 aria-hidden="true" />}
                      {sendingMode === 'archive' ? '存入中' : submitUncertain ? '重试存入原批次' : '直接存入台账'}
                    </Button>}
                </div>
              </div>
            </form>
          )}
        </section>}

        {canPublish && (
          <section className="file-publication__panel file-publication__preview-panel" aria-labelledby="publication-preview-title">
            <h2 id="publication-preview-title" className="file-publication__heading"><FileText aria-hidden="true" />通知卡片预览</h2>
            <div className="file-publication__preview">
              <h3><Megaphone aria-hidden="true" />文件发布通知</h3>
              <dl>
                {!parsing && !schemaStale && preview?.fields.length ? preview.fields.map(field => (
                  <div key={field.key}><dt>{field.name}</dt><dd>{metadata[field.key] || '—'}</dd></div>
                )) : <div><dt>资料信息</dt><dd>{parsing ? '解析中' : schemaStale ? '待重新解析' : '待解析'}</dd></div>}
                <div><dt>通知对象</dt><dd>{hasRecipients ? [...chosenGroups.map(group => group.name), ...recipientInputs].join('、') : '未选择，不发送通知'}</dd></div>
                {!parsing && !schemaStale && preview?.attachmentField && <div><dt>附件写入字段</dt><dd>{preview.attachmentField.name}</dd></div>}
                <div><dt>附件</dt><dd>{files.length ? `${files.length} 个 · ${formatSize(totalSize)}` : '未选文件'}</dd></div>
              </dl>
              {files.length > 0 && <ul aria-label="通知所含文件">{files.map(file => <li key={fileKey(file)}>{file.name}</li>)}</ul>}
              {hasRecipients && <p><Download aria-hidden="true" />审核通过后，收件人可从卡片进入发布记录</p>}
            </div>
          </section>
        )}
        </div>

        <section className="file-publication__panel" aria-labelledby="publication-history-title">
          <div className="file-publication__history-heading">
            <h2 id="publication-history-title" className="file-publication__heading"><History aria-hidden="true" />发布历史记录</h2>
            <div className="file-publication__history-filters">
              <div className="file-publication__search">
                <Search aria-hidden="true" />
                <Input type="search" aria-label="搜索发布记录" placeholder="名称、文件编号或批次 ID" value={search} maxLength={120}
                  onChange={event => { setSearch(event.target.value); setHistoryPage(1); }} />
              </div>
              <select className="file-publication__select" aria-label="按发布状态筛选" value={statusFilter}
                onChange={event => { setStatusFilter(event.target.value); setHistoryPage(1); }}>
                <option value="">全部状态</option>
                {Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              <div className="file-publication__history-dates">
                <label>从 <Input type="date" aria-label="提交开始日期" value={dates.from} max={dates.to || undefined}
                  onChange={event => { setDates({ ...dates, from: event.target.value }); setHistoryPage(1); }} /></label>
                <label>至 <Input type="date" aria-label="提交结束日期" value={dates.to} min={dates.from || undefined}
                  onChange={event => { setDates({ ...dates, to: event.target.value }); setHistoryPage(1); }} /></label>
              </div>
            </div>
          </div>
          {rangeInvalid && <p role="alert" className="file-publication__alert">提交结束日期应当晚于或等于开始日期。</p>}
          {historyLoading && <p role="status" className="file-publication__state">正在读取发布记录…</p>}
          {!rangeInvalid && !searchPending && history.isError && <p role="alert" className="file-publication__state">
            {publicationError(history.error, '发布记录读取失败。')}
            <Button type="button" variant="link" onClick={() => void history.refetch()}>重新加载</Button>
          </p>}
          {!rangeInvalid && !historyLoading && history.isSuccess && !visible.length && (
            <div className="file-publication__empty">
              {hasHistoryFilters ? '未找到匹配的发布记录' : '暂无发布记录'}
              {hasHistoryFilters && <Button variant="link" type="button" onClick={() => {
                setSearch(''); setSearchQuery(''); setStatusFilter(''); setDates({ from: '', to: '' }); setHistoryPage(1);
              }}>清除筛选</Button>}
            </div>
          )}
          {!!visible.length && (
            <div>
              <table className="file-publication__table">
                <thead><tr>{['资料名称', '文件编号', '通知对象', '发布人', '提交时间', '状态', '操作']
                  .map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
                <tbody>
                  {visible.map(batch => {
                    const canReview = batch.canReview && batch.status === 'pending';
                    const archived = batch.status === 'archived';
                    const canDownload = batch.canDownload && (archived || batch.status === 'publishing' || batch.status === 'published');
                    const deliveryNeedsCheck = batch.status === 'published' && !!batch.error;
                    return (
                    <tr key={batch.id} id={`file-publication-${batch.id}`} data-focused={batch.id === focusBatchId}>
                      <td data-label="资料名称">
                        <strong>{batch.title || '未命名批次'}</strong>
                        <small>{batch.files.length} 个文件{batch.files[0] && ` · ${batch.files[0].name}`}{batch.files.length > 1 && ' 等'}</small>
                      </td>
                      <td data-label="文件编号">{batch.code || '—'}</td>
                      <td data-label="通知对象"><div className="file-publication__group-tags">
                        {batch.groups.length ? batch.groups.map(group => <span key={group.id}>{recipientLabel(group)}</span>) : '—'}
                      </div></td>
                      <td data-label="发布人">{batch.publisher || '—'}</td>
                      <td data-label="提交时间">{formatDate(batch.submittedAt)}</td>
                      <td data-label="状态">
                        <span className="file-publication__status" data-state={deliveryNeedsCheck ? 'delivery-check' : batch.status}>
                          {archived || (batch.status === 'published' && !deliveryNeedsCheck) ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
                          {batchStatusLabel(batch)}
                        </span>
                        {(batch.error || batch.reason) && <small className="file-publication__issue">{batch.error || batch.reason}</small>}
                      </td>
                      <td data-label="操作">
                        <div className="file-publication__row-actions">
                          {canReview &&
                            <Button type="button" variant="outline" size="sm" onClick={() => setDetail({ batch, mode: 'review' })}>审核</Button>}
                          {canDownload &&
                            <Button type="button" variant="outline" size="sm" onClick={() => setDetail({ batch, mode: 'download' })}>
                              <Download aria-hidden="true" />下载
                            </Button>}
                          {!canReview && (!canDownload || archived || batch.groups.length > 0) &&
                            <Button type="button" variant="ghost" size="sm" onClick={() => setDetail({ batch, mode: 'details' })}>查看详情</Button>}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <nav className="file-publication__pagination" aria-label="发布历史分页">
                <span>{pages > 1 ? `第 ${page} / ${pages} 页 · ` : ''}共 {total} 条</span>
                {pages > 1 && <>
                  <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setHistoryPage(page - 1)}>上一页</Button>
                  <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => setHistoryPage(page + 1)}>下一页</Button>
                </>}
              </nav>
            </div>
          )}
        </section>
      </div>
      {detail && (
        <BatchDialog key={`${detail.batch.id}:${detail.mode}`} initialBatch={detail.batch} mode={detail.mode} scope={scope}
          close={() => setDetail(null)} reload={() => queryClient.invalidateQueries({ queryKey: historyKey })} />
      )}
      </TabsContent>}
      {canManageRecords && <TabsContent value="records" forceMount className="file-publication__tab-content">
        <RecordManager defaultLink={link} sources={sources} />
      </TabsContent>}
      </Tabs>
    </main>
  );
}

function BatchDialog({ initialBatch, mode, scope, close, reload }: {
  initialBatch: PublicationBatch;
  mode: BatchMode;
  scope: string;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const detail = useQuery({
    queryKey: ['file-publication', 'batch-detail', scope, initialBatch.id],
    queryFn: ({ signal }) => loadPublicationBatch(initialBatch.id, signal),
    placeholderData: initialBatch,
    retry: false,
    refetchOnMount: 'always',
    refetchInterval: query => batchIsActive(query.state.data) ? 4_000 : false,
  });
  const batch = detail.data ?? initialBatch;
  const confirmedDetail = detail.isSuccess && detail.isFetchedAfterMount && !detail.isPlaceholderData;
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const [retryRecipientId, setRetryRecipientId] = useState<string | null>(null);
  const [deliveryFeedback, setDeliveryFeedback] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const retryIds = useRef(new Map<string, string>());
  const downloadRequest = useRef<AbortController>(null);
  const canReview = confirmedDetail && mode === 'review' && batch.canReview && batch.status === 'pending';
  const canDownloadFiles = confirmedDetail && batch.canDownload && (
    mode !== 'details' || batch.status === 'published' || batch.status === 'publishing' || batch.status === 'archived'
  );
  const deliveriesById = new Map(batch.deliveries?.map(delivery => [delivery.recipientId, delivery]));

  useEffect(() => () => downloadRequest.current?.abort(), []);

  function retryStorageKey(recipientId: string) {
    return `file-publication:delivery-retry:${JSON.stringify([scope, batch.id, recipientId])}`;
  }

  function originalRetryId(recipientId: string) {
    const current = retryIds.current.get(recipientId);
    if (current) return current;
    try {
      const stored = window.sessionStorage.getItem(retryStorageKey(recipientId));
      return stored && PUBLICATION_UUID.test(stored) ? stored : undefined;
    } catch {
      return undefined;
    }
  }

  function rememberRetryId(recipientId: string, requestId?: string) {
    if (requestId) retryIds.current.set(recipientId, requestId);
    else retryIds.current.delete(recipientId);
    try {
      const key = retryStorageKey(recipientId);
      if (requestId) window.sessionStorage.setItem(key, requestId);
      else window.sessionStorage.removeItem(key);
    } catch {
      // Retain the request ID in this dialog if storage is unavailable.
    }
  }

  async function download(file: PublicationFile) {
    if (downloadRequest.current) return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloadId(file.id);
    setError('');
    try {
      await downloadPublicationFile(batch.id, file, request.signal);
    } catch (requestError) {
      if (!request.signal.aborted) setError(publicationError(requestError, '文件下载失败，请稍后重试。'));
    } finally {
      downloadRequest.current = null;
      if (!request.signal.aborted) setDownloadId(null);
    }
  }

  async function review(decision: 'approve' | 'reject') {
    if (!canReview || inFlight.current || (decision === 'reject' && !reason.trim())) return;
    inFlight.current = true;
    setDecisionPending(true);
    setError('');
    try {
      await reviewPublication(batch.id, decision, decision === 'reject' ? reason.trim() : undefined);
      await reload();
      close();
    } catch (requestError) {
      setError(publicationError(requestError, '审核结果暂未确认，请刷新记录后重试。'));
      void Promise.all([detail.refetch(), reload()]);
    } finally {
      inFlight.current = false;
      setDecisionPending(false);
    }
  }

  async function retryDelivery(delivery: PublicationDelivery) {
    if (!confirmedDetail || detail.isFetching || inFlight.current || delivery.status !== 'failed' || !delivery.canRetry) return;
    const { recipientId } = delivery;
    const requestId = originalRetryId(recipientId) ?? createPublicationRequestId();
    rememberRetryId(recipientId, requestId);
    inFlight.current = true;
    setRetryRecipientId(recipientId);
    setError('');
    setDeliveryFeedback('');
    try {
      await retryPublicationDeliveries(batch.id, [recipientId], requestId);
      rememberRetryId(recipientId);
      setDeliveryFeedback('补发已受理，正在核对投递状态。');
    } catch (requestError) {
      const message = publicationResultUncertain(requestError)
        ? '补发受理结果待核对。'
        : publicationError(requestError, '暂时无法核对补发结果。');
      setError(`${message} 可刷新投递状态。再次重试将沿用原补发请求。`);
    } finally {
      try {
        await Promise.all([detail.refetch(), reload()]);
      } finally {
        inFlight.current = false;
        setRetryRecipientId(null);
      }
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !decisionPending && !retryRecipientId) close(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'review' ? '审核发布批次' : mode === 'download' ? '下载批次文件' : '发布批次详情'}</DialogTitle>
          <DialogDescription>{batch.title || '未命名批次'}{batch.code ? ` · ${batch.code}` : ''}</DialogDescription>
        </DialogHeader>
        <dl className="file-publication__batch-info">
          <div><dt>状态</dt><dd>{batchStatusLabel(batch)}</dd></div>
          <div><dt>批次 ID</dt><dd>{batch.id}</dd></div>
          {batch.status === 'archived' ? <div><dt>保存方式</dt><dd>仅保存到多维表</dd></div> :
            !batch.groups.length && <div><dt>通知对象</dt><dd>未选择</dd></div>}
        </dl>
        {(batch.error || batch.reason) && <p className="file-publication__alert">{batch.error || batch.reason}</p>}
        {(batch.groups.length > 0 || detail.isError || !confirmedDetail) && (
          <section className="file-publication__delivery-panel" aria-labelledby="publication-delivery-title">
            <div className="file-publication__delivery-header">
              <h3 id="publication-delivery-title">通知投递状态</h3>
              <Button type="button" variant="outline" size="sm" disabled={detail.isFetching || !!retryRecipientId}
                onClick={() => void detail.refetch()}>刷新状态</Button>
            </div>
            {detail.isError && <p role="alert" className="file-publication__alert">{publicationError(detail.error, '暂时无法核对批次，请刷新。')}</p>}
            {!detail.isError && !confirmedDetail && <p role="status">正在读取投递状态…</p>}
            {batch.groups.length > 0 && (
              <ul className="file-publication__delivery-list">
                {batch.groups.map(group => {
                  const delivery = deliveriesById.get(group.id);
                  const retryAllowed = confirmedDetail && delivery?.status === 'failed' && delivery.canRetry;
                  return (
                    <li key={group.id}>
                      <div>
                        <strong>{group.kind === 'person' || group.id.startsWith('ou_') ? '人员' : '群组'} · {recipientLabel(group)}</strong>
                        {delivery?.message && <small>{delivery.message}</small>}
                      </div>
                      <span className="file-publication__delivery-state" data-state={delivery?.status || 'uncertain'}>
                        {delivery ? DELIVERY_STATUS[delivery.status] : '待核对'}
                      </span>
                      {retryAllowed && <Button type="button" variant="outline" size="sm" disabled={!!retryRecipientId || detail.isFetching}
                        aria-label={`补发给 ${group.name}`}
                        onClick={() => void retryDelivery(delivery)}>
                        {retryRecipientId === group.id ? '补发中' : originalRetryId(group.id) ? '重试原补发' : '补发'}
                      </Button>}
                    </li>
                  );
                })}
              </ul>
            )}
            {deliveryFeedback && <p className="file-publication__success" role="status">{deliveryFeedback}</p>}
          </section>
        )}
        <ul className="file-publication__files file-publication__dialog-files" aria-label="批次文件">
          {batch.files.map(file => (
            <li key={file.id}>
              <FileText aria-hidden="true" /><span>{file.name}</span><small>{formatSize(file.size)}</small>
              {canDownloadFiles && (
                <Button type="button" variant="outline" size="sm" disabled={!!downloadId} onClick={() => void download(file)}>
                  {downloadId === file.id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                  下载<span className="sr-only">{file.name}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="file-publication__alert" role="alert">{error}</p>}
        {canReview && (
          <div className="space-y-3">
            {rejecting && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="publication-reject-reason">驳回原因</label>
                <Textarea id="publication-reject-reason" value={reason} maxLength={500}
                  disabled={decisionPending} onChange={event => setReason(event.target.value)} />
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {rejecting ? (
                <>
                  <Button type="button" variant="outline" disabled={decisionPending} onClick={() => setRejecting(false)}>返回</Button>
                  <Button type="button" variant="destructive" disabled={decisionPending || !reason.trim()} onClick={() => void review('reject')}>确认驳回</Button>
                </>
              ) : (
                <>
                  <Button type="button" variant="outline" disabled={decisionPending} onClick={() => setRejecting(true)}>驳回</Button>
                  <Button type="button" disabled={decisionPending} onClick={() => void review('approve')}>
                    {decisionPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                    通过审核
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
