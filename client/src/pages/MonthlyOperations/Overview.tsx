import { useState } from 'react';
import { useOverviewOperations } from './overview-data';
import type { MonthlyEnergyBuilding } from '@shared/monthly-operations-resources.interface';
import { PueSummary } from './PueSummary';
import {
  ArrowRight,
  BellRing,
  Droplets,
  Gauge,
  Server,
  ShieldCheck,
  Wrench,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MetricCard, ProgressRow } from './components';
import { Panel } from './charts';
import { LiveTrend } from './ResourceCharts';
import { useResourceData } from './resource-data';
import { FeishuSourceLinks } from './FeishuSourceLinks';
import { rackSummary, resourceValue, energyBuilding } from './resource-model';
import {
  numberFormat,
  type DetailSelection,
  type MonthlyView,
  type Topic,
} from './model';

export interface PanelProps {
  view: MonthlyView;
  openDetail: (selection: DetailSelection) => void;
}
export function Overview({
  view,
  openDetail,
  onTopic,
}: PanelProps & { onTopic: (topic: Topic) => void }) {
  const [visible, setVisible] = useState<MonthlyEnergyBuilding[]>(
    view.building === 'all'
      ? ['园区', 'A楼', 'B楼', 'C楼']
      : energyBuilding(view.building)
        ? [energyBuilding(view.building)!]
        : [],
  );
  const operations = useOverviewOperations(view);
  const maintenance = operations.maintenance;
  const alarmPending = operations.alarmPending;
  const { data, status } = useResourceData();
  const rack = rackSummary(data, view.building);
  const pue = resourceValue(data, 'pue', view.building);
  const total = resourceValue(data, 'total', view.building);
  const it = resourceValue(data, 'it', view.building);
  const water = resourceValue(data, 'water', view.building);
  const load =
    view.building === 'all'
      ? data?.load?.park
      : data?.load?.rows.find((row) => row.building === view.building)?.value;
  const unavailable =
    status === 'loading' ? '正在读取实际数据…' : '暂无有效数据，可刷新重试';
  return (
    <div className="mo-topic-content">
      <div className="mo-overview-intro">
        <div>
          <span className="mo-eyebrow">OPERATIONS AT A GLANCE</span>
          <h2>
            {view.period.mode === 'month'
              ? '一个月'
              : view.period.mode === 'year'
                ? '一整年'
                : view.period.mode === 'last30' ? '过去30天' : '一段时间'}
            的运行，几个关键答案。
          </h2>
        </div>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source="overview" />
          <span className="mo-period-note">
            {view.period.partial
              ? `截至 ${view.asOf}`
              : `完整${view.period.noun}快照`}
            <span className="mo-dot" />
            资源实数 · 运维演示
          </span>
        </div>
      </div>
      <div className="mo-overview-summary">
        <Card className="mo-brief">
          <div className="mo-brief-copy">
            <span className="mo-overline">
              <ShieldCheck aria-hidden="true" />
              {view.period.noun}运行摘要
            </span>
            <h3>
              关注运行变化，
              <br />
              重点盯住执行进度。
            </h3>
            <p>
              已完成{' '}
              <strong>
                {operations.change.ready ? operations.change.done : '—'}
              </strong>{' '}
              项变更、
              <strong>
                {operations.drill.ready ? operations.drill.done : '—'}
              </strong>{' '}
              项演练；
              <br />
              维护计划完成率{' '}
              <strong>
                {maintenance.ready && maintenance.total
                  ? ((100 * maintenance.done) / maintenance.total).toFixed(1) +
                    '%'
                  : '—'}
              </strong>
              。
            </p>
            <Button variant="ghost" onClick={() => onTopic('assurance')}>
              查看执行进展 <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          <div className="mo-campus-art" aria-hidden="true">
            <div className="mo-orbit" />
            <div className="mo-campus-buildings">
              {['A', 'B', 'C', 'D', 'E'].map((building, index) => (
                <div
                  className="mo-building-art"
                  key={building}
                  style={{ height: `${54 + [28, 50, 38, 14, 0][index]}%` }}
                >
                  <span>{building}</span>
                  {Array.from({ length: 6 }, (_, floor) => (
                    <i key={floor} />
                  ))}
                </div>
              ))}
            </div>
            <span className="mo-campus-caption">
              NANTONG CAMPUS / {view.period.noun}运行
            </span>
          </div>
        </Card>
        <Card className="mo-attention">
          <div className="mo-attention-heading">
            <span className="mo-overline">{view.period.scope}关注</span>
            {operations.maintenanceAbnormal !== null &&
              alarmPending !== null && (
                <BadgeCount
                  count={operations.maintenanceAbnormal + alarmPending}
                />
              )}
          </div>
          <button onClick={() => onTopic('assurance')} type="button">
            <span className="mo-attention-icon is-amber">
              <Wrench />
            </span>
            <span>
              <strong>
                {operations.maintenanceAbnormal ?? '—'} 项维护需要跟进
              </strong>
            </span>
            <ArrowRight />
          </button>
          <button onClick={() => onTopic('alarms')} type="button">
            <span className="mo-attention-icon is-red">
              <BellRing />
            </span>
            <span>
              <strong>{alarmPending ?? '—'} 条告警待处理</strong>
            </span>
            <ArrowRight />
          </button>
          <button onClick={() => onTopic('capacity')} type="button">
            <span className="mo-attention-icon is-blue">
              <Server />
            </span>
            <span>
              <strong>
                {rack.available !== null
                  ? `${numberFormat(rack.available)} 个机柜可用`
                  : '资源数据待补充'}
              </strong>
              <small>
                {rack.available !== null
                  ? '对比各楼机柜余量与上架率'
                  : unavailable}
              </small>
            </span>
            <ArrowRight />
          </button>
        </Card>
      </div>
      <div className="mo-metrics mo-overview-metrics">
        <MetricCard
          title="机柜上架率"
          value={rack.rate?.toFixed(1) ?? '—'}
          unit="%"
          note={
            rack.online !== null && rack.capacity !== null
              ? `${numberFormat(rack.online)} / ${numberFormat(rack.capacity)} 柜 · 实际`
              : unavailable
          }
          icon={Server}
          onClick={() =>
            openDetail({ title: '机柜容量明细', resource: 'capacity' })
          }
        />
        <MetricCard
          title="IT 负载率"
          value={load?.toFixed(1) ?? '—'}
          unit="%"
          note={data?.load?.date ?? unavailable}
          icon={Gauge}
          onClick={() =>
            openDetail({ title: '各楼 IT 负载率', resource: 'load' })
          }
        />
        <MetricCard
          title={`${view.period.noun} PUE`}
          value={pue?.toFixed(3) ?? '—'}
          note={
            pue === null
              ? unavailable
              : view.building === 'all'
                ? '园区仅 A–C · 电量加权'
                : '各楼 PUE · IT 电量加权'
          }
          icon={Gauge}
          tone="teal"
          onClick={() =>
            openDetail({
              title: `${view.period.noun}电耗明细`,
              resource: 'energy',
              metric: 'pue',
            })
          }
        />
        <MetricCard
          title={`${view.period.scope}累计用电`}
          value={total !== null ? numberFormat(total / 10000, 1) : '—'}
          unit="万 kWh"
          note={
            it === null
              ? unavailable
              : `IT 用电 ${numberFormat(it / 10000, 1)} 万 kWh · 实际`
          }
          icon={Zap}
          onClick={() =>
            openDetail({
              title: `${view.period.noun}电耗明细`,
              resource: 'energy',
              metric: 'total',
            })
          }
        />
        <MetricCard
          title={`${view.period.scope}累计用水`}
          value={water === null ? '—' : numberFormat(water, 1)}
          unit="m³"
          note={water === null ? unavailable : '有效日累计 · 实际'}
          icon={Droplets}
          tone="sky"
          onClick={() =>
            openDetail({
              title: `${view.period.noun}水耗明细`,
              resource: 'water',
            })
          }
        />
      </div>
      <div className="mo-overview-bottom">
        <Panel
          title="能效走势"
          eyebrow="ENERGY EFFICIENCY"
          onAction={() => onTopic('energy')}
          action="能源水耗专题"
        >
          <div className="mo-chart-summary">
            <strong>
              {pue?.toFixed(3) ?? '—'}
              <span>{view.period.noun} PUE</span>
            </strong>
            <span>
              <i className="mo-legend-dot" />
              园区 A–C
            </span>
          </div>
          <LiveTrend
            key={view.building}
            period={view.period}
            building={view.building}
            comparison={{ visible, setVisible }}
          />
        </Panel>
        <Panel
          title="周期对比"
          eyebrow="PERIOD COMPARISON"
          action="全部工作"
          onAction={() => onTopic('assurance')}
        >
          <PueSummary
            start={view.period.start}
            end={view.period.asOf}
            visible={visible}
          />
          <h3 className="mo-execution-title">运营执行</h3>
          <div className="mo-execution-list">
            {(['event', 'change', 'drill', 'maintenance'] as const).map(
              (kind) => (
                <ProgressRow
                  key={kind}
                  label={
                    {
                      event: '事件闭环',
                      change: '变更执行',
                      drill: '演练计划',
                      maintenance: '维护计划',
                    }[kind]
                  }
                  done={operations[kind].done}
                  total={operations[kind].total}
                  unavailable={!operations[kind].ready}
                  tone={kind === 'event' ? 'teal' : 'blue'}
                  onClick={() =>
                    onTopic(
                      (
                        {
                          event: 'events',
                          change: 'changes',
                          drill: 'assessment',
                          maintenance: 'assurance',
                        } as const
                      )[kind],
                    )
                  }
                />
              ),
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
function BadgeCount({ count }: { count: number }) {
  return <span className="mo-attention-count">{count} 项待跟进</span>;
}
