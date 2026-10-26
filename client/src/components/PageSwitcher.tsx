import { useRef } from 'react';
import { Check, ChevronDown, PanelsTopLeft } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getAccessibleSwitcherPages } from '@/navigation/page-switcher';

const PAGE_SWITCHER_VISIBLE_PAGE_COUNT = 5;

export function PageSwitcher({
  compact = false,
  tone = 'default',
}: {
  compact?: boolean;
  tone?: 'default' | 'inverse';
}) {
  const { role, pagePaths } = useAccess();
  const location = useLocation();
  const navigate = useNavigate();
  const pages = getAccessibleSwitcherPages(role, pagePaths);
  const pageListRef = useRef<HTMLDivElement>(null);
  const hasOverflowPages = pages.length > PAGE_SWITCHER_VISIBLE_PAGE_COUNT;
  const activePage =
    pages.find((page) => page.path === location.pathname) ??
    pages.find((page) => location.pathname.startsWith(`${page.path}/`));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? 'icon-sm' : 'icon'}
          title="切换页面"
          aria-label="切换页面"
          className={`shrink-0 rounded-lg border shadow-sm transition-colors focus-visible:ring-2 ${
            compact ? 'size-8' : 'size-10'
          } ${
            tone === 'inverse'
              ? 'border-white/20 bg-white/10 text-white hover:border-white/35 hover:bg-white/20 hover:text-white focus-visible:ring-white/40'
              : 'border-border/80 bg-card/95 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-blue-500/60'
          }`}
        >
          <PanelsTopLeft className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>切换页面</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div ref={pageListRef} className="h-40 overflow-y-auto pr-1">
          {pages.map((page) => {
            const Icon = page.icon;
            const active = activePage?.path === page.path;

            return (
              <DropdownMenuItem
                key={page.path}
                aria-current={active ? 'page' : undefined}
                onSelect={() => {
                  if (!active) navigate(page.path);
                }}
                className={`gap-2 ${
                  active
                    ? 'bg-blue-50 text-blue-700 focus:bg-blue-100 focus:text-blue-800'
                    : ''
                }`}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span>{page.label}</span>
                {active ? <Check className="ml-auto size-4" /> : null}
              </DropdownMenuItem>
            );
          })}
        </div>
        {hasOverflowPages ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="显示更多页面"
            title="显示更多页面"
            onClick={() => {
              pageListRef.current?.scrollBy({
                top: pageListRef.current.clientHeight,
                behavior: 'smooth',
              });
            }}
            className="mt-1 h-7 w-full text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
