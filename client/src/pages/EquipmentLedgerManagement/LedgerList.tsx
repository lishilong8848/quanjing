import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  LedgerAsset,
  LedgerPage,
  LedgerQuery,
} from '@shared/equipment-ledger.interface';
import { getLedgerItems } from './api';
import { classifyLedgerAsset } from '@shared/equipment-ledger-classification';
import { useLedgerQuery, type LedgerCache } from './use-ledger-query';

export function WarrantyBadge({ value }: { value: string }) {
  return (
    <Badge
      variant="outline"
      className={`equipment-ledger-status tone-${value === '在保' ? 'success' : value === '过保' ? 'error' : 'warning'}`}
    >
      {value}
    </Badge>
  );
}
export function LedgerList({
  cache,
  snapshotId,
  query,
  onQueryChange,
  onAsset,
  onSnapshotChange,
}: {
  cache: LedgerCache;
  snapshotId: string;
  query: LedgerQuery;
  onQueryChange: (query: LedgerQuery) => void;
  onAsset: (asset: LedgerAsset) => void;
  onSnapshotChange: () => void;
}) {
  const key = `items:${snapshotId}:${JSON.stringify(query)}`;
  const result = useLedgerQuery<LedgerPage>(cache, key, (signal) =>
    getLedgerItems(query, signal),
  );
  const page = result.data;
  const mismatch = Boolean(page && page.snapshotId !== snapshotId);
  useEffect(() => {
    if (mismatch) onSnapshotChange();
  }, [mismatch, onSnapshotChange]);
  return (
    <div
      className="equipment-ledger-list"
      aria-busy={result.loading || mismatch}
    >
      {query.search?.trim() && page && !mismatch ? (
        <p role="status" className="equipment-ledger-result-count">
          搜索结果 {page.total.toLocaleString('zh-CN')} 条
        </p>
      ) : null}
      {result.error ? (
        <div role="alert" className="equipment-ledger-alert">
          {result.error}
          {page ? '；当前展示最近成功读取的数据' : ''}
          <Button variant="outline" size="sm" onClick={result.retry}>
            重试
          </Button>
        </div>
      ) : null}
      {page?.stale ? (
        <p role="status" className="equipment-ledger-notice">
          当前展示最近一次成功同步的数据
        </p>
      ) : null}
      {result.loading || mismatch ? (
        <p role="status" className="equipment-ledger-loading">
          正在读取设备清单…
        </p>
      ) : null}
      {!mismatch && page ? (
        <>
          <div className="equipment-ledger-table-wrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备</TableHead>
                  <TableHead>楼栋</TableHead>
                  <TableHead>种类 / 系统</TableHead>
                  <TableHead>品牌 / 型号</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead>维保截止</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.length ? (
                  page.items.map((asset) => (
                    <TableRow key={asset.id}>
                      <TableCell>
                        <button
                          className="equipment-ledger-device"
                          type="button"
                          onClick={() => onAsset(asset)}
                          aria-haspopup="dialog"
                        >
                          <strong>{asset.name}</strong>
                          <span title={asset.sourceCode || asset.code}>
                            {asset.sourceCode || asset.code}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell>{asset.building}</TableCell>
                      <TableCell>
                        <span className="equipment-ledger-cell-main">
                          {classifyLedgerAsset(asset).family}
                        </span>
                        <span className="equipment-ledger-cell-secondary">
                          {classifyLedgerAsset(asset).system}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="equipment-ledger-cell-main">
                          {asset.brand}
                        </span>
                        <span className="equipment-ledger-cell-secondary">
                          {asset.model}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {asset.quantity ?? '—'}
                      </TableCell>
                      <TableCell>{asset.warrantyUntil || '—'}</TableCell>
                      <TableCell>
                        <WarrantyBadge value={asset.warranty} />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onAsset(asset)}
                        >
                          详情
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <p className="equipment-ledger-empty">
                        没有符合条件的设备
                      </p>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="equipment-ledger-mobile-list">
            {page.items.map((asset) => (
              <button
                key={asset.id}
                className="equipment-ledger-mobile-row"
                type="button"
                onClick={() => onAsset(asset)}
              >
                <span>
                  <strong>{asset.name}</strong>
                  <small>
                    {asset.building} · {asset.sourceCode || asset.code}
                  </small>
                  <small>
                    {asset.brand} · {asset.model}
                  </small>
                </span>
                <span>
                  <WarrantyBadge value={asset.warranty} />
                  <small>{asset.warrantyUntil || '—'}</small>
                </span>
              </button>
            ))}
            {!page.items.length ? (
              <p className="equipment-ledger-empty">没有符合条件的设备</p>
            ) : null}
          </div>
          <div className="equipment-ledger-pagination">
            <span>共 {page.total.toLocaleString('zh-CN')} 条</span>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={result.loading || page.page <= 1}
                aria-label="上一页"
                onClick={() => onQueryChange({ ...query, page: page.page - 1 })}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span>
                {page.page} / {page.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={result.loading || page.page >= page.totalPages}
                aria-label="下一页"
                onClick={() => onQueryChange({ ...query, page: page.page + 1 })}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
