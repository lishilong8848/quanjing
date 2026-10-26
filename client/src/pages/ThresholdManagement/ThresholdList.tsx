import { memo } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ThresholdRecord } from '@shared/threshold-management.interface';

export const needsThresholdReview = (record: ThresholdRecord) =>
  !record.value || !record.building || record.kind === '待核对';
export const ThresholdList = memo(function ThresholdList({
  records,
  pending,
  canDelete,
  onDetail,
  onEdit,
  onDelete,
}: {
  records: ThresholdRecord[];
  pending: Set<string>;
  canDelete: boolean;
  onDetail: (record: ThresholdRecord) => void;
  onEdit?: (record: ThresholdRecord) => void;
  onDelete?: (record: ThresholdRecord) => void;
}) {
  return (
    <table className="threshold-table">
      <caption className="sr-only">设备阈值清单</caption>
      <thead>
        <tr>
          <th>设备 / 型号 / 位置</th>
          <th>参数</th>
          <th>楼栋 / 类型</th>
          <th>设定值</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr
            key={record.id}
            data-pending={pending.has(record.id) || undefined}
          >
            <td>
              <span className="threshold-mobile-label">设备</span>
              <strong>{record.device}</strong>
              {record.model && (
                <span className="threshold-secondary">{record.model}</span>
              )}
              <span className="threshold-secondary">
                {record.location || '—'}
              </span>
            </td>
            <td>
              <span className="threshold-mobile-label">参数</span>
              <button
                className="threshold-link"
                onClick={() => onDetail(record)}
              >
                {record.parameter}
              </button>
              <span className="threshold-secondary">
                {record.section || '—'}
              </span>
            </td>
            <td>
              <span className="threshold-mobile-label">楼栋 / 类型</span>
              <strong>{record.building || '待核对'}</strong>
              <span className="threshold-secondary">{record.kind}</span>
            </td>
            <td>
              <span className="threshold-mobile-label">设定值</span>
              <button
                className="threshold-value"
                aria-label={`查看${record.parameter}设定值`}
                onClick={() => onDetail(record)}
              >
                <span>{record.value}</span>
                {record.value !== '' &&
                  record.value !== '/' &&
                  record.unit &&
                  !record.value.includes(record.unit) && (
                    <small>{record.unit}</small>
                  )}
              </button>
              {record.enabled && (
                <span className="threshold-secondary">
                  使能 {record.enabled}
                </span>
              )}
            </td>
            <td>
              <span className="threshold-mobile-label">状态</span>
              <Badge
                variant="outline"
                className={
                  pending.has(record.id)
                    ? 'threshold-sync'
                    : needsThresholdReview(record)
                      ? 'threshold-review'
                      : 'threshold-maintained'
                }
              >
                {pending.has(record.id)
                  ? '同步中'
                  : needsThresholdReview(record)
                    ? '待核对'
                    : '已维护'}
              </Badge>
            </td>
            <td>
              <div className="threshold-row-actions">
                {onEdit && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`申请调整${record.parameter}`}
                    disabled={pending.has(record.id)}
                    onClick={() => onEdit(record)}
                  >
                    <Pencil size={16} />
                  </Button>
                )}
                {canDelete && onDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`删除${record.parameter}`}
                    disabled={pending.has(record.id)}
                    onClick={() => onDelete(record)}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});
