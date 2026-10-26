import { readFileSync } from 'fs';
import { join } from 'path';

describe('Nantong business optimization hotfix package', () => {
  it('packages only the complete compiled client and server overlays', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain("$clientRelativePath = 'dist/client'");
    expect(source).toContain("$serverRelativePath = 'dist/server'");
    expect(source).toContain("$sharedRelativePath = 'dist/shared'");
    expect(source).toContain('-Source $clientRoot');
    expect(source).toContain('-Source $serverRoot');
    expect(source).toContain('-Source $sharedRoot');
    expect(source).toContain("'hotfix-manifest.json'");
    expect(source).toContain(
      "'README_NANTONG_BUSINESS_OPTIMIZATION_HOTFIX.md'",
    );
    expect(source).toContain('Get-FileHash');
    expect(source).toContain('CreateFromDirectory');
    expect(source).toContain('OpenRead($zipPath)');
  });

  it('rejects secrets, data, dependencies, source maps, source files, tests and logs', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    for (const marker of [
      '.env',
      'node_modules',
      'sourcemaps',
      'data',
      'logs',
      '.map',
      '.ts',
      '.tsx',
      '.spec',
    ]) {
      expect(source).toContain(marker);
    }
  });

  it('checks the compiled duty sync fix and the retired AI field before packaging', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain('5o6S54+t5pys5Zyw5ZCM5q2l5a6M5oiQ');
    expect(source).toContain('getTodayLeaveStaffFromFeishu');
    expect(source).toContain('fld2xDxrRH');
    expect(source).toContain('Assert-CompiledFileExcludes');
  });

  it('rejects a stale server build without the startup program refresh', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-schedule.automation.js'",
    );
    expect(source).toContain("'onApplicationBootstrap'");
    expect(source).toContain("'startupProgramModifiedRefreshScheduled'");
    expect(source).toContain("'programModifiedDutyStaffRefreshInFlight'");
  });

  it('rejects a stale client build without the unified login CSRF recovery', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain("'/api/access/login'");
    expect(source).toContain("'suda-csrf-token'");
    expect(source).toContain("'same-origin'");
  });

  it('rejects stale typhoon delivery and campus training layout runtimes', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain("'.js', '.html', '.css'");
    expect(source).toContain("'/api/typhoon-path-screenshot/preview'");
    expect(source).toContain("'FORCE_SEND_TYPHOON_PATH'");
    expect(source).toContain("'training-dashboard-title-group'");
    expect(source).toContain("'grid-template-columns:394px 778px 700px'");
    expect(source).toContain("'buildTyphoonPathWarningDeliveryKey'");
    expect(source).toContain("'typhoon-path-screenshot/preview'");
    expect(source).toContain("'FORCE_SEND_TYPHOON_PATH'");
    expect(source).toContain("'forceSendTyphoonPathScreenshot'");
    expect(source).toContain("'expectedWarningKey'");
    expect(source).toContain(
      "'dist/server/modules/duty-schedule/typhoon-warning-state-store.js'",
    );
    expect(source).toContain("'typhoon-warning-send-state.json'");
    expect(source).toContain("'acquireTyphoonWarningMonitorLease'");
    expect(source).toContain("'writeTyphoonWarningSendStateFile'");
    expect(source).toContain(
      "'dist/server/modules/duty-schedule/typhoon-warning-monitor.service.js'",
    );
    expect(source).toContain("'onModuleInit'");
    expect(source).toContain("'runLocalTyphoonWarningMonitor'");
    expect(source).toContain("'monitorTyphoonWarningAndSendPathScreenshot'");
    expect(source).toContain("'typhoon-warning-group-delivery'");
    expect(source).toContain("'campus-training-dashboard-layout'");
  });

  it('rejects a stale campus training drill-down runtime', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain("'training-detail-dialog'");
    expect(source).toContain("'training-detail-pagination'");
    expect(source).toContain("'grid-template-rows:56px 558px'");
    expect(source).toContain(
      "'dist/server/modules/bitable-sync/training-dashboard.details.js'",
    );
    expect(source).toContain("'assessmentPassScore'");
    expect(source).toContain("'reconciliationNotes'");
    expect(source).toContain("'actualParticipantKeys'");
  });

  it('rejects a stale today operations panorama runtime', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain('Assert-CompiledClientExcludes');
    expect(source).toContain("'Asia/Shanghai'");
    expect(source).toContain("'#064fc5'");
    expect(source).toContain(
      '\'expected:"yesterdayExpected",unexpected:"yesterdayUnexpected",unclassified:"yesterdayUnclassified"\'',
    );
    expect(source).toContain('\'<9?"night":"white"\'');
    expect(source).toContain("'minPointSize:2'");
    expect(source).toContain("'5Zut5Yy655So55S16YeP5Li6'");
    expect(source).toContain("'5Zut5Yy66ICX5rC06YeP5Li6'");
    expect(source).toContain("'RC9FIOS4jeWPguS4juWbreWMuuW5s+Wdhw=='");
    expect(source).toContain("'55m954+t5LiO5aSc54+t5Zyo5bKX5Y+j5b6E'");
    expect(source).toContain(
      "'dist/server/modules/bitable-sync/today-operations-alarm.service.js'",
    );
    expect(source).toContain('"case \'unclassified\':"');
    expect(source).toContain('"case \'yesterdayExpected\':"');
    expect(source).toContain('"case \'yesterdayUnexpected\':"');
    expect(source).toContain('"case \'yesterdayUnclassified\':"');
  });

  it('requires the latest panorama placement and contract payment follow-up changes', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain('Assert-TodayOperationsPanelsAtBottom');
    expect(source).toContain(
      "'client/src/pages/TodayOperationsPanorama/index.tsx'",
    );
    expect(source).toContain(
      "$effectiveExecutionContractMarker = ConvertFrom-Utf8Base64 '5pyJ5pWI5omn6KGM5ZCI5ZCM'",
    );
    expect(source).toContain(
      "$noPaymentRequiredMarker = ConvertFrom-Utf8Base64 '5peg6ZyA5LuY5qy+'",
    );
    expect(source).toContain(
      "'dist/server/modules/contract-management/contract-payment-follow-up.service.js'",
    );
    expect(source).toContain("'no_payment_required'");
    expect(source).toContain(
      "$paymentFollowUpDispositionMarker = ConvertFrom-Utf8Base64 '5LuY5qy+6Lef6L+b5aSE572u'",
    );
    expect(source).toContain("'payment-follow-up-disposition'");
    expect(source).toContain("'dashboardCacheGeneration'");
    expect(source).toContain(
      'Operations panels are the final business section after the alarm overview.',
    );
    expect(source).toContain(
      'Framework contract cards count effective execution contracts only.',
    );
  });

  it('rejects stale screenshot, catch-up, and purchase lock runtimes', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-screenshot.service.js'",
    );
    expect(source).toContain('DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL');
    expect(source).toContain('sharedScreenshotUrl');
    expect(source).toContain('hasCompletedDutyOverviewDelivery');
    expect(source).toContain('hasStartedDutyOverviewDelivery');
    expect(source).toContain('isAutomaticGroupDeliveryAllowed');
    expect(source).toContain('daily-report-attachment-already-exists');
    expect(source).toContain('hasCompletedAutomaticArchive');
    expect(source).toContain('buildSiblingScreenshotPath');
    expect(source).toContain('createCampusOperationsScreenshotAccessToken');
    expect(source).toContain('screenshotShift');
    expect(source).toContain('data-screenshot-ready');
    expect(source).toContain('weatherWidget');
    expect(source).toContain('personnelMovements');
    expect(source).toContain('captureVerifiedScreenshotTarget');
    expect(source).toContain('waitForStableScreenshotTarget');
    expect(source).toContain('replaceExisting');
    expect(source).toContain('getMissingCampusOperationsKeys');
    expect(source).toContain("'dist/shared/campus-operations-shift.js'");
    expect(source).toContain('resolvePreviousCampusOperationsShift');
    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-daily-report-local-scheduler.service.js'",
    );
    expect(source).toContain('DUTY_DAILY_REPORT_LOCAL_SCHEDULER_LOOKBACK_DAYS');
    expect(source).toContain('DEFAULT_RECONCILE_INTERVAL_MS');
    expect(source).toContain('DUTY_DAILY_REPORT_RECORD_MISSING');
    expect(source).toContain('ensureDailyReportRecord');
    expect(source).toContain('createDailyReportRecord');
    expect(source).toContain('white-record');
    expect(source).toContain('night-record');
    expect(source).toMatch(
      /dist\/server\/common\/access\/unified-access\.guard\.js'\s*`\s*-Markers @\('verifyCampusOperationsScreenshotAccessToken', 'screenshotShift'\)/,
    );
    expect(source).toMatch(
      /dist\/server\/modules\/duty-schedule\/monthly-schedule-screenshot-access\.js'\s*`[\s\S]*?'verifyMonthlyScheduleScreenshotAccessToken'/,
    );
    expect(source).toContain('DEVELOPMENT_EPHEMERAL_SCREENSHOT_ACCESS_SECRET');
    expect(source).toContain('isScreenshotAccessExpiryValid');
    expect(source).toContain('local-development-monthly-schedule-screenshot');
    expect(source).toContain(
      "'dist/server/modules/purchase-inventory/purchase-workflow.store.js'",
    );
    expect(source).toContain('lockPromise = null');
    expect(source).toContain('.recovery');
  });

  it('documents preservation of the external duty delivery ledgers', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'scripts/create-nantong-business-optimization-hotfix.ps1',
      ),
      'utf8',
    );

    expect(source).toContain('nantong-schedule-state');
    expect(source).toContain('duty-daily-report-task-state.json');
    expect(source).toContain('duty-screenshot-delivery-state.json');
    expect(source).toContain('typhoon-warning-send-state.json');
    expect(source).toContain('DUTY_DAILY_REPORT_STATE_DIR');
  });
});
