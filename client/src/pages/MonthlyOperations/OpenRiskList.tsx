import { useState } from 'react';
import type { OpenRiskItem } from '@shared/monthly-operations-assessment.interface';
import type { MonthlySourceState } from '@shared/monthly-operations-resources.interface';

export function OpenRiskList({
  items,
  status,
  building,
}: {
  items: OpenRiskItem[];
  status: MonthlySourceState | undefined;
  building: string;
}) {
  const [mode, setMode] = useState<'all' | 'inspected'>('all');
  if (!status || status.status === 'error')
    return (
      <p role="alert">
        {status?.message || 'OPEN 风险清单暂不可用，请刷新重试'}
      </p>
    );
  const scoped = items.filter(
    (item) => building === 'all' || item.building === building,
  );
  const inspected = scoped.filter((item) => item.inspectionDate);
  const activeMode = status.status === 'stale' ? 'all' : mode;
  const shown = activeMode === 'all' ? scoped : inspected;
  return (
    <div className="mo-open-risks">
      {status.status === 'stale' && status.message && (
        <p className="mo-open-risk-warning" role="alert">
          {status.message}
        </p>
      )}
      <div
        className="mo-open-risk-tabs"
        role="group"
        aria-label="OPEN 风险清单范围"
      >
        <button
          type="button"
          aria-pressed={activeMode === 'all'}
          onClick={() => setMode('all')}
        >
          OPEN 风险项 <strong>{scoped.length}</strong>
        </button>
        <button
          type="button"
          aria-pressed={activeMode === 'inspected'}
          disabled={status.status === 'stale'}
          onClick={() => setMode('inspected')}
        >
          本期已排查 <strong>{inspected.length}</strong>
        </button>
      </div>
      {shown.length ? (
        <div className="mo-open-risk-scroll">
          {shown.map((item) => (
            <details key={item.id} className="mo-open-risk-row">
              <summary>
                <span className="mo-open-risk-code">
                  {item.building} · {item.code}
                </span>
                <span className="mo-open-risk-description">
                  {item.description}
                </span>
                <span className="mo-open-risk-level">{item.level}风险</span>
                <span
                  className={
                    item.inspectionDate
                      ? 'mo-open-risk-done'
                      : 'mo-open-risk-pending'
                  }
                >
                  {item.inspectionStatus}
                </span>
              </summary>
              <div className="mo-open-risk-detail">
                <span>{item.category || '分类待补充'}</span>
                {item.inspectionDate && (
                  <span>排查记录：{item.inspectionDate}</span>
                )}
                {item.currentStatus && (
                  <span>当前风险：{item.currentStatus}</span>
                )}
                {item.finding && <p>{item.finding}</p>}
                <p>{item.description}</p>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <p className="mo-open-risk-empty">
          {activeMode === 'all' ? '暂无 OPEN 风险项' : '本期暂无匹配的排查记录'}
        </p>
      )}
    </div>
  );
}
