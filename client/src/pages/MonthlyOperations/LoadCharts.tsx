import { Gauge } from 'lucide-react';
import { Panel, ColumnChart, EmptyState } from './charts';
import { ResourceStatus } from './ResourceCharts';
import { useResourceData } from './resource-data';
import { type BuildingFilter } from './model';
export function LoadCharts({ building }: { building: BuildingFilter }) {
  const { data } = useResourceData();
  const rows =
    data?.load?.rows.filter(
      (row) => building === 'all' || row.building === building,
    ) ?? [];
  const value = building === 'all' ? data?.load?.park : rows[0]?.value;
  return (
    <div className="mo-live-racks">
      <ResourceStatus source="load" />
      <div className="mo-rack-headline">
        <div className="mo-rack-headline-icon">
          <Gauge />
        </div>
        <div>
          <span>{building === 'all' ? '园区' : building} IT 负载率</span>
          <strong>
            {value?.toFixed(1) ?? '—'}
            <small>%</small>
          </strong>
        </div>
        <div>
          <span>数据日期</span>
          <b>{data?.load?.date ?? '—'}</b>
        </div>
      </div>
      {!rows.length ? (
        <EmptyState title="暂无完整负载数据" />
      ) : (
        <div className="mo-two-columns mo-load-comparison">
          <Panel title="各楼 IT 负载率">
            <ColumnChart
              rows={rows.map((row) => ({
                name: row.building,
                value: row.value,
              }))}
              series={[{ key: 'value', name: 'IT 负载率' }]}
              unit="%"
            />
          </Panel>
          <Panel title="负载分布">
            <div className="mo-rack-progress-list">
              {rows.map((row) => (
                <div key={row.building}>
                  <Gauge />
                  <div className="mo-rack-progress">
                    <div>
                      <span>{row.building}</span>
                      <strong>{row.value.toFixed(1)}%</strong>
                    </div>
                    <progress
                      aria-label={`${row.building} IT负载率`}
                      value={row.value}
                      max={Math.max(100, row.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
