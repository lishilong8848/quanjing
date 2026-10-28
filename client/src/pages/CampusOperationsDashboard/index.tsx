import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  checkMonthlyScheduleScreenshotAccess,
  getCampusOperationsDashboard,
} from '../../api';
import type {
  CampusOperationsBuildingMetric,
  CampusOperationsDashboardResponse,
  CampusOperationsShiftTarget,
  CampusOperationsTransformerRow,
} from '@shared/api.interface';
import { resolvePreviousCampusOperationsShift } from '@shared/campus-operations-shift';
import { getGlobalNavigationViewportHeight } from '@/navigation/global-navigation-layout';

const MIN_STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 768;
const CAMPUS_OPS_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const TRANSFORMER_SOURCE_NAME = '05-110站数据汇总';
const MACHINE_SOURCE_NAME = '交接班机柜数量引用';

export interface CampusOperationsScreenshotAccessPayload {
  screenshotDate: string | null;
  screenshotShift: 'white' | 'night' | null;
  screenshotToken: string | null;
}

type MetricTone = 'blue' | 'cyan' | 'green';
type MetricIcon = 'power' | 'trend' | 'server' | 'gauge';
type SyncStatus = 'idle' | 'syncing' | 'error';
type SyncNoticeTone = 'neutral' | 'success' | 'error';

interface MetricCardData {
  title: string;
  value: string;
  tone: MetricTone;
  icon: MetricIcon;
  sparkline: number[];
}

interface TransformerRow extends CampusOperationsTransformerRow {
  name: string;
  line: string;
  oilTemp: number;
  gear: number;
  load: number;
  current: string;
  loadRate: string;
  status: string;
}

interface BuildingMetric extends CampusOperationsBuildingMetric {
  building: string;
  totalPower: number;
  pue: number;
  itPower: number;
  itDesignPower: number;
  itLoad: number;
}

interface TopologyFeeder {
  x: number;
  building: string;
  section: string;
  loadLines: [string, string, string];
}

interface TopologyTransformer {
  x: number;
  label: string;
  loadKw: number;
  loadRate: string;
  busStart: number;
  busEnd: number;
  feeders: TopologyFeeder[];
}

const metricCards: MetricCardData[] = [
  {
    title: '总功率（KW）',
    value: '39,032',
    tone: 'blue',
    icon: 'power',
    sparkline: [10, 22, 20, 36, 34, 52, 40, 58, 46, 70, 38],
  },
  {
    title: 'PUE',
    value: '1.24',
    tone: 'cyan',
    icon: 'trend',
    sparkline: [9, 18, 17, 30, 29, 48, 37, 57, 50, 72, 42],
  },
  {
    title: 'IT总功率（KW）',
    value: '31,430',
    tone: 'blue',
    icon: 'server',
    sparkline: [12, 26, 24, 41, 39, 60, 48, 66, 54, 78, 45],
  },
  {
    title: 'IT负载率',
    value: '60.91%',
    tone: 'green',
    icon: 'gauge',
    sparkline: [9, 17, 22, 21, 33, 28, 45, 36, 58, 46, 73],
  },
];

const fallbackTransformerRows: TransformerRow[] = [
  {
    name: '1号主变',
    line: '阿开线',
    oilTemp: 54,
    gear: 3,
    load: 15250,
    current: '846.21',
    loadRate: '30.50%',
    status: '正常',
  },
  {
    name: '2号主变',
    line: '阿开线',
    oilTemp: 47,
    gear: 3,
    load: 7230,
    current: '399.8',
    loadRate: '14.61%',
    status: '正常',
  },
  {
    name: '3号主变',
    line: '阿家线',
    oilTemp: 47,
    gear: 4,
    load: 6460,
    current: '350.86',
    loadRate: '13.05%',
    status: '正常',
  },
  {
    name: '4号主变',
    line: '阿家线',
    oilTemp: 56,
    gear: 4,
    load: 14270,
    current: '782.02',
    loadRate: '28.54%',
    status: '正常',
  },
];

const fallbackBuildingMetrics: BuildingMetric[] = [
  { building: 'A楼', totalPower: 11493, pue: 1.23, itPower: 9294, itDesignPower: 12900, itLoad: 72.05 },
  { building: 'B楼', totalPower: 11298.63, pue: 1.23, itPower: 9124.42, itDesignPower: 12900, itLoad: 70.73 },
  { building: 'C楼', totalPower: 11456, pue: 1.22, itPower: 9306.89, itDesignPower: 12900, itLoad: 72.15 },
  { building: 'D楼', totalPower: 4784, pue: 1.28, itPower: 3704.23, itDesignPower: 12900, itLoad: 28.71 },
  { building: 'E楼', totalPower: 2816, pue: 1.7, itPower: 1651.23, itDesignPower: 14100, itLoad: 12.8 },
];

const topologyTransformers: TopologyTransformer[] = [
  {
    x: 175,
    label: '1#',
    loadKw: 15250,
    loadRate: '30.50%',
    busStart: 35,
    busEnd: 315,
    feeders: [
      { x: 58, building: 'A楼', section: '一段', loadLines: ['冷机', '1、2', '#主'] },
      { x: 118, building: 'A楼', section: '三段', loadLines: ['冷机', '4、5', '#主'] },
      { x: 178, building: 'B楼', section: '一段', loadLines: ['冷机', '1、2', '#主'] },
      { x: 238, building: 'B楼', section: '三段', loadLines: ['冷机', '4、5', '#主'] },
      { x: 298, building: 'C楼', section: '一段', loadLines: ['冷机', '1、2', '#主'] },
    ],
  },
  {
    x: 470,
    label: '2#',
    loadKw: 7230,
    loadRate: '14.61%',
    busStart: 350,
    busEnd: 620,
    feeders: [
      { x: 370, building: 'D楼', section: '一段', loadLines: ['冷机', '1、2', '#主'] },
      { x: 430, building: 'D楼', section: '三段', loadLines: ['冷机', '4、5', '#主'] },
      { x: 490, building: 'E楼', section: '一段', loadLines: ['冷机', '1、2', '#主'] },
      { x: 550, building: 'E楼', section: '三段', loadLines: ['冷机', '4、5', '#主'] },
      { x: 610, building: 'C楼', section: '三段', loadLines: ['冷机', '1、2', '#主'] },
    ],
  },
  {
    x: 790,
    label: '3#',
    loadKw: 6460,
    loadRate: '13.05%',
    busStart: 680,
    busEnd: 940,
    feeders: [
      { x: 690, building: 'D楼', section: '二段', loadLines: ['冷机', '3、2', '#备'] },
      { x: 750, building: 'D楼', section: '四段', loadLines: ['冷机', '6、5', '#备'] },
      { x: 810, building: 'E楼', section: '二段', loadLines: ['冷机', '3、2', '#备'] },
      { x: 870, building: 'E楼', section: '四段', loadLines: ['冷机', '6、5', '#备'] },
      { x: 930, building: 'C楼', section: '四段', loadLines: ['冷机', '3、2', '#备'] },
    ],
  },
  {
    x: 1095,
    label: '4#',
    loadKw: 14270,
    loadRate: '28.54%',
    busStart: 980,
    busEnd: 1240,
    feeders: [
      { x: 1000, building: 'A楼', section: '二段', loadLines: ['冷机', '3、2', '#备'] },
      { x: 1060, building: 'A楼', section: '四段', loadLines: ['冷机', '6、5', '#备'] },
      { x: 1120, building: 'B楼', section: '二段', loadLines: ['冷机', '3、2', '#备'] },
      { x: 1180, building: 'B楼', section: '四段', loadLines: ['冷机', '6、5', '#备'] },
      { x: 1240, building: 'C楼', section: '二段', loadLines: ['冷机', '3、2', '#备'] },
    ],
  },
];

function buildTopologyTransformers(rows: TransformerRow[]): TopologyTransformer[] {
  const rowMap = new Map(rows.map((row) => [row.name, row]));

  return topologyTransformers.map((item) => {
    const transformerName = `${item.label.replace('#', '')}号主变`;
    const row = rowMap.get(transformerName);
    return {
      ...item,
      loadKw: row?.load ?? item.loadKw,
      loadRate: row?.loadRate ?? item.loadRate,
    };
  });
}

function useStageLayout() {
  const [layout, setLayout] = useState({ scale: 1, width: MIN_STAGE_WIDTH });

  useEffect(() => {
    const updateLayout = () => {
      const widthScale = window.innerWidth / MIN_STAGE_WIDTH;
      const heightScale =
        getGlobalNavigationViewportHeight(window.innerHeight) / STAGE_HEIGHT;
      const scale = Math.min(1, widthScale, heightScale);
      const isWidthLimited = widthScale <= heightScale && widthScale < 1;
      const width = isWidthLimited
        ? MIN_STAGE_WIDTH
        : Math.max(MIN_STAGE_WIDTH, Math.ceil(window.innerWidth / scale));
      setLayout({ scale, width });
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);
    return () => window.removeEventListener('resize', updateLayout);
  }, []);

  return layout;
}

function formatMetric(value: number): string {
  return String(Math.round(value));
}

function formatMw(valueKw: number): string {
  return `${(valueKw / 1000).toFixed(2)}MW`;
}

function getLoadRateTone(loadRate: string): 'high' | 'medium' | 'low' {
  const value = Number.parseFloat(loadRate.replace('%', ''));
  if (!Number.isFinite(value)) {
    return 'low';
  }
  if (value >= 25) {
    return 'high';
  }
  if (value >= 15) {
    return 'medium';
  }
  return 'low';
}

function formatSyncTime(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSourceDate(value: string | null | undefined): string {
  if (!value) {
    return '--';
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return value;
  }
  return `${match[2]}/${match[3]}`;
}

function formatDataSourceText(target: CampusOperationsShiftTarget | null | undefined): string {
  const sourceNames = `${TRANSFORMER_SOURCE_NAME}、${MACHINE_SOURCE_NAME}`;
  if (!target) {
    return `数据来源：${sourceNames}`;
  }

  const transformerSource = `${formatSourceDate(target.transformerDate)} ${target.transformerShift || '--'}`;
  const machineSource = `${formatSourceDate(target.machineDate)} ${target.machineShift || '--'}`;

  if (transformerSource === machineSource) {
    return `数据来源：${sourceNames} · ${transformerSource}`;
  }

  return `数据来源：${TRANSFORMER_SOURCE_NAME} ${transformerSource} · ${MACHINE_SOURCE_NAME} ${machineSource}`;
}

function getTransformerOrder(name: string): number {
  return Number(name.match(/\d+/)?.[0] || 99);
}

function getBuildingOrder(building: string): number {
  const order = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].indexOf(building);
  return order === -1 ? 99 : order;
}

function mergeTransformerRows(rows: CampusOperationsTransformerRow[] = []): TransformerRow[] {
  if (rows.length === 0) {
    return fallbackTransformerRows;
  }

  const incoming = new Map(rows.map((row) => [row.name, row]));
  const merged = fallbackTransformerRows.map((fallback) => ({
    ...fallback,
    ...incoming.get(fallback.name),
    status: incoming.get(fallback.name)?.status || fallback.status,
  }));
  const extras = rows
    .filter((row) => !fallbackTransformerRows.some((fallback) => fallback.name === row.name))
    .sort((a, b) => getTransformerOrder(a.name) - getTransformerOrder(b.name));

  return [...merged, ...extras];
}

function mergeBuildingMetrics(rows: CampusOperationsBuildingMetric[] = []): BuildingMetric[] {
  if (rows.length === 0) {
    return fallbackBuildingMetrics;
  }

  const incoming = new Map(rows.map((row) => [row.building, row]));
  const merged = fallbackBuildingMetrics.map((fallback) => ({
    ...fallback,
    ...incoming.get(fallback.building),
  }));
  const extras = rows
    .filter((row) => !fallbackBuildingMetrics.some((fallback) => fallback.building === row.building))
    .sort((a, b) => getBuildingOrder(a.building) - getBuildingOrder(b.building));

  return [...merged, ...extras];
}

function normalizeDashboardData(
  response: CampusOperationsDashboardResponse | null,
  allowFallback = true,
): {
  transformerRows: TransformerRow[];
  buildingMetrics: BuildingMetric[];
} {
  if (!allowFallback) {
    return {
      transformerRows: [...(response?.transformerRows || [])].sort(
        (a, b) => getTransformerOrder(a.name) - getTransformerOrder(b.name),
      ),
      buildingMetrics: [...(response?.buildingMetrics || [])].sort(
        (a, b) => getBuildingOrder(a.building) - getBuildingOrder(b.building),
      ),
    };
  }

  return {
    transformerRows: mergeTransformerRows(response?.transformerRows),
    buildingMetrics: mergeBuildingMetrics(response?.buildingMetrics),
  };
}

export function createCampusOperationsInitialViewState(screenshotMode: boolean) {
  return {
    syncStatus: (screenshotMode ? 'syncing' : 'idle') as SyncStatus,
    hasExactScreenshotData: false,
    dashboardData: normalizeDashboardData(null, !screenshotMode),
  };
}

export function isCampusOperationsScreenshotReady(
  syncStatus: SyncStatus,
  screenshotMode: boolean,
  hasExactScreenshotData: boolean,
): boolean {
  return (
    syncStatus === 'idle' &&
    (!screenshotMode || hasExactScreenshotData)
  );
}

export function hasExactCampusOperationsScreenshotData(
  response: CampusOperationsDashboardResponse,
  screenshotAccess?: CampusOperationsScreenshotAccessPayload,
): boolean {
  const screenshotDate = screenshotAccess?.screenshotDate?.trim();
  const screenshotShift = screenshotAccess?.screenshotShift;
  if (!screenshotDate || !screenshotShift) {
    return false;
  }

  const expectedSource = resolvePreviousCampusOperationsShift(
    screenshotDate,
    screenshotShift,
  );
  if (!expectedSource) {
    return false;
  }
  const expectedShift = expectedSource.shiftLabel;
  const target = response.target;
  if (
    target.requestedDate !== expectedSource.date ||
    target.requestedShift !== expectedShift ||
    target.transformerDate !== expectedSource.date ||
    target.transformerShift !== expectedShift ||
    target.machineDate !== expectedSource.date ||
    target.machineShift !== expectedShift
  ) {
    return false;
  }

  const transformerNames = new Set(
    response.transformerRows.map((row) => row.name),
  );
  const buildingNames = new Set(
    response.buildingMetrics.map((row) => row.building),
  );
  return (
    ['1号主变', '2号主变', '3号主变', '4号主变'].every((name) =>
      transformerNames.has(name),
    ) &&
    ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].every((building) =>
      buildingNames.has(building),
    )
  );
}

function buildSparklinePath(points: number[]) {
  const width = 122;
  const height = 43;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function TechCircuit() {
  return (
    <svg className="campus-ops-tech-circuit" viewBox="0 0 1400 120" aria-hidden="true">
      <path d="M0 88H205L225 88" />
      <circle cx="225" cy="88" r="5" />
      <path d="M230 88H350L382 62H890L910 42H1040" />
      <path d="M910 42H1040L1060 28H1216" />
      <path d="M1054 72H1087L1112 46H1168L1193 72H1300" />
      <path d="M1114 62V42M1166 62V42" />
      <circle cx="1040" cy="28" r="4" />
      <circle cx="1072" cy="28" r="4" />
      <circle cx="1092" cy="75" r="4" />
      <circle cx="1120" cy="42" r="4" />
      <circle cx="1146" cy="42" r="4" />
      <circle cx="1225" cy="72" r="4" />
    </svg>
  );
}

function DotMatrix() {
  const dots = Array.from({ length: 9 * 18 }, (_, index) => index);

  return (
    <div className="campus-ops-dot-matrix" aria-hidden="true">
      {dots.map((dot) => (
        <span key={dot} />
      ))}
    </div>
  );
}

function MetricIconSvg({ icon }: { icon: MetricIcon }) {
  if (icon === 'power') {
    return (
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <path d="M43 8 19 42h18l-6 26 27-38H40z" />
      </svg>
    );
  }

  if (icon === 'trend') {
    return (
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <path className="stroke-only" d="M17 55H61" />
        <path className="stroke-only" d="M18 55V20" />
        <path className="stroke-only" d="M25 45 36 34l9 8 16-20" />
        <path className="stroke-only" d="M55 22h6v6" />
      </svg>
    );
  }

  if (icon === 'server') {
    return (
      <svg viewBox="0 0 76 76" aria-hidden="true">
        {[20, 36, 52].map((y) => (
          <g key={y}>
            <rect x="16" y={y - 7} width="44" height="11" rx="2" />
            <circle cx="25" cy={y - 1.5} r="2" className="cutout" />
            <path className="cutout-line" d={`M34 ${y - 2}H52`} />
          </g>
        ))}
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 76 76" aria-hidden="true">
      <path
        className="stroke-only"
        d="M18 44a20 20 0 1 1 40 0"
      />
      <path className="stroke-only" d="M24 50h28" />
      <path className="stroke-only" d="M38 43 49 27" />
      <circle cx="38" cy="43" r="4" />
      <path className="tick" d="M23 42h5M28 30l4 3M38 23v6M50 30l-4 3M53 42h5" />
    </svg>
  );
}

function MetricCard({ item }: { item: MetricCardData }) {
  const path = buildSparklinePath(item.sparkline);

  return (
    <article className={`campus-ops-metric-card campus-ops-${item.tone}`}>
      <div className="campus-ops-metric-icon">
        <MetricIconSvg icon={item.icon} />
      </div>
      <div className="campus-ops-metric-copy">
        <h2>{item.title}</h2>
        <strong>{item.value}</strong>
      </div>
      <svg className="campus-ops-sparkline" viewBox="0 0 130 52" aria-hidden="true">
        <path d={path} />
        <circle cx="122" cy="7" r="2.8" />
        <circle cx="122" cy="28" r="2" />
      </svg>
    </article>
  );
}

function TransformerIcon({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? 'campus-ops-transformer-icon compact' : 'campus-ops-transformer-icon'}
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      <path d="M24 5v9" />
      <path d="M14 17h20M17 14h14" />
      <path d="M18 17 11 42M30 17l7 25M14 27h20M10 42h28" />
      <path d="M20 22h8v8h-8z" />
      <path d="M17 34h14" />
      <circle cx="24" cy="9" r="2.5" />
    </svg>
  );
}

function PanelTitle({
  icon,
  title,
}: {
  icon: 'substation' | 'info';
  title: string;
}) {
  return (
    <div className="campus-ops-panel-title">
      {icon === 'substation' ? (
        <TransformerIcon compact />
      ) : (
        <svg className="campus-ops-info-icon" viewBox="0 0 32 32" aria-hidden="true">
          <rect x="5" y="4" width="22" height="24" rx="2" />
          <path d="M11 11h3M18 11h4M11 16h3M18 16h4M11 21h3M18 21h4" />
        </svg>
      )}
      <h2>{title}</h2>
    </div>
  );
}

function TransformerTable({
  rows,
  onOpenTopology,
}: {
  rows: TransformerRow[];
  onOpenTopology: () => void;
}) {
  return (
    <section className="campus-ops-panel campus-ops-transformer-panel">
      <button
        type="button"
        className="campus-ops-panel-title campus-ops-panel-title-button"
        aria-haspopup="dialog"
        onClick={onOpenTopology}
      >
        <TransformerIcon compact />
        <h2>110站主变运行状态</h2>
      </button>
      <div className="campus-ops-transformer-head" aria-hidden="true">
        <span />
        <span>线路</span>
        <span>油温(℃)</span>
        <span>档位</span>
        <span>负载（KW）</span>
        <span>电流（A）</span>
        <span>负载率</span>
        <span>GIS/压力</span>
      </div>
      <div className="campus-ops-transformer-rows">
        {rows.map((row) => (
          <article className="campus-ops-transformer-row" key={row.name}>
            <div className="campus-ops-transformer-name">
              <TransformerIcon />
              <strong>{row.name}</strong>
            </div>
            <span>{row.line}</span>
            <span>{row.oilTemp}</span>
            <span>{row.gear}</span>
            <span>{row.load}</span>
            <span>{row.current}</span>
            <div className="campus-ops-rate-cell">
              <em>{row.loadRate}</em>
              <span className="campus-ops-rate-track">
                <span style={{ width: row.loadRate }} />
              </span>
            </div>
            <span className="campus-ops-normal-badge">{row.status}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function ChartLegend() {
  return (
    <div className="campus-ops-chart-legend" aria-hidden="true">
      <span><i className="bar total" />总功率 (KW)</span>
      <span><i className="bar it" />IT总功率 (KW)</span>
      <span><i className="line pue" />PUE</span>
      <span><i className="line load" />IT负载率</span>
    </div>
  );
}

function OperationsChart({ metrics }: { metrics: BuildingMetric[] }) {
  const chart = useMemo(() => {
    const left = 45;
    const top = 28;
    const width = 900;
    const height = 200;
    const maxKw = 16000;
    const step = width / metrics.length;
    const barWidth = 31;
    const labelOffsets = [
      { totalX: 0, totalY: -8, itX: 0, itY: -8, loadX: 0, loadY: -30, pueX: 0, pueY: -22 },
      { totalX: 0, totalY: -8, itX: 0, itY: -8, loadX: 0, loadY: -30, pueX: 0, pueY: -22 },
      { totalX: 0, totalY: -8, itX: 0, itY: -8, loadX: 0, loadY: -30, pueX: 0, pueY: -22 },
      { totalX: -4, totalY: -14, itX: 17, itY: -10, loadX: -8, loadY: -42, pueX: -14, pueY: -20 },
      { totalX: -14, totalY: -10, itX: 18, itY: -10, loadX: -28, loadY: -36, pueX: 14, pueY: -24 },
    ];

    return metrics.map((item, index) => {
      const center = left + step * index + step / 2;
      const totalHeight = (item.totalPower / maxKw) * height;
      const itHeight = (item.itPower / maxKw) * height;
      const offsets = labelOffsets[index];
      const pueY = top + height - ((item.pue - 1) / 1) * 88 - 8;
      const loadY = top + height - (item.itLoad / 100) * height;
      return {
        ...item,
        x: center,
        totalX: center - 31,
        itX: center + 8,
        totalY: top + height - totalHeight,
        itY: top + height - itHeight,
        totalHeight,
        itHeight,
        barWidth,
        totalLabelX: center - 31 + barWidth / 2 + offsets.totalX,
        totalLabelY: top + height - totalHeight + offsets.totalY,
        itLabelX: center + 8 + barWidth / 2 + offsets.itX,
        itLabelY: top + height - itHeight + offsets.itY,
        pueY,
        loadY,
        loadLabelX: center + offsets.loadX,
        loadLabelY: loadY + offsets.loadY,
        pueLabelX: center + offsets.pueX,
        pueLabelY: pueY + offsets.pueY,
      };
    });
  }, [metrics]);

  const puePath = chart.map((item, index) => `${index === 0 ? 'M' : 'L'} ${item.x} ${item.pueY}`).join(' ');
  const loadPath = chart.map((item, index) => `${index === 0 ? 'M' : 'L'} ${item.x} ${item.loadY}`).join(' ');

  return (
    <svg className="campus-ops-chart" viewBox="0 0 980 260" aria-hidden="true">
      <defs>
        <linearGradient id="campusOpsBarBlue" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#0876ff" />
          <stop offset="100%" stopColor="#0d54d9" />
        </linearGradient>
        <linearGradient id="campusOpsBarCyan" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#10c4db" />
          <stop offset="100%" stopColor="#08a4c9" />
        </linearGradient>
      </defs>

      <line x1="36" x2="944" y1="228" y2="228" className="x-axis-line" />

      {chart.map((item) => (
        <g key={item.building}>
          <rect
            x={item.totalX}
            y={item.totalY}
            width={item.barWidth}
            height={item.totalHeight}
            rx="2"
            fill="url(#campusOpsBarBlue)"
          />
          <rect
            x={item.itX}
            y={item.itY}
            width={item.barWidth}
            height={item.itHeight}
            rx="2"
            fill="url(#campusOpsBarCyan)"
          />
          <text x={item.x} y="254" textAnchor="middle" className="category-label">
            {item.building}
          </text>
        </g>
      ))}

      <path d={loadPath} className="load-line" />
      <path d={puePath} className="pue-line" />

      {chart.map((item) => (
        <g key={`${item.building}-lines`}>
          <circle cx={item.x} cy={item.loadY} r="6" className="load-dot" />
          <circle cx={item.x} cy={item.pueY} r="6" className="pue-dot" />
        </g>
      ))}

      {chart.map((item) => (
        <g key={`${item.building}-labels`}>
          <text x={item.totalLabelX} y={item.totalLabelY} textAnchor="middle" className="bar-label blue">
            {formatMetric(item.totalPower)}
          </text>
          <text x={item.itLabelX} y={item.itLabelY} textAnchor="middle" className="bar-label cyan">
            {formatMetric(item.itPower)}
          </text>
          <text x={item.loadLabelX} y={item.loadLabelY} textAnchor="middle" className="load-label">
            {item.itLoad.toFixed(2)}%
          </text>
          <text x={item.pueLabelX} y={item.pueLabelY} textAnchor="middle" className="pue-label">
            {item.pue.toFixed(2)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function BuildingMetricsTable({ metrics }: { metrics: BuildingMetric[] }) {
  return (
    <table className="campus-ops-building-table">
      <colgroup>
        <col className="building-col" />
        <col className="power-col" />
        <col className="pue-col" />
        <col className="power-col" />
        <col className="design-power-col" />
        <col className="load-col" />
      </colgroup>
      <thead>
        <tr>
          <th>楼栋</th>
          <th>总功率（KW）</th>
          <th>PUE</th>
          <th>IT总功率（KW）</th>
          <th>IT设计总负荷（KW）</th>
          <th>IT负载率</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((item) => (
          <tr key={item.building}>
            <td>{item.building}</td>
            <td>{formatMetric(item.totalPower)}</td>
            <td>{item.pue.toFixed(2)}</td>
            <td>{formatMetric(item.itPower)}</td>
            <td>{formatMetric(item.itDesignPower)}</td>
            <td>{item.itLoad.toFixed(2)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SyncButton({
  status,
  lastUpdated,
  errorMessage,
  onRefresh,
}: {
  status: SyncStatus;
  lastUpdated: string | null;
  errorMessage: string | null;
  onRefresh: () => void;
}) {
  const canRefresh = canUsePageAction(useAccess(), 'campus_operations', 'refresh', true);
  const syncTime = formatSyncTime(lastUpdated);
  const title =
    status === 'error'
      ? `同步失败，点击重试${errorMessage ? `：${errorMessage}` : ''}`
      : syncTime
        ? `手动同步，上次同步 ${syncTime}`
        : '手动同步';

  return (
    <button
      type="button"
      className={`campus-ops-sync-button${status === 'syncing' ? ' is-syncing' : ''}${status === 'error' ? ' is-error' : ''}`}
      aria-label={title}
      title={title}
      disabled={status === 'syncing' || !canRefresh}
      onClick={onRefresh}
    >
      <RefreshCw aria-hidden="true" />
      <span className="campus-ops-sr-only">手动同步</span>
    </button>
  );
}

function SyncStatusFooter({
  status,
  lastUpdated,
  errorMessage,
  sourceText,
  notice,
  onRefresh,
}: {
  status: SyncStatus;
  lastUpdated: string | null;
  errorMessage: string | null;
  sourceText: string;
  notice: { text: string; tone: SyncNoticeTone } | null;
  onRefresh: () => void;
}) {
  const syncTime = formatSyncTime(lastUpdated);
  const timeText = status === 'syncing'
    ? '最近同步：同步中...'
    : status === 'error'
      ? `最近同步：同步失败${syncTime ? `，上次 ${syncTime}` : ''}`
      : `最近同步：${syncTime || '--'}`;

  return (
    <div className="campus-ops-sync-footer">
      <SyncButton
        status={status}
        lastUpdated={lastUpdated}
        errorMessage={errorMessage}
        onRefresh={onRefresh}
      />
      <span className={notice ? `campus-ops-sync-notice is-${notice.tone}` : undefined}>
        {notice?.text || timeText}
      </span>
      <span className="campus-ops-sync-divider" aria-hidden="true" />
      <span>{sourceText}</span>
    </div>
  );
}

function MachineInfoPanel({
  metrics,
}: {
  metrics: BuildingMetric[];
}) {
  return (
    <section className="campus-ops-panel campus-ops-machine-panel">
      <div className="campus-ops-machine-head">
        <PanelTitle icon="info" title="机房运行信息" />
        <ChartLegend />
      </div>
      <OperationsChart metrics={metrics} />
      <BuildingMetricsTable metrics={metrics} />
    </section>
  );
}

function TopologyTextBox({
  x,
  y,
  width,
  height,
  lines,
  className = '',
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  className?: string;
}) {
  const lineHeight = lines.length > 2 ? 17 : 19;
  const firstLineY = y + height / 2 - ((lines.length - 1) * lineHeight) / 2 + 5;

  return (
    <g className={className}>
      <rect x={x} y={y} width={width} height={height} rx="6" />
      <text x={x + width / 2} y={firstLineY} textAnchor="middle">
        {lines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={x + width / 2} dy={index === 0 ? 0 : lineHeight}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function TopologyFeederBranch({ feeder }: { feeder: TopologyFeeder }) {
  const buildingBox = { x: feeder.x - 25, y: 289, width: 50, height: 67 };
  const loadBox = { x: feeder.x - 25, y: 389, width: 50, height: 70 };

  return (
    <g className="campus-ops-topology-feeder">
      <line x1={feeder.x} x2={feeder.x} y1="250" y2="289" className="topology-outgoing topology-10kv-line" />
      <circle cx={feeder.x} cy="250" r="3" className="topology-dot topology-10kv-dot" />
      <circle cx={feeder.x} cy="275" r="3" className="topology-dot topology-10kv-dot" />
      <TopologyTextBox
        x={buildingBox.x}
        y={buildingBox.y}
        width={buildingBox.width}
        height={buildingBox.height}
        lines={[feeder.building, feeder.section]}
        className="topology-building-box"
      />
      <line x1={feeder.x} x2={feeder.x} y1="356" y2="389" className="topology-outgoing topology-400v-line" />
      <circle cx={feeder.x} cy="374" r="3" className="topology-dot topology-400v-dot" />
      <TopologyTextBox
        x={loadBox.x}
        y={loadBox.y}
        width={loadBox.width}
        height={loadBox.height}
        lines={feeder.loadLines}
        className="topology-load-box"
      />
    </g>
  );
}

function TopologyTransformerUnit({ item }: { item: TopologyTransformer }) {
  const loadRateTone = getLoadRateTone(item.loadRate);

  return (
    <g className="campus-ops-topology-transformer">
      <line x1={item.x} x2={item.x} y1="92" y2="134" className="topology-connection topology-110kv-line" />
      <circle cx={item.x} cy="92" r="3.4" className="topology-dot" />
      <circle cx={item.x} cy="142" r="16" className="topology-switch-circle" />
      <text x={item.x} y="147" textAnchor="middle" className="topology-switch-label">
        {item.label}
      </text>
      <line x1={item.x} x2={item.x} y1="158" y2="176" className="topology-connection topology-110kv-line" />
      <circle cx={item.x} cy="194" r="27" className="topology-transformer-circle" />
      <text x={item.x} y="204" textAnchor="middle" className="topology-transformer-symbol">
        3ξ
      </text>
      <g className={`topology-transformer-metric is-${loadRateTone}`} transform={`translate(${item.x + 36} 177)`}>
        <rect x="0" y="0" width="98" height="40" rx="7" />
        <text x="49" y="16" textAnchor="middle">
          <tspan className="topology-transformer-metric-label">负荷 </tspan>
          <tspan className="topology-transformer-power-value">{formatMw(item.loadKw)}</tspan>
        </text>
        <text x="49" y="32" textAnchor="middle">
          <tspan className="topology-transformer-metric-label">负载率 </tspan>
          <tspan className="topology-transformer-rate-value">{item.loadRate}</tspan>
        </text>
      </g>
      <line x1={item.x} x2={item.x} y1="221" y2="250" className="topology-connection topology-10kv-line" />
      <polygon points={`${item.x - 7},239 ${item.x + 7},239 ${item.x},253`} className="topology-arrow topology-10kv-arrow" />
      <line x1={item.busStart} x2={item.busEnd} y1="250" y2="250" className="topology-bus topology-bus-10kv" />
      {item.feeders.map((feeder) => (
        <TopologyFeederBranch feeder={feeder} key={`${feeder.building}-${feeder.section}-${feeder.x}`} />
      ))}
    </g>
  );
}

function TopologyIncoming({ x, label }: { x: number; label: string }) {
  return (
    <g className="campus-ops-topology-incoming">
      <rect x={x - 48} y="14" width="96" height="36" rx="5" />
      <text x={x} y="38" textAnchor="middle">{label}</text>
      <line x1={x} x2={x} y1="50" y2="84" className="topology-connection" />
      <polygon points={`${x - 7},80 ${x + 7},80 ${x},94`} className="topology-arrow" />
    </g>
  );
}

function TopologyContactLabel({ x, y }: { x: number; y: number }) {
  return (
    <g className="campus-ops-topology-contact">
      <rect x={x - 24} y={y - 13} width="48" height="26" rx="8" />
      <text x={x} y={y + 5} textAnchor="middle">联络</text>
    </g>
  );
}

function TopologyOpenTie({
  x1,
  x2,
  y,
  className = '',
}: {
  x1: number;
  x2: number;
  y: number;
  className?: string;
}) {
  const mid = (x1 + x2) / 2;
  const leftContact = mid - 16;
  const rightContact = mid + 16;

  return (
    <g className={`campus-ops-topology-open-tie ${className}`}>
      <line x1={x1} x2={leftContact} y1={y} y2={y} className="topology-open-tie-line" />
      <line x1={rightContact} x2={x2} y1={y} y2={y} className="topology-open-tie-line" />
      <circle cx={leftContact} cy={y} r="3.4" className="topology-open-tie-contact" />
      <circle cx={rightContact} cy={y} r="3.4" className="topology-open-tie-contact" />
      <line
        x1={leftContact + 4}
        x2={rightContact - 3}
        y1={y - 3}
        y2={y - 15}
        className="topology-open-tie-blade"
      />
    </g>
  );
}

function TopologyVerticalOpenTie({
  x,
  y1,
  y2,
  bladeDirection = 'right',
  className = '',
}: {
  x: number;
  y1: number;
  y2: number;
  bladeDirection?: 'left' | 'right';
  className?: string;
}) {
  const mid = (y1 + y2) / 2;
  const topContact = mid - 15;
  const bottomContact = mid + 15;
  const bladeOffset = bladeDirection === 'left' ? -1 : 1;

  return (
    <g className={`campus-ops-topology-open-tie ${className}`}>
      <line x1={x} x2={x} y1={y1} y2={topContact} className="topology-open-tie-line" />
      <line x1={x} x2={x} y1={bottomContact} y2={y2} className="topology-open-tie-line" />
      <circle cx={x} cy={topContact} r="3.4" className="topology-open-tie-contact" />
      <circle cx={x} cy={bottomContact} r="3.4" className="topology-open-tie-contact" />
      <line
        x1={x + 3 * bladeOffset}
        x2={x + 15 * bladeOffset}
        y1={topContact + 4}
        y2={bottomContact - 4}
        className="topology-open-tie-blade"
      />
    </g>
  );
}

function TopologyBusTie({
  x1,
  x2,
  y,
  labelY,
}: {
  x1: number;
  x2: number;
  y: number;
  labelY: number;
}) {
  const x = (x1 + x2) / 2;

  return (
    <>
      <TopologyOpenTie x1={x1} x2={x2} y={y} className="topology-open-tie-10kv" />
      <TopologyContactLabel x={x} y={labelY} />
    </>
  );
}

function TopologyLongBusTie() {
  return (
    <g className="campus-ops-topology-long-bus-tie">
      <path d="M35 250 H18 V332" className="topology-10kv-line topology-long-bus-tie-path" />
      <TopologyVerticalOpenTie
        x={18}
        y1={332}
        y2={392}
        bladeDirection="left"
        className="topology-open-tie-10kv topology-long-bus-tie-switch"
      />
      <path d="M18 392 V462 H1292 V250 H1240" className="topology-10kv-line topology-long-bus-tie-path" />
    </g>
  );
}

function TopologyLegend() {
  return (
    <g className="campus-ops-topology-legend">
      <rect x="20" y="464" width="1208" height="44" rx="7" className="topology-legend-frame" />
      <line x1="68" x2="118" y1="486" y2="486" className="topology-bus topology-bus-110 legend-bus" />
      <text x="138" y="491">110KV母线</text>
      <circle cx="238" cy="486" r="13" className="topology-transformer-circle" />
      <text x="238" y="491" textAnchor="middle" className="topology-legend-symbol">3ξ</text>
      <text x="260" y="491">变压器</text>
      <line x1="346" x2="396" y1="486" y2="486" className="topology-bus topology-bus-10kv legend-outgoing" />
      <text x="416" y="491">10KV母线</text>
      <line x1="506" x2="556" y1="486" y2="486" className="topology-bus topology-bus-400v legend-outgoing" />
      <text x="576" y="491">400V低压母线</text>
      <TopologyOpenTie x1={720} x2={775} y={486} className="topology-legend-open-tie" />
      <text x="795" y="491">联络开关（断开）</text>
      <rect x="915" y="474" width="34" height="25" rx="4" className="topology-building-legend-box" />
      <text x="963" y="491">楼栋分段</text>
      <rect x="1030" y="474" width="34" height="25" rx="4" className="topology-load-legend-box" />
      <text x="1078" y="491">冷机负载</text>
    </g>
  );
}

function TransformerTopologyModal({
  rows,
  onClose,
}: {
  rows: TransformerRow[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const topologyItems = useMemo(() => buildTopologyTransformers(rows), [rows]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const stopDialogClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="campus-ops-topology-overlay" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="campus-ops-topology-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campus-ops-topology-title"
        tabIndex={-1}
        onMouseDown={stopDialogClick}
        onKeyDown={handleDialogKeyDown}
      >
        <h2 className="campus-ops-topology-title" id="campus-ops-topology-title">
          110站主变运行拓扑
        </h2>
        <svg className="campus-ops-topology-svg" viewBox="0 0 1260 520" aria-hidden="true">
          <TopologyIncoming x={315} label="阿开8L4" />
          <TopologyIncoming x={955} label="阿家866" />
          <line x1="40" x2="575" y1="92" y2="92" className="topology-bus topology-bus-110 topology-main-bus" />
          <line x1="680" x2="1220" y1="92" y2="92" className="topology-bus topology-bus-110 topology-main-bus" />
          <TopologyOpenTie x1={575} x2={680} y={92} className="topology-open-tie-110" />
          <TopologyContactLabel x={630} y={62} />
          <TopologyLongBusTie />
          {topologyItems.map((item) => (
            <TopologyTransformerUnit item={item} key={item.label} />
          ))}
          <TopologyBusTie x1={620} x2={680} y={250} labelY={220} />
          <TopologyLegend />
        </svg>
      </div>
    </div>
  );
}

function DataSourceIcon() {
  return (
    <svg className="campus-ops-source-icon" viewBox="0 0 32 32" aria-hidden="true">
      <ellipse cx="16" cy="7" rx="10" ry="4" />
      <path d="M6 7v8c0 2.2 4.5 4 10 4s10-1.8 10-4V7" />
      <path d="M6 15v8c0 2.2 4.5 4 10 4s10-1.8 10-4v-8" />
    </svg>
  );
}

function CampusOperationsDashboardContent() {
  const canRefresh = canUsePageAction(useAccess(), 'campus_operations', 'refresh', true);
  const { scale, width } = useStageLayout();
  const screenshotMode = useMemo(
    () => getHasCampusOperationsScreenshotModeRequest(),
    [],
  );
  const initialViewState = useMemo(
    () => createCampusOperationsInitialViewState(screenshotMode),
    [screenshotMode],
  );
  const [topologyOpen, setTopologyOpen] = useState(false);
  const [dashboardData, setDashboardData] = useState(
    initialViewState.dashboardData,
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    initialViewState.syncStatus,
  );
  const [hasExactScreenshotData, setHasExactScreenshotData] = useState(
    initialViewState.hasExactScreenshotData,
  );
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState(
    `数据来源：${TRANSFORMER_SOURCE_NAME}、${MACHINE_SOURCE_NAME}`,
  );
  const [syncNotice, setSyncNotice] = useState<{ text: string; tone: SyncNoticeTone } | null>(null);
  const syncNoticeTimerRef = useRef<number | null>(null);
  const screenshotAccess = useMemo(
    () =>
      screenshotMode
        ? getCampusOperationsScreenshotAccessPayload()
        : undefined,
    [screenshotMode],
  );

  const showSyncNotice = useCallback((notice: { text: string; tone: SyncNoticeTone }, keepMs = 5200) => {
    if (syncNoticeTimerRef.current !== null) {
      window.clearTimeout(syncNoticeTimerRef.current);
    }
    setSyncNotice(notice);
    syncNoticeTimerRef.current = window.setTimeout(() => {
      setSyncNotice(null);
      syncNoticeTimerRef.current = null;
    }, keepMs);
  }, []);

  const loadDashboardData = useCallback(async (forceRefresh = false, showFeedback = false) => {
    forceRefresh = forceRefresh && canRefresh;
    setSyncStatus('syncing');
    if (screenshotMode) {
      setHasExactScreenshotData(false);
    }
    if (showFeedback) {
      showSyncNotice({ text: '同步中：正在读取多维表...', tone: 'neutral' }, 120000);
    }
    try {
      const response = await getCampusOperationsDashboard(
        forceRefresh,
        screenshotAccess,
      );
      if (
        screenshotMode &&
        !hasExactCampusOperationsScreenshotData(response, screenshotAccess)
      ) {
        throw new Error('截图请求未取得指定日期和班次的完整真实数据');
      }
      setDashboardData(normalizeDashboardData(response, !screenshotMode));
      setLastUpdated(response.fetchedAt);
      setSourceText(formatDataSourceText(response.target));
      setSyncError(null);
      setHasExactScreenshotData(screenshotMode);
      setSyncStatus('idle');
      if (showFeedback) {
        showSyncNotice({ text: `同步成功：${formatSyncTime(response.fetchedAt) || '已更新'}`, tone: 'success' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncError(message);
      setHasExactScreenshotData(false);
      setSyncStatus('error');
      if (showFeedback) {
        showSyncNotice({ text: '同步失败：请稍后重试', tone: 'error' }, 8000);
      }
    }
  }, [canRefresh, screenshotAccess, screenshotMode, showSyncNotice]);

  useEffect(() => {
    document.title = '园区运行数据仪表盘';
  }, []);

  useEffect(() => {
    void loadDashboardData(false);
    const timer = window.setInterval(
      () => void loadDashboardData(true, false),
      CAMPUS_OPS_SYNC_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [loadDashboardData]);

  useEffect(() => () => {
    if (syncNoticeTimerRef.current !== null) {
      window.clearTimeout(syncNoticeTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!topologyOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTopologyOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [topologyOpen]);

  return (
    <main className="campus-ops-dashboard" aria-label="园区运行数据仪表盘">
      <div
        className="campus-ops-frame"
        data-screenshot-target="campus-operations-dashboard"
        data-screenshot-ready={
          isCampusOperationsScreenshotReady(
            syncStatus,
            screenshotMode,
            hasExactScreenshotData,
          )
            ? 'true'
            : 'false'
        }
        style={{
          width: `${width * scale}px`,
          height: `${STAGE_HEIGHT * scale}px`,
        }}
      >
        <div
          className="campus-ops-stage"
          style={{ transform: `scale(${scale})`, width: `${width}px` }}
        >
          <TechCircuit />
          <DotMatrix />

          <section className="campus-ops-content-grid">
            <TransformerTable
              rows={dashboardData.transformerRows}
              onOpenTopology={() => setTopologyOpen(true)}
            />
            <MachineInfoPanel
              metrics={dashboardData.buildingMetrics}
            />
          </section>
          <SyncStatusFooter
            status={syncStatus}
            lastUpdated={lastUpdated}
            errorMessage={syncError}
            sourceText={sourceText}
            notice={syncNotice}
            onRefresh={() => void loadDashboardData(true, true)}
          />
        </div>
      </div>
      {topologyOpen ? (
        <TransformerTopologyModal
          rows={dashboardData.transformerRows}
          onClose={() => setTopologyOpen(false)}
        />
      ) : null}
    </main>
  );
}

export default function CampusOperationsDashboardPage() {
  if (!getHasCampusOperationsScreenshotModeRequest()) {
    return <CampusOperationsDashboardContent />;
  }

  return (
    <CampusOperationsScreenshotAccessGuard>
      <CampusOperationsDashboardContent />
    </CampusOperationsScreenshotAccessGuard>
  );
}

function getHasCampusOperationsScreenshotModeRequest(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('screenshot') === '1';
}

function getCampusOperationsScreenshotAccessPayload(): CampusOperationsScreenshotAccessPayload {
  if (typeof window === 'undefined') {
    return {
      screenshotDate: null,
      screenshotShift: null,
      screenshotToken: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const screenshotShift = params.get('screenshotShift');
  return {
    screenshotDate: params.get('screenshotDate'),
    screenshotShift:
      screenshotShift === 'white' || screenshotShift === 'night'
        ? screenshotShift
        : null,
    screenshotToken: params.get('screenshotToken'),
  };
}

function CampusOperationsScreenshotAccessGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const [checking, setChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let alive = true;
    const payload = getCampusOperationsScreenshotAccessPayload();

    void checkMonthlyScheduleScreenshotAccess({
      audience: 'campus-operations',
      screenshotDate: payload.screenshotDate,
      screenshotShift: payload.screenshotShift,
      token: payload.screenshotToken,
    })
      .then((result) => {
        if (alive) setAuthorized(Boolean(result.authorized));
      })
      .catch(() => {
        if (alive) setAuthorized(false);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  if (authorized) return <>{children}</>;

  return (
    <main className="min-h-[calc(100dvh-var(--global-navigation-height,0px))] bg-slate-50 px-4 py-10">
      <section className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 text-slate-700 shadow-sm">
        <div className="flex items-center gap-3">
          {checking ? (
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-rose-600" />
          )}
          <span>
            {checking
              ? '正在校验截图访问权限'
              : '截图访问校验失败'}
          </span>
        </div>
      </section>
    </main>
  );
}
