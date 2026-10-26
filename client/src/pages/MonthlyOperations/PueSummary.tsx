import { useMemo } from 'react';
import type { MonthlyEnergyBuilding } from '@shared/monthly-operations-resources.interface';
import { useResourceData } from './resource-data';
import { comparePue } from './pue-comparison';
import { BUILDING_COLORS } from './resource-model';

export function PueSummary({
  start,
  end,
  visible,
}: {
  start: string;
  end: string;
  visible: MonthlyEnergyBuilding[];
}) {
  const { data } = useResourceData();
  const stats = useMemo(
    () => comparePue(data, start, end, visible),
    [data, start, end, visible],
  );
  if (!visible.length || !data) return null;
  const valid = stats.rows.filter((r) => r.delta !== null);
  const down = valid.filter((r) => r.delta! < -0.0005).map((r) => r.building),
    up = valid.filter((r) => r.delta! > 0.0005).map((r) => r.building);
  return (
    <section className="mo-pue-summary" aria-label="PUE 对比综述">
      <div className="mo-summary-heading">
        <strong>周期综述</strong>
        <span>
          {start} — {end}
        </span>
      </div>
      <p>
        {stats.park !== null ? (
          <>
            园区 PUE <b>{stats.park.toFixed(3)}</b>。{' '}
          </>
        ) : null}
        {stats.low && stats.high && stats.low !== stats.high ? (
          <>
            所选楼栋中，{stats.low.building}最低{' '}
            <b>{stats.low.value!.toFixed(3)}</b>，{stats.high.building}最高{' '}
            <b>{stats.high.value!.toFixed(3)}</b>，相差{' '}
            <b>{(stats.high.value! - stats.low.value!).toFixed(3)}</b>。
          </>
        ) : stats.commonDays ? (
          '已显示所选楼栋的周期加权值。'
        ) : (
          '共同有效日期不足，暂不作楼间比较。'
        )}
      </p>
      {valid.length > 0 && (
        <p>
          后半段较前半段{down.length ? `，${down.join('、')}下降` : ''}
          {up.length ? `，${up.join('、')}上升` : ''}
          {!down.length && !up.length ? '整体持平' : ''}。
        </p>
      )}
      <div className="mo-pue-comparison-grid">
        {stats.rows.map((row) => (
          <div key={row.building}>
            <span>
              <i style={{ background: BUILDING_COLORS[row.building] }} />
              {row.building}
            </span>
            <strong>{row.value?.toFixed(3) ?? '—'}</strong>
            <small
              className={row.delta !== null && row.delta < 0 ? 'is-down' : ''}
              title={`周期以 ${stats.midpoint} 为前半段截止日；前后分别按有效日 IT 电量加权`}
            >
              {row.delta === null
                ? '前后对比不足'
                : `前后 ${row.delta > 0 ? '+' : ''}${row.delta.toFixed(3)}`}
            </small>
          </div>
        ))}
      </div>
      <div className="mo-pue-pairs" aria-label="A B C 楼差值">
        {(
          [
            ['A楼', 'B楼'],
            ['A楼', 'C楼'],
            ['B楼', 'C楼'],
          ] as const
        ).map(([a, b]) => {
          const first = stats.rows.find((r) => r.building === a)?.value,
            last = stats.rows.find((r) => r.building === b)?.value;
          if (first == null || last == null) return null;
          const delta = first - last;
          return (
            <span key={a + b}>
              {a[0]} − {b[0]}{' '}
              <b>
                {delta > 0 ? '+' : ''}
                {delta.toFixed(3)}
              </b>
            </span>
          );
        })}
      </div>
      <div
        className="mo-summary-foot"
        title="楼间与前后比较仅使用所选曲线共同有效日期；园区整体值按 A–C 的 PUE（数值）以 IT 电量加权。"
      >
        楼间比较：共同有效 {stats.commonDays} 天 · IT 电量加权
      </div>
    </section>
  );
}
