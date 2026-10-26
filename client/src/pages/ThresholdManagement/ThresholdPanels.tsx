import { memo } from 'react';
import { Activity, Building2, ClipboardCheck, Settings2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { needsThresholdReview } from './ThresholdList';
import type { ThresholdRecord } from '@shared/threshold-management.interface';

export const THRESHOLD_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
  '待核对',
];
export const ThresholdMetrics = memo(function ThresholdMetrics({
  records,
  onOpen,
}: {
  records: ThresholdRecord[];
  onOpen: (kind: string) => void;
}) {
  const settings = records.filter((record) => record.kind === '设定').length;
  const ratings = records.filter((record) => record.kind === '额定参数').length;
  const metrics = [
    { key: 'all', label: '设定值', value: records.length, icon: Settings2 },
    {
      key: '告警',
      label: '告警阈值',
      value: records.filter((r) => r.kind === '告警').length,
      icon: Activity,
    },
    {
      key: ratings > settings ? '额定参数' : '设定',
      label: ratings > settings ? '额定参数' : '设备设定',
      value: Math.max(ratings, settings),
      icon: Building2,
    },
    {
      key: 'review',
      label: '待核对',
      value: records.filter(needsThresholdReview).length,
      icon: ClipboardCheck,
    },
  ];
  return (
    <section aria-label="阈值概览" className="threshold-metrics">
      {metrics.map(({ key, label, value, icon: Icon }) => (
        <Card
          key={key}
          className={`threshold-card threshold-metric threshold-metric-${key}`}
        >
          <button onClick={() => onOpen(key)}>
            <span className="threshold-metric-icon">
              <Icon size={23} />
            </span>
            <span>
              <span className="threshold-secondary">{label}</span>
              <strong>{value.toLocaleString()}</strong>
            </span>
          </button>
        </Card>
      ))}
    </section>
  );
});
export const ThresholdBuildings = memo(function ThresholdBuildings({
  records,
  selected,
  onSelect,
}: {
  records: ThresholdRecord[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const counts = new Map<string, number>();
  records.forEach((r) =>
    counts.set(
      r.building || '待核对',
      (counts.get(r.building || '待核对') || 0) + 1,
    ),
  );
  return (
    <Card className="threshold-card">
      <CardHeader>
        <div className="threshold-section-heading">
          <CardTitle>楼栋总览</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSelect('')}
            aria-pressed={!selected}
          >
            全园区
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="threshold-buildings">
          {THRESHOLD_BUILDINGS.map((building) => (
            <button
              key={building}
              className={selected === building ? 'is-selected' : ''}
              aria-pressed={selected === building}
              onClick={() => onSelect(selected === building ? '' : building)}
            >
              <Building2 size={19} />
              <strong>{building}</strong>
              <span>
                {(counts.get(building) || 0).toLocaleString()} <small>项</small>
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
export const ThresholdDistribution = memo(function ThresholdDistribution({
  records,
  onOpen,
}: {
  records: ThresholdRecord[];
  onOpen: (device: string) => void;
}) {
  const counts = new Map<string, number>();
  records.forEach((r) => counts.set(r.device, (counts.get(r.device) || 0) + 1));
  const rows = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'),
  );
  const maximum = rows[0]?.[1] || 1;
  return (
    <Card className="threshold-card threshold-distribution">
      <CardHeader>
        <CardTitle>设备分布</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <div className="threshold-bars">
            {rows.map(([device, count], index) => (
              <button
                key={device}
                onClick={() => onOpen(device)}
                aria-label={`${device}，${count}项，查看明细`}
                className={index === 0 ? 'threshold-bar-highest' : ''}
              >
                <span className="threshold-bar-label">{device}</span>
                <span className="threshold-bar-track">
                  <span style={{ width: `${(count / maximum) * 100}%` }} />
                </span>
                <strong>{count.toLocaleString()}</strong>
              </button>
            ))}
          </div>
        ) : (
          <p className="threshold-empty">暂无设备参数</p>
        )}
      </CardContent>
    </Card>
  );
});
