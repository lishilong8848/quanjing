import { useMemo, useState } from 'react';
import {
  Building2,
  CalendarDays,
  ContactRound,
  FileCheck2,
  Phone,
  Search,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type {
  ContractSupplierDirectory,
  ContractSupplierCooperationDepth,
  ContractSupplierDirectoryItem,
} from '@shared/contract-management.interface';

export function SupplierDirectoryPanel({
  directory,
  embedded = false,
}: {
  directory: ContractSupplierDirectory;
  embedded?: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [contractListItem, setContractListItem] =
    useState<ContractSupplierDirectoryItem | null>(null);
  const filteredItems = useMemo(
    () => filterSupplierDirectory(directory.items, searchQuery),
    [directory.items, searchQuery],
  );
  const { summary } = directory;
  const metrics: Array<{
    label: string;
    value: string;
    detail: string;
    icon: LucideIcon;
    iconClass: string;
  }> = [
    {
      label: '名录公司',
      value: formatNumber(summary.totalSuppliers),
      detail: '按公司单位合并重复记录',
      icon: Building2,
      iconClass: 'bg-blue-50 text-blue-700',
    },
    {
      label: '联系人记录',
      value: formatNumber(summary.directoryEntries),
      detail: `${formatNumber(summary.contactsWithPhone)} 条已填写电话`,
      icon: ContactRound,
      iconClass: 'bg-cyan-50 text-cyan-700',
    },
    {
      label: '关联合同',
      value: `${formatNumber(summary.linkedContracts)} 份`,
      detail: '来自名录中的真实执行合同关联',
      icon: FileCheck2,
      iconClass: 'bg-emerald-50 text-emerald-700',
    },
    {
      label: '联系电话完整度',
      value: `${summary.phoneCoverageRate}%`,
      detail: '按名录联系人记录统计',
      icon: Phone,
      iconClass: 'bg-amber-50 text-amber-700',
    },
  ];

  return (
    <>
      <Card
      className={cn(
        'border-slate-200 bg-white',
        embedded
          ? 'flex min-h-full flex-col border-0 shadow-none'
          : 'overflow-hidden shadow-sm',
      )}
    >
      <CardHeader className="border-b border-slate-200 px-4 py-4 sm:px-5">
        <div
          className={cn(
            'flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between',
            embedded && 'lg:justify-end',
          )}
        >
          {!embedded && (
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-md shadow-blue-200">
                <Building2 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-slate-950">
                    供应商名录
                  </h2>
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                    {summary.totalSuppliers} 家
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  来自多维表【供应商名录】，按公司聚合联系人和执行合同
                </p>
              </div>
            </div>
          )}
          <label className="relative block w-full lg:w-[360px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-10 border-slate-200 bg-slate-50 pl-9 focus:bg-white"
              placeholder="搜索公司、联系人、电话、园区对接人或合同"
              aria-label="搜索供应商名录"
            />
          </label>
        </div>
      </CardHeader>

      <CardContent
        className={cn('p-0', embedded && 'flex min-h-0 flex-1 flex-col')}
      >
        <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
          {metrics.map(({ label, value, detail, icon: Icon, iconClass }) => (
            <div
              key={label}
              className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3"
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconClass}`}
              >
                <Icon className="h-4.5 w-4.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold text-slate-500">
                  {label}
                </span>
                <strong className="mt-0.5 block text-lg font-bold tabular-nums text-slate-950">
                  {value}
                </strong>
                <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                  {detail}
                </span>
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500 sm:px-5">
          <span aria-live="polite">
            当前显示 {filteredItems.length} / {summary.totalSuppliers} 家公司
          </span>
          <span>联系电话完整显示</span>
        </div>

        {filteredItems.length ? (
          <>
            <div className="hidden lg:block">
              <div className={cn(!embedded && 'max-h-[520px] overflow-auto')}>
                <table className="w-full min-w-[1120px] text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-semibold text-slate-500 shadow-[0_1px_0_rgb(226_232_240)]">
                    <tr>
                      <th className="px-5 py-3">公司单位</th>
                      <th className="px-4 py-3">联系人 / 电话</th>
                      <th className="px-4 py-3">园区对接人</th>
                      <th className="px-4 py-3">关联执行合同</th>
                      <th className="px-5 py-3 text-right">供应商合作深度</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredItems.map((item) => (
                      <SupplierDesktopRow
                        key={item.supplierId}
                        item={item}
                        onOpenContracts={setContractListItem}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div
              className={cn(
                'grid gap-3 p-4 lg:hidden',
                !embedded && 'max-h-[620px] overflow-y-auto',
              )}
            >
              {filteredItems.map((item) => (
                <SupplierMobileCard
                  key={item.supplierId}
                  item={item}
                  onOpenContracts={setContractListItem}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 text-blue-500">
              <Search className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-semibold text-slate-700">
              没有匹配的供应商
            </p>
            <p className="mt-1 text-xs text-slate-400">
              可尝试公司名称、联系人、电话或合同编号。
            </p>
          </div>
        )}
        </CardContent>
      </Card>
      <SupplierContractListDialog
        item={contractListItem}
        onOpenChange={(open) => {
          if (!open) setContractListItem(null);
        }}
      />
    </>
  );
}

function SupplierDesktopRow({
  item,
  onOpenContracts,
}: {
  item: ContractSupplierDirectoryItem;
  onOpenContracts: (item: ContractSupplierDirectoryItem) => void;
}) {
  return (
    <tr className="transition hover:bg-blue-50/35">
      <td className="px-5 py-3.5">
        <p className="max-w-[300px] font-semibold text-slate-900">
          {item.name}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {item.directoryEntryCount > 1
            ? `${item.directoryEntryCount} 条联系人记录已合并`
            : '1 条联系人记录'}
        </p>
      </td>
      <td className="px-4 py-3.5">
        <SupplierContacts item={item} />
      </td>
      <td className="px-4 py-3.5">
        <ParkLiaisons item={item} />
      </td>
      <td className="px-4 py-3.5">
        <RelatedContracts item={item} onOpen={onOpenContracts} />
      </td>
      <td className="px-5 py-3.5 text-right">
        <CooperationDepth item={item} />
      </td>
    </tr>
  );
}

function SupplierMobileCard({
  item,
  onOpenContracts,
}: {
  item: ContractSupplierDirectoryItem;
  onOpenContracts: (item: ContractSupplierDirectoryItem) => void;
}) {
  return (
    <article className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold leading-5 text-slate-900">
            {item.name}
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            {item.directoryEntryCount} 条联系人记录
          </p>
        </div>
        <CooperationDepth item={item} />
      </div>
      <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-400">
            供应商联系人
          </p>
          <div className="mt-1.5">
            <SupplierContacts item={item} />
          </div>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-slate-400">园区对接人</p>
          <div className="mt-1.5">
            <ParkLiaisons item={item} />
          </div>
        </div>
        <div className="sm:col-span-2">
          <p className="text-[11px] font-semibold text-slate-400">
            关联执行合同
          </p>
          <div className="mt-1.5">
            <RelatedContracts item={item} onOpen={onOpenContracts} />
          </div>
        </div>
      </div>
    </article>
  );
}

const cooperationDepthMeta: Record<
  ContractSupplierCooperationDepth,
  { label: string; className: string }
> = {
  over_100k: {
    label: '＞10万',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  '50k_to_100k': {
    label: '5万–10万',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  under_50k: {
    label: '＜5万',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  },
};

function CooperationDepth({ item }: { item: ContractSupplierDirectoryItem }) {
  const meta = cooperationDepthMeta[item.cooperationDepth];
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className={cn(
          'rounded-md border px-2 py-1 text-[11px] font-semibold',
          meta.className,
        )}
      >
        {meta.label}
      </span>
      <strong className="text-xs tabular-nums text-slate-900">
        {formatCurrency(item.linkedContractAmount)}
      </strong>
    </div>
  );
}

function SupplierContacts({ item }: { item: ContractSupplierDirectoryItem }) {
  if (!item.contacts.length) {
    return <span className="text-xs text-amber-700">联系人待补充</span>;
  }
  return (
    <div className="space-y-1.5">
      {item.contacts.slice(0, 3).map((contact, index) => (
        <div
          key={`${contact.name}:${contact.phone}:${index}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
        >
          <span className="inline-flex items-center gap-1 text-slate-700">
            <UserRound className="h-3.5 w-3.5 text-slate-400" />
            {contact.name || '姓名待补充'}
          </span>
          {contact.phone ? (
            <span className="font-semibold tabular-nums text-blue-700">
              {contact.phone}
            </span>
          ) : (
            <span className="text-amber-700">电话待补充</span>
          )}
        </div>
      ))}
      {item.contacts.length > 3 && (
        <p className="text-[11px] text-slate-400">
          另有 {item.contacts.length - 3} 位联系人
        </p>
      )}
    </div>
  );
}

function ParkLiaisons({ item }: { item: ContractSupplierDirectoryItem }) {
  if (!item.parkLiaisons.length) {
    return <span className="text-xs text-amber-700">园区对接人待补充</span>;
  }
  return (
    <div className="flex max-w-[240px] flex-wrap gap-1.5">
      {item.parkLiaisons.map((name) => (
        <span
          key={name}
          className="rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700"
        >
          {name}
        </span>
      ))}
    </div>
  );
}

function RelatedContracts({
  item,
  onOpen,
}: {
  item: ContractSupplierDirectoryItem;
  onOpen: (item: ContractSupplierDirectoryItem) => void;
}) {
  if (!item.relatedContracts.length) {
    return <span className="text-xs text-amber-700">关联合同待维护</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-label={`查看关联合同：${item.name}`}
      className="group block space-y-1.5 rounded-lg text-left transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
    >
      <p className="text-xs font-semibold text-slate-700">
        {item.relatedContracts.length} 份 · {item.activeContractCount}{' '}
        份履约中/临期
      </p>
      <div className="flex max-w-[320px] flex-wrap gap-1.5">
        {item.relatedContracts.slice(0, 3).map((contract) => (
          <span
            key={contract.recordId}
            title={contract.name}
            className="max-w-[180px] truncate rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 transition group-hover:bg-blue-100 group-hover:text-blue-700"
          >
            {contract.code || contract.name}
          </span>
        ))}
        {item.relatedContracts.length > 3 && (
          <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
            +{item.relatedContracts.length - 3}
          </span>
        )}
      </div>
    </button>
  );
}

function SupplierContractListDialog({
  item,
  onOpenChange,
}: {
  item: ContractSupplierDirectoryItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80dvh] w-[min(94vw,680px)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-5 py-4 text-left">
          <DialogTitle className="text-base font-bold text-slate-950">
            {item?.name || '供应商'} · 关联合同
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs text-slate-500">
            查看合同名称和合同周期，共 {item?.relatedContracts.length ?? 0} 份。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-4">
          {item?.relatedContracts.map((contract) => (
            <article
              key={contract.recordId}
              className="rounded-lg border border-slate-200 bg-slate-50/70 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 text-sm font-semibold text-slate-900">
                  {contract.name || '合同名称待补充'}
                </h3>
                <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 shadow-sm">
                  {contract.code || '合同编号待补充'}
                </span>
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-600">
                <CalendarDays className="h-4 w-4 shrink-0 text-blue-500" />
                <span className="font-semibold text-slate-500">合同周期</span>
                <span className="tabular-nums">
                  {formatContractPeriod(contract.startDate, contract.endDate)}
                </span>
              </div>
            </article>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function filterSupplierDirectory(
  items: ContractSupplierDirectoryItem[],
  query: string,
): ContractSupplierDirectoryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  if (!normalizedQuery) return items;
  return items.filter((item) =>
    [
      item.name,
      ...item.contacts.flatMap((contact) => [contact.name, contact.phone]),
      ...item.parkLiaisons,
      ...item.relatedContracts.flatMap((contract) => [
        contract.code,
        contract.name,
      ]),
    ]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery),
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatContractPeriod(
  startDate: string | null,
  endDate: string | null,
): string {
  return `${formatContractDate(startDate)} 至 ${formatContractDate(endDate)}`;
}

function formatContractDate(value: string | null): string {
  if (!value) return '待补充';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : value;
}
