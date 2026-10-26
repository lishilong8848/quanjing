import { useRef, useState } from 'react';
import type { MonthlyAlarmOverviewRecord } from '@shared/monthly-alarm-overview.interface';
import { AlarmImageDialog, AlarmImageThumbnail } from './AlarmImagePreview';

const SECTIONS = [
  { key: '未恢复异常告警', number: '04', tone: 'amber' },
  { key: '告警打标规范性', number: '05', tone: 'red' },
] as const;

function buildingLabel(building: string) {
  return building === '园区' ? '园区' : `EA118-${building}`;
}

export function PriorityIssues({
  records,
}: {
  records: MonthlyAlarmOverviewRecord[];
}) {
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(
    null,
  );
  const imageTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section className="mao-priority" aria-label="重点问题">
      {SECTIONS.map(({ key, number, tone }) => {
        const rows = records.filter((row) => row.section === key);
        return (
          <section
            className={`mao-issue-section mao-issue-${tone}`}
            key={key}
            aria-label={key}
          >
            <header className="mao-issue-heading">
              <div className="mao-issue-title">
                <span>{number}</span>
                <h2>{key}</h2>
              </div>
              <strong>
                {rows.length}
                <small>条问题</small>
              </strong>
            </header>
            {rows.length ? (
              <div className="mao-issue-grid">
                {rows.map((row) => (
                  <article className="mao-issue-card" key={row.id}>
                    <div className="mao-issue-meta">
                      <span className="mao-building-pill">
                        {buildingLabel(row.building)}
                      </span>
                      <time>{row.date || '日期未填写'}</time>
                    </div>
                    <div className="mao-issue-content">
                      <span>问题</span>
                      <h3>{row.problem || '问题未填写'}</h3>
                      {row.event && (
                        <p>
                          <strong>事件描述</strong>
                          {row.event}
                        </p>
                      )}
                    </div>
                    {row.images.length > 0 && (
                      <div className="mao-issue-images">
                        {row.images.map((item) => (
                          <AlarmImageThumbnail
                            key={item.url}
                            image={item}
                            onOpen={(trigger) => {
                              imageTriggerRef.current = trigger;
                              setPreview({
                                url: item.url,
                                title: `${buildingLabel(row.building)} · ${row.problem || item.name}`,
                              });
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="mao-issue-empty">本月暂无记录</div>
            )}
          </section>
        );
      })}
      {preview && (
        <AlarmImageDialog
          key={preview.url}
          preview={preview}
          onClose={() => setPreview(null)}
          onRestoreFocus={() => imageTriggerRef.current?.focus()}
        />
      )}
    </section>
  );
}
