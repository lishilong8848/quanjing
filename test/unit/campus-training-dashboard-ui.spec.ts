import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  buildSmoothAreaPath,
  buildSmoothLinePath,
  resolveRateLabelY,
  type ChartPoint,
} from '../../client/src/pages/CampusTrainingDashboard/chart-geometry';

function readSource(relativePath: string): string {
  const path = join(process.cwd(), relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function sourceBlock(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  if (start === -1) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

function expectDescribedHiddenList(
  componentSource: string,
  requiredFields: readonly string[],
): void {
  const describedByMatch = componentSource.match(
    /<svg[\s\S]{0,400}?aria-describedby=(["'])([^"']+)\1/,
  );
  expect(describedByMatch).not.toBeNull();
  if (!describedByMatch) return;

  const describedBy = describedByMatch[2];
  const idIndex = componentSource.indexOf(`id="${describedBy}"`);
  const listStart = componentSource.lastIndexOf('<ul', idIndex);
  const listEnd = componentSource.indexOf('</ul>', idIndex);
  expect(idIndex).toBeGreaterThan(-1);
  expect(listStart).toBeGreaterThan(-1);
  expect(listEnd).toBeGreaterThan(idIndex);
  if (idIndex === -1 || listStart === -1 || listEnd === -1) return;

  const listSource = componentSource.slice(listStart, listEnd + 5);
  const openingTag = listSource.slice(0, listSource.indexOf('>') + 1);
  expect(openingTag).toContain('className="sr-only"');
  expect(listSource).toContain('data.map');
  expect(listSource).toContain('<li');
  for (const field of requiredFields) {
    expect(listSource).toContain(field);
  }
}

describe('campus training dashboard UI', () => {
  it('builds midpoint cubic line paths without numeric overshoot', () => {
    const points: readonly ChartPoint[] = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 10 },
    ];

    expect(buildSmoothLinePath(points)).toBe(
      'M 10 20 C 20 20 20 40 30 40 C 40 40 40 10 50 10',
    );
    expect(buildSmoothLinePath([])).toBe('');
    expect(buildSmoothLinePath([{ x: 10, y: 20 }])).toBe('M 10 20');
  });

  it('closes a smooth area path against the requested baseline', () => {
    const points: readonly ChartPoint[] = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 10 },
    ];

    expect(buildSmoothAreaPath(points, 100)).toBe(
      'M 10 20 C 20 20 20 40 30 40 C 40 40 40 10 50 10 L 50 100 L 10 100 Z',
    );
    expect(buildSmoothAreaPath([], 100)).toBe('');
  });

  it('moves rate labels away from occupied bar-value baselines', () => {
    expect(resolveRateLabelY(38, [38, 38], 12, 208)).toBe(20);
    expect(resolveRateLabelY(196, [209, 209], 12, 208)).toBe(191);
    expect(resolveRateLabelY(133, [152, 190], 12, 208)).toBe(133);
    expect(resolveRateLabelY(20, [20], 12, 208)).toBe(38);
  });

  it('registers the dashboard in the unified protected page with legacy redirects', () => {
    const appSource = readSource('client/src/app.tsx');
    const switcherSource = readSource('client/src/navigation/page-switcher.ts');

    expect(appSource).toContain(
      "import('./pages/TrainingCertificationManagement')",
    );
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
    expect(appSource).toContain('path="/training-certification-management"');
    expect(appSource).toContain(
      'element={<TrainingCertificationManagementPage />}',
    );
    expect(appSource).toContain('path="/campus-training-dashboard"');
    expect(appSource).toContain(
      'to="/training-certification-management?module=training"',
    );
    expect(switcherSource).toContain("label: '培训持证'");
    expect(switcherSource).toContain(
      "path: '/training-certification-management'",
    );
  });

  it('loads the real dashboard API and exposes loading, error, retry, empty, and stale states', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );

    expect(pageSource).toContain('getCampusTrainingDashboard');
    expect(pageSource).toMatch(
      /useState<CampusTrainingDashboardResponse\s*\|\s*null>\(null\)/,
    );
    expect(pageSource).toContain('aria-busy={loading}');
    expect(pageSource).toContain('training-dashboard-loading');
    expect(pageSource).toContain('training-dashboard-error');
    expect(pageSource).toContain('training-dashboard-empty');
    expect(pageSource).toContain('training-dashboard-stale');
    expect(pageSource).toContain('role="alert"');
    expect(pageSource).toMatch(
      /training-dashboard-state training-dashboard-empty"[\s\S]{0,120}role="status"/,
    );
    expect(pageSource).toContain('重新加载');
    expect(pageSource).toMatch(
      /data-screenshot-ready=\{\s*dashboard\s*&&\s*!loading\s*\?/,
    );

    for (const stateClass of [
      '.training-dashboard-loading',
      '.training-dashboard-error',
      '.training-dashboard-empty',
      '.training-dashboard-stale',
    ]) {
      expect(styles).toContain(stateClass);
    }
    expect(styles).toContain(':focus-visible');
  });

  it('reloads selected months, supports forced retry, and prevents stale requests from winning', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const usesRequestSequence =
      /(?:requestId|requestSequence|visibleRequestId)\w*Ref\s*=\s*useRef\(0\)/.test(
        pageSource,
      ) &&
      /\+\+(?:requestId|requestSequence|visibleRequestId)\w*Ref\.current/.test(
        pageSource,
      ) &&
      /requestId\s*={2,3}\s*(?:requestId|requestSequence|visibleRequestId)\w*Ref\.current/.test(
        pageSource,
      );
    const usesRequestCancellation =
      pageSource.includes('AbortController') &&
      /\.abort\(\)/.test(pageSource) &&
      /\bsignal\b/.test(pageSource);

    expect(pageSource).toMatch(
      /getCampusTrainingDashboard\(\s*\w+\s*,\s*forceRefresh\s*\)/,
    );
    expect(pageSource).toMatch(/handleMonthChange[\s\S]{0,800}loadDashboard\(/);
    expect(pageSource).toMatch(/loadDashboard\(\s*month\s*,\s*true\s*\)/);
    expect(pageSource).toMatch(/selectableMonths\.map\(\s*\(/);
    expect(usesRequestSequence || usesRequestCancellation).toBe(true);
  });

  it('polls only an active background refresh with a bounded serial scheduler', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const loadDashboardSource = sourceBlock(
      pageSource,
      '  const loadDashboard = useCallback(',
      '\n  useEffect(() => {',
    );

    expect(loadDashboardSource).toMatch(
      /forceRefresh\s*=\s*false,\s*silent\s*=\s*false/,
    );
    expect(pageSource).toContain("dashboardSourceStatus !== 'refreshing'");
    expect(pageSource).toContain('return startTrainingRefreshPolling(');
    expect(pageSource).not.toContain('window.setInterval');
    expect(pageSource).toMatch(
      /loadDashboard\(\s*dashboardMonth\s*,\s*false\s*,\s*true\s*\)/,
    );
    expect(pageSource).toContain('已暂停自动查询');
    expect(pageSource).toContain('刷新重试');
    expect(loadDashboardSource).toMatch(/if\s*\(\s*!silent\s*\)/);
  });

  it('keeps embedded synchronization feedback before the content in normal flow', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );
    expect(
      pageSource.indexOf("dashboard?.sourceStatus === 'refreshing'"),
    ).toBeLessThan(pageSource.indexOf('{!dashboard ? ('));
    expect(
      pageSource.indexOf("dashboard?.sourceStatus === 'stale'"),
    ).toBeLessThan(pageSource.indexOf('{!dashboard ? ('));
    expect(styles).toMatch(
      /\.campus-training-dashboard-embedded \.training-dashboard-state-banner\s*\{[^}]*position:\s*relative;[^}]*inset:\s*auto;[^}]*width:\s*100%;[^}]*transform:\s*none;/s,
    );
  });

  it('does not let silent polling invalidate a visible refresh request', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const loadDashboardSource = sourceBlock(
      pageSource,
      '  const loadDashboard = useCallback(',
      '\n  useEffect(() => {',
    );

    expect(pageSource).toContain('visibleRequestIdRef');
    expect(pageSource).toContain('silentRequestIdRef');
    expect(loadDashboardSource).toMatch(
      /silent\s*\?\s*\+\+silentRequestIdRef\.current\s*:\s*\+\+visibleRequestIdRef\.current/,
    );
    expect(loadDashboardSource).toContain(
      'visibleRequestIdAtStart === visibleRequestIdRef.current',
    );
    expect(loadDashboardSource).toContain('silentRequestIdRef.current += 1');
    expect(loadDashboardSource).toMatch(
      /!silent\s*&&\s*requestId\s*===\s*visibleRequestIdRef\.current/,
    );
  });

  it('limits the month menu to non-future months with five visible scrollable rows', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );

    expect(pageSource).toContain('availableMonth <= currentTrainingMonth()');
    expect(pageSource).toContain('className="training-month-content"');
    expect(styles).toMatch(
      /\.training-month-content\s*\{[^}]*max-height:\s*216px;[^}]*overscroll-behavior:\s*contain;/s,
    );
    expect(styles).toMatch(
      /\.training-month-content \[data-radix-select-viewport\]\s*\{[^}]*max-height:\s*168px;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it('requests the current month initially and removes the training platform entry and detail page', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );

    expect(pageSource).toContain('currentTrainingMonth');
    expect(pageSource).toMatch(
      /loadDashboard\(\s*(?:default|current)\w*Month(?:Ref\.current)?\s*,\s*false\s*\)/,
    );
    expect(pageSource).not.toContain('员工培训平台');
    expect(pageSource).not.toContain('training-course-details');
    expect(pageSource).not.toContain('CourseDetailPanel');
    expect(pageSource).not.toContain('新员工培训课程详情');
    expect(styles).toMatch(
      /\.training-secondary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*grid-template-rows:\s*220px 328px;/s,
    );
  });

  it('validates every API response before committing it', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const loadDashboardSource = sourceBlock(
      pageSource,
      '  const loadDashboard = useCallback(',
      '\n  useEffect(() => {',
    );
    const validationMatch =
      /isCampusTrainingDashboardResponse\(\s*\w+\s*\)/.exec(
        loadDashboardSource,
      );
    const commitIndex = loadDashboardSource.indexOf('setDashboard(');

    expect(loadDashboardSource).not.toBe('');
    expect(validationMatch).not.toBeNull();
    expect(commitIndex).toBeGreaterThan(-1);
    expect(validationMatch?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(
      commitIndex,
    );
  });

  it('clears old notices before every dashboard request begins', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const loadDashboardSource = sourceBlock(
      pageSource,
      '  const loadDashboard = useCallback(',
      '\n  useEffect(() => {',
    );
    const requestIndex = loadDashboardSource.indexOf(
      'await getCampusTrainingDashboard',
    );
    const noticeClearIndex = loadDashboardSource.indexOf("setNotice('')");

    expect(requestIndex).toBeGreaterThan(-1);
    expect(noticeClearIndex).toBeGreaterThan(-1);
    expect(noticeClearIndex).toBeLessThan(requestIndex);
  });

  it('announces a successful forced refresh only for a fresh response', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const loadDashboardSource = sourceBlock(
      pageSource,
      '  const loadDashboard = useCallback(',
      '\n  useEffect(() => {',
    );
    const successCondition =
      /if\s*\(([^)]*)\)\s*\{\s*setNotice\(\s*['"]培训数据已重新加载['"]\s*\)/.exec(
        loadDashboardSource,
      )?.[1];

    expect(successCondition).toContain('forceRefresh');
    expect(successCondition).toMatch(/\w+\.sourceStatus\s*===\s*['"]fresh['"]/);
  });

  it('renders metric mini trends from the response instead of static chart data', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );

    expect(pageSource).toContain('dashboard.metricTrends[definition.key]');
    expect(pageSource).toContain('chartMax');
    expect(pageSource).not.toContain('getTrainingDashboardView');
    expect(pageSource).not.toContain('MINI_TRENDS');
    expect(pageSource).not.toContain('TRAINING_MONTHS');
    expect(pageSource).not.toContain('DEFAULT_TRAINING_MONTH');
  });

  it('renders the reference hierarchy and accessible chart semantics', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );

    expect(pageSource).toContain(
      'data-screenshot-target="campus-training-dashboard"',
    );
    expect(pageSource).toContain('培训进展看板');
    expect(pageSource).toContain('本月在岗考核课程进展');
    expect(pageSource).toContain('本月培训情况');
    expect(pageSource).toContain('新人培训计划');
    expect(pageSource).toContain('分享会开展情况');
    expect(pageSource).toContain('aria-label="本月考核课程进度组合图"');
    expect(pageSource).toContain('role="progressbar"');
  });

  it('describes the progress chart with a hidden structured data list', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const progressChartSource = sourceBlock(
      pageSource,
      'function TrainingProgressChart',
      '\nfunction ParticipationPanel',
    );

    expectDescribedHiddenList(progressChartSource, [
      'item.building',
      'item.planned',
      'item.completed',
      'item.rate',
    ]);
    expect(progressChartSource).toContain(
      'aria-describedby="training-progress-chart-data"',
    );
    expect(progressChartSource).toContain('本月需考核课程数');
    expect(progressChartSource).toContain('已完成考核课程数');
    expect(progressChartSource).toContain('考核课程完成率');
    expect(progressChartSource).not.toContain('本月计划培训课数');
  });

  it('uses separated gradient bars and a rate area without vertical-axis labels', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const progressChartSource = sourceBlock(
      pageSource,
      'function TrainingProgressChart',
      '\nfunction ParticipationPanel',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );

    expect(progressChartSource).toContain('training-rate-area-gradient');
    expect(progressChartSource).toContain('className="training-rate-area"');
    expect(progressChartSource).toContain('className="training-rate-line"');
    expect(progressChartSource).not.toContain(
      'className="training-chart-axis-title"',
    );
    expect(progressChartSource).not.toContain(
      'className="training-chart-tick"',
    );
    expect(progressChartSource).toContain(
      '<stop offset="0%" stopColor="#085af4"',
    );
    expect(progressChartSource).toContain(
      '<stop offset="100%" stopColor="#8ab8ff"',
    );
    expect(styles).toContain('.training-rate-area');
  });

  it('draws the smooth rate layers behind bars with foreground points and labels', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const progressChartSource = sourceBlock(
      pageSource,
      'function TrainingProgressChart',
      '\nfunction ParticipationPanel',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );
    const rateLabelStyles = sourceBlock(
      styles,
      '.training-rate-label {',
      '\n}',
    );

    expect(progressChartSource).toContain('const rateCoordinates = data.map');
    expect(progressChartSource).toContain(
      'buildSmoothAreaPath(rateCoordinates, plot.bottom)',
    );
    expect(progressChartSource).toContain(
      'buildSmoothLinePath(rateCoordinates)',
    );
    expect(progressChartSource).not.toContain('<polygon');
    expect(progressChartSource).not.toContain('<polyline');
    expect(progressChartSource).not.toContain('training-chart-grid');
    expect(progressChartSource).toContain('className="training-chart-axis"');
    expect(
      progressChartSource.match(/className="training-chart-axis"/g),
    ).toHaveLength(1);
    expect(progressChartSource).toContain(
      'const barWidth = Math.min(20, Math.max(10, step * 0.18));',
    );
    expect(progressChartSource).toContain(
      'const barGap = Math.min(16, Math.max(12, step * 0.12));',
    );
    expect(progressChartSource).toContain(
      'const preferredRateLabelY = Math.max(plot.top + 12, y - 20);',
    );
    expect(progressChartSource).toContain(
      'const rateLabelY = resolveRateLabelY(',
    );
    expect(progressChartSource).toContain('[plannedValueY, completedValueY]');
    expect(progressChartSource).toContain('const rateLabelMinY = 12;');
    expect(progressChartSource).toContain(
      'const rateLabelMaxY = plot.bottom - 8;',
    );
    expect(progressChartSource).toContain('y={plannedValueY}');
    expect(progressChartSource).toContain('y={completedValueY}');
    expect(progressChartSource).toContain('y={rateLabelY}');

    const layerMarkers = [
      'className="training-chart-axis"',
      'className="training-rate-area"',
      'className="training-rate-line"',
      'fill="url(#training-planned-gradient)"',
      'className="training-chart-value"',
      'className="training-rate-point"',
      'className="training-rate-label"',
    ];
    const layerIndexes = layerMarkers.map((marker) =>
      progressChartSource.indexOf(marker),
    );
    expect(layerIndexes).not.toContain(-1);
    for (let index = 1; index < layerIndexes.length; index += 1) {
      expect(layerIndexes[index - 1]).toBeLessThan(layerIndexes[index]);
    }

    expect(rateLabelStyles).toContain('stroke: var(--training-surface);');
    expect(rateLabelStyles).toContain('paint-order: stroke fill;');
    expect(styles).not.toContain('.training-chart-grid');
  });

  it('redesigns the current-month table around building completion and assessment rates', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const participationSource = sourceBlock(
      pageSource,
      'function ParticipationPanel',
      '\nfunction NewHirePlanPanel',
    );

    expect(participationSource).not.toContain('机构名称');
    expect(participationSource).not.toContain('南通机房');
    expect(participationSource).not.toContain('参与率');
    expect(participationSource).toContain('<TableHead>楼栋</TableHead>');
    expect(participationSource).toContain('<TableHead>培训完成率</TableHead>');
    expect(participationSource).toContain(
      '<TableHead>考核课程达标率</TableHead>',
    );
    expect(participationSource).not.toContain(
      '<TableHead>考核通过率</TableHead>',
    );
    expect(participationSource).toContain('item.trainingCompletionRate');
    expect(participationSource).toContain('item.assessmentPassRate');
  });

  it('opens one accessible detail dialog from metrics, charts, and data rows', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );

    expect(pageSource).toContain("from './TrainingDetailDialog'");
    expect(pageSource).toContain("from './training-detail-model'");
    expect(pageSource).not.toContain('function TrainingDetailDialog');
    expect(pageSource).not.toContain('function buildMetricDetail');
    expect(pageSource).toContain('setDetail(');
    expect(pageSource).toMatch(/MetricCard[\s\S]*onOpen=/);
    expect(pageSource).toMatch(/TrainingProgressChart[\s\S]*onOpen=/);
    expect(pageSource).toMatch(/ParticipationPanel[\s\S]*onRowOpen=/);
    expect(pageSource).toMatch(/NewHirePlanPanel[\s\S]*onRowOpen=/);
    expect(pageSource).toMatch(/SharingPanel[\s\S]*onOpen=/);
    expect(pageSource).toContain('training-clickable');
    expect(pageSource).toContain('const detailCache = useMemo');
    expect(pageSource).toContain('detailCache.metricDetails.get');
    expect(pageSource).toContain('detailCache.participationDetails.get');
    expect(pageSource).toContain('detailCache.newHireDetails.get');
  });

  it('caps each detail page at 20 rows so cached dialogs open within the interaction budget', () => {
    const dialogSource = readSource(
      'client/src/pages/CampusTrainingDashboard/TrainingDetailDialog.tsx',
    );

    expect(dialogSource).toContain('const DETAIL_PAGE_SIZE = 20');
    expect(dialogSource).toContain('DETAIL_PAGE_SIZE');
    expect(dialogSource).toContain('training-detail-pagination');
    expect(dialogSource).toContain('preparedDetail === detail');
    expect(dialogSource).toContain('window.setTimeout');
    expect(dialogSource).toContain('training-detail-preparing');
  });

  it('describes the sharing trend chart with a hidden structured data list', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const sharingChartSource = sourceBlock(
      pageSource,
      'function SharingTrendChart',
      '\nfunction SharingPanel',
    );

    expectDescribedHiddenList(sharingChartSource, [
      'item.month',
      'item.sessions',
    ]);
  });

  it('uses a smooth sharing trend without horizontal chart grid lines', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const sharingChartSource = sourceBlock(
      pageSource,
      'function SharingTrendChart',
      '\nfunction SharingPanel',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );

    expect(sharingChartSource).toContain(
      'buildSmoothAreaPath(coordinates, plot.bottom)',
    );
    expect(sharingChartSource).toContain('buildSmoothLinePath(coordinates)');
    expect(sharingChartSource).not.toContain('<polygon');
    expect(sharingChartSource).not.toContain('<polyline');
    expect(sharingChartSource).not.toContain('training-sharing-grid');
    expect(sharingChartSource).toContain('className="training-sharing-axis"');
    expect(
      sharingChartSource.match(/className="training-sharing-axis"/g),
    ).toHaveLength(1);
    expect(sharingChartSource).toMatch(
      /<path[\s\S]*className="training-sharing-line"/,
    );
    expect(sharingChartSource).toContain('className="training-sharing-point"');
    expect(styles).not.toContain('.training-sharing-grid');
  });

  it('uses gradient bars, a fixed desktop stage, responsive reflow, and reduced motion', () => {
    const pageSource = readSource(
      'client/src/pages/CampusTrainingDashboard/index.tsx',
    );
    const certificationPageSource = readSource(
      'client/src/pages/CampusCertificateDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/CampusTrainingDashboard/styles.css',
    );
    const titleGroupSource = sourceBlock(
      pageSource,
      'className="training-dashboard-title-group"',
      'className="training-header-actions"',
    );
    const tabletStyles = sourceBlock(
      styles,
      '@media (max-width: 960px) {',
      '\n@media (max-width: 680px) {',
    );
    const mobileStyles = sourceBlock(
      styles,
      '@media (max-width: 680px) {',
      '\n@media (max-width: 520px) {',
    );
    const narrowMobileStyles = sourceBlock(
      styles,
      '@media (max-width: 520px) {',
      '\n@media (prefers-reduced-motion: reduce) {',
    );

    expect(pageSource).toContain('const STAGE_WIDTH = 1920');
    expect(pageSource).toContain('const STAGE_HEIGHT = 650');
    expect(certificationPageSource).toContain('const STAGE_WIDTH = 1920');
    expect(certificationPageSource).toContain('const STAGE_HEIGHT = 600');
    expect(pageSource).toContain('window.innerWidth / STAGE_WIDTH');
    expect(pageSource).not.toContain('window.innerHeight / STAGE_HEIGHT');
    expect(pageSource).toContain('training-planned-gradient');
    expect(pageSource).toContain('training-completed-gradient');
    expect(pageSource).toContain('className="training-dashboard-title-group"');
    expect(pageSource).toContain('className="training-dashboard-brand-icon"');
    expect(titleGroupSource).toContain('<GraduationCap />');
    expect(styles).toContain('.campus-training-dashboard');
    expect(styles).toMatch(
      /\.training-dashboard-stage\s*\{[^}]*grid-template-columns:\s*394px 778px 700px;[^}]*grid-template-rows:\s*56px 558px;[^}]*gap:\s*12px;[^}]*padding:\s*12px;/s,
    );
    expect(styles).toMatch(
      /\.training-metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*grid-template-rows:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.training-primary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*grid-template-rows:\s*278px 270px;/s,
    );
    expect(styles).toMatch(
      /\.training-secondary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*grid-template-rows:\s*220px 328px;/s,
    );
    expect(styles).toMatch(
      /\.training-panel \[data-slot='table-container'\]\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.training-participation-panel \[data-slot='table-container'\]\s*\{[^}]*overflow:\s*visible;/s,
    );
    expect(styles).toMatch(
      /\.training-sharing-panel > \.training-sharing-content\s*\{[^}]*grid-template-rows:\s*30px minmax\(0,\s*1fr\) 52px;/s,
    );
    expect(styles).toMatch(
      /\.training-sharing-trend-chart\s*\{[^}]*height:\s*100%;/s,
    );
    expect(styles).toMatch(
      /\.training-dashboard-state-banner\s*\{[^}]*top:\s*80px;/s,
    );
    expect(styles).toMatch(
      /\.training-dashboard-state-banner\.training-dashboard-loading,\s*\.training-dashboard-state-banner\.training-dashboard-error\s*\{[^}]*top:\s*122px;/s,
    );
    expect(styles).toMatch(
      /\.training-dashboard-notice\s*\{[^}]*top:\s*80px;/s,
    );
    expect(styles).toContain('conic-gradient(');
    expect(styles).toContain('@media (max-width: 960px)');
    expect(styles).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.campus-training-dashboard\s*\{[^}]*position:\s*relative;[^}]*inset:\s*auto;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.training-metric-grid,[\s\S]*?\.training-primary-grid,[\s\S]*?\.training-secondary-grid\s*\{[^}]*grid-template-rows:\s*auto;/s,
    );
    expect(tabletStyles).toMatch(
      /\.training-dashboard-state-banner\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*16px;/s,
    );
    expect(tabletStyles).toMatch(
      /\.training-dashboard-notice\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*16px;/s,
    );
    expect(tabletStyles).toMatch(
      /\.training-dashboard-state-banner\.training-dashboard-loading,\s*\.training-dashboard-state-banner\.training-dashboard-error\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*60px;/s,
    );
    expect(tabletStyles).toMatch(
      /\.training-metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(mobileStyles).toMatch(
      /\.training-metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(narrowMobileStyles).toMatch(
      /\.training-metric-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
