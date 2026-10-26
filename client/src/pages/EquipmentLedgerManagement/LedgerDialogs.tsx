import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type {
  LedgerAsset,
  LedgerLifecycle,
  LedgerSummary,
  LedgerQuery,
} from '@shared/equipment-ledger.interface';
import type { LedgerCache } from './use-ledger-query';
import type { LedgerSelection } from './LedgerPanels';
import { LedgerList, WarrantyBadge } from './LedgerList';
import { EquipmentHistoryCard } from './EquipmentHistoryCard';

function Close() {
  return (
    <DialogClose asChild>
      <Button variant="outline" size="sm">
        关闭
      </Button>
    </DialogClose>
  );
}
export function LedgerDrilldown({
  selection,
  summary,
  cache,
  snapshotId,
  onChange,
  onAsset,
  onSnapshotChange,
  onRestoreFocus,
}: {
  selection: LedgerSelection | null;
  summary: LedgerSummary;
  cache: LedgerCache;
  snapshotId: string;
  onChange: (selection: LedgerSelection | null) => void;
  onAsset: (asset: LedgerAsset) => void;
  onSnapshotChange: () => void;
  onRestoreFocus: () => void;
}) {
  const dimension = selection?.dimension;
  const points = dimension
    ? summary[dimension].filter(
        (point) =>
          point.name !== '未填写' &&
          (!selection?.query.system ||
            summary.systems
              .find((system) => system.name === selection.query.system)
              ?.families.includes(point.name)),
      )
    : [];
  return (
    <Dialog
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) onChange(null);
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
        className="equipment-ledger-dialog sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle>{selection?.title}</DialogTitle>
          <DialogDescription className="sr-only">
            当前选择的设备清单
          </DialogDescription>
        </DialogHeader>
        {selection ? (
          dimension ? (
            <ol className="equipment-ledger-dimension-list">
              {points.map((point) => (
                <li key={point.name}>
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        title: selection.query.building
                          ? `${selection.query.building} · ${point.name}`
                          : point.name,
                        query: {
                          ...selection.query,
                          [dimension === 'families' ? 'family' : 'brand']:
                            point.name,
                        },
                      })
                    }
                  >
                    <span>{point.name}</span>
                    <strong>{point.count.toLocaleString('zh-CN')} 条</strong>
                  </button>
                </li>
              ))}
              {!points.length ? (
                <li className="equipment-ledger-empty">暂无数据</li>
              ) : null}
            </ol>
          ) : (
            <LedgerList
              cache={cache}
              snapshotId={snapshotId}
              query={selection.query}
              onQueryChange={(query: LedgerQuery) =>
                onChange({ ...selection, query })
              }
              onAsset={onAsset}
              onSnapshotChange={onSnapshotChange}
            />
          )
        ) : null}
        <div className="equipment-ledger-dialog-footer">
          <Close />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AssetDetail({
  asset,
  historyCache,
  historySnapshotId,
  lifecycle,
  lifecycleLoading,
  lifecycleError,
  detailLoading,
  detailError,
  onDetailRetry,
  onRetry,
  onClose,
  onRestoreFocus,
}: {
  asset: LedgerAsset | null;
  historyCache?: LedgerCache;
  historySnapshotId?: string;
  lifecycle?: LedgerLifecycle;
  lifecycleLoading: boolean;
  lifecycleError: string;
  detailLoading: boolean;
  detailError: string;
  onDetailRetry: () => void;
  onRetry: () => void;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const [detailTab, setDetailTab] = useState('history');
  useEffect(() => setDetailTab('history'), [asset?.id]);
  const sections = useMemo(
    () =>
      asset && lifecycle
        ? [
            {
              title: '同类生命周期',
              rows: lifecycle.assets
                .filter(
                  (item) =>
                    item.building === asset.building &&
                    item.name === asset.name,
                )
                .map((item) => ({ ...item, dueDate: item.dueDate })),
            },
            {
              title: '楼栋维护合同',
              rows: lifecycle.maintenanceContracts.filter(
                (item) => item.building === asset.building,
              ),
            },
            {
              title: '楼栋长期维护',
              rows: lifecycle.longTermMaintenance.filter(
                (item) => item.building === asset.building,
              ),
            },
            {
              title: '楼栋关键器件',
              rows: lifecycle.keyParts.filter(
                (item) => item.building === asset.building,
              ),
            },
          ]
        : [],
    [asset, lifecycle],
  );
  return (
    <Dialog
      open={Boolean(asset)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
        className="equipment-ledger-dialog sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{asset?.name}</DialogTitle>
          <DialogDescription className="sr-only">
            设备台账详情
          </DialogDescription>
        </DialogHeader>
        {asset ? (
          <div className="equipment-ledger-detail-body">
            <div className="equipment-ledger-detail-heading">
              <span>
                {asset.building} · {asset.sourceCode || asset.code}
              </span>
              <WarrantyBadge value={asset.warranty} />
            </div>
            {detailLoading ? (
              <p role="status" className="equipment-ledger-loading">
                正在更新设备详情…
              </p>
            ) : null}
            {detailError ? (
              <div role="alert" className="equipment-ledger-alert">
                {detailError}
                <Button variant="outline" size="sm" onClick={onDetailRetry}>
                  重试
                </Button>
              </div>
            ) : null}
            <nav className="equipment-detail-tabs" aria-label="设备详情内容">
              {[
                ['history', '机历信息'],
                ['info', '设备信息'],
                ['lifecycle', '生命周期'],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  aria-current={detailTab === value ? 'page' : undefined}
                  onClick={() => setDetailTab(value)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            {detailTab === 'info' ? (
              <>
                <dl className="equipment-ledger-detail-grid">
                  {Object.entries({
                    台账编号: asset.code,
                    设备编号: asset.sourceCode,
                    种类: asset.category,
                    系统: asset.specialty,
                    品牌: asset.brand,
                    型号: asset.model,
                    数量: asset.quantity,
                    安装位置: asset.location,
                    安装日期: asset.installedAt,
                    维保截止日期: asset.warrantyUntil,
                    '质保期（年）': asset.warrantyYears,
                    质保年限来源: asset.warrantySource,
                    序列号: asset.serial,
                    资产编号: asset.assetCode,
                    容量: asset.capacity,
                    运行方式: asset.operatingMode,
                    条目类型:
                      asset.kind === 'collection' ? '集合记录' : '设备明细',
                    盘点差异: asset.differences,
                    集合核查: asset.collectionAudit,
                  }).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value === null || value === '' ? '—' : value}</dd>
                    </div>
                  ))}
                </dl>
                {asset.parameters ? (
                  <details className="equipment-ledger-parameters">
                    <summary>产品参数</summary>
                    <p>{asset.parameters}</p>
                  </details>
                ) : null}
              </>
            ) : null}
            {detailTab === 'history' && asset.kind === 'detail' ? (
              <EquipmentHistoryCard
                key={`${historySnapshotId}:${asset.id}`}
                assetId={asset.id}
                cache={historyCache}
                snapshotId={historySnapshotId}
              />
            ) : null}
            {detailTab === 'history' && asset.kind === 'collection' ? (
              <p className="equipment-ledger-empty">集合记录无单台机历</p>
            ) : null}
            {detailTab === 'lifecycle' ? (
              <>
                {lifecycleLoading ? (
                  <p role="status" className="equipment-ledger-loading">
                    正在读取维护信息…
                  </p>
                ) : null}
                {lifecycleError ? (
                  <div className="equipment-ledger-alert" role="alert">
                    {lifecycleError}
                    <Button variant="outline" size="sm" onClick={onRetry}>
                      重试
                    </Button>
                  </div>
                ) : null}
                {lifecycle && lifecycle.status !== 'fresh' ? (
                  <p className="equipment-ledger-notice">
                    维护信息当前展示最近一次成功同步的数据
                  </p>
                ) : null}
                {sections.map((section) => (
                  <section
                    key={section.title}
                    className="equipment-ledger-related"
                  >
                    <h3>
                      {section.title}
                      <span>{section.rows.length}</span>
                    </h3>
                    {section.rows.length ? (
                      <ul>
                        {section.rows.map((row) => (
                          <li key={row.id}>
                            <span>{row.name}</span>
                            <span>{row.status}</span>
                            <time>{row.dueDate || '—'}</time>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="equipment-ledger-empty">暂无记录</p>
                    )}
                  </section>
                ))}
              </>
            ) : null}
          </div>
        ) : null}
        <div className="equipment-ledger-dialog-footer">
          <Close />
        </div>
      </DialogContent>
    </Dialog>
  );
}
