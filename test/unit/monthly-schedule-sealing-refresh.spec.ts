import { readFileSync } from 'fs';
import { join } from 'path';

describe('MonthlySchedule sealing refresh', () => {
  const apiSource = readFileSync(
    join(process.cwd(), 'client/src/api/index.ts'),
    'utf8',
  );
  const pageSource = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );
  const sealingApiStart = apiSource.indexOf(
    'export async function getYearlySealingInfo',
  );
  const sealingApiEnd = apiSource.indexOf(
    'export async function getYearlyChangeInfo',
    sealingApiStart,
  );
  const sealingApiSource = apiSource.slice(sealingApiStart, sealingApiEnd);

  it('forces sealing info refresh after manual local sync', () => {
    expect(sealingApiSource).toContain('refresh = false');
    expect(sealingApiSource).toContain(
      "params: { refresh: refresh ? '1' : undefined }",
    );
    expect(sealingApiSource).toContain(
      "headers: { 'Cache-Control': 'no-cache' }",
    );
    expect(pageSource).toMatch(
      /const loadSealingInfo = useCallback\(\s*async \(forceRefresh = false\)/,
    );
    expect(pageSource).toContain('if (!forceRefresh && cached)');
    expect(pageSource).toContain(
      'await getYearlySealingInfo(year, forceRefresh)',
    );
    expect(pageSource).toContain('loadSealingInfo(true)');
  });

  it('keeps externally added sealing records fresh without requiring a page reload', () => {
    const sealingLoaderStart = pageSource.indexOf(
      'const loadSealingInfo = useCallback',
    );
    const sealingLoaderEnd = pageSource.indexOf(
      'const loadChangeInfo = useCallback',
      sealingLoaderStart,
    );
    const sealingLoaderSource = pageSource.slice(
      sealingLoaderStart,
      sealingLoaderEnd,
    );
    const manualSyncStart = pageSource.indexOf(
      'const refreshAfterLocalSync = useCallback',
    );
    const manualSyncEnd = pageSource.indexOf(
      'const handleManualScreenshot = useCallback',
      manualSyncStart,
    );
    const manualSyncSource = pageSource.slice(manualSyncStart, manualSyncEnd);

    expect(pageSource).toContain(
      'const SEALING_INFO_CACHE_TTL_MS = 5 * 60 * 1000;',
    );
    expect(pageSource).toContain(
      'const SEALING_INFO_REVALIDATE_INTERVAL_MS = 60 * 1000;',
    );
    expect(sealingLoaderSource).toContain(
      'if (now - cached.fetchedAt < SEALING_INFO_CACHE_TTL_MS)',
    );
    expect(pageSource).toContain('const refreshSealingInfo = () => {');
    expect(pageSource).toContain('window.setInterval(');
    expect(pageSource).toContain('SEALING_INFO_REVALIDATE_INTERVAL_MS');
    expect(pageSource).toContain(
      "document.addEventListener('visibilitychange', refreshSealingInfo)",
    );
    expect(manualSyncSource).toContain('yearlySealingCache.clear();');
    expect(manualSyncSource).toContain('loadSealingInfo(true)');
    expect(manualSyncSource).toContain('sealingInfoLoaded');
  });

  it('revalidates guest-readable sealing reads without using the restricted refresh parameter', () => {
    expect(sealingApiSource).toContain(
      "params: { refresh: refresh ? '1' : undefined }",
    );
    expect(sealingApiSource).toContain(
      "headers: { 'Cache-Control': 'no-cache' }",
    );
    expect(sealingApiSource).not.toContain(
      "headers: refresh ? { 'Cache-Control': 'no-cache' } : undefined",
    );
  });

  it('opens the shared sealing detail dialog from both nearby schedule entries', () => {
    expect(pageSource).toContain(
      "from '../TodayOperationsPanorama/SealingDetailDialog'",
    );
    expect(pageSource).toContain('buildNetworkFreezeDetailModel');
    expect(pageSource).toContain('onOpenSealingDetails');
    expect(pageSource).toContain('setSealingDetailDate(dateStr)');
    expect(pageSource).toContain('<SealingDetailDialog');
    expect(pageSource).toContain('model={sealingDetailModel}');
    expect(pageSource).toContain(
      'restoreFocusTo={sealingDetailTriggerRef.current}',
    );
    expect(
      pageSource.match(
        /onOpenSealingDetails\(dateStr, event\.currentTarget\)/g,
      ),
    ).toHaveLength(2);
  });
});
