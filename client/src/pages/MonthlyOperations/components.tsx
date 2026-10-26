import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  STATUS_LABELS,
  KIND_LABELS,
  numberFormat,
  percentage,
  type WorkRecord,
  type WorkStatus,
} from './model';
import { EmptyState } from './charts';

export function StatusBadge({ status }: { status: WorkStatus }) {
  return (
    <Badge variant="outline" className={`mo-status mo-status-${status}`}>
      <i />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
export function MetricCard({
  title,
  value,
  unit,
  note,
  delta,
  icon: Icon,
  tone = 'blue',
  onClick,
}: {
  title: string;
  value: string;
  unit?: string;
  note?: string;
  delta?: string;
  icon: LucideIcon;
  tone?: string;
  onClick: () => void;
}) {
  return (
    <Card className={`mo-metric mo-tone-${tone}`}>
      <button type="button" onClick={onClick} aria-label={`查看${title}明细`}>
        <div className="mo-metric-top">
          <span>{title}</span>
          <Icon aria-hidden="true" />
        </div>
        <div className="mo-metric-value">
          <strong>{value}</strong>
          <span>{unit}</span>
          <ChevronRight aria-hidden="true" />
        </div>
        {(note || delta) && (
          <div className="mo-metric-foot">
            {delta && (
              <span className="mo-delta">
                {delta.startsWith('-') ? <ArrowDownRight /> : <ArrowUpRight />}
                {delta}
              </span>
            )}
            <span>{note}</span>
          </div>
        )}
      </button>
    </Card>
  );
}
export function ProgressRow({
  label,
  done,
  total,
  onClick,
  tone = 'blue',
  suffix = '项',
  unavailable = false,
}: {
  label: string;
  done: number;
  total: number;
  onClick?: () => void;
  tone?: string;
  suffix?: string;
  unavailable?: boolean;
}) {
  return (
    <button
      className={`mo-progress-row mo-tone-${tone}`}
      type="button"
      onClick={onClick}
      disabled={!onClick}
    >
      <span className="mo-progress-label">
        <span>{label}</span>
        <strong>
          {unavailable || !total
            ? '—'
            : percentage(done, total).toFixed(1) + '%'}
        </strong>
      </span>
      <span className="mo-progress-track">
        <span style={{ width: `${Math.min(100, percentage(done, total))}%` }} />
      </span>
      <span className="mo-progress-detail">
        {unavailable
          ? '—'
          : `${numberFormat(done)} / ${numberFormat(total)} ${suffix}`}
        {onClick && <ChevronRight aria-hidden="true" />}
      </span>
    </button>
  );
}
export function WorkTable({
  records,
  onSelect,
  compact = false,
}: {
  records: WorkRecord[];
  onSelect: (item: WorkRecord) => void;
  compact?: boolean;
}) {
  if (!records.length) return <EmptyState />;
  return (
    <div className={`mo-work-table ${compact ? 'is-compact' : ''}`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>事项</TableHead>
            <TableHead>楼栋</TableHead>
            {!compact && <TableHead>类型 / 专业</TableHead>}
            <TableHead>日期</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>
              <span className="sr-only">查看详情</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={record.id}>
              <TableCell>
                <button
                  type="button"
                  className="mo-record-title"
                  onClick={() => onSelect(record)}
                >
                  {record.title}
                  <span>{record.id}</span>
                </button>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="mo-building-badge">
                  {record.building}
                </Badge>
              </TableCell>
              {!compact && (
                <TableCell>
                  {KIND_LABELS[record.kind]}
                  <small className="mo-table-secondary">
                    {record.specialty}
                  </small>
                </TableCell>
              )}
              <TableCell>{record.date}</TableCell>
              <TableCell>
                <StatusBadge status={record.status} />
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`查看详情：${record.id}`}
                  onClick={() => onSelect(record)}
                >
                  <ArrowUpRight aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
