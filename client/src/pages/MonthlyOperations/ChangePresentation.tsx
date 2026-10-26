import {
  Activity,
  CheckCircle2,
  Clock3,
  ShieldAlert,
  AlertCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { MonthlyChange } from '@shared/monthly-operations-changes.interface';
import { CHANGE_STATES, isPriorityChange } from './change-model';

export function changeTime(iso: string | null) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  const local = new Date(Date.parse(iso) + 8 * 3600000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)}`;
}

export function ChangeStateBadge({ state }: Pick<MonthlyChange, 'state'>) {
  const Icon =
    state === 'running'
      ? Activity
      : state === 'done'
        ? CheckCircle2
        : state === 'failed'
          ? AlertCircle
          : Clock3;
  return (
    <Badge variant="outline" className={`mo-change-state mo-change-${state}`}>
      <Icon aria-hidden="true" />
      {CHANGE_STATES[state]}
    </Badge>
  );
}

export function ChangeRiskBadge({ level }: Pick<MonthlyChange, 'level'>) {
  const priority = isPriorityChange({ level });
  return (
    <Badge
      variant="outline"
      className={priority ? 'mo-change-risk is-priority' : 'mo-change-risk'}
    >
      {priority && <ShieldAlert aria-hidden="true" />}
      {level}
    </Badge>
  );
}

export function ChangeDetail({ record: r }: { record: MonthlyChange }) {
  const adjusted =
    (r.originalStart && r.originalStart !== r.plannedStart) ||
    (r.originalEnd && r.originalEnd !== r.plannedEnd);
  return (
    <div className="mo-change-detail">
      <Card
        className={`mo-change-detail-lead${isPriorityChange(r) ? ' is-priority' : ''}`}
      >
        <div className="mo-change-detail-status">
          <ChangeStateBadge state={r.state} />
          <ChangeRiskBadge level={r.level} />
        </div>
        <h3>{r.title}</h3>
        <div className="mo-detail-meta">
          <span>{r.code}</span>
          <span>{r.buildings.join('、') || '未标注楼栋'}</span>
        </div>
      </Card>
      <section>
        <h4>基本信息</h4>
        <dl className="mo-change-detail-fields">
          {[
            ['变更类型', r.type],
            ['专业', r.specialty],
            ['作业类型', r.workType],
            ['变更性质', r.nature],
            ['执行进度', r.progress || '未填写'],
            ['执行结果', r.result || '未反馈'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h4>执行时间</h4>
        <div className="mo-change-detail-schedule">
          {[
            ...(adjusted
              ? [
                  {
                    title: '原计划',
                    start: r.originalStart,
                    end: r.originalEnd,
                  },
                ]
              : []),
            {
              title: adjusted ? '调整后计划' : '计划时间',
              start: r.plannedStart,
              end: r.plannedEnd,
            },
            { title: '实际执行', start: r.actualStart, end: r.actualEnd },
          ].map((item) => (
            <Card key={item.title} className="mo-change-time-card">
              <h5>{item.title}</h5>
              <dl>
                <div>
                  <dt>开始</dt>
                  <dd>{changeTime(item.start)}</dd>
                </div>
                <div>
                  <dt>结束</dt>
                  <dd>{changeTime(item.end)}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      </section>
      {r.risk && (
        <section className="mo-change-risk-detail">
          <h4>
            <ShieldAlert aria-hidden="true" />
            重要风险点
          </h4>
          <p>{r.risk}</p>
        </section>
      )}
      {r.delayReason && (
        <section>
          <h4>延期原因</h4>
          <p>{r.delayReason}</p>
        </section>
      )}
    </div>
  );
}
