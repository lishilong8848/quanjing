import {
  Check,
  PanelsTopLeft,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAccess } from '@/access/AccessProvider';
import { canAccessPage } from '@/access/access-policy';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  PAGE_REGISTRY,
  type SwitcherPage,
} from '@/navigation/page-switcher';

export type ManagementPageKey = 'purchase' | 'inventory' | 'contract';

const MANAGEMENT_PAGE_KEYS = new Set<ManagementPageKey>([
  'purchase',
  'inventory',
  'contract',
]);

const managementPages = PAGE_REGISTRY.filter(
  (page): page is SwitcherPage & { key: ManagementPageKey } =>
    MANAGEMENT_PAGE_KEYS.has(page.key as ManagementPageKey),
);

interface ManagementPageSwitcherProps {
  activePage: ManagementPageKey;
}

export function ManagementPageSwitcher({
  activePage,
}: ManagementPageSwitcherProps) {
  const navigate = useNavigate();
  const { role, pagePaths } = useAccess();
  const accessiblePages = managementPages.filter((page) =>
    canAccessPage(role, page.path, pagePaths),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="切换供应链页面"
          aria-label="切换供应链页面"
          className="size-11 shrink-0 rounded-lg border border-white/20 bg-white/10 text-white shadow-sm hover:border-white/35 hover:bg-white/20 hover:text-white focus-visible:ring-white/40"
        >
          <PanelsTopLeft className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>切换页面</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accessiblePages.map((page) => {
          const Icon = page.icon;
          const active = page.key === activePage;

          return (
            <DropdownMenuItem
              key={page.key}
              onSelect={() => {
                if (!active) {
                  navigate(page.path);
                }
              }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'gap-2',
                active &&
                  'bg-blue-50 text-blue-700 focus:bg-blue-100 focus:text-blue-800',
              )}
            >
              <Icon className="size-4" />
              <span>{page.label}</span>
              {active && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
