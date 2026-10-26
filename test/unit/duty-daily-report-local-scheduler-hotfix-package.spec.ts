import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('duty daily report local scheduler hotfix package', () => {
  const script = readFileSync(
    join(
      process.cwd(),
      'scripts',
      'create-duty-daily-report-local-scheduler-hotfix-package.ps1',
    ),
    'utf8',
  );

  const expectedRuntimeFiles = [
    'dist/server/modules/duty-schedule/duty-daily-report-local-scheduler.service.js',
    'dist/server/modules/duty-schedule/duty-daily-report-task-coordinator.service.js',
    'dist/server/modules/duty-schedule/duty-daily-report-state-path.js',
    'dist/server/modules/duty-schedule/duty-schedule.automation.js',
    'dist/server/modules/duty-schedule/duty-schedule.module.js',
    'dist/server/modules/duty-schedule/duty-screenshot.service.js',
    'dist/server/modules/duty-schedule/duty-daily-report-bitable.service.js',
  ];

  it('packages only the seven required duty-schedule runtime files', () => {
    for (const runtimeFile of expectedRuntimeFiles) {
      expect(script).toContain(`'${runtimeFile}'`);
    }

    const packagedRuntimeFiles = [
      ...script.matchAll(
        /'((?:dist\/server\/modules\/duty-schedule\/)[^']+\.js)'/g,
      ),
    ].map((match) => match[1]);
    expect([...new Set(packagedRuntimeFiles)].sort()).toEqual(
      [...expectedRuntimeFiles].sort(),
    );
  });

  it('validates the standalone schedule, durable state, and attachment deduplication behavior', () => {
    expect(script).toContain('DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS');
    expect(script).toContain('DUTY_DAILY_REPORT_TASK_STATE_PATH');
    expect(script).toContain('DUTY_SCREENSHOT_DELIVERY_STATE_PATH');
    expect(script).toContain('DUTY_DAILY_REPORT_STATE_DIR');
    expect(script).toContain('duty-screenshot-delivery-state.json');
    expect(script).toContain('duty-${digest.slice(0, 40)}');
    expect(script).toContain('attachment.name === fileName');
    expect(script).toContain('nantong-duty-overview-');
  });

  it('excludes configuration, secrets, runtime data, and source files', () => {
    expect(script).toContain(
      'No .env, secrets, certificates, data, logs, node_modules, source files, or tests are included.',
    );
    expect(script).toContain(
      "@('.env', '.env.local', 'node_modules', 'data', 'logs', 'certs', '.runtime', 'server', 'test')",
    );
  });

  it('writes canonical forward-slash ZIP entries instead of platform paths', () => {
    expect(script).toContain(
      '$archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)',
    );
    expect(script).not.toContain('CreateFromDirectory');
  });

  it('pins the required base packages and documents state preservation and rollback', () => {
    expect(script).toContain('nantong-schedule-20260719-221003.zip');
    expect(script).toContain(
      'BDD7C469E20B40BCB2D3BA042BB7DC2C6898C54FDC9D0AE78C4DBE94EEB044FB',
    );
    expect(script).toContain(
      'nantong-minimal-overlay-after-20260719-221003-20260720-074815-fixed.zip',
    );
    expect(script).toContain(
      'AB3F36BCF6779CB4493E2447FBAFAE90B767B8AF0A59E64E09BAED7B945ADE89',
    );
    expect(script).toContain(
      'Preserve the shared nantong-schedule-state directory',
    );
    expect(script).toContain('## Rollback');
  });
});
