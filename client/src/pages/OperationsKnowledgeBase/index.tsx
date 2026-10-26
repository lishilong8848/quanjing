import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  BookOpen,
  Clock3,
  Download,
  FileText,
  Layers3,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  TerminalSquare,
} from 'lucide-react';

import { getOperationsKbDocument, getOperationsKbStats, searchOperationsKb } from '@/api';
import type {
  OperationsKbDocumentDetail,
  OperationsKbDocument,
  OperationsKbFacetItem,
  OperationsKbSearchResponse,
  OperationsKbStatsResponse,
} from '@shared/api.interface';

const PAGE_SIZE = 10;
type SortMode = 'relevance' | 'latest';

const quickModules = [
  { label: '故障案例', value: '故障案例', icon: AlertTriangle },
  { label: '操作手册', value: '操作手册', icon: BookOpen },
  { label: '应急预案', value: '应急预案', icon: AlertTriangle },
  { label: '制度规范', value: '制度规范', icon: ShieldCheck },
  { label: '图纸资料', value: '图纸资料', icon: Layers3 },
  { label: '常用脚本', value: '常用脚本', icon: TerminalSquare },
];

const facetLabels: Record<keyof Filters, string> = {
  module: '来源模块',
  documentType: '文档类型',
  specialty: '专业',
  equipmentType: '设备类型',
  scenario: '场景',
  level: '等级',
};

type Filters = {
  module: string;
  documentType: string;
  specialty: string;
  equipmentType: string;
  scenario: string;
  level: string;
};

const emptyFilters: Filters = {
  module: '',
  documentType: '',
  specialty: '',
  equipmentType: '',
  scenario: '',
  level: '',
};

function readFilters(params: URLSearchParams): Filters {
  return {
    module: params.get('module') || '',
    documentType: params.get('documentType') || '',
    specialty: params.get('specialty') || '',
    equipmentType: params.get('equipmentType') || '',
    scenario: params.get('scenario') || '',
    level: params.get('level') || '',
  };
}

function readPage(params: URLSearchParams) {
  const value = Number(params.get('page') || '1');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function readSort(params: URLSearchParams): SortMode {
  return params.get('sort') === 'latest' ? 'latest' : 'relevance';
}

function buildResultSearchParams(query: string, filters: Filters, page = 1, sort: SortMode = 'relevance') {
  const params = new URLSearchParams();
  const trimmedQuery = query.trim();
  if (trimmedQuery) params.set('q', trimmedQuery);
  (Object.keys(filters) as Array<keyof Filters>).forEach((key) => {
    if (filters[key]) params.set(key, filters[key]);
  });
  if (page > 1) params.set('page', String(page));
  if (sort !== 'relevance') params.set('sort', sort);
  return params;
}

function StatMetric({
  label,
  value,
  wide,
}: {
  label: string;
  value: string | number;
  wide?: boolean;
}) {
  return (
    <span className={`okb-stat-metric${wide ? ' okb-stat-metric-wide' : ''}`}>
      <span className="okb-stat-dot" />
      {label}
      <strong>{value}</strong>
    </span>
  );
}

function FilterSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: OperationsKbFacetItem[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="okb-filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">全部</option>
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.value}（{item.count}）
          </option>
        ))}
      </select>
    </label>
  );
}

function getAttachmentHref(recordUrl: string) {
  return recordUrl || '/operations-kb/results';
}

function isExternalHref(href: string) {
  return /^https?:\/\//i.test(href);
}

function ResultCard({ item }: { item: OperationsKbDocument }) {
  const titleIsInternal = item.recordUrl.startsWith('/');
  return (
    <article className="okb-result-card">
      <div className="okb-result-topline">
        <span className="okb-module-badge">{item.module || '未分类'}</span>
        {item.specialty ? <span>{item.specialty}</span> : null}
        {item.equipmentType ? <span>{item.equipmentType}</span> : null}
        <time>{item.updatedAt || '未知日期'}</time>
      </div>
      <h3>
        {titleIsInternal ? (
          <Link className="okb-result-title-link" to={item.recordUrl}>
            {item.title}
          </Link>
        ) : item.recordUrl ? (
          <a className="okb-result-title-link" href={item.recordUrl} rel="noreferrer" target="_blank">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h3>
      <p>{item.excerpt || '该资料暂无摘要，可继续通过模块、专业、场景或附件信息定位。'}</p>
      <div className="okb-result-actions">
        {(item.metaTags || []).slice(0, 6).map((tag) => (
          <span className={`okb-chip okb-meta-chip okb-meta-chip-${tag.tone || 'default'}`} key={`${tag.label}-${tag.value}`}>
            <span>{tag.label}</span>
            <strong>{tag.value}</strong>
          </span>
        ))}
        {(item.attachments || []).slice(0, 4).map((attachment) => {
          const href = getAttachmentHref(item.recordUrl);
          return (
            <a
              className="okb-attachment"
              href={href}
              key={`${item.id}-${attachment.name}-${href}`}
              rel={isExternalHref(href) ? 'noreferrer' : undefined}
              target={isExternalHref(href) ? '_blank' : undefined}
              title="打开记录，在飞书多维表中下载附件"
            >
              <Download size={14} />
              <span>{attachment.name}</span>
            </a>
          );
        })}
      </div>
    </article>
  );
}

export default function OperationsKnowledgeBasePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { recordId } = useParams();
  const [searchParams] = useSearchParams();
  const isResultsPage = location.pathname.endsWith('/results');
  const isRecordPage = Boolean(recordId);
  const [stats, setStats] = useState<OperationsKbStatsResponse | null>(null);
  const [data, setData] = useState<OperationsKbSearchResponse | null>(null);
  const [detail, setDetail] = useState<OperationsKbDocumentDetail | null>(null);
  const [queryInput, setQueryInput] = useState(searchParams.get('q') || '');
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [filters, setFilters] = useState<Filters>(() => readFilters(searchParams));
  const [page, setPage] = useState(() => readPage(searchParams));
  const [sort, setSort] = useState<SortMode>(() => readSort(searchParams));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE)),
    [data?.total],
  );

  useEffect(() => {
    void getOperationsKbStats().then(setStats).catch(() => undefined);
  }, []);

  useEffect(() => {
    const nextQuery = searchParams.get('q') || '';
    const nextFilters = readFilters(searchParams);
    const nextPage = readPage(searchParams);
    const nextSort = readSort(searchParams);
    setQuery(nextQuery);
    setQueryInput(nextQuery);
    setFilters(nextFilters);
    setPage(nextPage);
    setSort(nextSort);
  }, [searchParams]);

  const loadSearch = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await searchOperationsKb({
        q: query,
        page,
        pageSize: PAGE_SIZE,
        sort,
        ...filters,
      });
      setData(response);
    } catch {
      setError('检索服务暂时不可用，请稍后重试，或联系管理员检查 /api/operations-kb/search。');
    } finally {
      setLoading(false);
    }
  }, [filters, page, query, sort]);

  useEffect(() => {
    if (!isResultsPage) {
      setLoading(false);
      return;
    }
    void loadSearch();
  }, [isResultsPage, loadSearch]);

  useEffect(() => {
    if (!recordId) return;
    const loadDetail = async () => {
      try {
        setLoading(true);
        setError(null);
        setDetail(await getOperationsKbDocument(recordId));
      } catch {
        setError('条目详情加载失败，请返回检索结果重试。');
      } finally {
        setLoading(false);
      }
    };
    void loadDetail();
  }, [recordId]);

  const navigateToResults = (
    nextQuery = queryInput,
    nextFilters = filters,
    nextPage = 1,
    replace = false,
    nextSort: SortMode = sort,
  ) => {
    const trimmedQuery = nextQuery.trim();
    setQuery(trimmedQuery);
    setQueryInput(trimmedQuery);
    setFilters(nextFilters);
    setPage(nextPage);
    setSort(nextSort);
    const params = buildResultSearchParams(nextQuery, nextFilters, nextPage, nextSort);
    navigate(
      {
        pathname: '/operations-kb/results',
        search: params.toString(),
      },
      { replace },
    );
  };

  const updateFilter = (key: keyof Filters, value: string) => {
    const nextFilters = { ...filters, [key]: value };
    if (isResultsPage) {
      navigateToResults(query, nextFilters, 1);
      return;
    }
    setFilters(nextFilters);
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    navigateToResults(queryInput, filters, 1);
  };

  const resetAll = () => {
    if (isResultsPage) {
      navigateToResults('', emptyFilters, 1, true, 'relevance');
      return;
    }
    setFilters(emptyFilters);
    setQuery('');
    setQueryInput('');
  };

  const updateSort = (nextSort: SortMode) => {
    navigateToResults(query, filters, 1, false, nextSort);
  };

  return (
    <main className={`operations-kb-page${isResultsPage || isRecordPage ? ' okb-results-page' : ''}`}>
      <header className="okb-topbar">
        <Link className="okb-brand" to="/operations-kb" aria-label="返回藏经阁首页">
          <img src="/assets/vnet-logo-transparent.png" alt="世纪互联 VNET" />
        </Link>
        <nav className="okb-actions" aria-label="藏经阁操作">
          <button type="button" title="最近浏览">
            <Clock3 size={18} />
          </button>
          <button type="button" title="收藏">
            <Star size={18} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (isResultsPage) {
                document.getElementById('okb-filter-panel')?.scrollIntoView({ behavior: 'smooth' });
                return;
              }
              navigateToResults(queryInput, filters, 1);
            }}
          >
            <SlidersHorizontal size={18} />
            <span>高级筛选</span>
          </button>
        </nav>
      </header>

      <section className="okb-hero">
        <div className="okb-hero-logo" aria-label="南通基地运维藏经阁">
          <h1 data-text="南通基地-运维藏经阁">南通基地-运维藏经阁</h1>
          <span className="okb-hero-brand-logo" aria-hidden="true">
            <img src="/assets/vnet-logo-transparent.png" alt="" />
          </span>
        </div>

        <form className="okb-hero-search" onSubmit={submitSearch} role="search">
          <Search size={22} aria-hidden="true" />
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            type="search"
            autoComplete="off"
            placeholder="输入问题，如：机柜一路掉电怎么处理"
          />
          <button type="submit">一键检索</button>
        </form>

        <div className="okb-quick-links" aria-label="快捷入口">
          {quickModules.map((item) => {
            const Icon = item.icon;
            const active = filters.module === item.value;
            return (
              <button
                className={active ? 'active' : ''}
                key={item.value}
                onClick={() => updateFilter('module', active ? '' : item.value)}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <div className="okb-stats-strip" aria-label="知识库统计">
          <span className="okb-stat-kicker">知识库在线</span>
          <StatMetric label="资料" value={stats?.total ?? '加载中'} />
          <StatMetric label="模块" value={stats?.modules ?? '加载中'} />
          <StatMetric label="附件" value={stats?.attachments ?? '加载中'} />
          <StatMetric label="最近更新" value={stats?.latestUpdatedAt ?? '加载中'} wide />
        </div>
      </section>

      {isRecordPage ? (
        <section className="okb-record-detail" aria-live="polite">
          <Link className="okb-back-link" to="/operations-kb/results">
            返回检索
          </Link>
          {loading ? (
            <div className="okb-skeleton-list">
              <div />
            </div>
          ) : error ? (
            <div className="okb-error">{error}</div>
          ) : detail ? (
            <article className="okb-record-card">
              <div className="okb-result-topline">
                <span className="okb-module-badge">{detail.module || '未分类'}</span>
                {detail.specialty ? <span>{detail.specialty}</span> : null}
                {detail.equipmentType ? <span>{detail.equipmentType}</span> : null}
                <time>{detail.updatedAt || '未知日期'}</time>
              </div>
              <h2>{detail.title}</h2>
              <p>{detail.excerpt}</p>
              <div className="okb-result-actions">
                {(detail.metaTags || []).map((tag) => (
                  <span className={`okb-chip okb-meta-chip okb-meta-chip-${tag.tone || 'default'}`} key={`${tag.label}-${tag.value}`}>
                    <span>{tag.label}</span>
                    <strong>{tag.value}</strong>
                  </span>
                ))}
                {(detail.attachments || []).map((attachment) => {
                  const href = getAttachmentHref(detail.recordUrl);
                  return (
                    <a
                      className="okb-attachment"
                      href={href}
                      key={`${attachment.name}-${href}`}
                      rel={isExternalHref(href) ? 'noreferrer' : undefined}
                      target={isExternalHref(href) ? '_blank' : undefined}
                      title="打开记录，在飞书多维表中下载附件"
                    >
                      <Download size={14} />
                      <span>{attachment.name}</span>
                    </a>
                  );
                })}
              </div>
              <div className="okb-record-source">
                <span>来源多维表：{detail.rawTable || detail.module || '未知'}</span>
                <span>记录 ID：{detail.rawRecordId || detail.id}</span>
              </div>
              <dl className="okb-record-fields">
                {Object.entries(detail.rawFields || {}).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value || '-'}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ) : null}
        </section>
      ) : isResultsPage ? (
        <>
          <section className="okb-search-brief" id="okb-results-section">
            <div>
              <p>资料检索</p>
              <h2>{query ? `“${query}” 的检索结果` : '知识框架'}</h2>
            </div>
            <div className="okb-view-tools">
              <button className={sort === 'relevance' ? 'active' : ''} onClick={() => updateSort('relevance')} type="button">
                <Layers3 size={17} />
                <span>知识框架</span>
              </button>
              <button className={sort === 'latest' ? 'active' : ''} onClick={() => updateSort('latest')} type="button">
                <ArrowDownWideNarrow size={17} />
                <span>最新</span>
              </button>
            </div>
          </section>

          <section className="okb-results-shell">
            <aside className="okb-filter-panel" id="okb-filter-panel" aria-label="高级筛选">
              <div className="okb-filter-head">
                <strong>高级筛选</strong>
                <button type="button" onClick={resetAll} title="清空筛选">
                  <RotateCcw size={17} />
                  <span>重置</span>
                </button>
              </div>
              <div className="okb-filter-grid">
                {(Object.keys(facetLabels) as Array<keyof Filters>).map((key) => (
                  <FilterSelect
                    key={key}
                    label={facetLabels[key]}
                    value={filters[key]}
                    items={data?.facets[key] || []}
                    onChange={(value) => updateFilter(key, value)}
                  />
                ))}
              </div>
            </aside>

            <section className="okb-results-main" aria-live="polite">
              <div className="okb-results-title">
                <div>
                  <p>检索结果</p>
                  <h2>{loading ? '正在检索资料...' : `共 ${data?.total || 0} 条资料`}</h2>
                </div>
                <span>第 {page} / {totalPages} 页</span>
              </div>

              {loading ? (
                <div className="okb-skeleton-list">
                  <div />
                  <div />
                  <div />
                </div>
              ) : error ? (
                <div className="okb-error">{error}</div>
              ) : data?.results.length ? (
                <>
                  <div className="okb-results-list">
                    {data.results.map((item) => (
                      <ResultCard item={item} key={item.id} />
                    ))}
                  </div>
                  <div className="okb-pagination">
                    <button
                      disabled={page <= 1}
                      onClick={() => navigateToResults(query, filters, Math.max(1, page - 1))}
                      type="button"
                    >
                      上一页
                    </button>
                    <button
                      disabled={page >= totalPages}
                      onClick={() => navigateToResults(query, filters, Math.min(totalPages, page + 1))}
                      type="button"
                    >
                      下一页
                    </button>
                  </div>
                </>
              ) : (
                <div className="okb-empty">
                  <FileText size={42} />
                  <strong>没有匹配的资料</strong>
                  <span>换一个关键词或清空筛选后再试。</span>
                </div>
              )}
            </section>
          </section>
        </>
      ) : null}
    </main>
  );
}
