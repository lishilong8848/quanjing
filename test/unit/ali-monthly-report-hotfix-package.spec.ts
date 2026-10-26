import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Ali monthly report Bitable automation hotfix package', () => {
  const script = readFileSync(
    join(
      process.cwd(),
      'scripts',
      'create-ali-monthly-report-hotfix-package.ps1',
    ),
    'utf8',
  );

  it('packages the automation coordinator, scheduler, durable state, and config example', () => {
    for (const runtimeFile of [
      'dist/server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report-task-state.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report.scheduler.js',
      'tools/ali-monthly-report/config.example.json',
      'tools/ali-monthly-report/four_item_bundle_runner.py',
    ]) {
      expect(script).toContain(`'${runtimeFile}'`);
    }
  });

  it('rejects stale prebuilt output when SkipBuild is used', () => {
    expect(script).toContain('function Assert-SkipBuildOutputsAreFresh');
    expect(script).toContain('if ($SkipBuild)');
    expect(script).toContain(
      'Prebuilt production output is older than relevant source',
    );
    expect(script).toContain(
      "'server/modules/ali-monthly-report/ali-monthly-report.service.ts'",
    );
    expect(script).toContain(
      "'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js'",
    );
  });

  it('validates the real Base record link and dual-group interactive-card behavior', () => {
    for (const marker of [
      'resolvePromise({ stdout, stderr: safeStderr })',
      'build_bitable_record_url',
      'buildAliMonthlyReportManualSuccessCard',
      'buildAliMonthlyReportAutomationCard',
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS',
      'ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID',
      "'interactive'",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('validates personnel-change Bitable upload and its deployable configuration example', () => {
    for (const marker of [
      'DEFAULT_STAFF_REPORT_TABLE',
      'staff_report_table_id',
      'sync_staff_report_attachment',
      'staff_attachment_syncer',
      'STAFF_REPORT_TABLE_ID',
      'STAFF_REPORT_VIEW_ID',
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('documents and validates the monthly 3rd 09:00 scheduler with retry-safe persistent state', () => {
    for (const marker of [
      'ALI_MONTHLY_REPORT_SCHEDULER_ENABLED',
      'ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH',
      'resolveLatestDueAliMonthlyReportPeriod',
      'Promise.allSettled',
      'sendAutomationSummary',
      'nantong-schedule-state',
      '每月 3 日 09:00（Asia/Shanghai）',
      '失败项每小时重试',
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('keeps environment files and credentials out of the archive', () => {
    expect(script).toContain('secretsIncluded = $false');
    expect(script).toContain('环境变量只在服务器现有 .env / .env.local 中配置');
    expect(script).not.toContain("'./.env.example'");
  });
});
