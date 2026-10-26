import { readFileSync } from 'fs';
import { join } from 'path';

describe('monthly schedule change summary report wiring', () => {
  it('adds the change summary after drill submission and reuses local page data', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialog = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/ChangeSummaryReportDialog.tsx',
      ),
      'utf8',
    );
    const operations = page.slice(
      page.indexOf('变更相关'),
      page.indexOf('阈值调整', page.indexOf('变更相关')),
    );

    expect(operations.indexOf('变更总结')).toBeGreaterThan(
      operations.indexOf('演练提交'),
    );
    expect(page).toContain('<ChangeSummaryReportDialog');
    expect(page).toContain('personOptions={changeRequestSubmitterOptions}');
    expect(page).toContain('changes={changes}');
    expect(dialog).toContain('listEligibleChangeSummaryRecords(');
    expect(dialog).not.toContain('getYearlyChangeInfo');
    expect(dialog).not.toContain('getPersonProfiles');
    expect(dialog).toContain('ChangeAttachmentField');
    expect(dialog).toContain('stageChangeAttachment');
    expect(dialog).toContain('变更总结');
    expect(dialog).not.toMatch(/多维表|COS|对象存储/u);
  });

  it('uses one searchable submitter control instead of a duplicate search and select', () => {
    const dialog = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/ChangeSummaryReportDialog.tsx',
      ),
      'utf8',
    );
    const sectionStart = dialog.indexOf('变更提交人');
    const sectionEnd = dialog.indexOf(
      '<section',
      dialog.indexOf('</section>', sectionStart) + 1,
    );
    const submitterSection = dialog.slice(sectionStart, sectionEnd);
    const manualSection = submitterSection.slice(submitterSection.indexOf('personCachePresentation.blocking'));
    const submitterControls =
      manualSection.match(/<(?:Input|Select)(?=[\s>])/g) ?? [];

    expect(sectionStart).toBeGreaterThan(-1);
    expect(submitterSection).toContain('id="change-summary-submitter"');
    expect(submitterSection).toContain(
      'list="change-summary-submitter-options"',
    );
    expect(submitterSection).toContain('value={submitterName}');
    expect(submitterSection).toContain(
      '<datalist id="change-summary-submitter-options">',
    );
    expect(submitterControls).toHaveLength(1);
    expect(submitterSection).toContain("applicant.mode !== 'manual'");
    expect(submitterSection).toContain('readOnly');
    expect(submitterSection).not.toContain('<Select');
    expect(submitterSection).not.toContain('提交人 *</Label>');
  });

  it('opens from cached data immediately and refreshes eligible changes in the background', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const menuStart = page.indexOf('{canSubmitChangeSummaryReport && (');
    const menuEnd = page.indexOf('</DropdownMenuItem>', menuStart);
    const menu = page.slice(menuStart, menuEnd);
    const openAt = menu.indexOf('setChangeSummaryReportOpen(true);');
    const refreshAt = menu.indexOf('void loadChangeInfo(true);');

    expect(menuStart).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(openAt);
    expect(menu).not.toMatch(/await\s+loadChangeInfo\(true\)/u);
  });

  it('shows a refresh state instead of a false empty result while cached changes update', () => {
    const dialog = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/ChangeSummaryReportDialog.tsx',
      ),
      'utf8',
    );
    const emptyStateStart = dialog.indexOf('candidates.length === 0');
    const emptyState = dialog.slice(emptyStateStart, emptyStateStart + 700);

    expect(emptyStateStart).toBeGreaterThan(-1);
    expect(emptyState).toContain('changeCachePresentation.refreshing');
    expect(emptyState).toContain('正在刷新可提交的变更项目');
  });

  it('closes immediately, persists first, polls a durable task, and avoids full reloads', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = page.indexOf('const handleSubmitChangeSummaryReport');
    const end = page.indexOf('const handleSubmitAdditionalMatter', start);
    const handler = page.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('coordinateChangeSummaryReportAcceptance(');
    expect(handler).toContain('persist: (binding) =>');
    expect(handler).toContain('onPrepared: () =>');
    expect(handler).toContain('flushSync');
    expect(handler).toContain('create: createChangeSummaryReport');
    expect(handler).toContain("toast.loading('变更总结已提交，后台同步中…'");
    expect(page).toContain('pollChangeSummaryReportTask(');
    expect(page).toContain('changeSummaryReportTaskRuntimesRef');
    expect(page).toContain('setChanges((current) =>');
    expect(page).toContain('hasSummaryReport: true');
    expect(page).toContain('removeChangeSummaryReportRecovery(');
    expect(handler).not.toContain('getYearlyChangeInfo');
    expect(handler).not.toContain('loadChanges');
  });

  it('restores pending and failed tasks from session recovery without leaking to guests', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(page).toContain('readChangeSummaryReportRecoveries');
    expect(page).toContain('consumeChangeSummaryReportRecoveryAuthorization(');
    expect(page).not.toMatch(
      /useState\(\(\) =>\s*canSubmitChangeSummaryReport\s*\?\s*readChangeSummaryReport/u,
    );
    expect(page).toContain('trackChangeSummaryReportTask');
    expect(page).toContain('removeChangeSummaryReportRecovery(');
    expect(page).toContain('canSubmitChangeSummaryReport');
    expect(page).toContain('canSubmitChangeSummaryReportForRole(role)');
    const summaryMenu = page.slice(
      page.indexOf('变更总结'),
      page.indexOf('阈值调整', page.indexOf('变更总结')),
    );
    expect(summaryMenu).toContain('canSubmitChangeSummaryReport');
  });

  it('releases the synchronous submit lock when a pending-task effect is remounted', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const cleanupStart = page.indexOf(
      'disposeChangeSummaryReportTaskRuntimes(',
    );
    const cleanup = page.slice(cleanupStart - 200, cleanupStart + 500);

    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanup).toContain(
      'changeSummaryReportSubmittingRef.current = false',
    );
    expect(cleanup).toContain('changeSummaryReportTaskRuntimesRef.current');
    expect(cleanup).toContain('toast.dismiss(clientMutationId)');
  });

  it('keeps the menu available while independent tasks sync and excludes only pending records', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialog = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/ChangeSummaryReportDialog.tsx',
      ),
      'utf8',
    );
    const menuStart = page.indexOf('{canSubmitChangeSummaryReport && (');
    const menu = page.slice(menuStart, menuStart + 2_500);

    expect(menu).not.toContain('disabled={changeSummaryReportSubmitting}');
    expect(page).toContain(
      'pendingChangeRecordIds={pendingChangeSummaryReportRecordIds}',
    );
    expect(dialog).toContain(
      '!pendingChangeRecordIds.has(change.bitableRecordId)',
    );
  });

  it('uses the dedicated accepted-task API routes', () => {
    const api = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(api).toContain("url: '/api/duty-schedules/change-summary-report'");
    expect(api).toContain(
      '/api/duty-schedules/change-summary-report-sync/${encodeURIComponent(taskId)}',
    );
    expect(api).toContain(
      "url: '/api/duty-schedules/change-summary-report/abandon'",
    );
    expect(api).toContain('signal,');
  });

  it('cancels replaceable reads and preserves cached public submitters on refresh failure', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const loaderStart = page.indexOf('const loadPersonProfiles = useCallback');
    const profileLoader = page.slice(
      loaderStart,
      page.indexOf('const loadTravelPersonProfiles', loaderStart),
    );

    expect(page).toContain(
      'beginLatestDutyOverviewRequest(changeLoadAbortRef)',
    );
    expect(page).toMatch(
      /beginLatestDutyOverviewRequest\(\s*personProfileLoadAbortRef,?\s*\)/u,
    );
    expect(page).toContain('changeLoadAbortRef.current?.abort()');
    expect(page).toContain('personProfileLoadAbortRef.current?.abort()');
    expect(profileLoader).not.toContain('setPersonProfiles([])');
    expect(profileLoader).not.toContain('setChangeRequestSubmitterOptions([])');
    expect(profileLoader).toContain(
      "setScreenshotSectionState('personProfiles', 'error')",
    );
  });
});
