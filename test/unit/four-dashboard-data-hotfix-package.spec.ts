import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('four-dashboard data hotfix package', () => {
  const script = readFileSync(
    join(
      process.cwd(),
      'scripts',
      'create-four-dashboard-data-hotfix-package.ps1',
    ),
    'utf8',
  );

  it('packages the unified scheduler and certificate runtime without the legacy scheduler', () => {
    expect(script).toContain(
      "'dist/server/modules/dashboard-data-sync/dashboard-data-sync.scheduler.js'",
    );
    expect(script).toContain(
      "'dist/server/modules/bitable-sync/certificate-dashboard.service.js'",
    );
    expect(script).not.toContain(
      "'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.js'",
    );
  });

  it('documents the fixed 03:10 synchronization and certificate scope', () => {
    expect(script).toContain("'campus-certificate-dashboard'");
    expect(script).toContain('03:10');
    expect(script).toContain("'FEISHU_CERTIFICATE_TABLE_ID'");
  });

  it('preserves environment files and rejects secrets and runtime data', () => {
    expect(script).toContain(
      'Preserve existing .env, .env.local, data, certs, logs, node_modules, and runtime caches.',
    );
    expect(script).toContain('secretsIncluded = $false');
    expect(script).toContain(
      "$_ -match '(^|/)(\\.env[^/]*|node_modules|data|logs|certs|\\.runtime|sourcemaps)(/|$)'",
    );
  });
});
