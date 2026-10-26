import {
  AlertTriangle,
  Award,
  Crown,
  Medal,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  Area,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

import type {
  AliMonthlyQualityViewModel,
  MonthlyQualitySelection,
} from './monthly-quality-model';
import { buildMonthlyQualityTrendSummary } from './monthly-quality-trend';

const GRADE_AXIS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'];

interface AliMonthlyQualityRatingOverviewProps {
  view: AliMonthlyQualityViewModel;
  onSelectBuilding: (building: string) => void;
  onOpenBuilding: (building: string) => void;
  onSelectRating: (month: string, building: string) => void;
  onOpenIssues: (
    selection: MonthlyQualitySelection,
    title: string,
    description: string,
  ) => void;
  onOpenBuildings: (
    buildings: string[],
    title: string,
    description: string,
  ) => void;
}

export function AliMonthlyQualityRatingOverview({
  view,
  onSelectBuilding,
  onOpenBuilding,
  onSelectRating,
  onOpenIssues,
  onOpenBuildings,
}: AliMonthlyQualityRatingOverviewProps) {
  const improvedBuildings = view.buildings
    .filter(({ movement }) => movement === 'up')
    .map(({ building }) => building);
  const rankedBuildings = rankMonthlyBuildings(view.buildings);
  const topBuildings = rankedBuildings
    .filter(({ grade }) => Boolean(grade))
    .slice(0, 3)
    .map((building, index) => ({ building, rank: index + 1 }));
  const ratingState = view.sourceStates.ratings;
  const trendSummary = buildMonthlyQualityTrendSummary(
    view.selectedBuilding,
    view.buildingTrend,
  );
  const TrendSummaryIcon =
    trendSummary.tone === 'positive'
      ? TrendingUp
      : trendSummary.tone === 'negative'
        ? TrendingDown
        : Minus;
  const summaryCards = [
    {
      label: 'A+标杆',
      value: String(view.summary.benchmarkBuildings.length),
      meta: view.summary.benchmarkBuildings.join('、') || '本月暂无 A+',
      icon: Award,
      tone: 'benchmark',
      onOpen: () =>
        onOpenBuildings(
          view.summary.benchmarkBuildings,
          `${view.selectedMonth} A+标杆楼栋`,
          '评级来自阿里月度质量评级表',
        ),
    },
    {
      label: '评级覆盖',
      value: `${view.summary.ratedBuildings}/7`,
      meta: '已有月度评分的楼栋',
      icon: ShieldCheck,
      tone: 'coverage',
      onOpen: () =>
        onOpenIssues(
          { kind: 'summary' },
          `${view.selectedMonth}问题依据`,
          '当前评级月份的全部问题记录',
        ),
    },
    {
      label: '待关注',
      value: String(view.summary.attentionBuildings.length),
      meta: view.summary.attentionBuildings.join('、') || '暂无 B- 及以下评级',
      icon: AlertTriangle,
      tone: 'attention',
      onOpen: () =>
        onOpenIssues(
          { kind: 'attention' },
          `${view.selectedMonth}待关注楼栋问题`,
          'B- 及以下评级楼栋的当月问题记录',
        ),
    },
    {
      label: '环比改善',
      value: String(view.summary.movement.up),
      meta: `提升 ${view.summary.movement.up} · 持平 ${view.summary.movement.same} · 下降 ${view.summary.movement.down}`,
      icon: TrendingUp,
      tone: 'movement',
      onOpen: () =>
        onOpenBuildings(
          improvedBuildings,
          `${view.selectedMonth}环比改善楼栋`,
          '较上一有效评级月份提升的楼栋问题记录',
        ),
    },
  ] as const;

  return (
    <section
      className="quality-rating-overview"
      aria-labelledby="quality-rating-title"
    >
      <div className="quality-section-heading">
        <div>
          <span>月度评级结论</span>
          <h2 id="quality-rating-title">
            {view.selectedYear} · {view.selectedMonth} 楼栋质量评级
          </h2>
        </div>
        <div className="quality-grade-distribution" aria-label="评级分布">
          {view.gradeDistribution.map(({ grade, value }) => (
            <span data-grade={gradeTone(grade)} key={grade}>
              <strong>{grade}</strong>
              {value}栋
            </span>
          ))}
          {ratingState.status !== 'fresh' ? (
            <Badge className={`quality-source-badge is-${ratingState.status}`}>
              {ratingState.status === 'stale' ? '评级缓存' : '评级源异常'}
            </Badge>
          ) : null}
        </div>
      </div>

      {ratingState.status === 'error' && view.summary.ratedBuildings === 0 ? (
        <div className="quality-source-callout is-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          评级表暂时不可用，问题记录仍可在下方查看。
        </div>
      ) : null}

      <div className="quality-rating-summary-grid">
        {summaryCards.map(
          ({ label, value, meta, icon: Icon, tone, onOpen }) => (
            <button
              type="button"
              className={`quality-summary-card is-${tone}`}
              key={label}
              aria-label={`查看${label}明细`}
              onClick={onOpen}
            >
              <span className="quality-summary-icon" aria-hidden="true">
                <Icon />
              </span>
              <span>
                <small>{label}</small>
                <strong>{value}</strong>
                <em title={meta}>{meta}</em>
              </span>
            </button>
          ),
        )}
      </div>

      <Card className="quality-rating-panel quality-building-rating-panel">
        <CardContent>
          <div className="quality-panel-heading">
            <div>
              <span>楼栋月度评级</span>
              <h3>7 栋楼同月横向对比</h3>
            </div>
            <p>A+ 自动标识为标杆，问题数仅作为关联观察</p>
          </div>
          <div className="quality-rating-rail">
            {view.buildings.map((building) => {
              const MovementIcon = movementIcon(building.movement);
              return (
                <button
                  type="button"
                  className={`quality-building-rating-card${
                    building.building === view.selectedBuilding
                      ? ' is-selected'
                      : ''
                  }`}
                  data-grade={gradeTone(building.grade)}
                  key={building.building}
                  aria-label={`查看${building.building}${building.grade || '待评'}评级和问题依据`}
                  onClick={() => onOpenBuilding(building.building)}
                >
                  <span className="quality-building-card-topline">
                    <strong>{building.building}</strong>
                    {building.benchmark ? (
                      <Badge className="quality-benchmark-badge">
                        <Crown aria-hidden="true" />
                        标杆
                      </Badge>
                    ) : building.attention ? (
                      <Badge className="quality-attention-badge">关注</Badge>
                    ) : null}
                  </span>
                  <span className="quality-grade-value">
                    {building.grade || '待评'}
                  </span>
                  <span className={`quality-movement is-${building.movement}`}>
                    <MovementIcon aria-hidden="true" />
                    {movementLabel(building.movement, building.previousGrade)}
                  </span>
                  <span className="quality-building-evidence">
                    <span>
                      <small>问题记录</small>
                      <strong>{building.issueCount} 条</strong>
                    </span>
                    <span>
                      <small>累计 A+</small>
                      <strong>{building.cumulativeAPlus ?? '—'} 次</strong>
                    </span>
                  </span>
                  <em>{building.primaryItem}</em>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="quality-rating-panel quality-benchmark-ranking-panel">
        <CardContent>
          <div className="quality-panel-heading">
            <div>
              <span>月度标杆榜</span>
              <h3>{view.selectedMonth} · 楼栋质量排名</h3>
            </div>
            <p>以评级结论为主，结合当月问题记录形成稳定排序</p>
          </div>
          <div className="quality-benchmark-ranking-grid">
            <div className="quality-leadership-tier" aria-label="本月标杆梯队">
              <div className="quality-tier-heading">
                <span>
                  <Crown aria-hidden="true" />
                  本月标杆梯队
                </span>
                <small>前三名</small>
              </div>
              <div className="quality-tier-list">
                {topBuildings.length > 0 ? (
                  topBuildings.map(({ building, rank }) => (
                    <button
                      type="button"
                      className={`quality-tier-card is-rank-${rank}`}
                      data-grade={gradeTone(building.grade)}
                      key={building.building}
                      aria-label={`第${rank}名${building.building}，评级${building.grade}，${building.issueCount}条问题记录`}
                      onClick={() => onOpenBuilding(building.building)}
                    >
                      <span className="quality-tier-position">{rank}</span>
                      <span className="quality-tier-medal" aria-hidden="true">
                        {rank === 1 ? <Crown /> : <Medal />}
                      </span>
                      <span className="quality-tier-building">
                        <strong>{building.building}</strong>
                        <small>{building.primaryItem}</small>
                      </span>
                      <span className="quality-tier-evidence">
                        {building.issueCount} 条问题
                      </span>
                      {building.benchmark ? <em>标杆</em> : null}
                      <b>{building.grade}</b>
                    </button>
                  ))
                ) : (
                  <div className="quality-tier-empty">本月暂无有效评级</div>
                )}
              </div>
            </div>

            <div className="quality-ranking-board">
              <div className="quality-ranking-heading">
                <h4>楼栋排名</h4>
                <Badge>{view.selectedMonth}</Badge>
              </div>
              <ol className="quality-ranking-list">
                {rankedBuildings.map((building, index) => (
                  <li
                    data-grade={gradeTone(building.grade)}
                    key={building.building}
                  >
                    <button
                      type="button"
                      aria-label={`查看第${index + 1}名${building.building}评级详情`}
                      onClick={() => onOpenBuilding(building.building)}
                    >
                      <span className="quality-ranking-position">
                        {index + 1}
                      </span>
                      <span className="quality-ranking-building">
                        <strong>{building.building}</strong>
                        {building.benchmark ? <em>标杆</em> : null}
                      </span>
                      <span className="quality-ranking-issues">
                        {building.issueCount} 条问题
                      </span>
                      <b>{building.grade || '待评'}</b>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <p className="quality-ranking-rule">
            评级优先 · 问题数次之 · 楼栋顺序兜底
          </p>
        </CardContent>
      </Card>

      <div className="quality-rating-analysis-grid">
        <Card className="quality-rating-panel quality-rating-matrix-panel">
          <CardContent>
            <div className="quality-panel-heading">
              <div>
                <span>月度评级矩阵</span>
                <h3>各月各楼栋评级全景</h3>
              </div>
              <p>点击单元格查看该月该楼栋的问题依据</p>
            </div>
            <div
              className="quality-rating-matrix"
              role="grid"
              aria-label="月度楼栋评级矩阵"
            >
              <span className="quality-rating-matrix-corner">月份</span>
              {view.buildings.map(({ building }) => (
                <strong key={building}>{building}</strong>
              ))}
              {view.ratingMatrix.flatMap((row) => [
                <span
                  className="quality-rating-month"
                  key={`${row.month}-label`}
                >
                  {row.month}
                </span>,
                ...row.cells.map((cell) => (
                  <button
                    type="button"
                    data-grade={gradeTone(cell.grade)}
                    className={`quality-rating-cell${
                      row.month === view.selectedMonth &&
                      cell.building === view.selectedBuilding
                        ? ' is-selected'
                        : ''
                    }`}
                    key={`${row.year}-${row.month}-${cell.building}`}
                    aria-label={`查看${row.year}${row.month}${cell.building}${cell.grade || '待评'}评级及问题依据`}
                    onClick={() => onSelectRating(row.month, cell.building)}
                  >
                    {cell.grade || '—'}
                  </button>
                )),
              ])}
            </div>
          </CardContent>
        </Card>

        <Card className="quality-rating-panel quality-building-trend-panel">
          <CardContent>
            <div className="quality-panel-heading">
              <div>
                <span>楼栋评级走势</span>
                <h3>{view.selectedBuilding} · 近月评级变化</h3>
              </div>
              <Badge
                className="quality-current-grade"
                data-grade={gradeTone(
                  view.buildings.find(
                    ({ building }) => building === view.selectedBuilding,
                  )?.grade || '',
                )}
              >
                当前{' '}
                {view.buildings.find(
                  ({ building }) => building === view.selectedBuilding,
                )?.grade || '待评'}
              </Badge>
            </div>
            <div
              className="quality-trend-building-switcher"
              role="group"
              aria-label="选择楼栋评级走势"
            >
              <span>楼栋</span>
              <div>
                {view.buildings.map((building) => (
                  <button
                    type="button"
                    data-grade={gradeTone(building.grade)}
                    className={
                      building.building === view.selectedBuilding
                        ? 'is-selected'
                        : undefined
                    }
                    key={building.building}
                    aria-pressed={building.building === view.selectedBuilding}
                    aria-label={`查看${building.building}评级走势`}
                    onClick={() => onSelectBuilding(building.building)}
                  >
                    <span>{building.building}</span>
                    <strong>{building.grade || '待评'}</strong>
                  </button>
                ))}
              </div>
            </div>
            <div
              className="quality-rating-trend-chart"
              aria-label={`${view.selectedBuilding}评级走势图`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={view.buildingTrend}
                  margin={{ top: 16, right: 12, left: -12, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="quality-rating-trend-fill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="var(--risk-primary)"
                        stopOpacity={0.24}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--risk-primary)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="var(--quality-grid)"
                    strokeDasharray="3 4"
                  />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} />
                  <YAxis
                    domain={[0, GRADE_AXIS.length - 1]}
                    ticks={[0, 2, 3, 5, 8]}
                    reversed
                    tickFormatter={(value) => GRADE_AXIS[Number(value)] || ''}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(_value, _name, entry) => [
                      entry.payload.grade || '待评',
                      '评级',
                    ]}
                    contentStyle={{
                      border: '1px solid var(--risk-border)',
                      borderRadius: 8,
                      boxShadow: 'var(--risk-shadow)',
                    }}
                  />
                  <ReferenceLine
                    y={2}
                    stroke="var(--grade-a)"
                    strokeDasharray="4 4"
                    label={{ value: 'A-基准', fill: 'var(--risk-muted)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="gradeRank"
                    stroke="none"
                    fill="url(#quality-rating-trend-fill)"
                    baseValue={GRADE_AXIS.length - 1}
                    connectNulls
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="gradeRank"
                    stroke="var(--risk-primary)"
                    strokeWidth={3}
                    dot={{ r: 4, fill: 'var(--risk-primary)' }}
                    activeDot={{ r: 6 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="quality-rating-trend-actions">
              {view.buildingTrend.map((point) => (
                <button
                  type="button"
                  key={point.month}
                  aria-label={`查看${point.month}${view.selectedBuilding}${point.grade}评级问题依据`}
                  onClick={() =>
                    onSelectRating(point.month, view.selectedBuilding)
                  }
                >
                  <span>{point.month}</span>
                  <strong>{point.grade || '—'}</strong>
                </button>
              ))}
            </div>
            <div
              className="quality-trend-summary"
              data-tone={trendSummary.tone}
              aria-live="polite"
            >
              <span className="quality-trend-summary-icon" aria-hidden="true">
                <TrendSummaryIcon />
              </span>
              <div>
                <small>趋势总结</small>
                <strong>{trendSummary.headline}</strong>
                <p>{trendSummary.description}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function rankMonthlyBuildings(
  buildings: AliMonthlyQualityViewModel['buildings'],
): AliMonthlyQualityViewModel['buildings'] {
  const originalOrder = new Map(
    buildings.map(({ building }, index) => [building, index]),
  );
  return [...buildings].sort(
    (left, right) =>
      gradeRank(left.grade) - gradeRank(right.grade) ||
      left.issueCount - right.issueCount ||
      (originalOrder.get(left.building) ?? 0) -
        (originalOrder.get(right.building) ?? 0),
  );
}

function gradeRank(grade: string): number {
  const index = GRADE_AXIS.indexOf(grade);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function gradeTone(grade: string): string {
  return (
    grade.trim().toLowerCase().replace('+', 'plus').replace('-', 'minus') ||
    'pending'
  );
}

function movementIcon(
  movement: AliMonthlyQualityViewModel['buildings'][number]['movement'],
) {
  if (movement === 'up') return TrendingUp;
  if (movement === 'down') return TrendingDown;
  return Minus;
}

function movementLabel(
  movement: AliMonthlyQualityViewModel['buildings'][number]['movement'],
  previousGrade: string,
): string {
  if (movement === 'up') return `较上月 ${previousGrade} 提升`;
  if (movement === 'down') return `较上月 ${previousGrade} 下降`;
  if (movement === 'same') return `较上月 ${previousGrade} 持平`;
  return '无上月评级';
}
