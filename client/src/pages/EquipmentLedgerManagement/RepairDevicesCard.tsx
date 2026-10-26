import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CheckCheck, Clock3, Wrench } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type { LedgerAsset } from '@shared/equipment-ledger.interface';
import type { EquipmentHistoryDevicesState } from '@shared/equipment-history.interface';
import { classifyLedgerAsset } from '@shared/equipment-ledger-classification';
import { getEquipmentHistoryDevices } from './api';
import { useLedgerQuery, type LedgerCache } from './use-ledger-query';
import {
  formatRepairFaultDate,
  getRepairDeviceView,
  getRepairDevicePage,
  type RepairDeviceStatus,
} from './repair-device-view';
import './repair-devices.css';
import { createRepairDialogFocus } from './repair-dialog-focus';

export function RepairDevicesCard({
  cache,
  building,
  onAsset,
}: {
  cache: LedgerCache;
  building: string;
  onAsset: (asset: LedgerAsset) => void;
}) {
  const forceRefresh = useRef(false);
  const query = useLedgerQuery<EquipmentHistoryDevicesState>(
    cache,
    'repair-devices',
    (signal) => {
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return getEquipmentHistoryDevices(refresh, signal);
    },
  );
  const started = useRef(Date.now());
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!query.data?.refreshing && query.data?.status !== 'loading') return;
    if (Date.now() - started.current > 90000) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(query.retry, 1500);
    return () => clearTimeout(timer);
  }, [query.data, query.retry]);
  const [open, setOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const deviceList = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const deferredFocus = useMemo(() => createRepairDialogFocus(), []);
  useEffect(() => () => deferredFocus.cancel(), [deferredFocus]);
  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) deferredFocus.cancel();
      setOpen(nextOpen);
    },
    [deferredFocus],
  );
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [floor, setFloor] = useState('');
  const [family, setFamily] = useState('');
  const [status, setStatus] = useState<RepairDeviceStatus>('completed');
  const devices = useMemo(
    () =>
      (query.data?.devices || []).filter(
        (d) => !building || d.asset.building === building,
      ),
    [query.data, building],
  );
  const completed = devices.reduce((n, d) => n + d.completed, 0);
  const pending = devices.reduce((n, d) => n + d.pending, 0);
  const ready = query.data?.status === 'ready';
  const error =
    query.error ||
    query.data?.error ||
    (expired ? '维修设备更新超时，请重试' : '');
  const views = useMemo(
    () => ({
      all: getRepairDeviceView(devices, {
        floor,
        family,
        search,
        status: 'all',
      }),
      completed: getRepairDeviceView(devices, {
        floor,
        family,
        search,
        status: 'completed',
      }),
      pending: getRepairDeviceView(devices, {
        floor,
        family,
        search,
        status: 'pending',
      }),
    }),
    [devices, floor, family, search],
  );
  const { groups, deviceCount, recordCount } = views[status];
  const pagedViews = useMemo(
    () => ({
      all: getRepairDevicePage(views.all.groups, page),
      completed: getRepairDevicePage(views.completed.groups, page),
      pending: getRepairDevicePage(views.pending.groups, page),
    }),
    [views, page],
  );
  const paged = pagedViews[status];
  const deviceTables = useMemo(() => {
    const renderTable = (pageView: ReturnType<typeof getRepairDevicePage>) => (
      <Table className="equipment-repair-table" aria-label="维修设备清单">
        <TableHeader>
          <TableRow>
            <TableHead>设备 / 编号</TableHead>
            <TableHead>楼栋 / 种类</TableHead>
            <TableHead className="equipment-repair-desktop-column">
              品牌 / 型号
            </TableHead>
            <TableHead className="equipment-repair-desktop-column">
              最近故障
            </TableHead>
            <TableHead className="equipment-repair-desktop-column">
              故障摘要
            </TableHead>
            <TableHead>维修记录</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageView.groups
            .flatMap(([, rows]) => rows)
            .map((device) => {
              const kind = classifyLedgerAsset(device.asset).family;
              const date = formatRepairFaultDate(device.lastFaultAt);
              const brandModel =
                [device.asset.brand, device.asset.model]
                  .filter((value) => value && value !== '未填写')
                  .join(' · ') || '—';
              const fault = device.latestFault || '故障现象未填写';
              return (
                <TableRow key={device.asset.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="equipment-repair-device-link"
                      aria-label={`查看${device.asset.name} ${device.asset.sourceCode || device.asset.code}的机历`}
                      onClick={() => {
                        returnFocus.current = null;
                        changeOpen(false);
                        onAsset(device.asset);
                      }}
                    >
                      <span className="equipment-repair-device-name">
                        <strong>{device.asset.name}</strong>
                        <span>
                          {device.asset.sourceCode || device.asset.code}
                        </span>
                      </span>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                    <span className="equipment-repair-mobile-detail">
                      {brandModel} · {date}
                    </span>
                    <span className="equipment-repair-mobile-detail equipment-repair-device-fault">
                      {fault}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="equipment-repair-device-group">
                      <strong>{device.asset.building}</strong>
                      <span>{kind}</span>
                    </span>
                  </TableCell>
                  <TableCell className="equipment-repair-desktop-column">
                    <span
                      className="equipment-repair-device-fault"
                      title={brandModel}
                    >
                      {brandModel}
                    </span>
                  </TableCell>
                  <TableCell className="equipment-repair-desktop-column">
                    <time dateTime={device.lastFaultAt || undefined}>
                      {date}
                    </time>
                  </TableCell>
                  <TableCell className="equipment-repair-desktop-column">
                    <span
                      className="equipment-repair-device-fault"
                      title={fault}
                    >
                      {fault}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="equipment-repair-device-status">
                      <span>共 {device.count} 条</span>
                      <span className="is-completed">
                        完成 {device.completed}
                      </span>
                      {device.pending ? (
                        <span className="is-pending">
                          待维修 {device.pending}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
    );
    return {
      all: renderTable(pagedViews.all),
      completed: renderTable(pagedViews.completed),
      pending: renderTable(pagedViews.pending),
    };
  }, [pagedViews, changeOpen, onAsset]);

  useEffect(() => {
    if (deviceList.current) deviceList.current.scrollTop = 0;
  }, [paged.page, floor, family, status, search]);
  const openDetails = (
    nextStatus: RepairDeviceStatus,
    trigger: HTMLButtonElement,
  ) => {
    returnFocus.current = trigger;
    setSearch('');
    setPage(1);
    setFamily('');
    setFloor(building);
    setStatus(nextStatus);
    setOpen(true);
  };
  const reset = () => {
    forceRefresh.current = true;
    started.current = Date.now();
    setExpired(false);
    query.retry();
  };
  return (
    <>
      <Card className="equipment-repair-card" data-slot="card">
        <CardHeader data-slot="card-header">
          <CardTitle data-slot="card-title">
            <Wrench aria-hidden="true" />
            维修设备
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => openDetails('all', event.currentTarget)}
            aria-haspopup="dialog"
          >
            查看设备
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </CardHeader>
        <CardContent data-slot="card-content">
          <div className="equipment-repair-totals">
            <Button
              variant="ghost"
              className="equipment-repair-stat is-all"
              disabled={!ready}
              aria-haspopup="dialog"
              aria-label={`查看全部维修设备，共${ready ? devices.length : '—'}台`}
              onClick={(event) => openDetails('all', event.currentTarget)}
            >
              <Wrench aria-hidden="true" />
              <span>有维修记录设备</span>
              <strong>
                {ready ? devices.length : '—'}
                <small>台</small>
              </strong>
              <ArrowUpRight
                className="equipment-repair-stat-arrow"
                aria-hidden="true"
              />
            </Button>
            <Button
              variant="ghost"
              className="equipment-repair-stat is-completed"
              disabled={!ready}
              aria-haspopup="dialog"
              aria-label={`查看已完成维修，共${ready ? completed : '—'}条`}
              onClick={(event) => openDetails('completed', event.currentTarget)}
            >
              <CheckCheck aria-hidden="true" />
              <span>已完成维修</span>
              <strong>
                {ready ? completed : '—'}
                <small>条</small>
              </strong>
              <ArrowUpRight
                className="equipment-repair-stat-arrow"
                aria-hidden="true"
              />
            </Button>
            <Button
              variant="ghost"
              className="equipment-repair-stat is-pending"
              disabled={!ready}
              aria-haspopup="dialog"
              aria-label={`查看待维修记录，共${ready ? pending : '—'}条`}
              onClick={(event) => openDetails('pending', event.currentTarget)}
            >
              <Clock3 aria-hidden="true" />
              <span>待维修记录</span>
              <strong>
                {ready ? pending : '—'}
                <small>条</small>
              </strong>
              <ArrowUpRight
                className="equipment-repair-stat-arrow"
                aria-hidden="true"
              />
            </Button>
          </div>
          {error ? (
            <p role="alert">
              {error}
              <Button variant="ghost" size="sm" onClick={reset}>
                重试
              </Button>
            </p>
          ) : !ready ? (
            <p role="status">正在读取维修设备…</p>
          ) : query.data?.stale ? (
            <p role="status">当前展示最近成功读取的维修记录</p>
          ) : null}
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            deferredFocus.schedule(() => searchInput.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected)
              returnFocus.current.focus({ preventScroll: true });
          }}
          className="equipment-ledger-dialog equipment-repair-dialog sm:max-w-4xl"
        >
          <DialogHeader>
            <DialogTitle>维修设备</DialogTitle>
            <DialogDescription className="sr-only">
              按楼栋、设备种类和维修状态筛选设备，查看机历
            </DialogDescription>
          </DialogHeader>
          <div className="equipment-repair-filters">
            <Input
              ref={searchInput}
              aria-label="搜索维修设备"
              placeholder="搜索设备、编号、品牌或故障"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value.slice(0, 200));
                setPage(1);
              }}
            />
            <NativeSelect
              aria-label="维修设备楼栋"
              value={floor}
              onChange={(e) => {
                setFloor(e.target.value);
                setPage(1);
              }}
            >
              <NativeSelectOption value="">全部楼栋</NativeSelectOption>
              {[...new Set(devices.map((d) => d.asset.building))]
                .sort()
                .map((b) => (
                  <NativeSelectOption key={b} value={b}>
                    {b}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
            <NativeSelect
              aria-label="维修设备种类"
              value={family}
              onChange={(e) => {
                setFamily(e.target.value);
                setPage(1);
              }}
            >
              <NativeSelectOption value="">全部种类</NativeSelectOption>
              {[
                ...new Set(
                  devices.map((d) => classifyLedgerAsset(d.asset).family),
                ),
              ]
                .sort()
                .map((f) => (
                  <NativeSelectOption key={f} value={f}>
                    {f}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
            <NativeSelect
              aria-label="维修记录状态"
              value={status}
              onChange={(e) => {
                const value = e.target.value;
                if (
                  value === 'all' ||
                  value === 'completed' ||
                  value === 'pending'
                ) {
                  setStatus(value);
                  setPage(1);
                }
              }}
            >
              <NativeSelectOption value="completed">已维修</NativeSelectOption>
              <NativeSelectOption value="pending">待维修</NativeSelectOption>
              <NativeSelectOption value="all">全部记录</NativeSelectOption>
            </NativeSelect>
          </div>
          {ready ? (
            <p className="equipment-repair-result-count">
              <strong>{deviceCount}</strong>台设备
              <span>·</span>
              <strong>{recordCount}</strong>条维修记录
            </p>
          ) : null}
          <div ref={deviceList} className="equipment-repair-device-list">
            {error ? (
              <p role="alert">
                {error}
                <Button variant="outline" onClick={reset}>
                  重试
                </Button>
              </p>
            ) : null}
            {!ready ? (
              error ? null : (
                <p role="status">正在读取维修设备…</p>
              )
            ) : groups.length ? (
              deviceTables[status]
            ) : (
              <p className="equipment-ledger-empty">暂无匹配设备</p>
            )}
          </div>
          <div className="equipment-ledger-dialog-footer">
            {paged.pageCount > 1 ? (
              <nav
                aria-label="维修设备分页"
                className="equipment-repair-pagination"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={paged.page === 1}
                  onClick={() => setPage(paged.page - 1)}
                >
                  上一页
                </Button>
                <span aria-live="polite">
                  {paged.page} / {paged.pageCount}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={paged.page === paged.pageCount}
                  onClick={() => setPage(paged.page + 1)}
                >
                  下一页
                </Button>
              </nav>
            ) : null}
            <Button variant="outline" onClick={() => changeOpen(false)}>
              关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
