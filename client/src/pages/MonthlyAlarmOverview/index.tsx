import { useEffect, useMemo, useState } from 'react';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  AlertCircle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  Clock3,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import type {
  MonthlyAlarmOverviewRecord,
  MonthlyAlarmOverviewResponse,
} from '@shared/monthly-alarm-overview.interface';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  monthlyAlarmTotals,
  monthlyAlarmUnrestoredRate,
  sortUnexpectedAlarms,
} from './model';
import { AlarmCharts } from './AlarmCharts';
import { PriorityIssues } from './PriorityIssues';
import './styles.css';

const SOURCE_URL =
  'https://vnet.feishu.cn/wiki/SOwsw315aiBJjgkl48ccoxIPntc?table=tblqTFdVQNjRWKOK&view=vew8OzP7Nc';
const BUILDINGS = ['园区', 'A', 'B', 'C', 'D', 'E'];
const DETAIL_PAGE_SIZE = 12;

function metric(
  records: MonthlyAlarmOverviewRecord[],
  building: string,
  name: string,
) {
  return (
    records.find((row) => row.building === building && row.metric === name)
      ?.quantity ?? 0
  );
}

function countText(value: number) {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
}

function metricText(
  records: MonthlyAlarmOverviewRecord[],
  building: string,
  name: string,
) {
  const value = records.find(
    (row) => row.building === building && row.metric === name,
  )?.quantity;
  return value === null || value === undefined ? '—' : countText(value);
}

function rateText(records: MonthlyAlarmOverviewRecord[], building: string) {
  const value = monthlyAlarmUnrestoredRate(records, building);
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

function monthText(month: string) {
  const [year, number] = month.split('-');
  return `${year}年${Number(number)}月`;
}

function DetailRow({
  row,
  isTop,
}: {
  row: MonthlyAlarmOverviewRecord;
  isTop: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = row.event || row.analysis || row.problem || '告警记录';
  const description = /\.(png|jpe?g|webp|gif)$/i.test(row.description.trim())
    ? ''
    : row.description;
  const preview =
    [row.confirmation, row.analysis, row.problem, description].find(
      (value) => value && value !== title,
    ) || '';
  const period =
    row.period || row.date || (row.week ? `第 ${row.week} 周` : '月度记录');

  return (
    <li className={`mao-detail-row${isTop ? ' is-top' : ''}`}>
      <button
        type="button"
        className="mao-detail-row-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="mao-detail-building">
          <span className="mao-building-pill">
            {row.building === '园区' ? '园区' : `EA118-${row.building}`}
          </span>
          <small>{period}</small>
        </span>
        <strong className="mao-detail-event" title={title}>
          {title}
        </strong>
        <span className="mao-detail-preview" title={preview}>
          {preview || '—'}
        </span>
        <span className="mao-detail-count">
          {row.quantity === null ? '—' : `${countText(row.quantity)} 条`}
        </span>
        <span
          className={`mao-detail-status${row.closed === '否' ? ' is-open' : ''}`}
        >
          {row.closed === '是'
            ? '已闭环'
            : row.closed === '否'
              ? '未闭环'
              : '—'}
        </span>
        <ChevronDown className="mao-detail-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="mao-detail-expanded">
          {row.confirmation && (
            <p>
              <strong>动环确认</strong>
              {row.confirmation}
            </p>
          )}
          {row.analysis && row.analysis !== title && (
            <p>
              <strong>告警分析</strong>
              {row.analysis}
            </p>
          )}
          {row.problem && row.problem !== title && (
            <p>
              <strong>问题</strong>
              {row.problem}
            </p>
          )}
          {description && (
            <p>
              <strong>告警描述</strong>
              {description}
            </p>
          )}
          {!row.confirmation &&
            !row.analysis &&
            !row.problem &&
            !description && <p>暂无补充信息</p>}
        </div>
      )}
    </li>
  );
}

export default function MonthlyAlarmOverviewPage() {
  const [data, setData] = useState<MonthlyAlarmOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [month, setMonth] = useState('');
  const [building, setBuilding] = useState('all');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    axiosForBackend<MonthlyAlarmOverviewResponse>({
      url: '/api/risk-inspection/monthly-alarm-overview',
      method: 'GET',
      params: reload ? { refresh: '1' } : undefined,
      timeout: 40000,
    })
      .then(({ data: next }) => {
        if (!active) return;
        setData(next);
        setMonth((previous) =>
          next.months.includes(previous) ? previous : (next.months[0] ?? ''),
        );
        setError('');
      })
      .catch(() => {
        if (active) setError('月度告警数据读取失败，请重试。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);

  const monthRecords = useMemo(
    () => (data?.records ?? []).filter((row) => row.month === month),
    [data, month],
  );
  const summary = useMemo(
    () =>
      monthRecords.filter(
        (row) =>
          row.section === '周告警恢复情况' || row.section === '周告警情况',
      ),
    [monthRecords],
  );
  const totals = useMemo(
    () => monthlyAlarmTotals(summary, building),
    [summary, building],
  );
  const detailRows = useMemo(
    () =>
      sortUnexpectedAlarms(
        monthRecords.filter(
          (row) =>
            row.section === '月度预期外告警描述' &&
            (building === 'all' || row.building === building),
        ),
      ),
    [monthRecords, building],
  );
  const pageRows = detailRows.slice(
    (page - 1) * DETAIL_PAGE_SIZE,
    page * DETAIL_PAGE_SIZE,
  );
  const totalPages = Math.max(
    1,
    Math.ceil(detailRows.length / DETAIL_PAGE_SIZE),
  );
  const refresh = () => {
    if (!loading) setReload((value) => value + 1);
  };
  const chooseBuilding = (value: string) => {
    setBuilding(value);
    setPage(1);
  };
  const filteredRecords = useMemo(
    () =>
      monthRecords.filter(
        (row) => building === 'all' || row.building === building,
      ),
    [monthRecords, building],
  );

  return (
    <main className="monthly-alarm-overview" aria-label="月度告警总览">
      <div className="mao-container">
        <header className="mao-header">
          <div className="mao-title">
            <span className="mao-title-icon">
              <BellRing aria-hidden="true" />
            </span>
            <h1>月度告警总览</h1>
          </div>
          <div className="mao-actions">
            <label>
              月份{' '}
              <select
                value={month}
                onChange={(event) => {
                  setMonth(event.target.value);
                  setPage(1);
                }}
                disabled={!data?.months.length}
                aria-label="选择月份"
              >
                {data?.months.map((value) => (
                  <option key={value} value={value}>
                    {monthText(value)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw
                aria-hidden="true"
                className={loading ? 'animate-spin' : ''}
              />
              刷新
            </Button>
            <a
              className="mao-source"
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
            >
              飞书数据源 <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </header>

        {(error || data?.warning) && (
          <div className="mao-warning" role="alert">
            <AlertCircle aria-hidden="true" />
            {error || data?.warning}
          </div>
        )}
        {loading && !data ? (
          <Card className="mao-state" role="status">
            正在读取月度告警数据…
          </Card>
        ) : null}
        {!loading && (!data || data.sourceStatus === 'error') ? (
          <Card className="mao-state" role="alert">
            暂无可用数据。
            <Button variant="outline" onClick={refresh}>
              重新读取
            </Button>
          </Card>
        ) : null}
        {data && data.sourceStatus !== 'error' && (
          <>
            <div
              className="mao-building-filter"
              role="group"
              aria-label="按楼栋筛选"
            >
              {[
                { key: 'all', label: '全部楼栋' },
                ...BUILDINGS.filter((name) => name !== '园区').map((name) => ({
                  key: name,
                  label: `EA118-${name}`,
                })),
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={building === item.key}
                  className={building === item.key ? 'is-active' : ''}
                  onClick={() => chooseBuilding(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {monthRecords.length === 0 ? (
              <Card className="mao-state" role="status">
                所选月份暂无告警数据。
              </Card>
            ) : (
              <>
                <section className="mao-metrics" aria-label="月度关键指标">
                  {[
                    {
                      label: '告警总数',
                      value: totals.total,
                      icon: BellRing,
                      tone: 'blue',
                    },
                    {
                      label: '已恢复',
                      value: totals.restored,
                      icon: CheckCircle2,
                      tone: 'green',
                    },
                    {
                      label: '未恢复',
                      value: totals.unrestored,
                      icon: Clock3,
                      tone: 'amber',
                    },
                    {
                      label: '预期外告警',
                      value: totals.unexpected,
                      icon: AlertCircle,
                      tone: 'red',
                    },
                  ].map(({ label, value, icon: Icon, tone }) => (
                    <Card key={label} className={`mao-metric mao-${tone}`}>
                      <div className="mao-metric-heading">
                        <span>{label}</span>
                        <Icon aria-hidden="true" />
                      </div>
                      <strong>{countText(value)}</strong>
                    </Card>
                  ))}
                </section>
                <PriorityIssues records={filteredRecords} />
                <AlarmCharts
                  summary={summary}
                  records={filteredRecords}
                  buildingFilter={building}
                />
                <Card className="mao-panel" aria-label="各楼栋告警统计表">
                  <div className="mao-panel-heading">
                    <h2>楼栋告警概况</h2>
                  </div>
                  <div className="mao-table-wrap">
                    <table className="mao-summary-table">
                      <thead>
                        <tr>
                          <th>楼栋</th>
                          <th>告警总数</th>
                          <th>恢复数</th>
                          <th>未恢复数</th>
                          <th>未恢复率</th>
                          <th>预期外</th>
                          <th>误告警</th>
                        </tr>
                      </thead>
                      <tbody>
                        {BUILDINGS.map((name) => (
                          <tr key={name}>
                            <th>
                              {name === '园区' ? '园区汇总' : `EA118-${name}`}
                            </th>
                            <td>{metricText(summary, name, '告警总数')}</td>
                            <td>{metricText(summary, name, '恢复数')}</td>
                            <td>{metricText(summary, name, '未恢复数')}</td>
                            <td>{rateText(summary, name)}</td>
                            <td>{metricText(summary, name, '预期外告警')}</td>
                            <td>{metricText(summary, name, '误告警')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
                <section className="mao-detail-section" aria-label="告警明细">
                  <div className="mao-section-heading">
                    <h2>预期外告警</h2>
                    <strong>{detailRows.length} 条记录</strong>
                  </div>
                  {pageRows.length ? (
                    <div className="mao-detail-list-wrap">
                      <div className="mao-detail-list-head" aria-hidden="true">
                        <span>楼栋 / 时段</span>
                        <span>告警</span>
                        <span>动环确认 / 分析</span>
                        <span>涉及</span>
                        <span>状态</span>
                        <span />
                      </div>
                      <ul className="mao-detail-list">
                        {pageRows.map((row, index) => (
                          <DetailRow
                            key={row.id}
                            row={row}
                            isTop={
                              page === 1 &&
                              index === 0 &&
                              (row.quantity ?? 0) > 0
                            }
                          />
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <Card className="mao-state" role="status">
                      当前分类暂无记录。
                    </Card>
                  )}
                  {totalPages > 1 && (
                    <div className="mao-pagination">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page === 1}
                        onClick={() => setPage(page - 1)}
                      >
                        上一页
                      </Button>
                      <span>
                        {page} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page === totalPages}
                        onClick={() => setPage(page + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
