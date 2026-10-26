import { Server, ShieldCheck, Clock4, ClipboardCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

import type {
  LedgerSummary,
  LedgerQuery,
} from '@shared/equipment-ledger.interface';

export interface LedgerSelection {
  title: string;
  query: LedgerQuery;
  dimension?: 'families' | 'brands';
}
export function LedgerMetrics({
  summary,
  onSelect,
}: {
  summary: LedgerSummary;
  onSelect: (selection: LedgerSelection) => void;
}) {
  const definitions = [
    { key: 'total', title: '设备条目', icon: Server, tone: 'blue', query: {} },
    {
      key: 'inWarranty',
      title: '在保',
      icon: ShieldCheck,
      tone: 'success',
      query: { warranty: '在保' },
    },
    {
      key: 'expired',
      title: '过保',
      icon: Clock4,
      tone: 'blue',
      query: { warranty: '过保' },
    },
    {
      key: 'pending',
      title: '待确认',
      icon: ClipboardCheck,
      tone: 'muted',
      query: { warranty: '待确认' },
    },
  ] as const;
  return (
    <section
      className="equipment-ledger-metrics"
      aria-label={`${summary.building}设备指标`}
    >
      {definitions.map((item) => (
        <Card
          data-slot="card"
          key={item.key}
          className={`equipment-ledger-metric tone-${item.tone}`}
        >
          <CardContent data-slot="card-content" className="p-0">
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() =>
                onSelect({
                  title: item.title,
                  query: item.query,
                })
              }
            >
              <span className="equipment-ledger-metric-label">
                <span className="equipment-ledger-metric-icon">
                  <item.icon aria-hidden="true" />
                </span>
                {item.title}
              </span>
              <strong>
                {summary.metrics[item.key].toLocaleString('zh-CN')}
              </strong>
            </button>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
