import { useId } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '../../components/ui/button';

import {
  buildExpiryCalendar,
  buildExpiryCalendarFromEvents,
  filterCertificateTotals,
  stepCertificateMonth,
  type BuildingCompliance,
  type CertificateExpiryEvent,
  type CertificateFilter,
  type CertificateMonth,
} from './model';

interface ComplianceGaugeProps {
  rate: number;
  current: number;
  target: number;
}

interface ExpiryHeatmapProps {
  month: CertificateMonth;
  onMonthChange: (month: CertificateMonth) => void;
  filter: CertificateFilter;
  onFilterChange: (filter: CertificateFilter) => void;
  events?: readonly CertificateExpiryEvent[];
  availableMonths?: readonly CertificateMonth[];
  totals?: Readonly<Record<CertificateFilter, number>>;
  onDateSelect?: (date: string) => void;
  onMonthSelect?: (month: string) => void;
  onMetricSelect?: (metric: Exclude<CertificateFilter, 'all'>) => void;
}

interface BuildingComplianceChartProps {
  items: readonly BuildingCompliance[];
  onSelect?: (
    building: string,
    series: 'compliant' | 'non-compliant' | 'rate',
  ) => void;
}

const FILTER_OPTIONS: ReadonlyArray<{
  value: CertificateFilter;
  label: string;
}> = [
  { value: 'all', label: '全部证书' },
  { value: 'high-voltage', label: '高压电工证' },
  { value: 'low-voltage', label: '低压电工证' },
  { value: 'height-work', label: '登高证' },
];

const CERTIFICATE_BADGES: ReadonlyArray<{
  filter: Exclude<CertificateFilter, 'all'>;
  label: string;
}> = [
  { filter: 'high-voltage', label: '高压电工证' },
  { filter: 'low-voltage', label: '低压电工证' },
  { filter: 'height-work', label: '登高证' },
];

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const HEAT_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;
const CALENDAR_ROWS = 6;
const CALENDAR_COLUMNS = 7;
const CHART_LABEL_EDGE = 2;
const CHART_LABEL_GAP = 8;
const MINIMUM_INSIDE_SEGMENT_LABEL_HEIGHT = 14;

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeCount(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeRate(value: number) {
  return clamp(value, 0, 100);
}

function sumCounts(first: number, second: number) {
  const total = first + second;

  return Number.isFinite(total) ? total : Number.MAX_VALUE;
}

function getNiceCountStep(maximum: number) {
  if (maximum <= 20) {
    return 5;
  }

  const roughStep = maximum / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalizedStep = roughStep / magnitude;
  const multiplier =
    normalizedStep <= 1
      ? 1
      : normalizedStep <= 2
        ? 2
        : normalizedStep <= 5
          ? 5
          : 10;
  const step = magnitude * multiplier;

  return Number.isFinite(step) ? step : maximum;
}

export function getCountAxisTicks(
  items: readonly BuildingCompliance[],
): number[] {
  const maximum = items.reduce((currentMaximum, item) => {
    const total = sumCounts(
      normalizeCount(item.compliant),
      normalizeCount(item.nonCompliant),
    );

    return Math.max(currentMaximum, total);
  }, 0);
  const step = getNiceCountStep(maximum);
  const roundedMaximum = Math.ceil(maximum / step) * step;

  if (!Number.isFinite(roundedMaximum)) {
    return [0, maximum];
  }

  const axisMaximum = Math.max(step, roundedMaximum);
  const tickCount = Math.round(axisMaximum / step);

  return Array.from({ length: tickCount + 1 }, (_, index) => index * step);
}

export function isCertificateFilter(value: string): value is CertificateFilter {
  return FILTER_OPTIONS.some((option) => option.value === value);
}

function placeChartLabel(pointY: number, height: number, chartBottom: number) {
  const aboveTop = pointY - height - CHART_LABEL_GAP;

  if (aboveTop >= CHART_LABEL_EDGE) {
    return { top: aboveTop, placement: 'above' } as const;
  }

  const belowTop = pointY + CHART_LABEL_GAP;

  if (belowTop + height <= chartBottom) {
    return { top: belowTop, placement: 'below' } as const;
  }

  return {
    top: clamp(aboveTop, CHART_LABEL_EDGE, chartBottom - height),
    placement: 'above',
  } as const;
}

function formatCertificateMonth(month: CertificateMonth) {
  const [year, monthNumber] = month.split('-');

  return `${year}年${Number(monthNumber)}月`;
}

export function ComplianceGauge({
  rate,
  current,
  target,
}: ComplianceGaugeProps) {
  const boundedRate = normalizeRate(rate);
  const normalizedCurrent = normalizeCount(current);
  const normalizedTarget = normalizeCount(target);
  const formattedRate = boundedRate.toFixed(1);

  return (
    <section
      className="certificate-compliance-gauge"
      aria-label={`当前持证合规率 ${formattedRate}%，当前合格 ${normalizedCurrent} 人，目标 ${normalizedTarget} 人`}
    >
      <div className="certificate-compliance-gauge-graphic">
        <svg
          className="certificate-compliance-gauge-svg"
          viewBox="0 0 240 150"
          aria-hidden="true"
        >
          <path
            className="certificate-compliance-gauge-track"
            d="M 30 120 A 90 90 0 0 1 210 120"
            fill="none"
            pathLength={100}
          />
          <path
            className="certificate-compliance-gauge-progress"
            d="M 30 120 A 90 90 0 0 1 210 120"
            fill="none"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - boundedRate}
          />
        </svg>
        <div className="certificate-compliance-gauge-reading">
          <strong className="certificate-compliance-gauge-rate">
            {formattedRate}%
          </strong>
          <p className="certificate-compliance-gauge-label">持证合规率</p>
        </div>
      </div>

      <dl className="certificate-compliance-gauge-summary">
        <div className="certificate-compliance-gauge-stat">
          <dt>当前合格</dt>
          <dd>{normalizedCurrent} 人</dd>
        </div>
        <div className="certificate-compliance-gauge-stat">
          <dt>目标</dt>
          <dd>{normalizedTarget} 人</dd>
        </div>
      </dl>
    </section>
  );
}

export function ExpiryHeatmap({
  month,
  onMonthChange,
  filter,
  onFilterChange,
  events,
  availableMonths,
  totals = filterCertificateTotals,
  onDateSelect,
  onMonthSelect,
  onMetricSelect,
}: ExpiryHeatmapProps) {
  const calendar = events
    ? buildExpiryCalendarFromEvents(month, filter, events)
    : buildExpiryCalendar(month, filter);
  const previousMonth = stepCertificateMonth(month, -1, availableMonths);
  const nextMonth = stepCertificateMonth(month, 1, availableMonths);
  const monthLabel = formatCertificateMonth(month);
  const instanceId = useId();
  const filterId = `certificate-expiry-filter-${instanceId}`;
  const descriptionId = `certificate-expiry-description-${instanceId}`;

  return (
    <section className="certificate-expiry-heatmap">
      <div className="certificate-expiry-heatmap-heading">
        <div>
          <h2 className="certificate-section-title">证书到期日历热力图</h2>
          <p className="certificate-section-description">
            按日期查看证书到期数量分布，颜色越深表示到期证书越多。
          </p>
        </div>

        <div className="certificate-expiry-filter">
          <label htmlFor={filterId}>证书类型</label>
          <select
            id={filterId}
            name="certificate-type-filter"
            value={filter}
            onChange={(event) => {
              if (isCertificateFilter(event.currentTarget.value)) {
                onFilterChange(event.currentTarget.value);
              }
            }}
          >
            {FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="certificate-expiry-heatmap-summary">
        <ul className="certificate-expiry-badges" aria-label="证书分类">
          {CERTIFICATE_BADGES.map((badge) => (
            <li
              key={badge.filter}
              className={`certificate-expiry-badge certificate-expiry-badge-${badge.filter}`}
            >
              <button
                type="button"
                aria-label={`查看${badge.label}持有人清单`}
                onClick={() => onMetricSelect?.(badge.filter)}
              >
                {badge.label} {totals[badge.filter]}
              </button>
            </li>
          ))}
        </ul>
        <p className="certificate-expiry-total" aria-live="polite">
          <button
            type="button"
            aria-label={`查看${monthLabel}到期证书清单`}
            onClick={() => onMonthSelect?.(month)}
          >
            当前月份总计 <strong>{calendar.total}</strong> 本证书
          </button>
        </p>
      </div>

      <div className="certificate-expiry-heatmap-chart">
        <div className="certificate-expiry-calendar-navigation">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="certificate-expiry-calendar-button"
            aria-label="查看上一个月"
            disabled={previousMonth === null}
            onClick={() => {
              if (previousMonth) {
                onMonthChange(previousMonth);
              }
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <p className="certificate-expiry-calendar-month" aria-live="polite">
            {monthLabel}
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="certificate-expiry-calendar-button"
            aria-label="查看下一个月"
            disabled={nextMonth === null}
            onClick={() => {
              if (nextMonth) {
                onMonthChange(nextMonth);
              }
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>

        <div
          className="certificate-expiry-calendar"
          role="group"
          aria-label={`${monthLabel}证书到期数量日历`}
          aria-describedby={descriptionId}
          data-calendar-rows={CALENDAR_ROWS}
          data-calendar-columns={CALENDAR_COLUMNS}
        >
          <div className="certificate-expiry-weekdays">
            {WEEKDAY_LABELS.map((weekday) => (
              <div
                key={weekday}
                className="certificate-expiry-weekday"
                data-calendar-weekday={weekday}
              >
                星期{weekday}
              </div>
            ))}
          </div>

          <div className="certificate-expiry-cells">
            {calendar.cells.map((cell, slotIndex) => {
              if (cell.kind === 'blank') {
                return (
                  <div
                    key={cell.key}
                    className="certificate-expiry-cell certificate-expiry-cell-blank"
                    data-calendar-slot={slotIndex + 1}
                    data-calendar-blank="true"
                    aria-hidden="true"
                  />
                );
              }

              return (
                <button
                  type="button"
                  key={cell.key}
                  className="certificate-expiry-cell certificate-expiry-cell-day"
                  data-calendar-slot={slotIndex + 1}
                  data-calendar-current-month="true"
                  data-date={cell.date}
                  data-day={cell.day}
                  data-level={cell.level}
                  aria-label={`${cell.date}，到期 ${cell.count} 本证书，查看具体信息`}
                  onClick={() => onDateSelect?.(cell.date)}
                >
                  <span className="certificate-expiry-day-number">
                    {cell.day}
                  </span>
                  {cell.count > 0 ? (
                    <span className="certificate-expiry-day-count">
                      {cell.count} 本
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div id={descriptionId} className="certificate-sr-only">
        <table>
          <caption>{monthLabel}证书到期热力图详细分布</caption>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">到期明细</th>
            </tr>
          </thead>
          <tbody>
            {calendar.cells.map((cell) =>
              cell.kind === 'day' ? (
                <tr key={`detail-${cell.date}`}>
                  <th scope="row">{cell.date}</th>
                  <td className="certificate-expiry-sr-cell">
                    {monthLabel}
                    {cell.day}日，到期 {cell.count} 本证书，热力等级{' '}
                    {cell.level}
                  </td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      </div>

      <div className="certificate-expiry-legend">
        <small>少</small>
        <ol className="certificate-expiry-legend-levels" aria-hidden="true">
          {HEAT_LEVELS.map((level) => (
            <li key={level} data-level={level} />
          ))}
        </ol>
        <small>多</small>
        <p>图例分为 7 级，颜色深浅对应同一天到期的证书数量。</p>
      </div>
    </section>
  );
}

export function BuildingComplianceChart({
  items,
  onSelect,
}: BuildingComplianceChartProps) {
  const chart = {
    left: 24,
    right: 616,
    top: 28,
    bottom: 122,
  } as const;
  const normalizedItems = items.map((item) => ({
    ...item,
    compliant: normalizeCount(item.compliant),
    nonCompliant: normalizeCount(item.nonCompliant),
    rate: normalizeRate(item.rate),
  }));
  const countTicks = getCountAxisTicks(normalizedItems);
  const countAxisMaximum = countTicks[countTicks.length - 1];
  const chartWidth = chart.right - chart.left;
  const chartHeight = chart.bottom - chart.top;
  const groupWidth = chartWidth / Math.max(normalizedItems.length, 1);
  const barWidth = clamp(groupWidth * 0.34, 18, 32);
  const countY = (value: number) =>
    chart.bottom -
    (clamp(normalizeCount(value), 0, countAxisMaximum) / countAxisMaximum) *
      chartHeight;
  const rateY = (value: number) =>
    chart.bottom - (normalizeRate(value) / 100) * chartHeight;
  const plottedItems = normalizedItems.map((item, index) => {
    const x = clamp(
      chart.left + groupWidth * (index + 0.5),
      chart.left,
      chart.right,
    );
    const compliant = item.compliant;
    const nonCompliant = item.nonCompliant;
    const total = sumCounts(compliant, nonCompliant);
    const compliantTop = countY(compliant);
    const totalTop = countY(total);

    return {
      item,
      x,
      compliant,
      nonCompliant,
      compliantTop,
      totalTop,
      rate: item.rate,
      rateTop: rateY(item.rate),
    };
  });
  const ratePoints = plottedItems
    .map(({ x, rateTop }) => `${x},${rateTop}`)
    .join(' ');
  const accessibleDescription = normalizedItems.length
    ? `楼栋持证合规情况：${normalizedItems
        .map(
          (item) =>
            `${item.building}合规${item.compliant}人、不合规${item.nonCompliant}人、合规率${item.rate}%`,
        )
        .join('；')}`
    : '楼栋持证合规情况：暂无数据';

  return (
    <figure
      className="certificate-building-compliance-chart"
      role="group"
      aria-label={accessibleDescription}
    >
      <div className="certificate-building-chart-legend" aria-hidden="true">
        <p className="certificate-building-chart-legend-compliant">合规人数</p>
        <p className="certificate-building-chart-legend-noncompliant">
          不合规人数
        </p>
        <p className="certificate-building-chart-legend-rate">合规率</p>
      </div>

      {items.length === 0 ? (
        <p className="certificate-building-chart-empty">暂无楼栋合规数据</p>
      ) : null}

      <svg
        className="certificate-building-chart-svg"
        viewBox="0 0 640 160"
        role="group"
        aria-label="楼栋合规图表，点击柱形或合规率查看人员清单"
      >
        {plottedItems.map(
          ({ item, x, compliant, nonCompliant, compliantTop, totalTop }) => {
            const compliantHeight = chart.bottom - compliantTop;
            const nonCompliantHeight = compliantTop - totalTop;
            const isTinyCompliantSegment =
              compliant > 0 &&
              compliantHeight < MINIMUM_INSIDE_SEGMENT_LABEL_HEIGHT;
            const isTinyNonCompliantSegment =
              nonCompliant > 0 &&
              nonCompliantHeight < MINIMUM_INSIDE_SEGMENT_LABEL_HEIGHT;
            const compliantLabelX = isTinyCompliantSegment
              ? x - barWidth / 2 - 4
              : x;
            const compliantLabelY = clamp(
              compliantTop + compliantHeight / 2,
              chart.top + 6,
              chart.bottom - 6,
            );
            const nonCompliantLabelX = isTinyNonCompliantSegment
              ? x + barWidth / 2 + 4
              : x;
            const nonCompliantLabelY = clamp(
              totalTop + nonCompliantHeight / 2,
              chart.top + 6,
              chart.bottom - 6,
            );

            return (
              <g key={`bar-${item.building}`}>
                <rect
                  className="certificate-building-chart-bar-compliant"
                  data-series="compliant-bar"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看${item.building}合规人员清单`}
                  onClick={() => onSelect?.(item.building, 'compliant')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect?.(item.building, 'compliant');
                    }
                  }}
                  x={x - barWidth / 2}
                  y={compliantTop}
                  width={barWidth}
                  height={compliantHeight}
                />
                <rect
                  className="certificate-building-chart-bar-noncompliant"
                  data-series="noncompliant-bar"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看${item.building}不合规人员清单`}
                  onClick={() => onSelect?.(item.building, 'non-compliant')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect?.(item.building, 'non-compliant');
                    }
                  }}
                  x={x - barWidth / 2}
                  y={totalTop}
                  width={barWidth}
                  height={nonCompliantHeight}
                />
                <text
                  className="certificate-building-chart-value-compliant"
                  data-series="compliant-value"
                  data-value={compliant}
                  data-placement={isTinyCompliantSegment ? 'left' : 'inside'}
                  x={compliantLabelX}
                  y={compliantLabelY}
                  textAnchor={isTinyCompliantSegment ? 'end' : 'middle'}
                  dominantBaseline="middle"
                >
                  {compliant}
                </text>
                {nonCompliant > 0 ? (
                  <text
                    className="certificate-building-chart-value-noncompliant"
                    data-series="noncompliant-value"
                    data-value={nonCompliant}
                    data-placement={
                      isTinyNonCompliantSegment ? 'right' : 'inside'
                    }
                    x={nonCompliantLabelX}
                    y={nonCompliantLabelY}
                    textAnchor={isTinyNonCompliantSegment ? 'start' : 'middle'}
                    dominantBaseline="middle"
                  >
                    {nonCompliant}
                  </text>
                ) : null}
                <text
                  className="certificate-building-chart-building-label"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看${item.building}合规率明细`}
                  onClick={() => onSelect?.(item.building, 'rate')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect?.(item.building, 'rate');
                    }
                  }}
                  x={x}
                  y={chart.bottom + 22}
                  textAnchor="middle"
                >
                  {item.building}
                </text>
              </g>
            );
          },
        )}

        <polyline
          className="certificate-building-chart-rate-line-halo"
          data-series="rate-line-halo"
          points={ratePoints}
          fill="none"
        />
        <polyline
          className="certificate-building-chart-rate-line"
          data-series="rate-line"
          points={ratePoints}
          fill="none"
        />

        {plottedItems.map(({ item, x, rate, rateTop }) => {
          const isRateHealthy = rate >= 90;
          const labelWidth = isRateHealthy ? 34 : 60;
          const labelHeight = isRateHealthy ? 14 : 18;
          const labelX = clamp(
            x - labelWidth / 2,
            chart.left,
            chart.right - labelWidth,
          );
          const labelPlacement = placeChartLabel(
            rateTop,
            labelHeight,
            chart.bottom,
          );

          return (
            <g
              key={`rate-point-${item.building}`}
              role="button"
              tabIndex={0}
              aria-label={`查看${item.building}合规率明细`}
              onClick={() => onSelect?.(item.building, 'rate')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect?.(item.building, 'rate');
                }
              }}
              className={
                isRateHealthy
                  ? 'certificate-building-chart-rate-label'
                  : 'certificate-building-chart-rate-label certificate-building-chart-alert'
              }
              data-series="rate-label"
              data-building={item.building}
              data-point-y={rateTop}
              data-label-top={labelPlacement.top}
              data-label-bottom={labelPlacement.top + labelHeight}
              data-placement={labelPlacement.placement}
            >
              <circle
                className="certificate-building-chart-rate-point"
                data-series="rate-point"
                data-building={item.building}
                cx={x}
                cy={rateTop}
                r={4}
              />
              {isRateHealthy ? (
                <>
                  <rect
                    className="certificate-building-chart-rate-label-box"
                    x={labelX}
                    y={labelPlacement.top}
                    width={labelWidth}
                    height={labelHeight}
                  />
                  <text
                    className="certificate-building-chart-rate-value"
                    x={labelX + labelWidth / 2}
                    y={labelPlacement.top + labelHeight / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {rate}%
                  </text>
                </>
              ) : (
                <>
                  <rect
                    className="certificate-building-chart-alert-box"
                    x={labelX}
                    y={labelPlacement.top}
                    width={labelWidth}
                    height={labelHeight}
                    strokeDasharray="5 4"
                  />
                  <text
                    className="certificate-building-chart-alert-label"
                    x={labelX + labelWidth / 2}
                    y={labelPlacement.top + labelHeight / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {rate}% 待提升
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
