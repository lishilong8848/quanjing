import { useRef, useState } from 'react';
import {
  Droplets,
  Gauge,
  Server,
  Thermometer,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { Panel, ColumnChart } from './charts';
import { MetricCard } from './components';
import { numberFormat } from './model';
import type { PanelProps } from './Overview';
import { LoadCharts } from './LoadCharts';
import { EnergyExplorer, RackCharts } from './ResourceCharts';
import { useResourceData } from './resource-data';
import { resourceValue, resourceCoverage } from './resource-model';
import { FeishuSourceLinks } from './FeishuSourceLinks';
import { SourceModal } from './SourceModal';

export function CapacityPanel({ view, openDetail }: PanelProps) {
  const [source, setSource] = useState<'racks' | 'load' | 'reserve'>('racks');
  const [movement, setMovement] = useState<'poweredOn' | 'poweredOff' | null>(
    null,
  );
  const movementTrigger = useRef<HTMLElement | null>(null);
  const { data } = useResourceData();
  const movementRows = (data?.rackMovements?.rows ?? []).filter(
    (row) => view.building === 'all' || row.building === view.building,
  );
  const movementValue = (field: 'poweredOn' | 'poweredOff') =>
    movementRows.length
      ? numberFormat(movementRows.reduce((sum, row) => sum + row[field], 0))
      : '—';
  const openMovement = (field: 'poweredOn' | 'poweredOff') => {
    movementTrigger.current = document.activeElement as HTMLElement;
    setMovement(field);
  };
  return (
    <>
      <Tabs
        value={source}
        onValueChange={(value) => setSource(value as typeof source)}
        className="mo-topic-content"
      >
        <div className="mo-section-heading">
          <div>
            <span className="mo-eyebrow">CAPACITY & RESERVES</span>
            <h2>容量看余量，保障看储备。</h2>
          </div>
          <div className="mo-heading-actions">
            {source !== 'reserve' && <FeishuSourceLinks source={source} />}
            <TabsList className="mo-subtabs">
              <TabsTrigger value="racks">机柜使用</TabsTrigger>
              <TabsTrigger value="load">负载容量</TabsTrigger>
              <TabsTrigger value="reserve">水电油后备</TabsTrigger>
            </TabsList>
          </div>
        </div>
        <TabsContent value="racks">
          <RackCharts
            building={view.building}
            onDetail={(selectedBuilding) =>
              openDetail({
                title: '机柜容量明细',
                resource: 'capacity',
                building:
                  selectedBuilding === 'all' ? undefined : selectedBuilding,
              })
            }
            onLoadDetail={(selectedBuilding) =>
              openDetail({
                title: 'IT 负载率明细',
                resource: 'load',
                building:
                  selectedBuilding === 'all' ? undefined : selectedBuilding,
              })
            }
          />
          <div className="mo-demo-section-label">机柜变动 · 班次记录</div>
          <div className="mo-two-columns">
            <MetricCard
              title={`${view.period.scope}上电`}
              value={movementValue('poweredOn')}
              unit="柜"
              note={
                data?.rackMovements.status === 'error'
                  ? '读取失败，请刷新重试'
                  : '所选周期班次上电合计'
              }
              icon={TrendingUp}
              onClick={() => openMovement('poweredOn')}
            />
            <MetricCard
              title={`${view.period.scope}下电`}
              value={movementValue('poweredOff')}
              unit="柜"
              note={
                data?.rackMovements.status === 'error'
                  ? '读取失败，请刷新重试'
                  : '所选周期班次下电合计'
              }
              icon={Zap}
              tone="amber"
              onClick={() => openMovement('poweredOff')}
            />
          </div>
        </TabsContent>
        <TabsContent value="load">
          <LoadCharts building={view.building} />
        </TabsContent>
        <TabsContent value="reserve">
          <div className="mo-demo-section-label">水电油后备 · 演示数据</div>
          <div className="mo-two-columns">
            <Panel
              title="水油储备"
              onAction={() =>
                openDetail({
                  title: '水油储备演示明细',
                  resource: 'reserve',
                  demo: true,
                })
              }
            >
              <ColumnChart
                rows={view.resources.map((row) => ({
                  name: row.building,
                  water: row.waterReserve,
                  fuel: row.fuelReserve,
                }))}
                series={[
                  { key: 'water', name: '储备用水', color: 'var(--mo-sky)' },
                  { key: 'fuel', name: '柴油储备', color: 'var(--mo-amber)' },
                ]}
                unit=" m³"
              />
            </Panel>
            <Panel title="预计后备时长">
              <ColumnChart
                rows={view.resources.map((row) => ({
                  name: row.building,
                  backup: row.backupHours,
                }))}
                series={[
                  {
                    key: 'backup',
                    name: '预计后备时长',
                    color: 'var(--mo-teal)',
                  },
                ]}
                unit=" 小时"
              />
            </Panel>
          </div>
        </TabsContent>
      </Tabs>
      {movement && (
        <SourceModal
          title={`${view.period.scope}${movement === 'poweredOn' ? '上电' : '下电'}清单`}
          trigger={movementTrigger.current}
          onClose={() => setMovement(null)}
        >
          <div className="mo-assessment-sheet-body mo-rack-movement-sheet">
            {data?.rackMovements.status === 'error' ? (
              <p role="alert">
                {data.rackMovements.message || '机柜变动读取失败，请刷新重试'}
              </p>
            ) : movementRows.some((row) => row[movement] > 0) ? (
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>楼栋</th>
                    <th>班次</th>
                    <th>{movement === 'poweredOn' ? '上电' : '下电'}机柜</th>
                  </tr>
                </thead>
                <tbody>
                  {movementRows
                    .filter((row) => row[movement] > 0)
                    .map((row) => (
                      <tr key={row.id}>
                        <td>{row.date}</td>
                        <td>{row.building}</td>
                        <td>{row.shift}</td>
                        <td>{row[movement]} 柜</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <p>
                所选周期暂无{movement === 'poweredOn' ? '上电' : '下电'}机柜记录
              </p>
            )}
          </div>
        </SourceModal>
      )}
    </>
  );
}
export function EnergyPanel({ view, openDetail }: PanelProps) {
  const [source, setSource] = useState<'electricity' | 'water'>('electricity');
  const { data, status } = useResourceData();
  const metrics = [
    {
      key: 'pue' as const,
      title: `${view.period.noun} PUE`,
      icon: Gauge,
      unit: undefined,
      note:
        view.building === 'all'
          ? '园区仅 A–C · 电量加权'
          : 'PUE 字段 · IT 电量加权',
    },
    {
      key: 'total' as const,
      title: `${view.period.scope}累计用电`,
      icon: Zap,
      unit: '万 kWh',
      note: '实际电量 · 园区合计 A–E 楼',
    },
    {
      key: 'it' as const,
      title: `${view.period.scope}IT 用电`,
      icon: Server,
      unit: '万 kWh',
      note: '所选周期有效日累计',
    },
    {
      key: 'nonIt' as const,
      title: `${view.period.scope}非 IT 用电`,
      icon: Thermometer,
      unit: '万 kWh',
      note: '按源表非 IT 用电字段累计',
    },
  ];
  return (
    <Tabs
      value={source}
      onValueChange={(value) => setSource(value as typeof source)}
      className="mo-topic-content"
    >
      <div className="mo-section-heading">
        <div>
          <span className="mo-eyebrow">ENERGY & WATER</span>
          <h2>看清消耗，也看清效率。</h2>
        </div>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source={source} />
          <TabsList className="mo-subtabs">
            <TabsTrigger value="electricity">电耗与能效</TabsTrigger>
            <TabsTrigger value="water">水耗与水效</TabsTrigger>
          </TabsList>
        </div>
      </div>
      <TabsContent value="electricity">
        <div className="mo-metrics">
          {metrics.map((metric) => {
            const value = resourceValue(data, metric.key, view.building);
            return (
              <MetricCard
                key={metric.key}
                title={metric.title}
                value={
                  value === null
                    ? '—'
                    : metric.key === 'pue'
                      ? value.toFixed(3)
                      : numberFormat(value / 10000, 1)
                }
                unit={metric.unit}
                note={
                  value === null
                    ? status === 'loading'
                      ? '正在读取实际数据…'
                      : '暂无有效数据，可刷新重试'
                    : `${metric.note} · ${resourceCoverage(data, metric.key, view.building)}`
                }
                icon={metric.icon}
                tone={metric.key === 'pue' ? 'teal' : 'blue'}
                onClick={() =>
                  openDetail({
                    title: '电耗与能效趋势',
                    resource: 'energy',
                    metric: metric.key,
                  })
                }
              />
            );
          })}
        </div>
        <Panel
          title="电耗、能效与气象趋势"
          action="放大查看"
          onAction={() =>
            openDetail({
              title: '电耗与能效趋势',
              resource: 'energy',
              metric: 'pue',
            })
          }
        >
          <EnergyExplorer
            key={`${view.period.key}-${view.building}`}
            period={view.period}
            building={view.building}
            initialWindow="period"
          />
        </Panel>
      </TabsContent>
      <TabsContent value="water">
        <div className="mo-metrics">
          {(
            [
              { key: 'water', title: '累计用水', unit: 'm³', icon: Droplets },
              {
                key: 'waterEast',
                title: '东区用水',
                unit: 'm³',
                icon: Droplets,
              },
              {
                key: 'waterWest',
                title: '西区用水',
                unit: 'm³',
                icon: Droplets,
              },
              { key: 'wue', title: 'WUE', unit: 'L/kWh', icon: Gauge },
            ] as const
          ).map((metric) => {
            const value = resourceValue(data, metric.key, view.building);
            return (
              <MetricCard
                key={metric.key}
                title={view.period.noun + ' ' + metric.title}
                value={
                  value === null
                    ? '—'
                    : numberFormat(value, metric.key === 'wue' ? 2 : 1)
                }
                unit={metric.unit}
                note={
                  value === null
                    ? status === 'loading'
                      ? '正在读取实际数据…'
                      : '暂无有效数据，可刷新重试'
                    : metric.key === 'wue'
                      ? `源表电量加权 · ${resourceCoverage(data, metric.key, view.building)}`
                      : `按日累计 · ${resourceCoverage(data, metric.key, view.building)}`
                }
                icon={metric.icon}
                tone="sky"
                onClick={() =>
                  openDetail({
                    title: '用水与水效趋势',
                    resource: 'water',
                    metric: metric.key,
                  })
                }
              />
            );
          })}
        </div>
        <Panel
          title="用水与水效趋势"
          action="放大查看"
          onAction={() =>
            openDetail({
              title: '用水与水效趋势',
              resource: 'water',
              metric: 'water',
            })
          }
        >
          <EnergyExplorer
            key={view.period.key + '-' + view.building}
            period={view.period}
            building={view.building}
            initialMetric="water"
            initialWindow="period"
          />
        </Panel>
      </TabsContent>
    </Tabs>
  );
}
