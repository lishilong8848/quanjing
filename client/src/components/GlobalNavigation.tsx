import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Grid3X3, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  findNavigationPage,
  getAccessibleNavigationDomains,
  type AccessibleNavigationDomain,
  type NavigationDomainKey,
  type SwitcherPage,
} from '@/navigation/page-switcher';

import { GlobalUserControl } from './Layout';

const VNET_LOGO_URL = '/assets/vnet-logo-transparent.png';

function NavigationPageButton({
  page,
  active,
  onNavigate,
}: {
  page: SwitcherPage;
  active: boolean;
  onNavigate: (path: string, external?: boolean) => void;
}) {
  const Icon = page.icon;
  const className = cn(
    'group flex w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-[background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 motion-reduce:transform-none motion-reduce:transition-none',
    active
      ? 'border-blue-200 bg-blue-50 text-blue-800'
      : 'border-transparent bg-slate-50/80 text-slate-700 hover:-translate-y-0.5 hover:border-blue-100 hover:bg-blue-50/70',
  );
  const content = (
    <>
      <span
        className={cn(
          'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card shadow-sm',
          active
            ? 'border-blue-200 text-blue-600'
            : 'border-slate-200 text-slate-500 group-hover:border-blue-200 group-hover:text-blue-600',
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className="truncate">{page.label}</span>
          {active ? (
            <Check className="ml-auto size-4 shrink-0 text-blue-600" />
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500">
          {page.description}
        </span>
      </span>
    </>
  );

  if (page.external) {
    return (
      <a
        href={page.path}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => onNavigate(page.path, true)}
        className={className}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(page.path)}
      className={className}
    >
      {content}
    </button>
  );
}

function DomainPageList({
  domain,
  activePath,
  showDomainHeader = true,
  onNavigate,
}: {
  domain: AccessibleNavigationDomain;
  activePath: string | undefined;
  showDomainHeader?: boolean;
  onNavigate: (path: string, external?: boolean) => void;
}) {
  const activeDomain = domain.pages.some((page) => page.path === activePath);

  return (
    <section
      aria-labelledby={
        showDomainHeader ? `navigation-domain-${domain.key}` : undefined
      }
      aria-label={showDomainHeader ? undefined : `${domain.label}应用入口`}
      data-navigation-domain={domain.key}
      data-active-navigation-domain={activeDomain ? 'true' : undefined}
    >
      {showDomainHeader ? (
        <div className="mb-2 px-1">
          <h2
            id={`navigation-domain-${domain.key}`}
            className="text-sm font-semibold text-slate-900"
          >
            {domain.label}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">
            {domain.description}
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        {domain.pages.map((page) => (
          <NavigationPageButton
            key={page.path}
            page={page}
            active={activePath === page.path}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </section>
  );
}

function AllApplications({
  domains,
  activePath,
  query,
  inputId,
  onQueryChange,
  onNavigate,
}: {
  domains: readonly AccessibleNavigationDomain[];
  activePath: string | undefined;
  query: string;
  inputId: string;
  onQueryChange: (query: string) => void;
  onNavigate: (path: string, external?: boolean) => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const filteredDomains = useMemo(
    () =>
      domains
        .map((domain) => ({
          ...domain,
          pages: domain.pages.filter((page) =>
            [domain.label, domain.description, page.label, page.description]
              .join(' ')
              .toLocaleLowerCase('zh-CN')
              .includes(normalizedQuery),
          ),
        }))
        .filter((domain) => domain.pages.length > 0),
    [domains, normalizedQuery],
  );

  return (
    <>
      <div className="relative">
        <label htmlFor={inputId} className="sr-only">
          搜索应用入口
        </label>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索页面或业务分类"
          className="h-10 rounded-lg border-slate-200 bg-slate-50/80 pl-9 focus-visible:border-blue-300 focus-visible:ring-blue-100"
        />
      </div>
      {filteredDomains.length > 0 ? (
        <div className="mt-4 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filteredDomains.map((domain) => (
            <DomainPageList
              key={domain.key}
              domain={domain}
              activePath={activePath}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
          <p className="text-sm font-medium text-slate-700">未找到相关入口</p>
          <p className="mt-1 text-xs text-slate-500">请尝试其他关键词</p>
        </div>
      )}
    </>
  );
}

export function GlobalNavigation() {
  const { role, pagePaths } = useAccess();
  const location = useLocation();
  const navigate = useNavigate();
  const domains = getAccessibleNavigationDomains(role, pagePaths);
  const firstDomainKey = domains[0]?.key;
  const activePage = findNavigationPage(location.pathname);
  const activeDomainKey = activePage?.domainKey;
  const [openDomainKey, setOpenDomainKey] =
    useState<NavigationDomainKey | null>(null);
  const [allApplicationsOpen, setAllApplicationsOpen] = useState(false);
  const [mobileApplicationsOpen, setMobileApplicationsOpen] = useState(false);
  const [desktopQuery, setDesktopQuery] = useState('');
  const [mobileQuery, setMobileQuery] = useState('');
  const mobileApplicationsContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      !mobileApplicationsOpen ||
      mobileQuery.trim() ||
      !activeDomainKey ||
      activeDomainKey === firstDomainKey
    ) {
      return undefined;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      mobileApplicationsContentRef.current
        ?.querySelector<HTMLElement>('[data-active-navigation-domain="true"]')
        ?.scrollIntoView({ block: 'start' });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeDomainKey, firstDomainKey, mobileApplicationsOpen, mobileQuery]);

  const closeNavigation = () => {
    setOpenDomainKey(null);
    setAllApplicationsOpen(false);
    setMobileApplicationsOpen(false);
  };

  const navigateTo = (path: string, external = false) => {
    closeNavigation();
    if (!external && location.pathname !== path) {
      navigate(path);
    }
  };

  return (
    <header
      data-global-navigation="true"
      data-screenshot-hidden="true"
      className="duty-desktop-utility-nav fixed inset-x-0 top-0 z-40 h-16 border-b border-slate-200/90 bg-slate-50/95 shadow-[0_1px_3px_hsl(220_25%_20%/0.08)] backdrop-blur-xl"
    >
      <div className="mx-auto flex h-full w-full max-w-[1600px] items-center gap-2 px-3 sm:px-4 lg:px-6">
        <button
          type="button"
          aria-label="返回平台门户"
          onClick={() => navigateTo('/nantong-base')}
          className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          <img
            src={VNET_LOGO_URL}
            alt="世纪互联 VNET"
            className="h-9 w-[86px] object-contain"
          />
          <span className="hidden border-l border-slate-200 pl-3 2xl:block">
            <span className="block text-sm font-semibold text-slate-900">
              南通基地运营平台
            </span>
            <span className="mt-0.5 block text-[11px] text-slate-500">
              一站式运营工作台
            </span>
          </span>
        </button>

        <nav
          aria-label="平台业务分类"
          className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 xl:flex"
        >
          {domains.map((domain) => {
            const active = activeDomainKey === domain.key;
            return (
              <Popover
                key={domain.key}
                open={openDomainKey === domain.key}
                onOpenChange={(open) =>
                  setOpenDomainKey(open ? domain.key : null)
                }
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-active={active ? 'true' : 'false'}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'h-9 shrink-0 gap-1 rounded-lg px-2.5 text-sm font-medium text-slate-600 hover:bg-blue-50 hover:text-blue-700',
                      active && 'bg-blue-50 text-blue-700',
                    )}
                  >
                    {domain.label}
                    <ChevronDown
                      className="size-3.5 text-slate-400"
                      aria-hidden="true"
                    />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="center"
                  sideOffset={11}
                  className="w-[340px] rounded-xl border-slate-200 bg-slate-50/98 p-2 shadow-xl"
                >
                  <DomainPageList
                    domain={domain}
                    activePath={activePage?.path}
                    showDomainHeader={false}
                    onNavigate={navigateTo}
                  />
                </PopoverContent>
              </Popover>
            );
          })}
        </nav>

        <div className="ml-auto hidden shrink-0 items-center gap-2 xl:flex">
          <Popover
            open={allApplicationsOpen}
            onOpenChange={(open) => {
              setAllApplicationsOpen(open);
              if (open) setOpenDomainKey(null);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-2 rounded-lg border-slate-200 bg-card text-slate-700 shadow-sm hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
              >
                <Grid3X3 className="size-4 text-blue-600" aria-hidden="true" />
                全部应用
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={11}
              collisionPadding={16}
              className="w-[min(920px,calc(100vw-32px))] rounded-xl border-slate-200 bg-slate-50/98 p-4 shadow-2xl"
            >
              <ScrollArea className="max-h-[min(70dvh,640px,calc(var(--radix-popover-content-available-height)-2.125rem))] pr-3 [&_[data-slot=scroll-area-viewport]]:max-h-[inherit] [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
                <AllApplications
                  domains={domains}
                  activePath={activePage?.path}
                  query={desktopQuery}
                  inputId="desktop-application-search"
                  onQueryChange={setDesktopQuery}
                  onNavigate={navigateTo}
                />
              </ScrollArea>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 xl:hidden">
          <span className="min-w-0 flex-1 truncate text-right text-xs font-medium text-slate-600 sm:text-sm">
            {activePage?.label ?? '平台应用'}
          </span>
          <Sheet
            open={mobileApplicationsOpen}
            onOpenChange={setMobileApplicationsOpen}
          >
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="打开全部应用"
                title="全部应用"
                className="size-9 shrink-0 rounded-lg border-slate-200 bg-card text-blue-600 shadow-sm"
              >
                <Grid3X3 className="size-4" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-[min(92vw,440px)] gap-0 overflow-hidden border-slate-200 bg-slate-50 p-0 sm:max-w-[440px]"
            >
              <SheetHeader className="border-b border-slate-200 bg-card px-5 py-4 text-left">
                <SheetTitle>全部应用</SheetTitle>
                <SheetDescription>按业务分类选择要进入的页面</SheetDescription>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1 px-4 py-4">
                <div ref={mobileApplicationsContentRef}>
                  <AllApplications
                    domains={domains}
                    activePath={activePage?.path}
                    query={mobileQuery}
                    inputId="mobile-application-search"
                    onQueryChange={setMobileQuery}
                    onNavigate={navigateTo}
                  />
                </div>
              </ScrollArea>
            </SheetContent>
          </Sheet>
        </div>

        <GlobalUserControl />
      </div>
    </header>
  );
}
