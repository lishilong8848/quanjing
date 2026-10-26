import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { formatShanghaiBusinessDateKey } from '../../client/src/pages/TodayOperationsPanorama/business-date';
import { getKpiComparisonMarqueeMetrics } from '../../client/src/pages/TodayOperationsPanorama/KpiComparisonMarquee';
import { buildOverviewSourceNotice } from '../../client/src/pages/TodayOperationsPanorama/overview-source-status';
import type { TodayOperationsWorkSourceStates } from '../../shared/today-operations-overview.interface';

function readSource(relativePath: string): string {
  const path = join(process.cwd(), relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function readMediaBlock(styles: string, query: string): string {
  const start = styles.lastIndexOf(query);
  if (start < 0) {
    return '';
  }

  const next = styles.indexOf('@media', start + query.length);
  return styles.slice(start, next < 0 ? styles.length : next);
}

function readPixelValue(
  styles: string,
  selector: string,
  property: string,
): number {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = styles.matchAll(
    new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'gs'),
  );

  for (const rule of rules) {
    const value = rule[1].match(new RegExp(`${property}:\\s*(\\d+)px`));
    if (value) {
      return Number(value[1]);
    }
  }

  return Number.NaN;
}

function buildSourceStates(
  overrides: Partial<TodayOperationsWorkSourceStates> = {},
): TodayOperationsWorkSourceStates {
  const fresh = () => ({
    status: 'fresh' as const,
    errorCode: null,
    errorMessage: null,
  });

  return {
    events: fresh(),
    changes: fresh(),
    inspections: fresh(),
    maintenance: fresh(),
    ...overrides,
  };
}

describe('buildOverviewSourceNotice', () => {
  it('keeps the rack refreshing state distinct from a failed refresh', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'stale',
        sourceStates: buildSourceStates(),
        rackSourceState: {
          status: 'stale',
          errorCode: null,
          errorMessage: '机柜数据正在刷新，当前显示最近有效数据',
        },
      }),
    ).toEqual({
      tone: 'stale',
      message: '机柜数据正在刷新，当前显示最近有效数据',
    });
  });
  it('names a failed rack source without claiming operations cards have failed', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'partial',
        sourceStates: buildSourceStates(),
        rackSourceState: {
          status: 'failed',
          errorCode: 'SOURCE_TIMEOUT',
          errorMessage: null,
        },
      }),
    ).toEqual({
      tone: 'error',
      message: '机柜使用概览暂时无法读取，其他可用数据正常展示',
    });
  });
  it('returns no notice when the overview is fresh', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'fresh',
        sourceStates: buildSourceStates(),
      }),
    ).toBeNull();
  });

  it('returns no notice when overview data is missing', () => {
    expect(buildOverviewSourceNotice(null)).toBeNull();
  });

  it('identifies stale work sources that are still refreshing from today cache', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'stale',
        sourceStates: buildSourceStates({
          inspections: {
            status: 'stale',
            errorCode: null,
            errorMessage: '已展示本日缓存',
          },
          maintenance: {
            status: 'stale',
            errorCode: null,
            errorMessage: '已展示本日缓存',
          },
        }),
      }),
    ).toEqual({
      tone: 'stale',
      message: '今日检修、今日维保数据正在刷新，当前显示本日缓存',
    });
  });

  it.each([
    [
      'error code',
      {
        status: 'stale' as const,
        errorCode: 'FEISHU_READ_FAILED',
        errorMessage: '已展示本日缓存',
      },
    ],
    [
      'refresh failure message',
      {
        status: 'stale' as const,
        errorCode: null,
        errorMessage: '刷新失败，已展示本日缓存',
      },
    ],
  ])(
    'identifies a stale work source with an explicit %s as a refresh failure',
    (_caseName, inspections) => {
      expect(
        buildOverviewSourceNotice({
          sourceStatus: 'stale',
          sourceStates: buildSourceStates({ inspections }),
        }),
      ).toEqual({
        tone: 'stale',
        message: '今日检修数据刷新失败，当前显示本日缓存',
      });
    },
  );

  it('describes refreshing and failed stale sources without dropping either status', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'stale',
        sourceStates: buildSourceStates({
          inspections: {
            status: 'stale',
            errorCode: null,
            errorMessage: '已展示本日缓存',
          },
          maintenance: {
            status: 'stale',
            errorCode: '1254018',
            errorMessage: '刷新失败，已展示本日缓存',
          },
        }),
      }),
    ).toEqual({
      tone: 'stale',
      message: '今日检修数据正在刷新；今日维保数据刷新失败，当前均显示本日缓存',
    });
  });

  it('keeps fixed source order when a failed stale source precedes a refreshing one', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'stale',
        sourceStates: buildSourceStates({
          events: {
            status: 'stale',
            errorCode: '1254018',
            errorMessage: '刷新失败，已展示本日缓存',
          },
          changes: {
            status: 'stale',
            errorCode: null,
            errorMessage: '已展示本日缓存',
          },
        }),
      }),
    ).toEqual({
      tone: 'stale',
      message: '今日事件数据刷新失败；今日变更数据正在刷新，当前均显示本日缓存',
    });
  });

  it('uses the core overview fallback when all work sources are fresh', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'stale',
        sourceStates: buildSourceStates(),
      }),
    ).toEqual({
      tone: 'stale',
      message: '运行概览刷新失败，当前显示最近一次成功数据',
    });
  });

  it('identifies the failed source for a partial overview', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'partial',
        sourceStates: buildSourceStates({
          inspections: {
            status: 'failed',
            errorCode: 'FEISHU_READ_FAILED',
            errorMessage: '刷新失败',
          },
        }),
      }),
    ).toEqual({
      tone: 'error',
      message: '今日检修数据源暂时不可用，对应卡片已标记为“—”',
    });
  });

  it('lists partial overview failures in the fixed source order', () => {
    expect(
      buildOverviewSourceNotice({
        sourceStatus: 'partial',
        sourceStates: buildSourceStates({
          events: {
            status: 'failed',
            errorCode: 'FEISHU_READ_FAILED',
            errorMessage: '刷新失败',
          },
          changes: {
            status: 'failed',
            errorCode: 'FEISHU_READ_FAILED',
            errorMessage: '刷新失败',
          },
          inspections: {
            status: 'failed',
            errorCode: 'FEISHU_READ_FAILED',
            errorMessage: '刷新失败',
          },
          maintenance: {
            status: 'failed',
            errorCode: 'FEISHU_READ_FAILED',
            errorMessage: '刷新失败',
          },
        }),
      }),
    ).toEqual({
      tone: 'error',
      message:
        '今日事件、今日变更、今日检修、今日维保数据源暂时不可用，对应卡片已标记为“—”',
    });
  });
});

describe('getKpiComparisonMarqueeMetrics', () => {
  it.each([
    ['non-finite viewport', Number.NaN, 160],
    ['infinite viewport', Number.POSITIVE_INFINITY, 160],
    ['non-finite content', 100, Number.NaN],
    ['infinite content', 100, Number.NEGATIVE_INFINITY],
    ['zero viewport', 0, 160],
    ['negative viewport', -1, 160],
    ['zero content', 100, 0],
    ['negative content', 100, -1],
    ['equal widths', 100, 100],
    ['one pixel overflow', 100, 101],
  ])(
    'disables marquee metrics for %s',
    (_caseName, viewportWidth, contentWidth) => {
      expect(
        getKpiComparisonMarqueeMetrics(viewportWidth, contentWidth),
      ).toEqual({
        distance: 0,
        durationSeconds: 0,
      });
    },
  );

  it('returns bounded metrics for meaningful overflow', () => {
    const metrics = getKpiComparisonMarqueeMetrics(100, 160);

    expect(metrics.distance).toBe(60);
    expect(metrics.durationSeconds).toBeGreaterThanOrEqual(7);
    expect(metrics.durationSeconds).toBeLessThanOrEqual(14);
  });
});

describe('today operations panorama UI', () => {
  it('marquees only overflowing KPI comparison copy without cloning visible text', () => {
    const componentSource = readSource(
      'client/src/pages/TodayOperationsPanorama/KpiComparisonMarquee.tsx',
    );
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const reducedMotion = readMediaBlock(
      styles,
      '@media (prefers-reduced-motion: reduce)',
    );
    const baseTrackRule =
      styles.match(
        /\n\.today-panorama-kpi-comparison-marquee-track\s*\{([^}]*)\}/s,
      )?.[1] ?? '';

    expect(componentSource).toMatch(
      /useLayoutEffect\(\(\) => \{\s*measure\(\);/,
    );
    expect(componentSource.indexOf('useLayoutEffect')).toBeLessThan(
      componentSource.indexOf('useEffect'),
    );
    expect(componentSource).toContain('new ResizeObserver(measure)');
    expect(componentSource).toMatch(
      /observer\.observe\(viewport\);\s*observer\.observe\(track\);/,
    );
    expect(componentSource).toContain('observer.disconnect()');
    expect(componentSource).toContain(
      "window.addEventListener('resize', measure)",
    );
    expect(componentSource).toContain(
      "window.removeEventListener('resize', measure)",
    );
    expect(componentSource).toMatch(
      /setMetrics\(\(current\) =>\s*current\.distance === next\.distance &&\s*current\.durationSeconds === next\.durationSeconds\s*\?\s*current\s*:\s*next,\s*\);/,
    );
    expect(componentSource).toContain(
      'data-overflowing={String(isOverflowing)}',
    );
    expect(componentSource).toContain(
      'title={isOverflowing ? text : undefined}',
    );
    expect(componentSource).toMatch(
      /className="today-panorama-kpi-comparison-marquee"[\s\S]*?>\s*<span\s+ref=\{trackRef\}\s+className="today-panorama-kpi-comparison-marquee-track"\s*>\s*\{text\}\s*<\/span>\s*<\/span>/,
    );
    expect(componentSource).not.toMatch(/aria-hidden[^>]*>\s*\{text\}/);

    expect(pageSource).toContain("from './KpiComparisonMarquee'");
    expect(pageSource).toMatch(
      /<p\s+className="today-panorama-kpi-comparison"[\s\S]*?>\s*\{item\.key === 'on-duty' \? null : <DirectionIcon aria-hidden="true" \/>\}\s*<KpiComparisonMarquee\s+id=\{comparisonId\}\s+text=\{item\.comparison\}\s+focusable=\{!onClick && !item\.helpText\}\s*\/>\s*<\/p>/,
    );

    expect(styles).toMatch(
      /\.today-panorama-kpi-comparison-marquee\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(baseTrackRule).toMatch(/display:\s*block;/);
    expect(baseTrackRule).toMatch(/width:\s*max-content;/);
    expect(baseTrackRule).not.toContain('animation:');
    expect(styles).toMatch(
      /\.today-panorama-kpi-comparison-marquee\[data-overflowing='true'\]\s+\.today-panorama-kpi-comparison-marquee-track\s*\{[^}]*animation:/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-kpi-card:hover\s+\.today-panorama-kpi-comparison-marquee-track,\s*\.today-panorama-kpi-card:focus-within\s+\.today-panorama-kpi-comparison-marquee-track\s*\{[^}]*animation-play-state:\s*paused;/s,
    );
    expect(styles).toMatch(
      /@keyframes todayPanoramaKpiComparisonMarquee[\s\S]*translateX\(\s*calc\(0px - var\(--today-panorama-kpi-comparison-distance\)\)\s*\)/,
    );
    expect(reducedMotion).toMatch(
      /\.today-panorama-kpi-comparison-marquee-track\s*\{[^}]*animation:\s*none !important;[^}]*transform:\s*none !important;/s,
    );
  });

  it('omits marquee CSS variables when KPI comparison copy does not overflow', () => {
    const componentSource = readSource(
      'client/src/pages/TodayOperationsPanorama/KpiComparisonMarquee.tsx',
    );

    expect(componentSource).toMatch(
      /const isOverflowing = metrics\.distance > 0;\s*const style: KpiComparisonMarqueeStyle \| undefined = isOverflowing\s*\?\s*\{\s*'--today-panorama-kpi-comparison-distance': `\$\{metrics\.distance\}px`,\s*'--today-panorama-kpi-comparison-duration': `\$\{metrics\.durationSeconds\}s`,\s*\}\s*:\s*undefined;/,
    );
    expect(componentSource).toContain(
      'data-overflowing={String(isOverflowing)}',
    );
    expect(componentSource).toContain(
      'title={isOverflowing ? text : undefined}',
    );
    expect(componentSource).toContain('style={style}');
  });

  it('describes interactive KPI buttons with their comparison copy by id', () => {
    const componentSource = readSource(
      'client/src/pages/TodayOperationsPanorama/KpiComparisonMarquee.tsx',
    );
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );

    expect(pageSource).toMatch(/import \{[^}]*\buseId\b[^}]*\} from 'react';/s);
    expect(pageSource).toMatch(
      /function KpiCard\([\s\S]*?const comparisonId = useId\(\);/,
    );
    expect(componentSource).toMatch(
      /interface KpiComparisonMarqueeProps\s*\{[^}]*id:\s*string;/s,
    );
    expect(componentSource).toContain('id={id}');
    expect(pageSource).toMatch(
      /<KpiComparisonMarquee\s+id=\{comparisonId\}[\s\S]*?text=\{item\.comparison\}/,
    );
    expect(pageSource).toMatch(
      /const card = onClick \? \(\s*<button[\s\S]*?aria-label=\{`[^`]*\$\{item\.title\}[^`]*`\}\s*aria-describedby=\{comparisonId\}/,
    );
    expect(pageSource).not.toMatch(/aria-label=\{`[^`]*\$\{item\.comparison\}/);
  });

  it('focuses only overflowing comparison copy on ordinary non-interactive KPI cards', () => {
    const componentSource = readSource(
      'client/src/pages/TodayOperationsPanorama/KpiComparisonMarquee.tsx',
    );
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );

    expect(componentSource).toMatch(
      /interface KpiComparisonMarqueeProps\s*\{[^}]*focusable\?:\s*boolean;/s,
    );
    expect(componentSource).toContain('focusable = false');
    expect(componentSource).toContain(
      'tabIndex={focusable && isOverflowing ? 0 : undefined}',
    );
    expect(componentSource).toContain(
      'aria-label={focusable && isOverflowing ? text : undefined}',
    );
    expect(pageSource).toContain('focusable={!onClick && !item.helpText}');
    expect(styles).toMatch(
      /\.today-panorama-kpi-comparison-marquee:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--panorama-primary\);[^}]*outline-offset:\s*2px;/s,
    );
  });

  it('registers a separate protected route while preserving the old dashboard route', () => {
    const appSource = readSource('client/src/app.tsx');
    const switcherSource = readSource('client/src/navigation/page-switcher.ts');

    expect(appSource).toContain("import('./pages/TodayOperationsPanorama')");
    expect(appSource).toContain('path="/today-operations-panorama"');
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
    expect(appSource).toContain('path="/campus-operations-dashboard"');
    expect(appSource).toContain('<TodayOperationsPanoramaPage />');
    expect(appSource).toContain('<CampusOperationsDashboardPage />');
    expect(switcherSource).toContain("path: '/today-operations-panorama'");
    expect(switcherSource).toContain("path: '/campus-operations-dashboard'");
    expect(switcherSource).toMatch(
      /label: '今日航图',\s*path: '\/today-operations-panorama'/,
    );
    expect(switcherSource).toMatch(
      /label: '主变运行',\s*path: '\/campus-operations-dashboard'/,
    );
  });

  it('uses cached reads when the current visitor cannot force a refresh', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const operationsSource = readSource(
      'client/src/pages/TodayOperationsPanorama/OperationsPanels.tsx',
    );

    expect(pageSource).toMatch(/capabilities:\s*\{\s*canForceRefresh\s*\}/);
    expect(pageSource).toContain('canForceRefresh && forceRefresh');
    expect(pageSource).toContain('allowForceRefresh={canForceRefresh}');
    expect(operationsSource).toContain('allowForceRefresh = true');
    expect(operationsSource).toContain('loadDashboardData(allowForceRefresh)');
  });

  it('renders every reference section in a naturally scrolling page', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const operationsSource = readSource(
      'client/src/pages/TodayOperationsPanorama/OperationsPanels.tsx',
    );
    const completePageSource = `${pageSource}\n${operationsSource}`;
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );

    expect(pageSource).toContain(
      'data-screenshot-target="today-operations-panorama"',
    );
    expect(pageSource).toContain('智舱 · 今日全景');
    expect(pageSource).toContain('aria-label="智舱今日全景"');
    expect(pageSource).not.toContain('智能 · 今日全景');
    expect(pageSource).not.toContain('aria-label="智能今日全景"');
    expect(completePageSource).toContain('110站主变运行状态');
    expect(completePageSource).toContain('机房运行信息');
    expect(pageSource).toContain('机柜使用概览');
    expect(pageSource).toContain('运维概况一览');
    expect(pageSource).toContain('近7天告警一览');
    expect(pageSource).toContain('昨日告警一览');
    expect(pageSource).toContain('近期告警信息清单');
    expect(styles).toContain('.today-operations-panorama');
    expect(styles).toMatch(
      /\.today-operations-panorama\s*\{[^}]*overflow-x:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-content\s*\{[^}]*max-width:\s*1680px;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-hero\s*\{[^}]*linear-gradient\(\s*180deg,\s*#064fc5 0%,\s*#00359b 54%,\s*#012a7d 100%\s*\)/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-title-copy h1\s*\{[^}]*color:\s*hsl\(0 0% 100%\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-time\s*\{[^}]*color:\s*hsl\(210 100% 96%\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-live-grid\s*\{[^}]*grid-template-columns:\s*44fr 56fr;[^}]*gap:\s*14px;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-overview-grid\s*\{[^}]*grid-template-columns:\s*44fr 56fr;[^}]*gap:\s*14px;/s,
    );
    expect(styles).not.toContain('grid-template-columns: 46fr 54fr');
    expect(styles).toContain('@media (max-width: 1100px)');
    expect(styles).toContain('@media (max-width: 720px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('places the operations panels after every other business section', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const alarmOverviewIndex = pageSource.lastIndexOf('<AlarmOverview');
    const operationsPanelsIndex = pageSource.lastIndexOf('<OperationsPanels');

    expect(alarmOverviewIndex).toBeGreaterThan(-1);
    expect(operationsPanelsIndex).toBeGreaterThan(alarmOverviewIndex);
    expect(pageSource.slice(operationsPanelsIndex)).toMatch(
      /<OperationsPanels[\s\S]*?\/>\s*<\/div>\s*<\/div>\s*<\/main>/,
    );
  });

  it('reuses the campus operations data contract and full panel behavior', () => {
    const operationsSource = readSource(
      'client/src/pages/TodayOperationsPanorama/OperationsPanels.tsx',
    );

    expect(operationsSource).toContain('getCampusOperationsDashboard');
    expect(operationsSource).toContain(
      'CAMPUS_OPS_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000',
    );
    expect(operationsSource).toContain('TransformerTopologyModal');
    expect(operationsSource).toContain('campus-ops-transformer-panel');
    expect(operationsSource).toContain('campus-ops-machine-panel');
    expect(operationsSource).toContain('forceRefresh');
    expect(operationsSource).toContain('fallbackTransformerRows');
    expect(operationsSource).toContain('fallbackBuildingMetrics');
  });

  it('loads alarm cards, charts, and table from an independent Feishu-backed endpoint', () => {
    const dataSource = readSource(
      'client/src/pages/TodayOperationsPanorama/data.ts',
    );
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const apiSource = readSource('client/src/api/index.ts');
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );

    expect(apiSource).toContain('getTodayOperationsAlarmDashboard');
    expect(apiSource).toContain("url: '/api/bitable/today-operations-alarms'");
    expect(pageSource).toContain('getTodayOperationsAlarmDashboard');
    expect(pageSource).toContain('alarmReady');
    expect(pageSource).toContain('today-panorama-source-state');
    expect(pageSource).toContain('createInitialAlarmRequestState');
    expect(pageSource).toContain('beginAlarmRequest');
    expect(pageSource).toContain('completeAlarmRequest');
    expect(pageSource).toContain('failAlarmRequest');
    expect(pageSource).toContain('const visibleData = alarmRequestState.data;');
    expect(pageSource).toMatch(
      /isAlarmListRequestPending\(\s*alarmRequestState,\s*requestKey,\s*\)/,
    );
    expect(pageSource).toContain('data={visibleData}');
    expect(styles).toContain('.today-panorama-source-state');
    expect(pageSource).not.toContain('PANORAMA_ALARM_ROWS');
    expect(pageSource).not.toContain('PANORAMA_ALARM_TREND');
    expect(pageSource).not.toContain('PANORAMA_YESTERDAY_ALARMS');
    expect(dataSource).not.toContain('PANORAMA_ALARM_ROWS');
    expect(dataSource).not.toContain('PANORAMA_ALARM_TREND');
    expect(pageSource).not.toContain(
      "url: '/api/bitable/campus-operations-dashboard'",
    );
    expect(pageSource).toMatch(
      /data-screenshot-ready=\{\s*operationsReady && overviewReady && sealingReady && alarmReady\s*\?\s*'true'\s*:\s*'false'\s*\}/,
    );
  });

  it('keeps alarm data visible while rendering source-driven filters, dual statuses, and KPI guidance', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const dialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/AlarmDetailDialog.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const media1440 = readMediaBlock(styles, '@media (max-width: 1440px)');
    const media1280 = readMediaBlock(styles, '@media (max-width: 1280px)');
    const media900 = readMediaBlock(styles, '@media (max-width: 900px)');
    const media720 = readMediaBlock(styles, '@media (max-width: 720px)');

    expect(pageSource).toMatch(
      /'alarms-double-unhandled':\s*\{\s*metric:\s*'doubleUnhandled',\s*title:\s*'双未告警清单',?\s*\}/s,
    );
    expect(pageSource).toMatch(/const card = onClick \? \(/);
    expect(pageSource).toContain(
      '<TooltipTrigger asChild>{card}</TooltipTrigger>',
    );
    expect(pageSource).toContain('today-panorama-kpi-help');
    expect(pageSource).toContain('data.options.levels.map');
    expect(pageSource).not.toContain(
      '<SelectItem value="高危">高危</SelectItem>',
    );
    expect(pageSource).toContain('data.options.processingStatuses.map');
    expect(pageSource).toContain('data.options.recoveryStatuses.map');
    expect(pageSource).toContain('aria-label="处理状态筛选"');
    expect(pageSource).toContain('aria-label="恢复状态筛选"');
    expect(pageSource).toContain('<th scope="col">恢复状态</th>');
    expect(pageSource).toContain('row.processingStatus');
    expect(pageSource).toContain('row.recoveryStatus');
    expect(dialogSource).toContain('item.processingStatus');
    expect(dialogSource).toContain('item.recoveryStatus');
    expect(dialogSource).toContain('getProcessingBadgeClass');
    expect(dialogSource).toContain('getRecoveryBadgeClass');
    expect(dialogSource).not.toContain('getHandlingBadgeClass');
    expect(pageSource).toContain(
      'const [processingStatus, setProcessingStatus] = useState<',
    );
    expect(pageSource).toContain(
      'const [recoveryStatus, setRecoveryStatus] = useState<',
    );
    expect(pageSource).toMatch(
      /const requestKey = JSON\.stringify\(\{[^}]*processingStatus,[^}]*recoveryStatus,/s,
    );
    expect(pageSource).toMatch(
      /getTodayOperationsAlarmDashboard\(\{[^}]*processingStatus:[^}]*recoveryStatus:/s,
    );
    expect(pageSource).toMatch(
      /\}, \[\s*allowForceRefresh,[\s\S]*?processingStatus,[\s\S]*?recoveryStatus,[\s\S]*?requestKey,\s*tagReviewPollToken,\s*\]\);/,
    );
    expect(pageSource).toMatch(
      /const resetFilters = \(\) => \{[^}]*setProcessingStatus\('all'\);[^}]*setRecoveryStatus\('all'\);[^}]*setPage\(1\);/s,
    );
    expect(pageSource).toMatch(
      /onProcessingStatusChange=\{\(value\) => \{\s*setProcessingStatus\(value\);\s*setPage\(1\);/,
    );
    expect(pageSource).toMatch(
      /onRecoveryStatusChange=\{\(value\) => \{\s*setRecoveryStatus\(value\);\s*setPage\(1\);/,
    );
    expect(pageSource).toContain('const alarmRequestIdRef = useRef(0);');
    expect(pageSource).toContain(
      'const requestId = alarmRequestIdRef.current + 1;',
    );
    expect(
      pageSource.match(
        /if \(alarmRequestIdRef\.current !== requestId\) return;/g,
      ),
    ).toHaveLength(2);
    expect(
      pageSource.match(
        /isCurrent:\s*alarmRequestIdRef\.current === requestId/g,
      ),
    ).toHaveLength(2);
    expect(pageSource).toMatch(
      /return \(\) => \{\s*if \(alarmRequestIdRef\.current === requestId\) \{\s*alarmRequestIdRef\.current \+= 1;\s*\}\s*\};/,
    );
    expect(pageSource).toContain('const visibleData = alarmRequestState.data;');
    expect(pageSource).toMatch(
      /isAlarmListRequestPending\(\s*alarmRequestState,\s*requestKey,\s*\)/,
    );
    expect(pageSource).toContain('loading={listRequestPending}');
    expect(pageSource).toMatch(
      /const paginationDisabled = getAlarmPaginationDisabledState\(\{\s*currentPage,\s*totalPages,\s*pending:\s*loading,\s*\}\);/,
    );
    expect(pageSource).toContain('disabled={paginationDisabled.previous}');
    expect(pageSource).toContain('disabled={paginationDisabled.next}');
    expect(pageSource).not.toContain('disabled={currentPage === 1}');
    expect(pageSource).not.toContain('disabled={currentPage === totalPages}');
    expect(pageSource).not.toContain('const [data, setData]');
    expect(pageSource).not.toContain('const [loadState, setLoadState]');
    expect(pageSource).not.toContain(
      'const [dataRequestKey, setDataRequestKey]',
    );

    expect(styles).toMatch(
      /\.today-panorama-alarm-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toContain('.today-panorama-kpi-title');
    expect(styles).toMatch(
      /\.today-panorama-kpi-help\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-table-toolbar\s*\{[^}]*repeat\(4,/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-table-scroll\s*\{[^}]*overflow-x:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-table\s*\{[^}]*min-width:\s*13(?:2|3|4|5|6)0px;/s,
    );
    expect(media1440).not.toMatch(
      /\.today-panorama-alarm-kpi-grid\s*\{[^}]*overflow-x:\s*auto;/s,
    );
    expect(media1280).not.toMatch(
      /\.today-panorama-alarm-kpi-grid\s*\{[^}]*grid-template-columns:/s,
    );
    expect(media1280).toMatch(
      /\.today-panorama-table-toolbar\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(media900).toMatch(
      /\.today-panorama-alarm-kpi-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(media900).toMatch(
      /\.today-panorama-table-toolbar\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(media720).toMatch(
      /\.today-panorama-alarm-kpi-grid[^}]*grid-template-columns:\s*1fr;/s,
    );
    expect(media720).toMatch(
      /\.today-panorama-table-toolbar\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
  });

  it('loads rack and operations overview cards from the registered Feishu sources', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const apiSource = readSource('client/src/api/index.ts');

    expect(apiSource).toContain('getTodayOperationsOverview');
    expect(apiSource).toContain(
      "url: '/api/bitable/today-operations-overview'",
    );
    expect(pageSource).toContain('getTodayOperationsOverview');
    expect(pageSource).toContain('overviewReady');
    expect(pageSource).toContain(
      'const OVERVIEW_REFRESH_INTERVAL_MS = 5 * 60 * 1000;',
    );
    expect(pageSource).toContain(
      'const SEALING_REFRESH_INTERVAL_MS = 5 * 60 * 1000;',
    );
    expect(pageSource).toContain(
      'void loadOverviewData(false, true, businessDateKey);',
    );
    expect(pageSource).toContain('getYearlySealingInfo');
    expect(pageSource).toContain(
      'void loadSealingInfo(false, true, businessDateKey);',
    );
    expect(pageSource).toMatch(
      /useMemo\(\s*\(\) => buildOverviewSourceNotice\(overviewData\),\s*\[overviewData\],?\s*\)/,
    );
    expect(pageSource.match(/\{overviewSourceNotice \? \(/g)).toHaveLength(1);
    expect(pageSource).toContain(
      "role={overviewSourceNotice.tone === 'error' ? 'alert' : 'status'}",
    );
    expect(pageSource).not.toContain(
      '飞书连接暂时不可用，当前显示最近一次成功的运行概览',
    );
    expect(pageSource).not.toContain(
      '部分运维数据源暂时不可用，对应卡片已标记为“--”，不会按 0 计数',
    );
    expect(pageSource).not.toContain(
      "overviewData?.sourceStatus === 'partial'",
    );
    expect(pageSource).toContain('机柜上电数量（本周）');
    expect(pageSource).toContain('机柜下电数量（本周）');
    expect(pageSource).not.toContain('机柜上线数量（本周）');
    expect(pageSource).not.toContain('机柜下线数量（本周）');
    expect(pageSource).toContain('OperationsDetailDialog');
    expect(pageSource).toContain('AlarmDetailDialog');
    expect(pageSource).toContain('details={overviewData.details}');
    expect(pageSource).not.toContain('往期重点关注事件');
    expect(pageSource).not.toContain('往期重点关注变更');
    expect(pageSource).not.toContain(
      'useMemo(() => buildOperationsTickerItems(), [])',
    );
    expect(pageSource).not.toContain(
      'RackUsageGauge value={PANORAMA_RACK_SUMMARY.usageRate}',
    );
    expect(pageSource).not.toContain('PANORAMA_MAINTENANCE_CARDS.map');
  });

  it('allows explicit rack retry to bypass a partial snapshot while initial reads stay cache-first', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );

    expect(
      pageSource.match(/onRetry=\{\(\) => void loadOverviewData\(false\)\}/g),
    ).toHaveLength(1);
    const rackState = pageSource.slice(
      pageSource.indexOf('title="机柜使用概览"'),
      pageSource.indexOf('{overviewData && maintenanceCards.length > 0'),
    );
    expect(rackState).toContain('onRetry={() => void loadOverviewData(true)}');
    expect(pageSource).toContain('canForceRefresh && forceRefresh');
  });

  it('opens cached rack usage details immediately and keeps retry wiring explicit', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const triggerSource =
      pageSource.match(
        /<button[\s\S]*?aria-label="查看各楼机柜上架率明细"[\s\S]*?<\/button>/,
      )?.[0] ?? '';

    expect(pageSource).toContain("from './RackUsageDetailDialog'");
    expect(pageSource).toContain(
      'const [rackUsageDialogOpen, setRackUsageDialogOpen] = useState(false)',
    );
    expect(pageSource).toContain(
      'const rackUsageTriggerRef = useRef<HTMLButtonElement | null>(null)',
    );
    expect(triggerSource).toContain('type="button"');
    expect(triggerSource).toContain('ref={rackUsageTriggerRef}');
    expect(triggerSource).toContain('aria-label="查看各楼机柜上架率明细"');
    expect(triggerSource).toContain('aria-haspopup="dialog"');
    expect(triggerSource).toContain('aria-expanded={rackUsageDialogOpen}');
    expect(triggerSource).toContain(
      'onClick={() => setRackUsageDialogOpen(true)}',
    );
    expect(triggerSource).toContain('点击查看各楼明细');
    expect(triggerSource).not.toContain('await');
    expect(triggerSource).not.toContain('loadOverviewData');
    expect(triggerSource).not.toContain('getTodayOperationsOverview');
    expect(pageSource).toContain('<RackUsageDetailDialog');
    expect(pageSource).toContain('summary={summary}');
    expect(pageSource).toContain('open={rackUsageDialogOpen}');
    expect(pageSource).toContain('onOpenChange={setRackUsageDialogOpen}');
    expect(pageSource).toContain(
      'restoreFocusTo={rackUsageTriggerRef.current}',
    );
    expect(pageSource).toContain("overviewLoadState === 'error' ||");
    expect(pageSource).toContain("overviewData?.sourceStatus === 'stale'");
    expect(pageSource).toContain('onRetry={() => void loadOverviewData(true)}');
    expect(pageSource).toContain("retrying={overviewLoadState === 'loading'}");
  });

  it('defines an accessible rack usage dialog and exact dual-axis chart contract', () => {
    const dialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/RackUsageDetailDialog.tsx',
    );
    const chartsSource = readSource(
      'client/src/pages/TodayOperationsPanorama/charts.tsx',
    );

    expect(dialogSource).toContain('各楼机柜上架率');
    expect(dialogSource).toContain('capacityDate');
    expect(dialogSource).toContain('暂无容量日期');
    expect(dialogSource).toContain('已上架沿用实际上电数量口径');
    expect(dialogSource).toContain('当前展示最近一次成功同步的数据');
    expect(dialogSource).toContain('暂无各楼机柜容量数据');
    expect(dialogSource).toContain('useDeferredValue');
    expect(dialogSource).toContain('const chartReady = useDeferredValue(open)');
    expect(dialogSource).toContain('正在绘制各楼机柜图表…');
    expect(dialogSource).toContain('hasBuildingData && chartReady');
    expect(dialogSource).toContain('<dialog');
    expect(dialogSource).toContain('useLayoutEffect');
    expect(dialogSource).toContain('dialog.showModal()');
    expect(dialogSource).toContain('dialog.close()');
    expect(dialogSource).toContain('onCancel');
    expect(dialogSource).toContain('onClose');
    expect(dialogSource).toContain('aria-labelledby={titleId}');
    expect(dialogSource).toContain('aria-describedby={descriptionId}');
    expect(dialogSource).toContain('重新读取');
    expect(dialogSource).toContain('retrying: boolean');
    expect(dialogSource).toContain('disabled={retrying}');
    expect(dialogSource).toContain('aria-busy={retrying}');
    expect(dialogSource).toContain("retrying ? '读取中…' : '重新读取'");
    expect(dialogSource).toContain('event.preventDefault()');
    expect(dialogSource).toContain('restoreFocusTo?.focus()');
    expect(dialogSource).toContain('const root = document.documentElement');
    expect(dialogSource).toContain("root.style.overflow = 'hidden'");
    expect(dialogSource).toContain("body.style.overflow = 'hidden'");
    expect(dialogSource).toContain(
      'root.style.overflow = previousRootOverflow',
    );
    expect(dialogSource).toContain(
      'body.style.overflow = previousBodyOverflow',
    );
    expect(dialogSource).not.toContain("from '@/components/ui/dialog'");
    expect(dialogSource).not.toMatch(/from ['"][^'"]*api[^'"]*['"]/i);
    expect(dialogSource).not.toContain('getTodayOperationsOverview');
    expect(dialogSource).not.toContain('useEffect');

    expect(chartsSource).toContain('RackUsageDetailChart');
    expect(chartsSource).toMatch(
      /<span\s+className="today-panorama-rack-gauge-visual"/,
    );
    expect(chartsSource).toContain('<ComposedChart');
    expect(chartsSource).toMatch(/<YAxis\s+[\s\S]*?yAxisId="count"/);
    expect(chartsSource).toMatch(/<YAxis\s+[\s\S]*?yAxisId="rate"/);
    expect(chartsSource).toMatch(
      /<Bar\s+[\s\S]*?dataKey="total"[\s\S]*?yAxisId="count"/,
    );
    expect(chartsSource).toMatch(
      /<Bar\s+[\s\S]*?dataKey="online"[\s\S]*?yAxisId="count"/,
    );
    expect(chartsSource).toMatch(
      /<Line\s+[\s\S]*?dataKey="usageRate"[\s\S]*?yAxisId="rate"/,
    );
    expect(chartsSource).toContain('<Tooltip');
    expect(chartsSource).toContain('<Legend');
    expect(chartsSource).toContain('name="设计机柜"');
    expect(chartsSource).toContain('name="已上架机柜"');
    expect(chartsSource).toContain('name="机柜上架率"');
    expect(chartsSource).toContain(
      'className="today-panorama-rack-count-label"',
    );
    expect(chartsSource).toContain(
      'className="today-panorama-rack-rate-label"',
    );
    expect(chartsSource).toMatch(/Math\.max\(\s*100,/);
    expect(chartsSource).toContain(
      'Math.ceil((maximumUsageRate * 11) / 100) * 10',
    );
    expect(chartsSource).not.toContain(
      'Math.max(100, ...chartData.map((item) => item.usageRate)) * 1.1',
    );
    expect(chartsSource).toContain('role="img"');
    expect(chartsSource).toContain('各楼机柜上架率：');
    expect(chartsSource).toContain('item.total.toLocaleString');
    expect(chartsSource).toContain('item.online.toLocaleString');
    expect(chartsSource).toContain('item.usageRate.toFixed(1)');
    expect(chartsSource).toContain('isAnimationActive={false}');
  });

  it('styles the rack detail trigger, dialog states, chart, and mobile layout', () => {
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const mobile = readMediaBlock(styles, '@media (max-width: 720px)');

    expect(styles).toMatch(
      /\.today-panorama-rack-gauge\s*\{[^}]*appearance:\s*none;[^}]*border:\s*0;/s,
    );
    expect(styles).toContain('.today-panorama-rack-gauge:hover');
    expect(styles).toContain('.today-panorama-rack-gauge:active');
    expect(styles).toMatch(
      /\.today-panorama-rack-gauge:focus-visible\s*\{[^}]*outline:\s*3px/s,
    );
    expect(styles).toContain('.today-panorama-rack-gauge-hint');
    expect(styles).toContain('.today-panorama-rack-usage-dialog');
    expect(styles).toContain('.today-panorama-rack-usage-chart');
    expect(styles).toContain('.today-panorama-rack-usage-summary');
    expect(styles).toContain('.today-panorama-rack-usage-stale');
    expect(styles).toContain('.today-panorama-rack-usage-empty');
    expect(styles).toContain('.today-panorama-rack-usage-retry');
    expect(styles).toMatch(
      /\.today-panorama-rack-usage-dialog\s*\{[^}]*--panorama-muted:/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-rack-usage-body\s*\{[^}]*overscroll-behavior:\s*contain;/s,
    );
    expect(mobile).toContain('.today-panorama-rack-usage-dialog');
    expect(mobile).toContain('.today-panorama-rack-usage-chart');
    expect(mobile).toMatch(
      /\.today-panorama-rack-count-label\s*\{[^}]*display:\s*none;/s,
    );
    expect(mobile).toMatch(
      /\.today-panorama-rack-rate-label\s*\{[^}]*font-size:\s*10px;/s,
    );
    expect(mobile).toMatch(/max-height:\s*280px;/);
  });

  it('loads the six top KPIs independently without falling back to static values', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const dataSource = readSource(
      'client/src/pages/TodayOperationsPanorama/data.ts',
    );
    const modelSource = readSource(
      'client/src/pages/TodayOperationsPanorama/top-kpi-model.ts',
    );
    const apiSource = readSource('client/src/api/index.ts');

    expect(apiSource).toContain('getTodayOperationsKpis');
    expect(apiSource).toContain("url: '/api/bitable/today-operations-kpis'");
    expect(apiSource).toContain('refresh: options.refresh ?');
    expect(pageSource).toContain('getTodayOperationsKpis');
    expect(pageSource).toContain('loadTopKpis');
    expect(pageSource).toContain('buildTopKpis');
    expect(pageSource).toContain('buildTopKpiPlaceholders');
    expect(pageSource).toContain('loadTopKpis(true)');
    expect(pageSource).toContain('loadOverviewData(true)');
    expect(pageSource).toContain('manualRefreshToken');
    expect(pageSource).toContain('aria-label="刷新今日全景全部数据"');
    expect(pageSource).not.toContain('PANORAMA_KPIS.map');
    expect(dataSource).not.toContain("value: '2,822'");
    expect(dataSource).not.toContain("value: '1,026,221'");
    expect(modelSource).toContain('previousValue');
    expect(modelSource).toContain("direction: 'neutral'");
  });

  it('refreshes KPI and overview data immediately when the Shanghai business date changes', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );

    expect(
      formatShanghaiBusinessDateKey(new Date('2026-07-20T15:59:59.000Z')),
    ).toBe('2026-07-20');
    expect(
      formatShanghaiBusinessDateKey(new Date('2026-07-20T16:00:00.000Z')),
    ).toBe('2026-07-21');
    expect(pageSource).toContain(
      'const businessDateKey = formatShanghaiBusinessDateKey(now)',
    );
    expect(pageSource).toContain(
      'topKpiBusinessDateRef.current !== businessDateKey',
    );
    expect(pageSource).toContain(
      'overviewBusinessDateRef.current !== businessDateKey',
    );
    expect(pageSource).toContain('setOverviewData(null)');
    expect(pageSource).toContain(
      'response.businessDate !== expectedBusinessDate',
    );
    expect(pageSource).toContain(
      'loadOverviewData(businessDateChanged, false, businessDateKey)',
    );
    expect(pageSource).toContain('[businessDateKey, loadTopKpis]');
    expect(pageSource).toContain('[businessDateKey, loadOverviewData]');
  });

  it('uses a prominent readable operations ticker', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const mobileTicker = readMediaBlock(styles, '@media (max-width: 520px)');
    const reducedMotion = readMediaBlock(
      styles,
      '@media (prefers-reduced-motion: reduce)',
    );
    const baseTickerRule =
      styles.match(/\.today-panorama-operations-ticker\s*\{([^}]*)\}/s)?.[1] ??
      '';
    const keyTickerRule =
      styles.match(
        /\.today-panorama-operations-ticker\[data-emphasis='key'\]\s*\{([^}]*)\}/s,
      )?.[1] ?? '';
    const tickerCopyRule =
      styles.match(/\.today-panorama-ticker-copy\s*\{([^}]*)\}/s)?.[1] ?? '';
    const tickerContentRule =
      styles.match(/\.today-panorama-ticker-content\s*\{([^}]*)\}/s)?.[1] ?? '';
    const liveRegionOpeningTag =
      pageSource.match(
        /<p\s+className="today-panorama-ticker-copy"[\s\S]*?>/,
      )?.[0] ?? '';

    expect(pageSource).toContain('OPERATIONS_TICK_INTERVAL_MS = 7000');
    expect(pageSource).toContain('function OperationsTicker');
    expect(pageSource).toContain('today-panorama-operations-ticker');
    expect(pageSource).toContain(
      "data-emphasis={activeItem.isKey ? 'key' : undefined}",
    );
    expect(pageSource).toContain('today-panorama-ticker-key-badge');
    expect(pageSource).toContain(
      'const [hoverPaused, setHoverPaused] = useState(false)',
    );
    expect(pageSource).toContain(
      'const [focusPaused, setFocusPaused] = useState(false)',
    );
    expect(pageSource).toContain(
      'const isPaused = manualPaused || hoverPaused || focusPaused',
    );
    expect(pageSource).toContain('onMouseEnter={() => setHoverPaused(true)}');
    expect(pageSource).toContain('onMouseLeave={() => setHoverPaused(false)}');
    expect(pageSource).toContain('onFocusCapture={() => setFocusPaused(true)}');
    expect(pageSource).toContain('setFocusPaused(false)');
    expect(pageSource).not.toContain('setInteractionPaused');
    expect(pageSource).toContain('aria-pressed={manualPaused}');
    expect(pageSource).toContain('<Pause aria-hidden="true" />');
    expect(pageSource).toContain('<Play aria-hidden="true" />');
    expect(liveRegionOpeningTag).toContain('aria-live="polite"');
    expect(liveRegionOpeningTag).toContain('aria-atomic="true"');
    expect(liveRegionOpeningTag).not.toContain('key={activeItem.key}');
    expect(pageSource).toMatch(
      /<span\s+className="today-panorama-ticker-content"\s+key=\{activeItem\.key\}\s*>/,
    );
    expect(styles).toMatch(
      /\.today-panorama-operations-ticker\s*\{[^}]*min-height:\s*64px;/s,
    );
    expect(baseTickerRule).toMatch(
      /grid-template-columns:\s*42px minmax\(0,\s*1fr\) auto 34px;/,
    );
    expect(baseTickerRule).toMatch(/gap:\s*12px;/);
    expect(baseTickerRule).toMatch(/margin:\s*0 0 14px;/);
    expect(baseTickerRule).toMatch(/padding:\s*9px 14px;/);
    expect(baseTickerRule).toContain(
      'border: 1px solid color-mix(in srgb, var(--ticker-color) 30%, white);',
    );
    expect(baseTickerRule).toContain(
      'color-mix(in srgb, var(--ticker-color) 10%, white)',
    );
    expect(baseTickerRule).toContain('--ticker-ink: hsl(219 69% 36%);');
    expect(styles).toMatch(
      /\.today-panorama-operations-ticker\[data-tone='alert'\]\s*\{[^}]*--ticker-ink:\s*hsl\(354 66% 42%\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-operations-ticker\[data-tone='warning'\]\s*\{[^}]*--ticker-ink:\s*hsl\(28 92% 32%\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-operations-ticker\[data-tone='success'\]\s*\{[^}]*--ticker-ink:\s*hsl\(142 66% 29%\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-operations-ticker\s*\{[^}]*box-shadow:\s*inset 4px 0 0 var\(--ticker-color\)/s,
    );
    expect(baseTickerRule).toMatch(
      /0 6px 18px color-mix\(in srgb,\s*var\(--ticker-color\) 12%,\s*transparent\)/,
    );
    expect(keyTickerRule).toContain(
      'color-mix(in srgb, var(--ticker-color) 14%, white)',
    );
    expect(keyTickerRule).toContain('inset 6px 0 0 var(--ticker-color)');
    expect(styles).toMatch(
      /\.today-panorama-ticker-icon\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/s,
    );
    expect(tickerCopyRule).not.toMatch(/animation:/);
    expect(tickerContentRule).toMatch(
      /animation:\s*todayPanoramaTickerFade 420ms/,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-control:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--ticker-ink\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-heading strong\s*\{[^}]*font-size:\s*14px;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-heading strong\s*\{[^}]*color:\s*var\(--ticker-ink\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-icon\s*\{[^}]*color:\s*var\(--ticker-ink\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-progress\s*\{[^}]*color:\s*var\(--ticker-ink\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-key-badge\s*\{[^}]*background:\s*var\(--ticker-ink\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-detail\s*\{[^}]*font-size:\s*13px;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-ticker-progress\s*\{[^}]*padding:\s*2px 8px;[^}]*border-radius:\s*999px;/s,
    );
    expect(styles).toContain(
      ".today-panorama-operations-ticker[data-emphasis='key']",
    );
    expect(styles).toContain('.today-panorama-ticker-copy');
    expect(styles).toContain('.today-panorama-ticker-content');
    expect(styles).toContain('@keyframes todayPanoramaTickerFade');
    expect(mobileTicker).toMatch(
      /\.today-panorama-operations-ticker\s*\{[^}]*grid-template-columns:\s*40px minmax\(0,\s*1fr\) 32px;/s,
    );
    expect(mobileTicker).toMatch(
      /\.today-panorama-ticker-progress\s*\{[^}]*display:\s*none;/s,
    );
    expect(mobileTicker).toMatch(
      /\.today-panorama-ticker-detail\s*\{[^}]*-webkit-line-clamp:\s*2;/s,
    );
    expect(reducedMotion).toMatch(
      /\.today-panorama-ticker-content,[^{]*\{[^}]*animation:\s*none !important;/s,
    );
  });

  it('uses slow semantic status signals and curated operations data', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const dataSource = readSource(
      'client/src/pages/TodayOperationsPanorama/data.ts',
    );

    expect(pageSource).toContain('function KpiSignal');
    expect(pageSource).not.toContain('function MiniTrend');
    expect(pageSource).toContain('data-direction={direction}');
    expect(styles).toContain('@keyframes todayPanoramaSignalBreath');
    expect(styles).toMatch(
      /\.today-panorama-kpi-signal\[data-direction='up'\][\s\S]*--signal-color:\s*hsl\(354 70% 54%\)/,
    );
    expect(styles).toMatch(
      /\.today-panorama-kpi-signal\[data-direction='down'\][\s\S]*--signal-color:\s*hsl\(142 66% 37%\)/,
    );
    expect(styles).toMatch(
      /\.today-panorama-kpi-signal\[data-direction='neutral'\][\s\S]*--signal-color:\s*hsl\(217 91% 57%\)/,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*today-panorama-kpi-signal/,
    );
    expect(dataSource).toContain("title: '其他事宜'");
    expect(dataSource).toContain("{ label: '今日施工', value: '0 项' }");
    expect(dataSource).toContain("{ label: '其他事宜', value: '0 项' }");
    expect(dataSource).not.toContain("label: '重要客户服务'");
    expect(dataSource).toContain("footer: '其他事宜：0 项'");
  });

  it('groups alarm content and removes visual chart clutter', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const chartsSource = readSource(
      'client/src/pages/TodayOperationsPanorama/charts.tsx',
    );
    const alarmDialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/AlarmDetailDialog.tsx',
    );

    expect(pageSource).toContain(
      '<SectionHeading index="03" title="园区近日告警信息总览" />',
    );
    expect(pageSource).toContain('today-panorama-alarm-overview');
    expect(pageSource.indexOf('today-panorama-alarm-overview')).toBeLessThan(
      pageSource.indexOf('today-panorama-alarm-kpi-grid'),
    );
    expect(chartsSource).not.toContain('<CartesianGrid');
    expect(chartsSource.match(/<YAxis\s+hide/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(chartsSource).toContain('dataKey="unclassified"');
    expect(chartsSource).not.toContain('minPointSize');
    expect(chartsSource).toContain('formatAlarmBarLabel');
    expect(chartsSource).toContain('resolveAlarmChartSelection');
    expect(chartsSource).toContain('onSelect');
    expect(pageSource).toContain('building={alarmDetail?.building}');
    expect(alarmDialogSource).toContain('building?: string');
    expect(alarmDialogSource).toContain('building,');
    expect(alarmDialogSource).toContain('const scopeKey =');
    expect(pageSource).toContain('未分类');
    expect(pageSource).not.toContain(
      '未分类告警 {visibleData.summary.unclassifiedTotal} 条',
    );
  });

  it('opens data-backed operations and alarm KPI cards as accessible detail dialogs', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const operationsDialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/OperationsDetailDialog.tsx',
    );
    const onDutyDialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/OnDutyPeopleDialog.tsx',
    );
    const buildingMetricDialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/BuildingMetricDetailDialog.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const apiSource = readSource('client/src/api/index.ts');

    expect(pageSource).toContain("from './OperationsDetailDialog'");
    expect(pageSource).toContain("from './OnDutyPeopleDialog'");
    expect(pageSource).toContain("from './BuildingMetricDetailDialog'");
    expect(pageSource).toContain("from './AlarmDetailDialog'");
    expect(pageSource).toContain('onOpenDetails');
    expect(pageSource).toContain('onKpiClick');
    expect(pageSource).toContain("item.key === 'on-duty'");
    expect(pageSource).toContain("item.key === 'average-pue'");
    expect(pageSource).toContain("item.key === 'electricity'");
    expect(pageSource).toContain("item.key === 'water'");
    expect(pageSource).toContain('setBuildingMetricKey');
    expect(pageSource).toContain('topKpiData?.details.buildingMetrics');
    expect(pageSource).toContain(
      'buildOnDutyDialogModel(topKpiData, onDutyLeadShift)',
    );
    expect(pageSource).toContain('resolveShanghaiOnDutyLeadShift(now)');
    expect(pageSource).toContain(
      'buildTopKpis(topKpiData.metrics, topKpiData.details, onDutyLeadShift)',
    );
    expect(pageSource).not.toContain('topKpiData.details.onDutyPeople');
    expect(pageSource).toContain('setOnDutyDialogOpen');
    expect(pageSource).toContain('buildOperationsTickerItems(');
    expect(pageSource).toContain('networkFreezeDetailModel');
    expect(apiSource).toContain('metric: options.metric');
    expect(styles).toContain('.today-panorama-maintenance-card.is-interactive');
    expect(styles).toContain('.today-panorama-detail-dialog');
    expect(styles).toContain('.today-panorama-detail-row.is-key');
    expect(styles).toContain('.today-panorama-on-duty-building');
    expect(onDutyDialogSource).toContain('今日在岗人员');
    expect(onDutyDialogSource).not.toContain('白班与夜班在岗口径');
    expect(onDutyDialogSource).toContain('model.shifts.map');
    expect(onDutyDialogSource).toContain('shift.buildings.map');
    expect(onDutyDialogSource).toContain('building.people.map');
    expect(onDutyDialogSource).toContain('person.statusLabel');
    expect(onDutyDialogSource).toContain('person.relatedStaff');
    expect(pageSource).toContain('useTodayAttendanceSnapshot');
    expect(pageSource).toContain('attendance={todayAttendance}');
    expect(onDutyDialogSource).toContain('TodayAttendanceSnapshot');
    expect(onDutyDialogSource).toContain('今日考勤异常');
    expect(onDutyDialogSource).toContain('TodayAttendanceAnomalyList');
    expect(apiSource).toContain("url: '/api/attendance/today'");
    expect(onDutyDialogSource).toContain(
      "model.shifts.map(formatShiftSummary).join(' · ')",
    );
    expect(onDutyDialogSource).toContain(
      '当前缓存仅包含人数汇总，具体人员清单将在刷新后显示',
    );
    expect(buildingMetricDialogSource).toContain(
      "const BUILDING_ORDER = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼']",
    );
    expect(buildingMetricDialogSource).not.toContain(
      '园区用电量为 A–E 五栋楼当期数据之和',
    );
    expect(buildingMetricDialogSource).not.toContain(
      '园区耗水量为 A–E 五栋楼当期数据之和',
    );
    expect(buildingMetricDialogSource).not.toContain('D/E 不参与园区平均');
    expect(buildingMetricDialogSource).toContain('includedBuildings');
    expect(buildingMetricDialogSource).toContain('暂无数据');
    expect(buildingMetricDialogSource).not.toContain("from '@/api'");
    expect(pageSource).toContain('buildingMetricTriggerRef');
    expect(pageSource).toContain(
      'restoreFocusTo={buildingMetricTriggerRef.current}',
    );
    expect(buildingMetricDialogSource).toContain('onCloseAutoFocus');
    expect(buildingMetricDialogSource).toContain('restoreFocusTo?.focus');
    expect(styles).toContain('.today-panorama-building-metric-grid');
    expect(styles).toContain('.today-panorama-building-metric-card');
    expect(operationsDialogSource).not.toContain(
      "item.owner || '负责人待补充'",
    );
    expect(operationsDialogSource).toContain('维修方式');
    expect(operationsDialogSource).toContain('实际开始时间');
    expect(operationsDialogSource).toContain('预期结束时间');
    expect(operationsDialogSource).toContain('检修天数');
    expect(operationsDialogSource).toContain('维保楼栋');
    expect(operationsDialogSource).toContain('sanitizeWorkFacet');
    expect(operationsDialogSource).toContain('getWorkStatusLabel');
    expect(operationsDialogSource).toContain('scrollRef');
    expect(operationsDialogSource).toContain('scrollTop = 0');
    expect(operationsDialogSource).toContain('useMemo');
    expect(operationsDialogSource).toContain('today-panorama-work-list');
    expect(operationsDialogSource).toContain('today-panorama-work-status');
    expect(operationsDialogSource).toContain('已恢复');
    expect(pageSource).toContain('operationsDetailTriggerRef');
    expect(operationsDialogSource).toContain('onCloseAutoFocus');
    expect(operationsDialogSource).toContain('restoreFocusTo?.focus');
    expect(operationsDialogSource).not.toContain('min-w-[240px]');
    expect(operationsDialogSource).not.toContain('min-w-[300px]');
    expect(styles).toContain('.today-panorama-work-list');
    expect(styles).toContain('.today-operations-dialog-row');
    expect(styles).toContain('content-visibility: auto');
    expect(styles).toMatch(
      /\.today-panorama-work-title\s*\{[^}]*-webkit-line-clamp:\s*3;/s,
    );
    expect(styles).toMatch(
      /\.today-operations-dialog-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(210px,\s*290px\)\s+max-content;/s,
    );
  });

  it('opens the sealing card from cached data and shares its concrete records with the ticker', () => {
    const pageSource = readSource(
      'client/src/pages/TodayOperationsPanorama/index.tsx',
    );
    const dialogSource = readSource(
      'client/src/pages/TodayOperationsPanorama/SealingDetailDialog.tsx',
    );
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );

    expect(pageSource).toContain("from './SealingDetailDialog'");
    expect(pageSource).toContain('buildNetworkFreezeDetailModel');
    expect(pageSource).toContain('networkFreezeDetailModel');
    expect(pageSource).toContain("item.key === 'network-freeze'");
    expect(pageSource).toContain('setSealingDialogOpen(true)');
    expect(pageSource).toContain('<SealingDetailDialog');
    expect(pageSource).toContain('model={networkFreezeDetails}');
    expect(pageSource).toContain('loadState={sealingLoadState}');
    expect(pageSource).toContain(
      'restoreFocusTo={sealingDetailTriggerRef.current}',
    );
    expect(pageSource).toContain('SEALING_REFRESH_INTERVAL_MS = 5 * 60 * 1000');
    expect(pageSource).toContain("responses.some((response) => response.sourceStatus === 'stale')");
    expect(dialogSource).not.toContain("from '@/api'");
    expect(dialogSource).toContain('封网安排清单');
    expect(dialogSource).toContain('今日封网');
    expect(dialogSource).toContain('未来 7 天封网');
    expect(dialogSource).toContain('model.todayItems');
    expect(dialogSource).toContain('model.nextSevenDaysItems');
    expect(dialogSource).toContain('封网编号');
    expect(dialogSource).toContain('管控类型');
    expect(dialogSource).toContain('开始时间');
    expect(dialogSource).toContain('结束时间');
    expect(dialogSource).not.toMatch(/<span>\s*<dt>/);
    expect(dialogSource).toMatch(
      /<dt>[\s\S]*?<Hash[\s\S]*?封网编号[\s\S]*?<\/dt>/,
    );
    expect(dialogSource).toContain('当前展示最近一次成功同步的数据');
    expect(dialogSource).toContain('onCloseAutoFocus');
    expect(dialogSource).toContain('restoreFocusTo?.focus');
    expect(dialogSource).toContain("from './sealing-timeline-model'");
    expect(dialogSource).toContain('buildSealingTimelineModel');
    expect(dialogSource).toContain('未来 7 天封网时段');
    expect(dialogSource).toContain('未来 168 小时连续视图');
    expect(dialogSource).toContain('小时颗粒度');
    expect(dialogSource).toContain('封网时段');
    expect(dialogSource).toContain('focusSealingRecord');
    expect(dialogSource).toContain('registerSealingRow');
    expect(dialogSource).toContain('data-edge=');
    expect(dialogSource).toContain('today-panorama-sealing-timeline-gantt');
    expect(dialogSource).toContain('today-panorama-sealing-timeline-record');
    expect(dialogSource).not.toContain('today-panorama-sealing-timeline-days');
    expect(styles).toContain('.today-panorama-sealing-dialog');
    expect(styles).toContain('.today-panorama-sealing-list');
    expect(styles).toContain('.today-panorama-sealing-row');
    expect(styles).toContain('.today-panorama-sealing-timeline');
    expect(styles).toContain('.today-panorama-sealing-timeline-track');
    expect(styles).toContain('.today-panorama-sealing-timeline-segment');
    expect(styles).toContain('.today-panorama-sealing-timeline-record-info');
    expect(styles).toMatch(
      /\.today-panorama-sealing-groups\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-sealing-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s,
    );
    expect(styles).not.toMatch(
      /\.today-panorama-sealing-timeline-track\s*\{[^}]*background-image:/s,
    );
    expect(styles).toContain("[data-edge='start']");
    expect(styles).toContain("[data-edge='end']");
    expect(styles).toContain(':focus-visible');
  });

  it('hides the visible sync footer while retaining live refresh behavior', () => {
    const operationsSource = readSource(
      'client/src/pages/TodayOperationsPanorama/OperationsPanels.tsx',
    );

    expect(operationsSource).not.toContain('<SyncStatusFooter');
    expect(operationsSource).not.toContain('最近同步：');
    expect(operationsSource).not.toContain('数据来源：');
    expect(operationsSource).toContain('getCampusOperationsDashboard');
    expect(operationsSource).toContain(
      'CAMPUS_OPS_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000',
    );
    expect(operationsSource).toContain('loadDashboardData(allowForceRefresh)');
    expect(operationsSource).toContain(
      "data-screenshot-ready={syncStatus === 'syncing' ? 'false' : 'true'}",
    );
  });

  it('keeps dashboard density compact without collapsing the desktop KPI row early', () => {
    const styles = readSource(
      'client/src/pages/TodayOperationsPanorama/styles.css',
    );
    const media1440 = readMediaBlock(styles, '@media (max-width: 1440px)');
    const media1280 = readMediaBlock(styles, '@media (max-width: 1280px)');
    const media720 = readMediaBlock(styles, '@media (max-width: 720px)');

    expect(styles).toMatch(
      /\.today-panorama-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(media1440).not.toMatch(
      /\.today-panorama-kpi-grid\s*\{[^}]*grid-template-columns:/s,
    );
    expect(media1280).toMatch(
      /\.today-panorama-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(media720).toMatch(
      /\.today-panorama-kpi-grid,[^}]*grid-template-columns:\s*1fr;/s,
    );
    expect(media720).toMatch(
      /\.today-operations-panorama \.campus-ops-machine-panel\s*\{[^}]*overflow-x:\s*auto;/s,
    );

    expect(
      readPixelValue(styles, '.today-panorama-section-stack', 'gap'),
    ).toBeLessThanOrEqual(16);
    expect(
      readPixelValue(styles, '.today-panorama-kpi-card', 'min-height'),
    ).toBeLessThanOrEqual(96);
    expect(
      readPixelValue(
        styles,
        '.today-operations-panorama .campus-ops-panel',
        'height',
      ),
    ).toBeLessThanOrEqual(388);
    expect(
      readPixelValue(styles, '.today-panorama-section-card', 'min-height'),
    ).toBeLessThanOrEqual(400);
    expect(
      readPixelValue(styles, '.today-panorama-chart-card', 'min-height'),
    ).toBeLessThanOrEqual(300);
  });
});
