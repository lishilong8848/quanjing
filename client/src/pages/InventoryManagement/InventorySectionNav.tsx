import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardList,
  History,
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { cn } from '@/lib/utils';

export type InventorySection =
  | 'overview'
  | 'ledger'
  | 'inbound'
  | 'outbound'
  | 'borrow'
  | 'stocktake';

export const INVENTORY_SECTIONS: Array<{
  key: InventorySection;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { key: 'overview', label: '总览', description: '库存态势', icon: LayoutDashboard },
  { key: 'ledger', label: '库存台账', description: '库存明细', icon: ClipboardList },
  { key: 'inbound', label: '入库管理', description: '入库记录', icon: ArrowDownToLine },
  { key: 'outbound', label: '出库管理', description: '出库记录', icon: ArrowUpFromLine },
  { key: 'borrow', label: '借调管理', description: '借调归还', icon: History },
  { key: 'stocktake', label: '盘点与预警', description: '风险进度', icon: AlertTriangle },
];

export function InventorySectionNav({
  activeSection,
}: {
  activeSection: InventorySection;
}) {
  const [, setSearchParams] = useSearchParams();

  const selectSection = (section: InventorySection) => {
    setSearchParams((current) => {
      const searchParams = new URLSearchParams(current);
      if (section === 'overview') searchParams.delete('view');
      else searchParams.set('view', section);
      return searchParams;
    });
  };

  return (
    <nav
      aria-label="库存管理二级页面"
      className="sticky top-0 z-20 overflow-x-auto rounded-xl border border-blue-100 bg-white/95 p-1.5 shadow-[0_6px_20px_rgba(27,75,143,0.08)] backdrop-blur"
    >
      <div className="flex min-w-max items-center gap-1">
        {INVENTORY_SECTIONS.map((section) => {
          const Icon = section.icon;
          const active = activeSection === section.key;
          return (
            <button
              key={section.key}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => selectSection(section.key)}
              className={cn(
                'inline-flex h-12 min-w-32 items-center gap-2 rounded-lg px-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
                active
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-blue-50 hover:text-blue-700',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>
                <strong className="block text-xs font-semibold">{section.label}</strong>
                <small className={cn('mt-0.5 block text-[10px]', active ? 'text-blue-100' : 'text-slate-400')}>
                  {section.description}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
