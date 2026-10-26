import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.setTimeout(120_000);

const projectRoot = join(__dirname, '..', '..');
const scriptPath = join(
  projectRoot,
  'scripts',
  'create-weather-warning-pause-hotfix-package.ps1',
);

function runPowerShell(args: string[]): string {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
    { cwd: projectRoot, encoding: 'utf8' },
  );
}

describe('weather warning pause hotfix package', () => {
  test('builds a weather-only manual overlay with pause defaults', () => {
    expect(existsSync(scriptPath)).toBe(true);

    const testRoot = mkdtempSync(join(tmpdir(), 'weather-pause-hotfix-'));
    const clientRoot = join(testRoot, 'client');
    const outputRoot = join(testRoot, 'output');
    const expandedRoot = join(testRoot, 'expanded');
    mkdirSync(clientRoot, { recursive: true });
    writeFileSync(
      join(clientRoot, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script src="/main.js"></script></body></html>',
      'utf8',
    );
    writeFileSync(
      join(clientRoot, 'main.js'),
      'console.log("registrationEnabled","progressNotificationsEnabled","guardCompletion","border-blue-200 bg-blue-50 text-blue-800","border-emerald-200 bg-emerald-50 text-emerald-800","已匹配 1 条戒备规则，请按戒备要求执行");',
      'utf8',
    );

    try {
      runPowerShell([
        '-File',
        scriptPath,
        '-OutputRoot',
        outputRoot,
        '-SkipBuild',
        '-ClientRoot',
        clientRoot,
      ]);

      const archivePath = runPowerShell([
        '-Command',
        `(Get-ChildItem -LiteralPath '${outputRoot.replace(/'/gu, "''")}' -Filter '*.zip' -File | Select-Object -First 1 -ExpandProperty FullName)`,
      ]).trim();
      expect(archivePath).not.toBe('');
      expect(existsSync(`${archivePath}.sha256.txt`)).toBe(true);

      runPowerShell([
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/gu, "''")}' -DestinationPath '${expandedRoot.replace(/'/gu, "''")}'`,
      ]);

      const requiredEntries = [
        'README.md',
        'hotfix-manifest.json',
        'weather-warning-pause.env.patch.example',
        'dist/client/index.html',
        'dist/client/main.js',
        'dist/server/modules/weather-warning/weather-warning-automation.service.js',
        'dist/server/modules/weather-warning/weather-warning-automation-state-store.js',
        'dist/server/modules/weather-warning/weather-warning-bitable.service.js',
        'dist/server/modules/weather-warning/weather-warning-card.js',
        'dist/server/modules/weather-warning/weather-warning-snapshot.service.js',
        'dist/server/modules/weather-warning/weather-warning.config.js',
        'dist/server/modules/weather-warning/weather-warning.controller.js',
        'dist/server/modules/weather-warning/weather-warning-external-contract.js',
        'dist/server/modules/weather-warning/weather-warning-feature.config.js',
        'dist/server/modules/weather-warning/weather-warning-query.controller.js',
        'dist/server/modules/weather-warning/weather-warning-registration-enabled.guard.js',
        'dist/server/modules/weather-warning/weather-warning-notification.service.js',
        'dist/server/modules/weather-warning/weather-warning.module.js',
        'dist/shared/api.interface.js',
      ];
      const missingEntries = requiredEntries.filter(
        (entry) => !existsSync(join(expandedRoot, ...entry.split('/'))),
      );
      expect(missingEntries).toEqual([]);

      const envPatch = readFileSync(
        join(expandedRoot, 'weather-warning-pause.env.patch.example'),
        'utf8',
      );
      expect(envPatch).toContain(
        'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED=true',
      );
      expect(envPatch).toContain('WEATHER_WARNING_REGISTRATION_ENABLED=false');
      expect(envPatch).toContain(
        'FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED=false',
      );

      const manifest = JSON.parse(
        readFileSync(join(expandedRoot, 'hotfix-manifest.json'), 'utf8'),
      ) as {
        mode: string;
        scope: string[];
        excludedScope: string[];
        files: Array<{ path: string; sha256: string; bytes: number }>;
      };
      expect(manifest.mode).toBe('manual-existing-deployment-overlay');
      expect(manifest.scope).toEqual(
        expect.arrayContaining([
          'weather-warning-registration-pause',
          'weather-warning-progress-notification-pause',
          'weather-warning-initial-notification-retained',
          'weather-warning-resolved-notification',
          'weather-warning-lifecycle-state-v3',
          'weather-warning-guard-completion',
          'weather-warning-color-presentation',
          'monthly-schedule-weather-ui',
        ]),
      );
      expect(manifest.excludedScope).toContain('purchase-page-optimization');
      expect(manifest.files.length).toBeGreaterThan(10);
      for (const file of manifest.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(file.bytes).toBeGreaterThan(0);
      }

      const allPaths = manifest.files.map(({ path }) => path);
      expect(
        allPaths.some((path) =>
          path.startsWith('dist/server/modules/purchase-inventory/'),
        ),
      ).toBe(false);
      expect(allPaths.some((path) => /(^|\/)\.env(?:\.|$)/u.test(path))).toBe(
        false,
      );
      expect(allPaths.some((path) => path.endsWith('.map'))).toBe(false);
      expect(allPaths.some((path) => path.endsWith('.ts'))).toBe(false);
      expect(allPaths.some((path) => path.endsWith('.tsx'))).toBe(false);

      const readme = readFileSync(join(expandedRoot, 'README.md'), 'utf8');
      expect(readme).toContain('仅供手工覆盖');
      expect(readme).toContain('不会自动连接、覆盖或重启公网服务');
      expect(readme).toContain('首次戒备提醒仍保留');
      expect(readme).toContain('预警结束通报启用');
      expect(readme).toContain('戒备登记与戒备进度消息继续停用');
      expect(readme).toContain('HTTP 503');

      const automationSource = readFileSync(
        join(
          expandedRoot,
          'dist/server/modules/weather-warning/weather-warning-automation.service.js',
        ),
        'utf8',
      );
      expect(automationSource).toContain('buildWeatherWarningResolvedCard');
      expect(automationSource).toContain('auto:resolved:');
      expect(automationSource).toContain('pendingResolvedEvents');

      const stateStoreSource = readFileSync(
        join(
          expandedRoot,
          'dist/server/modules/weather-warning/weather-warning-automation-state-store.js',
        ),
        'utf8',
      );
      expect(stateStoreSource).toContain('pendingResolvedEvents');

      const cardSource = readFileSync(
        join(
          expandedRoot,
          'dist/server/modules/weather-warning/weather-warning-card.js',
        ),
        'utf8',
      );
      expect(cardSource).toContain('结束通报');
      expect(cardSource).toContain('已结束');

      const bitableSource = readFileSync(
        join(
          expandedRoot,
          'dist/server/modules/weather-warning/weather-warning-bitable.service.js',
        ),
        'utf8',
      );
      expect(bitableSource).toContain('guardCompletion');
      expect(bitableSource).toContain('completedBuildingCount');

      const snapshotSource = readFileSync(
        join(
          expandedRoot,
          'dist/server/modules/weather-warning/weather-warning-snapshot.service.js',
        ),
        'utf8',
      );
      expect(snapshotSource).toContain('guardCompletion');

      const archiveBytes = readFileSync(archivePath);
      const expectedArchiveHash = createHash('sha256')
        .update(archiveBytes)
        .digest('hex');
      const hashSidecar = readFileSync(
        `${archivePath}.sha256.txt`,
        'utf8',
      );
      expect(hashSidecar.trim()).toBe(
        `${expectedArchiveHash}  ${archivePath.split(/[\\/]/u).pop()}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
