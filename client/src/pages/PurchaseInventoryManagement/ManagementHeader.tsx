import type { KeyboardEventHandler, ReactNode } from 'react';
import { Database, ListFilter, RefreshCw, Search } from 'lucide-react';

import { cn } from '@/lib/utils';

type ManagementPageKey =
  | 'purchase'
  | 'inventory'
  | 'operations-tools'
  | 'contract'
  | 'monthly-report'
  | 'threshold'
  | 'meeting';

const VNET_OFFICIAL_LOGO_URL = '/assets/vnet-official-logo.png';

interface ManagementHeaderProps {
  activePage: ManagementPageKey;
  searchValue?: string;
  searchPlaceholder?: string;
  sourceLabel?: string;
  updatedAt: string;
  refreshing: boolean;
  actions?: ReactNode;
  filterLabel?: string;
  title?: string;
  subtitle?: string;
  toolbarLabel?: string;
  showSearch?: boolean;
  searchResults?: ReactNode;
  onFilter?: () => void;
  onSearchFocus?: () => void;
  onSearchKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onSearchChange?: (value: string) => void;
  onRefresh?: () => void;
  tone?: 'default' | 'soft';
}

export function ManagementHeader({
  activePage: _activePage,
  searchValue = '',
  searchPlaceholder = '搜索',
  sourceLabel,
  updatedAt,
  refreshing,
  actions,
  filterLabel = '定位筛选条件',
  title = '南通全景运维平台 · 采‑供‑存',
  subtitle = '采购、库存与合同履约实时协同',
  toolbarLabel = '供应链页面工具栏',
  showSearch = true,
  searchResults,
  onFilter,
  onSearchFocus,
  onSearchKeyDown,
  onSearchChange,
  onRefresh,
  tone = 'default',
}: ManagementHeaderProps) {
  return (
    <header
      className={cn(
        'relative z-30 overflow-visible text-white',
        tone === 'soft'
          ? 'bg-[linear-gradient(115deg,#5f86ee_0%,#536fdc_48%,#6879da_100%)] shadow-[0_14px_36px_rgba(72,94,168,0.18)]'
          : 'bg-[linear-gradient(180deg,#064fc5_0%,#00359b_54%,#012a7d_100%)] shadow-[0_18px_42px_rgba(0,47,135,0.28)]',
      )}
    >
      <div
        aria-hidden="true"
        data-management-header-effects="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <span className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-blue-300/10 blur-3xl" />
        <span className="absolute -bottom-32 left-1/3 h-56 w-96 rounded-full bg-cyan-200/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[1920px] flex-col gap-4 px-4 py-4 md:px-8 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center xl:max-w-[660px] xl:flex-1 2xl:max-w-none">
          <span
            role="img"
            aria-label="世纪互联 VNET"
            className="h-14 w-36 shrink-0 bg-white md:h-16 md:w-40"
            style={{
              WebkitMask: `url(${VNET_OFFICIAL_LOGO_URL}) center / contain no-repeat`,
              mask: `url(${VNET_OFFICIAL_LOGO_URL}) center / contain no-repeat`,
            }}
          />
          <span className="hidden h-16 w-px shrink-0 bg-white/25 md:block" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight md:text-3xl">
              {title}
            </h1>
            {subtitle ? <p className="mt-1 text-sm text-blue-100/85">{subtitle}</p> : null}
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-blue-100/80">
              {sourceLabel ? (
                <span
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5"
                  title={sourceLabel}
                >
                  <Database className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{sourceLabel}</span>
                </span>
              ) : null}
              <span className="shrink-0">数据更新时间：{updatedAt}</span>
            </div>
          </div>
        </div>

        <div
          role="toolbar"
          aria-label={toolbarLabel}
          className="flex w-full min-w-0 flex-wrap items-center gap-2 xl:w-auto xl:flex-nowrap xl:justify-end"
        >
          {showSearch && onSearchChange && (
            <div className="relative w-full shrink-0 sm:w-72 xl:w-56 2xl:w-80">
              <label className="relative block w-full">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-200" />
                <input
                  aria-label={searchPlaceholder}
                  value={searchValue}
                  onChange={(event) => onSearchChange(event.target.value)}
                  onFocus={onSearchFocus}
                  onKeyDown={onSearchKeyDown}
                  placeholder={searchPlaceholder}
                  aria-expanded={Boolean(searchResults)}
                  aria-controls={
                    searchResults ? 'management-search-results' : undefined
                  }
                  className="h-11 w-full rounded-lg border border-white/20 bg-white/10 pl-9 pr-3 text-sm text-white outline-none transition placeholder:text-blue-100/70 hover:bg-white/15 focus:border-white/40 focus:bg-white/15 focus:ring-2 focus:ring-white/15"
                />
              </label>
              {searchResults}
            </div>
          )}

          {onFilter && (
            <button
              type="button"
              title={filterLabel}
              aria-label={filterLabel}
              onClick={onFilter}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:border-white/35 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <ListFilter className="h-4 w-4" />
            </button>
          )}

          {actions}

          {onRefresh && (
            <button
              type="button"
              title="刷新数据"
              aria-label="刷新数据"
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:border-white/35 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw
                className={cn('h-4 w-4', refreshing && 'animate-spin')}
              />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
