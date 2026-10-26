import type { TodayOperationsAlarmTagReviewStatus } from '@shared/today-operations-alarm.interface';
import './alarm-ai-connection-badge.css';

const statusLabels = {
  unconfigured: '未启用',
  connecting: '连接中',
  online: '在线',
  unverified: '待验证',
  error: '连接失败',
} as const;

export function AlarmAiConnectionBadge({ review }: { review: TodayOperationsAlarmTagReviewStatus }) {
  const connection = review.connection ?? (review.state === 'unconfigured' ? 'unconfigured' : 'unverified');
  const label = `AI ${statusLabels[connection]}`;
  return <span className="alarm-ai-connection-badge" data-state={connection} role="status" aria-label={label} title={label}>
    <span className="alarm-ai-connection-badge-mark" aria-hidden="true">AI</span>
    {connection === 'online'
      ? <span className="alarm-ai-connection-beacon" aria-hidden="true"><span className="alarm-ai-connection-core" /></span>
      : <span className="alarm-ai-connection-status" aria-hidden="true">{statusLabels[connection]}</span>}
  </span>;
}
