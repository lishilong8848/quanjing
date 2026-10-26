import { useState } from 'react';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ThresholdDialogContent as DialogContent } from './ThresholdDialogContent';
import { Button } from '@/components/ui/button';
import { ThresholdList } from './ThresholdList';
import type { ThresholdRecord } from '@shared/threshold-management.interface';

export function ThresholdDetail({
  record,
  onClose,
  onEdit,
  onDelete,
  syncing,
}: {
  record: ThresholdRecord | undefined;
  onClose: () => void;
  onEdit: (record: ThresholdRecord) => void;
  onDelete?: (record: ThresholdRecord) => void;
  syncing: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="threshold-dialog">
        <DialogHeader>
          <DialogTitle>{record?.parameter || '阈值详情'}</DialogTitle>
          <DialogDescription className="sr-only">
            设备参数详情与原表记录
          </DialogDescription>
        </DialogHeader>
        {record ? (
          <>
            <div className="threshold-detail-value">
              <strong>{record.value}</strong>
              {record.value !== '' &&
                record.value !== '/' &&
                record.unit &&
                !record.value.includes(record.unit) && (
                  <span>{record.unit}</span>
                )}
            </div>
            <dl className="threshold-detail-grid">
              {[
                ['专业', record.profession],
                ['设备', record.device],
                ['楼栋', record.building || '待核对'],
                ['位置', record.location],
                ['设备型号', record.model],
                ['品牌', record.brand],
                ['参数分组', record.section],
                ['参数类型', record.kind],
                ['运行范围', record.range],
                ['告警使能', record.enabled],
                ['备注', record.note],
                [
                  '原表',
                  record.source
                    ? `${record.source.sheet} · ${record.source.cell}`
                    : '—',
                ],
                ['原始值', record.source?.originalValue || '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
            <DialogFooter className="threshold-detail-actions">
              {onDelete && (
                <Button
                  variant="outline"
                  className="threshold-delete"
                  disabled={syncing}
                  onClick={() => onDelete(record)}
                >
                  删除
                </Button>
              )}
              {syncing && (
                <span className="threshold-sync" role="status">
                  同步中
                </span>
              )}
              <Button disabled={syncing} onClick={() => onEdit(record)}>
                申请调整
              </Button>
            </DialogFooter>
          </>
        ) : (
          <p role="status">该阈值已删除</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function ThresholdDrilldown({
  title,
  records,
  error,
  onClose,
  onDetail,
}: {
  title: string;
  records: ThresholdRecord[];
  error: string;
  onClose: () => void;
  onDetail: (record: ThresholdRecord) => void;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(records.length / 20));
  const current = Math.min(page, totalPages);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="threshold-dialog threshold-drilldown">
        <DialogHeader>
          <DialogTitle>
            {title} · {records.length.toLocaleString()} 项
          </DialogTitle>
          <DialogDescription className="sr-only">
            当前筛选范围的阈值明细
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="threshold-error">
            {error}。当前展示最近一次成功读取的数据
          </p>
        )}
        {records.length ? (
          <ThresholdList
            records={records.slice((current - 1) * 20, current * 20)}
            pending={new Set()}
            canDelete={false}
            onDetail={onDetail}
          />
        ) : (
          <p className="threshold-empty">暂无参数</p>
        )}
        <DialogFooter>
          <div className="threshold-pagination">
            <Button
              variant="outline"
              size="sm"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </Button>
            <span>
              {current} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={current >= totalPages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
