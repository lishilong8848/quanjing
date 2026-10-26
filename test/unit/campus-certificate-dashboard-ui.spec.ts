import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript';

jest.mock(
  '@/lib/utils',
  () => jest.requireActual('../../client/src/lib/utils'),
  { virtual: true },
);

import { canAccessPage } from '../../client/src/access/access-policy';
import * as certificateCharts from '../../client/src/pages/CampusCertificateDashboard/charts';
import type { AccessRole } from '../../shared/access-control.interface';

import {
  buildingCompliance,
  certificateMetrics,
  createHeatmap,
  dashboardSummary,
  filterCertificateTotals,
  nonCompliantPeople,
  type BuildingCompliance,
  type CertificateFilter,
  type CertificateMetric,
  type NonCompliantPerson,
} from '../../client/src/pages/CampusCertificateDashboard/model';

type ExpectedCertificateMonth =
  | '2025-05'
  | '2025-06'
  | '2025-07'
  | '2025-08'
  | '2025-09'
  | '2025-10'
  | '2025-11'
  | '2025-12';

interface ExpectedCertificateCalendarDay {
  kind: 'day';
  date: string;
  day: number;
  count: number;
  level: number;
}

type ExpectedCertificateCalendarCell =
  | { kind: 'blank' }
  | ExpectedCertificateCalendarDay;

interface ExpectedCertificateCalendar {
  cells: ExpectedCertificateCalendarCell[];
  total: number;
}

interface ExpectedCertificateCalendarModel {
  CERTIFICATE_MONTHS?: readonly ExpectedCertificateMonth[];
  buildExpiryCalendar?: (
    month: ExpectedCertificateMonth,
    filter: CertificateFilter,
  ) => ExpectedCertificateCalendar;
  stepCertificateMonth?: (
    month: ExpectedCertificateMonth,
    direction: -1 | 1,
  ) => ExpectedCertificateMonth | null;
}

function loadCertificateCalendarModel(): ExpectedCertificateCalendarModel {
  return require('../../client/src/pages/CampusCertificateDashboard/model') as ExpectedCertificateCalendarModel;
}

const { BuildingComplianceChart, ComplianceGauge, ExpiryHeatmap } =
  certificateCharts;

const hardenedChartExports = certificateCharts as typeof certificateCharts & {
  getCountAxisTicks?: (items: BuildingCompliance[]) => number[];
  isCertificateFilter?: (value: string) => value is CertificateFilter;
};

interface DashboardLogicModule {
  calculateDashboardScale: (
    width: number,
    height: number,
    previousScale?: number,
  ) => number;
  formatDashboardTimestamp: (date: Date) => string;
  filterNonCompliantPeople: (
    people: NonCompliantPerson[],
    query: string,
  ) => NonCompliantPerson[];
}

function loadDashboardLogic(): DashboardLogicModule {
  return require('../../client/src/pages/CampusCertificateDashboard/logic') as DashboardLogicModule;
}

describe('campus certificate dashboard charts', () => {
  it('exposes certificate badges, monthly total and each building series as drilldown controls', () => {
    const heatmap = renderToStaticMarkup(
      React.createElement(ExpiryHeatmap, {
        month: '2026-09',
        onMonthChange: () => undefined,
        filter: 'all',
        onFilterChange: () => undefined,
        events: [],
        onDateSelect: () => undefined,
        onMonthSelect: () => undefined,
        onMetricSelect: () => undefined,
      }),
    );
    const chart = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, {
        items: [{ building: 'A楼', compliant: 8, nonCompliant: 2, rate: 80 }],
        onSelect: () => undefined,
      }),
    );

    expect(heatmap).toContain('aria-label="查看高压电工证持有人清单"');
    expect(heatmap).toContain('aria-label="查看2026年9月到期证书清单"');
    expect(chart).toContain('aria-label="查看A楼合规人员清单"');
    expect(chart).toContain('aria-label="查看A楼不合规人员清单"');
    expect(chart).toContain('aria-label="查看A楼合规率明细"');
  });
  it('defines the certificate chart components and chart landmarks', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/charts.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('function ComplianceGauge');
    expect(source).toContain('function ExpiryHeatmap');
    expect(source).toContain('function BuildingComplianceChart');
    expect(source).toContain('viewBox="0 0 640 160"');
    expect(source).toContain('name="certificate-type-filter"');
    expect(source).toContain('证书到期日历热力图');
    expect(source).toMatch(
      /if\s*\(\s*isCertificateFilter\(event\.currentTarget\.value\)\s*\)/,
    );
  });

  it('clamps gauge rates and normalizes invalid people counts', () => {
    const underflow = renderToStaticMarkup(
      React.createElement(ComplianceGauge, {
        rate: -5,
        current: Number.NaN,
        target: Number.POSITIVE_INFINITY,
      }),
    );
    const overflow = renderToStaticMarkup(
      React.createElement(ComplianceGauge, {
        rate: 150,
        current: 86,
        target: 90,
      }),
    );

    expect(underflow).toContain('0.0%');
    expect(underflow).toContain('当前合格 0 人，目标 0 人');
    expect(underflow).not.toMatch(/NaN|Infinity/);
    expect(overflow).toContain('100.0%');
  });

  it('renders the exact six-row May calendar with one accessible detail per day', () => {
    const { buildExpiryCalendar } = loadCertificateCalendarModel();

    expect(buildExpiryCalendar).toEqual(expect.any(Function));
    if (!buildExpiryCalendar) return;

    const calendar = buildExpiryCalendar('2025-05', 'all');
    const markup = renderToStaticMarkup(
      React.createElement(ExpiryHeatmap, {
        month: '2025-05',
        onMonthChange: () => undefined,
        filter: 'all',
        onFilterChange: () => undefined,
        onDateSelect: () => undefined,
      }),
    );
    const slots = [
      ...markup.matchAll(/<[^>]+data-calendar-slot="(\d+)"[^>]*>/g),
    ].map((match) => match[0]);
    const weekdays = [
      ...markup.matchAll(
        /data-calendar-weekday="([一二三四五六日])"[^>]*>星期\1</g,
      ),
    ].map((match) => match[1]);
    const screenReaderCells =
      markup.match(/class="certificate-expiry-sr-cell"/g) ?? [];
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(slots).toHaveLength(42);
    expect(markup.match(/data-calendar-current-month="true"/g)).toHaveLength(
      31,
    );
    expect(
      markup.match(
        /<button[^>]*type="button"[^>]*data-calendar-current-month="true"/g,
      ),
    ).toHaveLength(31);
    expect(markup).toContain(
      'aria-label="2025-05-01，到期 0 本证书，查看具体信息"',
    );
    expect(markup).not.toContain('role="img"');
    expect(markup.match(/data-calendar-blank="true"/g)).toHaveLength(11);
    expect(markup).toContain('data-calendar-rows="6"');
    expect(markup).toContain('data-calendar-columns="7"');
    expect(markup).toContain('2025年5月');
    expect(weekdays).toEqual(['一', '二', '三', '四', '五', '六', '日']);

    calendar.cells.forEach((cell, slotIndex) => {
      const slot = slots[slotIndex];

      expect(slot).toContain(`data-calendar-slot="${slotIndex + 1}"`);
      if (cell.kind === 'blank') {
        expect(slot).toContain('data-calendar-blank="true"');
        expect(slot).not.toContain('data-date=');
        expect(slot).not.toContain('data-day=');
        return;
      }

      expect(slot).toContain('data-calendar-current-month="true"');
      expect(slot).toContain(`data-date="${cell.date}"`);
      expect(slot).toContain(`data-day="${cell.day}"`);
      expect(slot).toContain(`data-level="${cell.level}"`);
    });

    expect(markup).toContain(
      `当前月份总计 <strong>${calendar.total}</strong> 本证书`,
    );
    expect(screenReaderCells).toHaveLength(31);
    expect(describedBy).toBeDefined();
    expect(markup).toContain(
      `<div id="${describedBy}" class="certificate-sr-only"><table>`,
    );
    expect(markup).toContain('<caption>');
    expect(markup).toContain('2025年5月31日，到期');
  });

  it('keeps all adjacent-month slots blank in the June calendar', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ExpiryHeatmap, {
        month: '2025-06',
        onMonthChange: () => undefined,
        filter: 'all',
        onFilterChange: () => undefined,
      }),
    );

    expect(markup.match(/data-calendar-slot="\d+"/g)).toHaveLength(42);
    expect(markup.match(/data-calendar-current-month="true"/g)).toHaveLength(
      30,
    );
    expect(markup.match(/data-calendar-blank="true"/g)).toHaveLength(12);
    expect(markup).toContain('2025年6月');
    expect(markup).not.toMatch(/data-date="2025-(?:05|07)-/);
  });

  it('disables calendar navigation only at the supported month boundaries', () => {
    const renderMonth = (month: ExpectedCertificateMonth) =>
      renderToStaticMarkup(
        React.createElement(ExpiryHeatmap, {
          month,
          onMonthChange: () => undefined,
          filter: 'all',
          onFilterChange: () => undefined,
        }),
      );
    const getNavigationButton = (markup: string, label: string) =>
      markup.match(
        new RegExp(`<button(?=[^>]*aria-label="${label}")[^>]*>`),
      )?.[0];
    const mayMarkup = renderMonth('2025-05');
    const juneMarkup = renderMonth('2025-06');
    const decemberMarkup = renderMonth('2025-12');
    const decemberPreviousButton = getNavigationButton(
      decemberMarkup,
      '查看上一个月',
    );
    const decemberNextButton = getNavigationButton(
      decemberMarkup,
      '查看下一个月',
    );

    expect(getNavigationButton(mayMarkup, '查看上一个月')).toContain(
      'disabled=""',
    );
    expect(getNavigationButton(mayMarkup, '查看下一个月')).not.toContain(
      'disabled=""',
    );
    expect(getNavigationButton(juneMarkup, '查看上一个月')).not.toContain(
      'disabled=""',
    );
    expect(getNavigationButton(juneMarkup, '查看下一个月')).not.toContain(
      'disabled=""',
    );
    expect(decemberPreviousButton).toBeDefined();
    expect(decemberNextButton).toBeDefined();
    expect(decemberPreviousButton).not.toContain('disabled=""');
    expect(decemberNextButton).toContain('disabled=""');
  });

  it('uses unique select and description ids for multiple heatmaps', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ExpiryHeatmap, {
          month: '2025-05',
          onMonthChange: () => undefined,
          filter: 'all',
          onFilterChange: () => undefined,
        }),
        React.createElement(ExpiryHeatmap, {
          month: '2025-06',
          onMonthChange: () => undefined,
          filter: 'high-voltage',
          onFilterChange: () => undefined,
        }),
      ),
    );
    const selectIds = [...markup.matchAll(/<select id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const descriptionIds = [
      ...markup.matchAll(/aria-describedby="([^"]+)"/g),
    ].map((match) => match[1]);

    expect(selectIds).toHaveLength(2);
    expect(new Set(selectIds).size).toBe(2);
    expect(descriptionIds).toHaveLength(2);
    expect(new Set(descriptionIds).size).toBe(2);
  });

  it('derives safe filters from the rendered select options', () => {
    const isCertificateFilter = hardenedChartExports.isCertificateFilter;

    expect(isCertificateFilter?.('all')).toBe(true);
    expect(isCertificateFilter?.('height-work')).toBe(true);
    expect(isCertificateFilter?.('invalid-filter')).toBe(false);
  });

  it('builds a dynamic count axis that covers a 20 plus 1 stack', () => {
    const getCountAxisTicks = hardenedChartExports.getCountAxisTicks;
    const items: BuildingCompliance[] = [
      { building: '测试楼', compliant: 20, nonCompliant: 1, rate: 95 },
    ];
    const ticks = getCountAxisTicks?.(items);
    const maximumTick = ticks ? ticks[ticks.length - 1] : undefined;

    expect(ticks?.[0]).toBe(0);
    expect(maximumTick).toBeGreaterThanOrEqual(21);
    expect(
      ticks?.every((tick, index) => index === 0 || tick > ticks[index - 1]),
    ).toBe(true);
  });

  it('omits plot gridlines and side-axis ticks while retaining legends and building labels', () => {
    const chartMarkup = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, {
        items: buildingCompliance,
      }),
    );

    expect(chartMarkup).not.toContain('certificate-building-chart-gridline');
    expect(chartMarkup).not.toContain('certificate-building-chart-axis-label');
    expect(chartMarkup).not.toContain('data-count-axis-tick');
    expect(chartMarkup).toContain('certificate-building-chart-building-label');
    expect(chartMarkup).toContain('合规人数');
    expect(chartMarkup).toContain('不合规人数');
    expect(chartMarkup).toContain('合规率');
  });

  it('keeps every rate label above its point and suppresses zero non-compliant values', () => {
    const chartMarkup = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, {
        items: buildingCompliance,
      }),
    );
    const tagsForSeries = (series: string) =>
      [
        ...chartMarkup.matchAll(
          new RegExp(`<[^>]+data-series="${series}"[^>]*>`, 'g'),
        ),
      ].map((match) => match[0]);
    const numericAttribute = (tag: string, name: string) => {
      const value = tag.match(new RegExp(`${name}="([^"]+)"`))?.[1];

      return value === undefined ? Number.NaN : Number(value);
    };
    const rateLabels = tagsForSeries('rate-label');
    const compliantValues = tagsForSeries('compliant-value');
    const nonCompliantValues = tagsForSeries('noncompliant-value');
    const rateValueCapsules = [
      ...(chartMarkup.match(/certificate-building-chart-rate-label-box/g) ??
        []),
      ...(chartMarkup.match(/certificate-building-chart-alert-box/g) ?? []),
    ];

    expect(compliantValues).toHaveLength(buildingCompliance.length);
    expect(nonCompliantValues).toHaveLength(
      buildingCompliance.filter((item) => item.nonCompliant > 0).length,
    );
    expect(
      nonCompliantValues.every(
        (tag) => numericAttribute(tag, 'data-value') > 0,
      ),
    ).toBe(true);
    expect(rateLabels).toHaveLength(buildingCompliance.length);
    expect(rateValueCapsules).toHaveLength(buildingCompliance.length);

    rateLabels.forEach((tag) => {
      const pointY = numericAttribute(tag, 'data-point-y');
      const labelTop = numericAttribute(tag, 'data-label-top');
      const labelBottom = numericAttribute(tag, 'data-label-bottom');

      expect(tag).toContain('data-placement="above"');
      expect(labelTop).toBeGreaterThanOrEqual(0);
      expect(labelBottom).toBeLessThanOrEqual(pointY - 6);
    });
  });

  it('uses readable plot values and a surface halo behind the rate line', () => {
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );
    const plotValueRule =
      styles.match(
        /\.certificate-building-chart-value-compliant,\s*\.certificate-building-chart-value-noncompliant\s*\{[^}]*\}/,
      )?.[0] ?? '';
    const rateLineHaloRule =
      styles.match(
        /\.certificate-building-chart-rate-line-halo\s*\{[^}]*\}/,
      )?.[0] ?? '';
    const rateValueRule =
      styles.match(
        /\.certificate-building-chart-rate-value\s*\{[^}]*\}/,
      )?.[0] ?? '';

    expect(plotValueRule).toContain('font-size: 9px');
    expect(rateLineHaloRule).toContain('stroke: var(--certificate-surface)');
    expect(rateValueRule).toContain('font-size: 9px');
    expect(rateValueRule).toContain('paint-order: stroke fill');
    expect(rateValueRule).toContain('stroke: var(--certificate-surface)');
  });

  it('renders empty, stacked, line, point and normalized building chart states', () => {
    const emptyMarkup = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, { items: [] }),
    );
    const chartMarkup = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, {
        items: [
          { building: '测试楼', compliant: 20, nonCompliant: 1, rate: 95 },
          {
            building: '异常楼',
            compliant: Number.NaN,
            nonCompliant: Number.POSITIVE_INFINITY,
            rate: Number.POSITIVE_INFINITY,
          },
        ],
      }),
    );
    const nonCompliantBarHeight = chartMarkup.match(
      /data-series="noncompliant-bar"[^>]*height="([^"]+)"/,
    )?.[1];

    expect(emptyMarkup).toContain('暂无楼栋合规数据');
    expect(chartMarkup).not.toMatch(/NaN|Infinity/);
    expect(chartMarkup).toContain('异常楼合规0人、不合规0人、合规率0%');
    expect(Number(nonCompliantBarHeight)).toBeGreaterThan(0);
    expect(chartMarkup).toContain('data-series="compliant-bar"');
    expect(chartMarkup).toContain('data-series="noncompliant-bar"');
    expect(chartMarkup).toContain('data-series="rate-line"');
    expect(chartMarkup).toContain('data-series="rate-point"');
  });

  it('places a tiny non-compliant segment value outside its own bar', () => {
    const chartMarkup = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, {
        items: [
          { building: '测试楼', compliant: 20, nonCompliant: 1, rate: 95 },
        ],
      }),
    );
    const valueTag = chartMarkup.match(
      /<text[^>]*data-series="noncompliant-value"[^>]*>/,
    )?.[0];

    expect(valueTag).toBeDefined();
    expect(valueTag).toContain('data-placement="right"');
    expect(valueTag).toContain('text-anchor="start"');
  });

  it('places a tiny compliant segment value outside its own bar', () => {
    const chartMarkup = renderToStaticMarkup(
      React.createElement(BuildingComplianceChart, {
        items: [
          { building: '高量楼', compliant: 100, nonCompliant: 0, rate: 100 },
          { building: '低量楼', compliant: 1, nonCompliant: 0, rate: 100 },
        ],
      }),
    );
    const valueTag = chartMarkup.match(
      /<text[^>]*data-series="compliant-value"[^>]*data-value="1"[^>]*>/,
    )?.[0];

    expect(valueTag).toBeDefined();
    expect(valueTag).toContain('data-placement="left"');
    expect(valueTag).toContain('text-anchor="end"');
  });
});

describe('campus certificate dashboard model', () => {
  it('keeps the reference summary and certificate metrics stable', () => {
    const metrics: CertificateMetric[] = certificateMetrics;

    expect(dashboardSummary).toEqual({
      complianceRate: 95.6,
      currentQualified: 86,
      targetQualified: 90,
      totalCertificates: 153,
    });
    expect(metrics).toEqual([
      {
        id: 'high-voltage',
        label: '高压电工资质持有情况',
        value: 68,
        tone: 'blue',
      },
      {
        id: 'low-voltage',
        label: '低压电工资质持有情况',
        value: 72,
        tone: 'green',
      },
      {
        id: 'height-work',
        label: '高处作业资质持有情况',
        value: 7,
        tone: 'red',
      },
      {
        id: 'expiring',
        label: '证件90天内到期',
        value: 8,
        tone: 'orange',
      },
    ]);
    expect(metrics.map((item) => item.value)).toEqual([68, 72, 7, 8]);
    expect(filterCertificateTotals).toEqual({
      all: 153,
      'high-voltage': 68,
      'low-voltage': 72,
      'height-work': 7,
    });
  });

  it('keeps building compliance totals and display order stable', () => {
    const buildings: BuildingCompliance[] = buildingCompliance;

    expect(buildings).toEqual([
      { building: '110站', compliant: 8, nonCompliant: 0, rate: 100 },
      { building: 'A楼', compliant: 11, nonCompliant: 0, rate: 100 },
      { building: 'H楼', compliant: 15, nonCompliant: 0, rate: 100 },
      { building: 'D楼', compliant: 11, nonCompliant: 0, rate: 100 },
      { building: 'E楼', compliant: 10, nonCompliant: 2, rate: 83 },
      { building: 'C楼', compliant: 10, nonCompliant: 0, rate: 100 },
      { building: 'B楼', compliant: 8, nonCompliant: 2, rate: 80 },
    ]);
    expect(buildings.map((item) => item.building)).toEqual([
      '110站',
      'A楼',
      'H楼',
      'D楼',
      'E楼',
      'C楼',
      'B楼',
    ]);
    expect(buildings.reduce((sum, item) => sum + item.compliant, 0)).toBe(73);
    expect(buildings.reduce((sum, item) => sum + item.nonCompliant, 0)).toBe(4);
  });

  it('keeps the four non-compliant people and their position tones stable', () => {
    const people: NonCompliantPerson[] = nonCompliantPeople;

    expect(people).toHaveLength(4);
    expect(
      people.map(
        ({ building, name, position, missingCertificate, positionTone }) => ({
          building,
          name,
          position,
          missingCertificate,
          positionTone,
        }),
      ),
    ).toEqual([
      {
        building: 'E楼',
        name: '江亮',
        position: '运维值班员',
        missingCertificate: '低压电工证或高压电工证',
        positionTone: 'green',
      },
      {
        building: 'B楼',
        name: '李松奇',
        position: '运维值班员',
        missingCertificate: '高压电工证',
        positionTone: 'green',
      },
      {
        building: 'E楼',
        name: '付锦涛',
        position: '运维值班员',
        missingCertificate: '低压电工证或高压电工证',
        positionTone: 'green',
      },
      {
        building: 'B楼',
        name: '季磊',
        position: '暖通工程师',
        missingCertificate: '低压电工证',
        positionTone: 'red',
      },
    ]);
    expect(new Set(people.map((person) => person.id)).size).toBe(4);
  });

  it('builds deterministic bounded seven-by-twenty-four heatmaps', () => {
    const categoryFilters: CertificateFilter[] = [
      'high-voltage',
      'low-voltage',
      'height-work',
    ];
    const filters: CertificateFilter[] = ['all', ...categoryFilters];
    const heatmaps = filters.map((filter) => ({
      filter,
      values: createHeatmap(filter),
    }));

    for (const { filter, values } of heatmaps) {
      expect(values).toHaveLength(7);
      expect(values.every((row) => row.length === 24)).toBe(true);
      expect(
        values
          .flat()
          .every(
            (value) => Number.isInteger(value) && value >= 0 && value <= 6,
          ),
      ).toBe(true);
      expect(createHeatmap(filter)).toEqual(values);
    }

    expect(
      new Set(heatmaps.map(({ values }) => JSON.stringify(values))).size,
    ).toBe(4);
  });

  it('exports the compact certificate calendar model contract', () => {
    const calendarModel = loadCertificateCalendarModel();

    expect({
      months: calendarModel.CERTIFICATE_MONTHS,
      buildExpiryCalendar: typeof calendarModel.buildExpiryCalendar,
      stepCertificateMonth: typeof calendarModel.stepCertificateMonth,
    }).toEqual({
      months: [
        '2025-05',
        '2025-06',
        '2025-07',
        '2025-08',
        '2025-09',
        '2025-10',
        '2025-11',
        '2025-12',
      ],
      buildExpiryCalendar: 'function',
      stepCertificateMonth: 'function',
    });
  });

  it('builds a deterministic 42-slot May calendar with additive daily counts', () => {
    const { buildExpiryCalendar } = loadCertificateCalendarModel();

    expect(buildExpiryCalendar).toEqual(expect.any(Function));
    if (!buildExpiryCalendar) return;

    const categoryFilters: CertificateFilter[] = [
      'high-voltage',
      'low-voltage',
      'height-work',
    ];
    const filters: CertificateFilter[] = ['all', ...categoryFilters];
    const calendars = Object.fromEntries(
      filters.map((filter) => [filter, buildExpiryCalendar('2025-05', filter)]),
    ) as Record<CertificateFilter, ExpectedCertificateCalendar>;

    for (const filter of filters) {
      const calendar = calendars[filter];

      expect(calendar.cells).toHaveLength(42);
      expect(
        calendar.cells.slice(0, 3).every((cell) => cell.kind === 'blank'),
      ).toBe(true);
      expect(
        calendar.cells.slice(34).every((cell) => cell.kind === 'blank'),
      ).toBe(true);
      calendar.cells.slice(3, 34).forEach((cell, dayIndex) => {
        const day = dayIndex + 1;

        expect(cell).toMatchObject({
          kind: 'day',
          day,
          date: `2025-05-${String(day).padStart(2, '0')}`,
        });
        if (cell.kind !== 'day') return;
        expect(Number.isInteger(cell.count)).toBe(true);
        expect(cell.count).toBeGreaterThanOrEqual(0);
        expect(cell.level).toBe(Math.min(6, cell.count));
      });
      expect(buildExpiryCalendar('2025-05', filter)).toEqual(calendar);
    }

    for (const filter of categoryFilters) {
      const calendar = calendars[filter];
      const dailyCountTotal = calendar.cells.reduce(
        (sum, cell) => sum + (cell.kind === 'day' ? cell.count : 0),
        0,
      );

      expect(calendar.total).toBeGreaterThan(0);
      expect(dailyCountTotal).toBe(calendar.total);
      expect(dailyCountTotal).toBeGreaterThan(0);
    }

    const allDailyCountTotal = calendars.all.cells.reduce(
      (sum, cell) => sum + (cell.kind === 'day' ? cell.count : 0),
      0,
    );
    expect(calendars.all.total).toBe(allDailyCountTotal);

    const countSequences = categoryFilters.map((filter) =>
      calendars[filter].cells
        .filter(
          (cell): cell is ExpectedCertificateCalendarDay => cell.kind === 'day',
        )
        .map((cell) => cell.count),
    );
    expect(
      new Set(countSequences.map((counts) => JSON.stringify(counts))).size,
    ).toBe(3);

    for (let index = 3; index <= 33; index += 1) {
      const allCell = calendars.all.cells[index];
      const highCell = calendars['high-voltage'].cells[index];
      const lowCell = calendars['low-voltage'].cells[index];
      const heightCell = calendars['height-work'].cells[index];

      expect(
        [allCell, highCell, lowCell, heightCell].every(
          (cell) => cell.kind === 'day',
        ),
      ).toBe(true);
      if (
        allCell.kind === 'day' &&
        highCell.kind === 'day' &&
        lowCell.kind === 'day' &&
        heightCell.kind === 'day'
      ) {
        expect(allCell.count).toBe(
          highCell.count + lowCell.count + heightCell.count,
        );
      }
    }
  });

  it('builds exact 42-slot calendar structures across month boundaries', () => {
    const { buildExpiryCalendar } = loadCertificateCalendarModel();

    expect(buildExpiryCalendar).toEqual(expect.any(Function));
    if (!buildExpiryCalendar) return;

    const cases: Array<{
      month: ExpectedCertificateMonth;
      leadingBlanks: number;
      days: number;
    }> = [
      { month: '2025-06', leadingBlanks: 6, days: 30 },
      { month: '2025-12', leadingBlanks: 0, days: 31 },
    ];

    for (const { month, leadingBlanks, days } of cases) {
      const cells = buildExpiryCalendar(month, 'all').cells;

      expect(cells).toHaveLength(42);
      expect(
        cells.slice(0, leadingBlanks).every((cell) => cell.kind === 'blank'),
      ).toBe(true);
      cells
        .slice(leadingBlanks, leadingBlanks + days)
        .forEach((cell, dayIndex) => {
          const day = dayIndex + 1;

          expect(cell).toMatchObject({
            kind: 'day',
            day,
            date: `${month}-${String(day).padStart(2, '0')}`,
          });
          if (cell.kind !== 'day') return;
          expect(Number.isInteger(cell.count)).toBe(true);
          expect(cell.count).toBeGreaterThanOrEqual(0);
          expect(cell.level).toBe(Math.min(6, cell.count));
        });
      expect(
        cells
          .slice(leadingBlanks + days)
          .every((cell) => cell.kind === 'blank'),
      ).toBe(true);
    }
  });

  it('preserves category totals across all supported certificate months', () => {
    const { CERTIFICATE_MONTHS, buildExpiryCalendar } =
      loadCertificateCalendarModel();

    expect(CERTIFICATE_MONTHS).toBeDefined();
    expect(buildExpiryCalendar).toEqual(expect.any(Function));
    if (!CERTIFICATE_MONTHS || !buildExpiryCalendar) return;

    const categoryFilters: Array<Exclude<CertificateFilter, 'all'>> = [
      'high-voltage',
      'low-voltage',
      'height-work',
    ];
    const categoryTotals = Object.fromEntries(
      categoryFilters.map((filter) => [
        filter,
        CERTIFICATE_MONTHS.reduce(
          (total, month) => total + buildExpiryCalendar(month, filter).total,
          0,
        ),
      ]),
    ) as Record<Exclude<CertificateFilter, 'all'>, number>;
    const allTotal = CERTIFICATE_MONTHS.reduce(
      (total, month) => total + buildExpiryCalendar(month, 'all').total,
      0,
    );

    expect(categoryTotals).toEqual({
      'high-voltage': filterCertificateTotals['high-voltage'],
      'low-voltage': filterCertificateTotals['low-voltage'],
      'height-work': filterCertificateTotals['height-work'],
    });
    expect(allTotal).toBe(
      categoryTotals['high-voltage'] +
        categoryTotals['low-voltage'] +
        categoryTotals['height-work'],
    );
    expect(allTotal).toBe(147);
  });

  it('rejects unsupported runtime certificate calendar inputs', () => {
    const { buildExpiryCalendar, stepCertificateMonth } =
      loadCertificateCalendarModel();

    expect(buildExpiryCalendar).toEqual(expect.any(Function));
    expect(stepCertificateMonth).toEqual(expect.any(Function));
    if (!buildExpiryCalendar || !stepCertificateMonth) return;

    expect(() =>
      buildExpiryCalendar('2025-13' as ExpectedCertificateMonth, 'all'),
    ).toThrow(RangeError);
    expect(() =>
      buildExpiryCalendar('2025-05', 'unsupported-filter' as CertificateFilter),
    ).toThrow(RangeError);
    expect(
      stepCertificateMonth('2025-13' as ExpectedCertificateMonth, 1),
    ).toBeNull();
    expect(stepCertificateMonth('2025-05', 0 as -1 | 1)).toBeNull();
  });

  it('keeps every certificate calendar count and total non-negative and integral', () => {
    const { CERTIFICATE_MONTHS, buildExpiryCalendar } =
      loadCertificateCalendarModel();

    expect(CERTIFICATE_MONTHS).toBeDefined();
    expect(buildExpiryCalendar).toEqual(expect.any(Function));
    if (!CERTIFICATE_MONTHS || !buildExpiryCalendar) return;

    const filters: CertificateFilter[] = [
      'all',
      'high-voltage',
      'low-voltage',
      'height-work',
    ];

    CERTIFICATE_MONTHS.forEach((month) => {
      filters.forEach((filter) => {
        const calendar = buildExpiryCalendar(month, filter);

        expect(Number.isInteger(calendar.total)).toBe(true);
        expect(calendar.total).toBeGreaterThanOrEqual(0);
        calendar.cells.forEach((cell) => {
          if (cell.kind !== 'day') return;
          expect(Number.isInteger(cell.count)).toBe(true);
          expect(cell.count).toBeGreaterThanOrEqual(0);
        });
      });
    });
  });

  it('stops certificate calendar month stepping at both boundaries', () => {
    const { CERTIFICATE_MONTHS, stepCertificateMonth } =
      loadCertificateCalendarModel();

    expect(CERTIFICATE_MONTHS).toBeDefined();
    expect(stepCertificateMonth).toEqual(expect.any(Function));
    if (!CERTIFICATE_MONTHS || !stepCertificateMonth) return;

    CERTIFICATE_MONTHS.forEach((month, index) => {
      expect(stepCertificateMonth(month, -1)).toBe(
        index === 0 ? null : CERTIFICATE_MONTHS[index - 1],
      );
      expect(stepCertificateMonth(month, 1)).toBe(
        index === CERTIFICATE_MONTHS.length - 1
          ? null
          : CERTIFICATE_MONTHS[index + 1],
      );
    });
  });
});

describe('campus certificate dashboard page', () => {
  it('registers the protected dashboard route and navigation entry', () => {
    const appSource = readFileSync(
      join(process.cwd(), 'client/src/app.tsx'),
      'utf8',
    );
    const navigationSource = readFileSync(
      join(process.cwd(), 'client/src/navigation/page-switcher.ts'),
      'utf8',
    );
    const sourceFile = ts.createSourceFile(
      'app.tsx',
      appSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    type RouteNode = ts.JsxElement | ts.JsxSelfClosingElement;
    const isRouteNode = (node: ts.Node): node is RouteNode => {
      if (ts.isJsxElement(node)) {
        return node.openingElement.tagName.getText(sourceFile) === 'Route';
      }
      return (
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(sourceFile) === 'Route'
      );
    };
    const getRouteAttributes = (route: RouteNode) =>
      ts.isJsxElement(route)
        ? route.openingElement.attributes
        : route.attributes;
    const getRouteAttribute = (route: RouteNode, name: string) =>
      getRouteAttributes(route).properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) &&
          property.name.getText(sourceFile) === name,
      );
    const getElementExpressionText = (route: RouteNode) => {
      const initializer = getRouteAttribute(route, 'element')?.initializer;
      return initializer &&
        ts.isJsxExpression(initializer) &&
        initializer.expression
        ? initializer.expression.getText(sourceFile)
        : null;
    };
    const getPath = (route: RouteNode) => {
      const initializer = getRouteAttribute(route, 'path')?.initializer;
      return initializer && ts.isStringLiteral(initializer)
        ? initializer.text
        : null;
    };
    const getDescendantRoutes = (root: ts.Node) => {
      const routes: RouteNode[] = [];
      const visit = (node: ts.Node) => {
        if (isRouteNode(node)) routes.push(node);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(root, visit);
      return routes;
    };

    const guardRoute = getDescendantRoutes(sourceFile).find(
      (route): route is ts.JsxElement =>
        ts.isJsxElement(route) &&
        getElementExpressionText(route) === '<RouteAccessGuard />',
    );
    const standaloneRoute = guardRoute
      ? getDescendantRoutes(guardRoute).find(
          (route): route is ts.JsxElement =>
            ts.isJsxElement(route) &&
            getElementExpressionText(route) === '<StandaloneAccessLayout />',
        )
      : undefined;
    const dashboardRoute = standaloneRoute
      ? getDescendantRoutes(standaloneRoute).find(
          (route): route is ts.JsxSelfClosingElement =>
            ts.isJsxSelfClosingElement(route) &&
            getPath(route) === '/training-certification-management' &&
            getElementExpressionText(route) ===
              '<TrainingCertificationManagementPage />',
        )
      : undefined;

    expect(appSource).toContain(
      "import('./pages/TrainingCertificationManagement')",
    );
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
    expect(appSource).toContain(
      'element={<TrainingCertificationManagementPage />}',
    );
    expect(appSource).toContain('path="/campus-certificate-dashboard"');
    expect(appSource).toContain(
      'to="/training-certification-management?module=certificate"',
    );
    expect(guardRoute).toBeDefined();
    expect(standaloneRoute).toBeDefined();
    expect(dashboardRoute).toBeDefined();
    expect(navigationSource).toContain("label: '培训持证'");
    expect(navigationSource).toContain(
      "path: '/training-certification-management'",
    );
  });

  it('allows only general administrators to access the dashboard', () => {
    const pathname = '/campus-certificate-dashboard';
    const allowedRoles: AccessRole[] = ['admin', 'editor'];
    const deniedRoles: AccessRole[] = [
      'guest',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
    ];

    for (const role of allowedRoles) {
      expect(canAccessPage(role, pathname)).toBe(true);
    }
    for (const role of deniedRoles) {
      expect(canAccessPage(role, pathname)).toBe(false);
    }
  });

  it('keeps the fixed screenshot stage and key operational states', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );
    expect(source).toContain(
      'data-screenshot-target="campus-certificate-dashboard"',
    );
    expect(source).toContain('园区整体持证合规率');
    expect(source).toContain('各楼持证合规情况');
    expect(source).toContain('持证不合规人员');
    expect(source).toContain('未找到匹配的不合规人员');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('name="certificate-person-search"');
    expect(source).toContain('autoComplete="off"');
    expect(source).toMatch(/const\s+STAGE_WIDTH\s*=\s*1920/);
    expect(source).toMatch(/const\s+STAGE_HEIGHT\s*=\s*600/);
  });

  it('owns the selected certificate month and passes it to the heatmap', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );
    const heatmapUsage = source.match(/<ExpiryHeatmap\b[\s\S]*?\/>/)?.[0] ?? '';

    expect(source).toContain('new Date().toISOString().slice(0, 7)');
    expect(heatmapUsage).toMatch(/\bmonth=\{certificateMonth\}/);
    expect(heatmapUsage).toMatch(/\bonMonthChange=\{setCertificateMonth\}/);
  });

  it('uses the compact three-column 508-pixel dashboard body', () => {
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );

    expect({
      stageRows:
        /\.certificate-dashboard-stage\s*\{[^}]*grid-template-rows:\s*56px\s+508px\s*;/.test(
          styles,
        ),
      bodyHeight:
        /\.certificate-dashboard-body\s*\{[^}]*height:\s*508px\s*;/.test(
          styles,
        ),
      bodyColumns:
        /\.certificate-dashboard-body\s*\{[^}]*grid-template-columns:\s*394px\s+778px\s+700px\s*;/.test(
          styles,
        ),
      bodyGap: /\.certificate-dashboard-body\s*\{[^}]*gap:\s*12px\s*;/.test(
        styles,
      ),
      leftColumns:
        /\.certificate-left-column\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/.test(
          styles,
        ),
      leftHeight: /\.certificate-left-column\s*\{[^}]*height:\s*508px\s*;/.test(
        styles,
      ),
      gaugeSpansColumns:
        /\.certificate-gauge-card\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/.test(
          styles,
        ),
      centerHeight:
        /\.certificate-heatmap-card\s*\{[^}]*height:\s*508px\s*;/.test(styles),
      rightRows:
        /\.certificate-right-column\s*\{[^}]*grid-template-rows:\s*278px\s+220px\s*;/.test(
          styles,
        ),
      rightHeight:
        /\.certificate-right-column\s*\{[^}]*height:\s*508px\s*;/.test(styles),
    }).toEqual({
      stageRows: true,
      bodyHeight: true,
      bodyColumns: true,
      bodyGap: true,
      leftColumns: true,
      leftHeight: true,
      gaugeSpansColumns: true,
      centerHeight: true,
      rightRows: true,
      rightHeight: true,
    });
  });

  it('uses a seven-column, six-row certificate expiry calendar', () => {
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );

    expect(styles).toMatch(
      /\.certificate-expiry-weekdays\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)\s*;/,
    );
    expect(styles).toMatch(
      /\.certificate-expiry-cells\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)\s*;[^}]*grid-template-rows:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)\s*;/,
    );
    expect(styles).not.toMatch(
      /\.certificate-expiry-(?:weekdays|cells)\s*\{[^}]*repeat\((?:14|24),/,
    );
  });

  it('anchors hidden calendar details without expanding the card scroll bounds', () => {
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );
    const screenReaderOnlyRule =
      styles.match(/\.certificate-sr-only\s*\{[^}]*\}/)?.[0] ?? '';

    expect(screenReaderOnlyRule).toContain('position: absolute');
    expect(screenReaderOnlyRule).toContain('inset: 0 auto auto 0');
    expect(screenReaderOnlyRule).toContain('clip-path: inset(50%)');
  });

  it('keeps structural panels stationary on hover', () => {
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );
    const hoverRule =
      styles.match(
        /\.certificate-dashboard\s+\.certificate-panel:hover\s*\{[^}]*\}/,
      )?.[0] ?? '';

    expect(hoverRule).not.toBe('');
    expect(hoverRule).not.toContain('transform: translateY(-2px)');
  });

  it('keeps the theme-bearing root rule after the stylesheet prelude', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );
    const preludeIndex = styles.indexOf('.certificate-dashboard *');
    const guardIndex = styles.indexOf('.certificate-dashboard-css-chunk-guard');
    const rootRuleIndex = styles.indexOf(
      '.certificate-dashboard.certificate-dashboard-root',
    );

    expect(source).toContain(
      'className={`certificate-dashboard certificate-dashboard-root${',
    );
    expect(source).toContain(
      "embedded ? ' certificate-dashboard-embedded' : ''",
    );
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(preludeIndex).toBeGreaterThan(guardIndex);
    expect(preludeIndex).toBeGreaterThanOrEqual(0);
    expect(rootRuleIndex).toBeGreaterThan(preludeIndex);
    expect(styles.slice(rootRuleIndex)).toContain(
      '--certificate-primary: hsl(217 91% 57%)',
    );
    expect(styles).toMatch(
      /\.certificate-compliance-gauge-graphic\s*\{[\s\S]*?justify-content:\s*center;/,
    );
    expect(styles).toMatch(
      /\.certificate-expiry-heatmap-chart\s*\{[\s\S]*?justify-content:\s*flex-start;/,
    );
  });
});

describe('campus certificate dashboard logic', () => {
  it('keeps hardened screenshot, refresh, pagination and motion contracts', () => {
    loadDashboardLogic();
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );
    const styles = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );

    expect(source).toContain('持证数据已从飞书多维表格更新');
    expect(source).not.toContain('看板时间已更新');
    expect(source).toMatch(
      /data-screenshot-ready=\{\s*dashboardData\s*!==\s*null/,
    );
    expect(source).toMatch(/<span[^>]*aria-current="page"[^>]*>/);
    expect(source).not.toMatch(/<Button[^>]*aria-current="page"/);
    expect(styles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-delay:\s*0ms\s*!important/,
    );
  });

  it('calculates bounded scales for valid dashboard viewports', () => {
    const { calculateDashboardScale } = loadDashboardLogic();

    expect(calculateDashboardScale(1440, 810)).toBe(0.75);
    expect(calculateDashboardScale(1920, 600)).toBe(1);
    expect(calculateDashboardScale(1920, 540)).toBe(0.9);
    expect(calculateDashboardScale(1920, 1080)).toBe(1);
    expect(calculateDashboardScale(2560, 1440)).toBe(1);
  });

  it('preserves a valid previous scale for invalid dashboard viewports', () => {
    const { calculateDashboardScale } = loadDashboardLogic();

    expect(calculateDashboardScale(0, 1080, 0.75)).toBe(0.75);
    expect(calculateDashboardScale(-1, 1080, 0.75)).toBe(0.75);
    expect(calculateDashboardScale(Number.NaN, 1080, 0.75)).toBe(0.75);
    expect(calculateDashboardScale(1920, Number.POSITIVE_INFINITY, 0.75)).toBe(
      0.75,
    );
    expect(calculateDashboardScale(0, 0)).toBe(1);
  });

  it('formats local dashboard timestamps with zero padding', () => {
    const { formatDashboardTimestamp } = loadDashboardLogic();
    const localDate = new Date(2025, 4, 6, 7, 8);

    expect(formatDashboardTimestamp(localDate)).toBe('2025-05-06 07:08');
  });

  it('filters non-compliant people across all searchable fields', () => {
    const { filterNonCompliantPeople } = loadDashboardLogic();
    const people: NonCompliantPerson[] = [
      {
        id: 'alice',
        building: 'A-01',
        name: 'Alice',
        position: 'Operator',
        missingCertificate: 'High Voltage',
        positionTone: 'green',
      },
      {
        id: 'bob',
        building: 'B-02',
        name: 'Bob',
        position: 'Engineer',
        missingCertificate: 'Height Work',
        positionTone: 'red',
      },
    ];

    expect(filterNonCompliantPeople(people, '')).toEqual(people);
    expect(filterNonCompliantPeople(people, '  ')).toEqual(people);
    expect(filterNonCompliantPeople(people, 'a-01')).toEqual([people[0]]);
    expect(filterNonCompliantPeople(people, ' ALICE ')).toEqual([people[0]]);
    expect(filterNonCompliantPeople(people, 'operator')).toEqual([people[0]]);
    expect(filterNonCompliantPeople(people, 'HIGH VOLTAGE')).toEqual([
      people[0],
    ]);
    expect(filterNonCompliantPeople(people, 'missing')).toEqual([]);
  });
});
