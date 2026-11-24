import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, Link2, Loader2, Pencil, Plus, RefreshCw, Search, Table2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createPublicationRequestId, loadPublicationRecords, mutatePublicationRecord, publicationError,
  publicationResultUncertain, publicationVersionConflict, type PublicationOptions, type PublicationRecord,
  type PublicationRecordField, type PublicationRecordMutationResult, type PublicationRecordPage, type PublicationRecordSearch,
  type PublicationRecordValue, type PublicationRecordValues,
} from './api';
import './records-layout.css';

type Operation = { kind: 'create' } | { kind: 'update' | 'delete'; record: PublicationRecord };
type RecordView = { link: string; cursors: (string | undefined)[]; page: PublicationRecordPage; search?: PublicationRecordSearch };
const operationTitle = { create: '新增记录', update: '编辑记录', delete: '删除记录' };
const operationSuccess = { create: '记录已新增', update: '记录已保存', delete: '记录已删除' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const taipeiOffset = 8 * 60 * 60 * 1000;

function fieldCanEdit(field: PublicationRecordField, row?: PublicationRecord): boolean {
  return field.editable && !row?.readonlyFields?.includes(field.key);
}

function cellText(field: PublicationRecordField, value: PublicationRecordValue | undefined): string {
  if (value == null || value === '') return '—';
  if (field.type === 5 && typeof value === 'number' && Number.isFinite(new Date(value).getTime())) {
    return dateFormat.format(value);
  }
  if (typeof value === 'boolean') return value ? '已勾选' : '未勾选';
  if (Array.isArray(value)) return value.join('、') || '—';
  if (typeof value === 'object') return value.text || value.link || '—';
  return String(value);
}

function isHttpLink(value: string): boolean {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function RecordCell({ field, row, compact = false }: {
  field: PublicationRecordField; row: PublicationRecord; compact?: boolean;
}) {
  const value = row.values[field.key];
  const text = cellText(field, value);
  const content = field.type === 15 && value && typeof value === 'object' && !Array.isArray(value) && isHttpLink(value.link)
    ? <a href={value.link} target="_blank" rel="noopener noreferrer">{text}</a>
    : text;
  const abbreviated = compact && (text.length > 64 || text.split('\n').length > 2);
  return <>
    {abbreviated ? <details className="file-publication__record-cell-detail">
      <summary>
        <span>{Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 35).join('')}…</span>
        <small>展开全文</small><small>收起全文</small>
      </summary>
      {content}
    </details> : content}
    {field.editable && !fieldCanEdit(field, row) && <small className="file-publication__record-format">保留原格式</small>}
  </>;
}

function RecordCard({ row, fields, actions }: {
  row: PublicationRecord; fields: PublicationRecordField[]; actions: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = fields[0];
  const value = first && row.values[first.key];
  const title = !first || value == null || value === '' ? '未填写' : cellText(first, value);
  return (
    <li className="file-publication__record-card">
      <details onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>
          <div>
            {first && <small>{first.name}</small>}
            <strong>{title}</strong>
          </div>
          <span>字段详情 <ChevronDown aria-hidden="true" /></span>
        </summary>
        {expanded && <dl>
          {fields.map(field => <div key={field.key}>
            <dt>{field.name}{!field.editable && <small>只读</small>}</dt>
            <dd><RecordCell field={field} row={row} /></dd>
          </div>)}
        </dl>}
      </details>
      {actions && <div className="file-publication__record-card-actions">{actions}</div>}
    </li>
  );
}

export default function RecordManager({ defaultLink, sources }: {
  defaultLink: string;
  sources: PublicationOptions['sources'];
}) {
  const [enteredLink, setEnteredLink] = useState<string>();
  const [view, setView] = useState<RecordView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [keyword, setKeyword] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const lookup = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const link = enteredLink ?? defaultLink;
  const page = view?.page;
  const rows = page?.records ?? [];
  const textFields = page?.fields.filter(field => field.type === 1) ?? [];
  const hasWritableFields = page?.fields.some(field => field.editable);
  const hasRowActions = page?.permissions.delete || (page?.permissions.update && hasWritableFields)
    || rows.some(row => row.managed);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; lookup.current?.abort(); };
  }, []);

  function changeLink(value: string) {
    lookup.current?.abort();
    setEnteredLink(value);
    setView(null);
    setLoading(false);
    setError('');
    setFeedback('');
    setKeyword('');
    setFieldKey('');
  }

  async function load(target: string, cursors: RecordView['cursors'] = [undefined], search?: PublicationRecordSearch) {
    if (!target || !mounted.current) return;
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setEnteredLink(target);
    setLoading(true);
    setError('');
    try {
      const result = await loadPublicationRecords(target, cursors.at(-1), controller.signal, search);
      if (!controller.signal.aborted) setView({ link: target, cursors, page: result, search });
    } catch (fetchError) {
      if (!controller.signal.aborted) setError(publicationError(fetchError, '读取多维表失败，请重试。'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function searchRecords(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || loading || !keyword.trim()) return;
    setFeedback('');
    void load(view.link, [undefined], { keyword: keyword.trim(), ...(fieldKey ? { fieldKey } : {}) });
  }

  function clearSearch() {
    if (!view || loading) return;
    setKeyword('');
    setFieldKey('');
    setFeedback('');
    void load(view.link);
  }

  function readSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || !link.trim()) return;
    setKeyword('');
    setFieldKey('');
    setFeedback('');
    void load(link.trim());
  }

  function paste(event: ClipboardEvent<HTMLInputElement>) {
    const target = event.clipboardData.getData('text').trim();
    if (!isHttpLink(target) || target.length > 1000) return;
    event.preventDefault();
    changeLink(target);
    void load(target);
  }

  function selectSource(target: string) {
    if (target === view?.page.sourceUrl || target === view?.link || (loading && target === link)) return;
    changeLink(target);
    void load(target);
  }

  function rowActions(row: PublicationRecord, currentPage: PublicationRecordPage) {
    if (row.managed) return <small title="该记录当前由发布流程维护">发布流程保护</small>;
    const canEdit = currentPage.permissions.update && currentPage.fields.some(field => fieldCanEdit(field, row));
    if (!canEdit && !currentPage.permissions.delete) return null;
    return (
      <div className="file-publication__row-actions">
        {canEdit && <Button type="button" size="sm" variant="outline" disabled={loading}
          onClick={() => setOperation({ kind: 'update', record: row })}><Pencil aria-hidden="true" />编辑</Button>}
        {currentPage.permissions.delete && <Button type="button" size="sm" variant="ghost" disabled={loading}
          className="file-publication__records-delete" onClick={() => setOperation({ kind: 'delete', record: row })}>
          <Trash2 aria-hidden="true" />删除
        </Button>}
      </div>
    );
  }

  function afterMutation(result: PublicationRecordMutationResult, kind: Operation['kind']) {
    if (!mounted.current || !view) return;
    setOperation(null);
    setFeedback(operationSuccess[kind] + '，已同步至多维表。');
    setView(current => {
      if (!current || current.search) return current;
      const records = 'deleted' in result
        ? current.page.records.filter(row => row.id !== result.id)
        : current.page.records.map(row => row.id === result.record.id ? result.record : row);
      return { ...current, page: { ...current.page, records } };
    });
    void load(view.link, kind === 'create' || view.search ? [undefined] : view.cursors, view.search);
  }

  return (
    <div className="file-publication__layout">
      <section className="file-publication__panel file-publication__record-browser" aria-labelledby="publication-records-title">
        <h2 id="publication-records-title" className="file-publication__heading"><Table2 aria-hidden="true" />多维表记录</h2>
        <form className="file-publication__records-source" onSubmit={readSource}>
          {sources.length > 0 && (
            <div className="file-publication__record-sources" role="group" aria-label="已配置台账">
              <span>已配置台账</span>
              {sources.map(source => (
                <Button key={source.url} type="button" size="sm" variant="outline"
                  aria-pressed={source.url === (page?.sourceUrl ?? link)}
                  onClick={() => selectSource(source.url)}>
                  <Table2 aria-hidden="true" />{source.label}
                </Button>
              ))}
            </div>
          )}
          <label className="file-publication__label" htmlFor="record-source-link">台账多维表链接</label>
          <div className="file-publication__source-input">
            <Input id="record-source-link" value={link} type="url"
              maxLength={1000} placeholder="粘贴已授权的飞书多维表链接" onPaste={paste}
              onChange={event => changeLink(event.target.value)} />
            <Button type="submit" disabled={loading || !link.trim()}>
              {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              {loading ? '读取中' : '读取多维表'}
            </Button>
          </div>
        </form>
        {loading && !page && <p className="file-publication__record-loading" role="status">正在读取台账字段和记录…</p>}
        {feedback && <p className="file-publication__success" role="status">{feedback}</p>}
        {error && <p className="file-publication__alert" role="alert">{error}</p>}
        {page && view && (
          <>
            <div className="file-publication__records-toolbar">
              <div>
                <div className="file-publication__record-title">
                  <h3>{page.tableName}</h3>
                  {isHttpLink(page.sourceUrl) && <a href={page.sourceUrl} target="_blank" rel="noopener noreferrer">
                    飞书原表 <ExternalLink aria-hidden="true" />
                  </a>}
                </div>
                <p className="file-publication__records-count" aria-live="polite">
                  {loading ? '正在更新 · ' : ''}{page.fields.length} 个字段 · 本页 {rows.length} 条
                  {page.total !== undefined && ` · ${view.search ? '匹配' : '共'} ${page.total} 条`}
                </p>
              </div>
              <div className="file-publication__row-actions">
                <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(view.link, view.cursors, view.search)}>
                  <RefreshCw aria-hidden="true" />刷新
                </Button>
                {page.permissions.create && hasWritableFields && (
                  <Button size="sm" disabled={loading} onClick={() => setOperation({ kind: 'create' })}>
                    <Plus aria-hidden="true" />新增记录
                  </Button>
                )}
              </div>
            </div>
            {(textFields.length > 0 || view.search) && (
              <form className="file-publication__record-search" role="search" aria-label="跨页搜索多维表记录" onSubmit={searchRecords}>
                <Input type="search" aria-label="全表搜索关键词" value={keyword} maxLength={128}
                  placeholder="搜索整张表的文本字段" onChange={event => setKeyword(event.target.value)} />
                <select className="file-publication__select" aria-label="搜索字段范围" value={fieldKey}
                  onChange={event => setFieldKey(event.target.value)}>
                  <option value="">全部文本字段</option>
                  {textFields.map(field => <option key={field.key} value={field.key}>{field.name}</option>)}
                </select>
                <div className="file-publication__row-actions">
                  <Button type="submit" variant="outline" size="sm" disabled={loading || !keyword.trim()}>
                    <Search aria-hidden="true" />搜索
                  </Button>
                  {view.search && <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={clearSearch}>清除搜索</Button>}
                </div>
              </form>
            )}
            {view.search && <p className="file-publication__record-query" role="status">正在显示「{view.search.keyword}」的搜索结果</p>}
            <div className="file-publication__records-scroll" role="region" aria-label={`${page.tableName}字段与记录`} tabIndex={0}>
              <table className="file-publication__records-table" aria-busy={loading}>
                <thead><tr>
                  {page.fields.map(field => <th key={field.key} scope="col">
                    {field.name}{!field.editable && <small>只读</small>}
                  </th>)}
                  {hasRowActions && <th className="file-publication__record-action-column" scope="col">操作</th>}
                </tr></thead>
                <tbody>
                  {rows.map(row => <tr key={row.id}>
                    {page.fields.map(field => <td key={field.key}><RecordCell field={field} row={row} compact /></td>)}
                    {hasRowActions && <td className="file-publication__record-action-column">{rowActions(row, page) ?? '—'}</td>}
                  </tr>)}
                </tbody>
              </table>
            </div>
            {rows.length > 0 && <ul className="file-publication__record-cards" aria-label={page.tableName + '记录'} aria-busy={loading}>
              {rows.map(row => <RecordCard key={row.id} row={row} fields={page.fields} actions={rowActions(row, page)} />)}
            </ul>}
            {rows.length === 0 && <p className="file-publication__empty">
              {view.search && view.cursors.length === 1 && !page.pageToken ? '全表未找到匹配记录' : '当前页暂无记录'}
            </p>}
            <nav className="file-publication__pagination" aria-label="多维表记录分页">
              <span>第 {view.cursors.length} 页</span>
              <Button variant="outline" size="sm" disabled={loading || view.cursors.length <= 1}
                onClick={() => void load(view.link, view.cursors.slice(0, -1), view.search)}>上一页</Button>
              <Button variant="outline" size="sm" disabled={loading || !page.pageToken}
                onClick={() => void load(view.link, [...view.cursors, page.pageToken], view.search)}>下一页</Button>
            </nav>
          </>
        )}
      </section>
      {view && operation && <RecordDialog operation={operation} view={view} close={() => setOperation(null)}
        refresh={() => { setOperation(null); void load(view.link, view.cursors, view.search); }} onSuccess={afterMutation} />}
    </div>
  );
}

function RecordDialog({ operation, view, close, refresh, onSuccess }: {
  operation: Operation;
  view: RecordView;
  close: () => void;
  refresh: () => void;
  onSuccess: (result: PublicationRecordMutationResult, kind: Operation['kind']) => void;
}) {
  const [values, setValues] = useState<PublicationRecordValues>({});
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const record = operation.kind === 'create' ? undefined : operation.record;
  const deleting = operation.kind === 'delete';
  const fields = view.page.fields.filter(field => fieldCanEdit(field, record));
  const firstValue = view.page.fields[0];
  const name = record && firstValue ? cellText(firstValue, record.values[firstValue.key]) : '';
  const changed = Object.fromEntries(fields.flatMap(field => {
    const raw = values[field.key];
    if (raw === undefined) return [];
    const value = field.type === 2 && typeof raw === 'string' ? Number(raw) : raw;
    return JSON.stringify(value) === JSON.stringify(record?.values[field.key] ?? null) ? [] : [[field.key, value]];
  }));
  const uiLocked = busy || uncertain || conflict;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict || (!deleting && Object.keys(changed).length === 0)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    requestId.current ??= createPublicationRequestId();
    const base = { link: view.link, requestId: requestId.current };
    try {
      const result = await mutatePublicationRecord(operation.kind === 'create'
        ? { ...base, kind: 'create', schemaVersion: view.page.schemaVersion, values: changed }
        : operation.kind === 'update' ? { ...base, kind: 'update', record: operation.record, values: changed }
          : { ...base, kind: 'delete', record: operation.record });
      onSuccess(result, operation.kind);
    } catch (mutationError) {
      const stale = publicationVersionConflict(mutationError);
      const unknown = uncertain || (!stale && publicationResultUncertain(mutationError));
      if (!unknown) requestId.current = null;
      setConflict(stale && !unknown);
      setUncertain(unknown);
      setError(uncertain && stale ? '多维表已变化，原操作结果仍待确认，请保留当前内容并联系管理员核对。'
        : publicationError(mutationError, stale ? '多维表记录已变化，请刷新后核对。'
          : unknown ? '操作结果待确认，请使用原请求重试。' : '操作失败，请检查所填内容。'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy && !uncertain) close(); }}>
      <DialogContent className="file-publication__record-dialog" showCloseButton={!busy && !uncertain}
        onOpenAutoFocus={event => {
          if (deleting) {
            const cancel = document.getElementById('record-operation-cancel');
            if (cancel) { event.preventDefault(); cancel.focus(); }
          }
        }}>
        <DialogHeader>
          <DialogTitle>{operationTitle[operation.kind]}</DialogTitle>
          <DialogDescription>{deleting ? `${view.page.tableName} · ${name || record?.id}。确认后会同步删除飞书多维表中的这条记录。`
            : name ? `${view.page.tableName} · ${name}` : view.page.tableName}</DialogDescription>
        </DialogHeader>
        <form className="file-publication__record-form" onSubmit={submit}>
          {!deleting && <fieldset className="file-publication__metadata" disabled={uiLocked}>
            {fields.map(field => <RecordField key={field.key} field={field}
              value={values[field.key] === undefined ? record?.values[field.key] : values[field.key]}
              onChange={value => setValues(current => ({ ...current, [field.key]: value }))} />)}
          </fieldset>}
          {error && <p className="file-publication__alert" role="alert">{error}</p>}
          {uncertain && <p className="file-publication__state">当前内容已保留。使用原请求重试可核对结果。</p>}
          <DialogFooter>
            {conflict ? <Button type="button" onClick={refresh}>刷新记录</Button> : <>
              <Button id="record-operation-cancel" type="button" variant="outline" disabled={busy || uncertain} onClick={close}>取消</Button>
              <Button type="submit" variant={deleting ? 'destructive' : 'default'}
                disabled={busy || (!deleting && Object.keys(changed).length === 0)}>
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                {busy ? '处理中' : uncertain ? '使用原请求重试' : deleting ? '确认删除' : '保存记录'}
              </Button>
            </>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecordField({ field, value, onChange }: {
  field: PublicationRecordField;
  value?: PublicationRecordValue;
  onChange: (value: PublicationRecordValue) => void;
}) {
  const id = useId();
  const options = field.options ?? [];
  const stringValue = typeof value === 'string' ? value : '';
  if (field.type === 4) {
    const selected = Array.isArray(value) ? value : [];
    return <fieldset className="file-publication__record-choice">
      <legend className="file-publication__label">{field.name}</legend>
      <div className="file-publication__groups">
        {options.map(option => <label key={option.id}>
          <input type="checkbox" checked={selected.includes(option.name)} onChange={event => {
            onChange(event.currentTarget.checked ? [...selected, option.name] : selected.filter(name => name !== option.name));
          }} />{option.name}
        </label>)}
        {options.length === 0 && <span>暂无可选项</span>}
      </div>
    </fieldset>;
  }
  if (field.type === 15) {
    const url = value && typeof value === 'object' && !Array.isArray(value) ? value : { text: '', link: '' };
    return <fieldset className="file-publication__metadata-field file-publication__record-link">
      <legend className="file-publication__label">{field.name}</legend>
      <Input aria-label={`${field.name}网址`} type="url" value={url.link} placeholder="https://" maxLength={2048}
        onChange={event => onChange(event.target.value || url.text ? { ...url, link: event.target.value } : null)} />
      <Input aria-label={`${field.name}显示文字`} value={url.text} placeholder="显示文字" maxLength={2000}
        onChange={event => onChange(event.target.value || url.link ? { ...url, text: event.target.value } : null)} />
      {value && <Button type="button" size="sm" variant="link" onClick={() => onChange(null)}>清空链接</Button>}
    </fieldset>;
  }

  return <div className="file-publication__metadata-field">
    <label htmlFor={id}>{field.name}{field.type === 5 && '（UTC+8）'}</label>
    {field.type === 3 ? (
      <select id={id} className="file-publication__record-select" value={stringValue} onChange={event => onChange(event.target.value || null)}>
        <option value="">未选择</option>
        {stringValue && !options.some(option => option.name === stringValue) && <option value={stringValue}>{stringValue}</option>}
        {options.map(option => <option key={option.id} value={option.name}>{option.name}</option>)}
      </select>
    ) : field.type === 2 ? (
      <Input id={id} type="number" step="any" value={typeof value === 'number' ? value : stringValue}
        onChange={event => onChange(event.target.value || null)} />
    ) : field.type === 5 ? (
      <Input id={id} type="datetime-local" value={typeof value === 'number' && Number.isFinite(new Date(value + taipeiOffset).getTime())
        ? new Date(value + taipeiOffset).toISOString().slice(0, 16) : ''}
        onChange={event => onChange(event.target.value ? Date.parse(`${event.target.value}+08:00`) : null)} />
    ) : field.type === 7 ? (
      <input className="file-publication__record-checkbox" id={id} type="checkbox" checked={value === true}
        onChange={event => onChange(event.currentTarget.checked)} />
    ) : field.type === 1 ? (
      <Textarea id={id} rows={2} maxLength={20_000} value={stringValue} onChange={event => onChange(event.target.value || null)} />
    ) : (
      <Input id={id} type={field.type === 13 ? 'tel' : 'text'} maxLength={20_000} value={stringValue}
        onChange={event => onChange(event.target.value || null)} />
    )}
  </div>;
}
