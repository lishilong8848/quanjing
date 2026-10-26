import { useMemo, useState, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { SourceModal } from './SourceModal';
import type { MonthlyAlarm } from '@shared/monthly-operations-alarms.interface';
import { alarmDate, alarmDetails } from './alarm-model';
import { EmptyState } from './charts';
export function AlarmList({
  records,
  compact = false,
  onOpenTag,
}: {
  records: MonthlyAlarm[];
  compact?: boolean;
  onOpenTag?: () => void;
}) {
  const [search, setSearch] = useState(''),
    [tag, setTag] = useState('全部'),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<MonthlyAlarm | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const searchText = search.trim().toLowerCase();
  const tags = ['全部', '未处理', '未确认', '打标异常', '未恢复超过48小时'];
  const filtered = useMemo(
    () =>
      records
        .filter(
          (r) =>
            (tag === '全部' || r.tags.includes(tag)) &&
            (!searchText ||
              `${r.title} ${r.object} ${r.location} ${r.building}`
                .toLowerCase()
                .includes(searchText)),
        )
        .sort(
          (a, b) =>
            Number(b.tags.includes('未处理')) -
              Number(a.tags.includes('未处理')) ||
            Number(!b.confirmedAt) - Number(!a.confirmedAt) ||
            b.occurredAt.localeCompare(a.occurredAt),
        ),
    [records, tag, searchText],
  );
  const size = compact ? 6 : 15,
    pages = Math.max(1, Math.ceil(filtered.length / size)),
    current = Math.min(page, pages);
  return (
    <div className="mo-alarm-list">
      <div className="mo-assessment-filters">
        <div className="mo-assessment-chips">
          {tags.map((t) => (
            <Button
              size="sm"
              variant={tag === t ? 'default' : 'outline'}
              key={t}
              onClick={() => {
                if (t === '打标异常' && onOpenTag) {
                  onOpenTag();
                  return;
                }
                setTag(t);
                setPage(1);
              }}
            >
              {t}
            </Button>
          ))}
        </div>
        <Input
          aria-label="搜索告警"
          placeholder="搜索告警、设备、位置"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className="mo-assessment-count">
        {filtered.length.toLocaleString()} 条记录
      </div>
      {!filtered.length ? (
        <EmptyState description="" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>状态</TableHead>
              <TableHead>告警 / 监控对象</TableHead>
              <TableHead>楼栋</TableHead>
              <TableHead>等级</TableHead>
              <TableHead>产生时间</TableHead>
              <TableHead>预期 / 原因</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice((current - 1) * size, current * size).map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="mo-alarm-badges">
                    <Badge
                      className={
                        r.process === '未处理' ? 'mo-assessment-attention' : ''
                      }
                      variant="outline"
                    >
                      {r.process}
                    </Badge>
                    <Badge variant="outline">{r.recovery}</Badge>
                    {!r.confirmedAt && (
                      <Badge
                        variant="outline"
                        className="mo-assessment-attention"
                      >
                        未确认
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <button
                    className="mo-event-title"
                    onClick={(e) => {
                      trigger.current = e.currentTarget;
                      setSelected(r);
                    }}
                  >
                    {r.title}
                    <small>
                      {r.object} · {r.location}
                    </small>
                  </button>
                </TableCell>
                <TableCell className="mo-nowrap">{r.building}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      ['严重', '紧急'].includes(r.level)
                        ? 'mo-assessment-attention'
                        : ''
                    }
                  >
                    {r.level}
                  </Badge>
                </TableCell>
                <TableCell className="mo-nowrap">
                  {alarmDate(r.occurredAt)}
                </TableCell>
                <TableCell>
                  {r.expected || (
                    <span className="mo-alarm-warning">未打标</span>
                  )}
                  <small className="mo-alarm-category">{r.category}</small>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mo-pagination">
        <span>
          {current} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={current === 1}
          onClick={() => setPage(current - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={current === pages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </Button>
      </div>
      {selected && (
        <SourceModal
          variant="record"
          title={selected.title}
          trigger={trigger.current}
          onClose={() => setSelected(null)}
        >
          <div className="mo-assessment-record-body">
            <div className="mo-assessment-record-status">
              <Badge>{selected.process}</Badge>
              <Badge variant="outline">{selected.recovery}</Badge>
              {selected.tags.map((t) => (
                <Badge
                  variant="outline"
                  key={t}
                  className="mo-assessment-attention"
                >
                  {t}
                </Badge>
              ))}
            </div>
            <dl>
              {alarmDetails(selected).map((d) => (
                <div key={d.label}>
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </SourceModal>
      )}
    </div>
  );
}
