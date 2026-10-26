import { readFileSync } from 'fs';
import * as path from 'path';

describe('construction management interaction performance boundaries', () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );
  const globalCss = readFileSync(
    path.resolve(__dirname, '../../client/src/index.css'),
    'utf8',
  );
  const serviceSource = readFileSync(
    path.resolve(
      __dirname,
      '../../server/modules/duty-schedule/duty-schedule.service.ts',
    ),
    'utf8',
  );
  const personnelCheckSource = readFileSync(
    path.resolve(__dirname, '../../shared/construction-personnel-check.ts'),
    'utf8',
  );

  it('keeps the dashboard and project cards out of dialog-only rerenders', () => {
    expect(source).toMatch(
      /const\s+MemoizedConstructionStatusOverview\s*=\s*React\.memo\(\s*ConstructionStatusOverview\s*,?\s*\)/,
    );
    expect(source).toMatch(
      /const\s+MemoizedDailyProgressBoard\s*=\s*React\.memo\(\s*DailyProgressBoard\s*,?\s*\)/,
    );
    expect(source).toMatch(
      /const\s+MemoizedConstructionCalendar\s*=\s*React\.memo\(\s*ConstructionCalendar\s*,?\s*\)/,
    );
    expect(source).toMatch(
      /const\s+MemoizedConstructionCard\s*=\s*React\.memo\(\s*ConstructionCard\s*,?\s*\)/,
    );

    expect(source).toContain('<MemoizedConstructionStatusOverview');
    expect(source).toContain('<MemoizedDailyProgressBoard');
    expect(source).toContain('<MemoizedConstructionCalendar');
    expect(source).toContain('<MemoizedConstructionCard');
  });

  it('passes stable project-card callbacks instead of recreating them in the map', () => {
    const cardMapSource = source.slice(
      source.indexOf('{visibleProjectInProgressItems.map((item) => ('),
      source.indexOf('{hiddenProjectCount > 0'),
    );

    expect(cardMapSource).toContain(
      'onExpandedChange={handleProjectExpansionChange}',
    );
    expect(cardMapSource).toContain(
      'onRefreshApprovalStatus={handleRefreshApprovalStatus}',
    );
    expect(cardMapSource).toContain(
      'onTerminateRequest={handleProjectTerminateRequest}',
    );
    expect(cardMapSource).not.toContain('onExpandedChange={(expanded)');
    expect(cardMapSource).not.toContain('onRefreshApprovalStatus={()');
    expect(cardMapSource).not.toContain('onTerminateRequest={(candidate)');
  });

  it('defers project-list filtering so search typing stays responsive', () => {
    expect(source).toContain('useDeferredValue,');
    expect(source).toContain(
      'const deferredProjectSearchQuery = useDeferredValue(projectSearchQuery);',
    );

    const projectSearchSource = source.slice(
      source.indexOf('const [projectSearchQuery, setProjectSearchQuery]'),
      source.indexOf('const requireConstructionEdit = useCallback('),
    );
    expect(projectSearchSource).toContain(
      'matchesConstructionProjectSearch(item, deferredProjectSearchQuery)',
    );
    expect(projectSearchSource).not.toContain(
      'matchesConstructionProjectSearch(item, projectSearchQuery)',
    );
  });

  it('rerenders only the changed crew row and skips off-screen row layout', () => {
    expect(source).toContain(
      'const MemoizedCrewCheckListItem = React.memo(CrewCheckListItem);',
    );
    expect(source).toContain('<MemoizedCrewCheckListItem');
    expect(source).toContain("contentVisibility: 'auto'");
    expect(source).toContain("containIntrinsicSize: '72px'");
    expect(source).toContain('const handleCrewToggle = useCallback(');
    expect(source).toContain('const handleCrewCheckAll = useCallback(');
    expect(source).toContain('const handleCrewClear = useCallback(');
  });

  it('reuses the existing roster updater for expired authorization without another roster request', () => {
    expect(source).toContain(
      'onUpdateCrewAuthorization={openCrewRosterUploadDialog}',
    );
    expect(source).toContain(
      'onUpdateAuthorization={handleCrewAuthorizationUpdate}',
    );
    expect(personnelCheckSource).toContain('该项目授权人员已过期，需更新授权');
    expect(source).toContain('更新人员授权');

    const followupDialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function SpecialWorkTypeMaterialDialog'),
    );
    expect(followupDialogSource).toContain(
      'getConstructionCrewAuthorizationSummary(crewMembers)',
    );
    expect(followupDialogSource).not.toContain('fetchConstructionManagement(');
    expect(followupDialogSource).not.toContain(
      'syncConstructionCrewRosterFromUpload(',
    );
  });

  it('commits async personnel and change-order selections before input blur closes the result list', () => {
    const changeOrderSelectSource = source.slice(
      source.indexOf('function ConstructionChangeOrderSelect'),
      source.indexOf('function ConstructionStaffSelect'),
    );
    const staffSelectSource = source.slice(
      source.indexOf('function ConstructionStaffSelect'),
      source.indexOf('function ConstructionStaffMultiSelect'),
    );

    for (const selectSource of [changeOrderSelectSource, staffSelectSource]) {
      expect(selectSource).toContain('onMouseDown={(event) => {');
      expect(selectSource).toContain('event.preventDefault();');
      expect(selectSource).toContain(
        "if (event.key === 'Enter' || event.key === ' ')",
      );
      expect(selectSource).toContain('onClick={(event) => {');
    }
  });

  it('avoids persistent animation and large blur layers on interactive surfaces', () => {
    const dailyBoardSource = source.slice(
      source.indexOf('function DailyProgressBoard'),
      source.indexOf('function ConstructionCalendar'),
    );
    const calendarSource = source.slice(
      source.indexOf('function ConstructionCalendar'),
      source.indexOf('function ConstructionStatusOverview'),
    );
    const panoramaSource = source.slice(
      source.indexOf('function ConstructionPanoramaCard'),
      source.indexOf('function DailyProgressStageCard'),
    );
    const followupDialogChrome = source.slice(
      source.indexOf(
        '<DialogContent',
        source.indexOf('function FollowupDialog'),
      ),
      source.indexOf(
        'className="grid min-h-0',
        source.indexOf('function FollowupDialog'),
      ),
    );

    expect(dailyBoardSource).not.toContain('backdrop-blur');
    expect(calendarSource).not.toContain('backdrop-blur');
    expect(panoramaSource).not.toContain('backdrop-blur');
    expect(followupDialogChrome).not.toContain('backdrop-blur');
    expect(globalCss).toContain(
      '.construction-live-indicator__core {\n  animation: none;',
    );
  });

  it('paints lightweight feedback before mounting a cold follow-up dialog without an artificial delay', () => {
    expect(source).toContain('const scheduleFollowupDialogOpen = useCallback(');
    expect(source).toContain('window.requestAnimationFrame');
    expect(source).toContain('scheduleFollowupDialogOpen(');
    expect(source).toContain('function DialogOpeningFeedback');
    expect(source).toContain("document.createElement('div')");
    expect(source).toContain('openingFeedback?.show(label);');
    expect(source).toContain(
      '<DialogOpeningFeedback feedbackRef={followupOpeningFeedbackRef} />',
    );
    expect(source).not.toContain('React.useImperativeHandle');
    expect(source).not.toContain('setFollowupOpeningLabel');
    expect(source).toContain("setAttribute('role', 'status')");
    expect(source).toContain('正在打开');
    expect(source).not.toContain('CONSTRUCTION_DIALOG_FEEDBACK_DELAY_MS');
    expect(source).not.toContain('followupOpeningTimeoutRef');

    const dailyQuickOpenSource = source.slice(
      source.indexOf('const handleDailyFollowupQuickOpen = useCallback('),
      source.indexOf(
        'const handleSupplementalFollowupQuickOpen = useCallback(',
      ),
    );
    expect(
      dailyQuickOpenSource.indexOf('scheduleFollowupDialogOpen('),
    ).toBeLessThan(
      dailyQuickOpenSource.indexOf('isDailyFollowupOpenForProject('),
    );

    const schedulerSource = source.slice(
      source.indexOf('const scheduleFollowupDialogOpen = useCallback('),
      source.indexOf('const handleDailyProgressStageOpen = useCallback('),
    );
    expect(
      schedulerSource.match(/window\.requestAnimationFrame/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(schedulerSource).not.toContain('window.setTimeout');
  });

  it('never leaves the opening feedback layer blocking construction controls', () => {
    expect(source).toContain("overlay.style.pointerEvents = 'none';");
    expect(source).toContain(
      'const openingFeedback = followupOpeningFeedbackRef.current;',
    );
    expect(source).toContain('openingFeedback?.show(label);');
    expect(source).toContain('hideFollowupOpeningFeedbackOnNextFrame');
  });

  it('unmounts the heavy follow-up form while it is closed', () => {
    expect(source).toContain('{followupOpen && (');
    expect(source).toContain('<FollowupDialog');
    expect(source).not.toMatch(
      /<FollowupDialog[\s\S]{0,200}?open=\{followupOpen\}/,
    );
  });

  it('does not rebuild other hidden construction dialogs during form interactions', () => {
    expect(source).toContain('{applicationOpen && (');
    expect(source).toContain('{selectedConstruction && (');
    expect(source).toContain('{constructionListDialog && (');
    expect(source).toContain('{crewRosterUploadTarget && (');
    expect(source).toContain('{projectTerminateCandidate && (');
    expect(source).toContain('{projectDeleteCandidate && (');
  });

  it('keeps the low-frequency online work form out of the construction entry chunk', () => {
    expect(source).toContain(
      "const LazyOnlineWorkFormDialog = React.lazy(() => import('./online-work-form'))",
    );
    expect(source).toContain("} from './online-work-form-model';");
    expect(source).not.toMatch(
      /import\s*\{[\s\S]*?\bOnlineWorkFormDialog\b[\s\S]*?\}\s*from\s*'\.\/online-work-form';/,
    );
    expect(source).toContain('<React.Suspense fallback={null}>');
    expect(source).toContain('<LazyOnlineWorkFormDialog');

    const dashboardStartupSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage()'),
      source.indexOf(
        'const [data, setData] = useState<ConstructionManagementResponse | null>(null);',
      ),
    );
    expect(dashboardStartupSource).not.toContain(
      "import('./online-work-form')",
    );
    expect(dashboardStartupSource).not.toContain('window.setTimeout');
  });

  it('loads independent construction tables concurrently on refresh', () => {
    const managementReadSource = serviceSource.slice(
      serviceSource.indexOf('async getConstructionManagement('),
      serviceSource.indexOf(
        'private async syncConstructionRoomManagerAfterDepositConfirmation(',
      ),
    );

    expect(managementReadSource).toContain('await Promise.allSettled([');
    expect(managementReadSource).toContain('overviewReadTask');
    expect(managementReadSource).toContain('followupReadTask');
    expect(managementReadSource).toContain('crewReadTask');
  });

  it('retries transient Feishu data-not-ready write responses', () => {
    expect(serviceSource).toContain(
      'shouldRetryBitableWriteResponse(bitableResponseData)',
    );
    expect(serviceSource).toContain(
      'CONSTRUCTION_BITABLE_WRITE_RETRY_BASE_DELAY_MS',
    );
  });

  it('does not fail photo uploads when legacy AI feedback fields are absent', () => {
    expect(serviceSource).toContain("'AI识别反馈（过程）',");
    expect(serviceSource).toContain("'AI识别反馈（收尾）',");
  });
});
