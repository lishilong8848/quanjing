import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('one-click production startup with preserved private configuration', () => {
  const launchers = [
    readFileSync(resolve(process.cwd(), 'start.ps1'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'deploy/start.ps1'), 'utf8'),
  ];
  const packager = readFileSync(
    resolve(process.cwd(), 'scripts/create-latest-combined-hotfix-package.ps1'),
    'utf8',
  );

  it.each(launchers)(
    'loads preserved .env and .env.local credentials before reporting storage readiness',
    (launcher) => {
      const runtime = launcher.slice(launcher.indexOf('$appRoot = Resolve-AppRoot'));
      const dotenvImport = runtime.indexOf('Import-DotEnvCredentialFallback');
      const readiness = runtime.indexOf(
        'Change attachment object storage credentials:',
      );

      expect(dotenvImport).toBeGreaterThanOrEqual(0);
      expect(runtime).toContain(
        'Import-DotEnvCredentialFallback -FilePath $envFile',
      );
      expect(runtime).toContain(
        'Import-DotEnvCredentialFallback -FilePath $envLocalFile',
      );
      expect(dotenvImport).toBeLessThan(readiness);
    },
  );

  it.each(launchers)(
    'loads the deployment-external private file before app-local env files',
    (launcher) => {
      const runtime = launcher.slice(launcher.indexOf('$appRoot = Resolve-AppRoot'));
      expect(runtime).toContain(
        "$sharedPrivateEnvFile = Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule.private.env'",
      );

      const sharedImport = runtime.indexOf(
        'Import-DotEnvCredentialFallback -FilePath $sharedPrivateEnvFile -Names $changeStorageCredentialNames',
      );
      const envImport = runtime.indexOf(
        'Import-DotEnvCredentialFallback -FilePath $envFile -Names $changeStorageCredentialNames',
      );
      const envLocalImport = runtime.indexOf(
        'Import-DotEnvCredentialFallback -FilePath $envLocalFile -Names $changeStorageCredentialNames',
      );
      const readiness = runtime.indexOf(
        'Change attachment object storage credentials:',
      );

      expect(sharedImport).toBeGreaterThanOrEqual(0);
      expect(sharedImport).toBeLessThan(envImport);
      expect(envImport).toBeLessThan(envLocalImport);
      expect(envLocalImport).toBeLessThan(readiness);
    },
  );

  it.each(launchers)(
    'defaults the change attachment index to deployment-external persistent state',
    (launcher) => {
      const runtime = launcher.slice(launcher.indexOf('$appRoot = Resolve-AppRoot'));
      expect(runtime).toContain(
        "$defaultChangeStorageIndexPath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'change-attachment-cos-index.json'",
      );
      expect(runtime).toContain(
        "Get-DotEnvValue -FilePath $sharedPrivateEnvFile -Name 'COS_CHANGE_INDEX_PATH'",
      );
      expect(runtime).toContain('$env:COS_CHANGE_INDEX_PATH = $changeStorageIndexPath');
    },
  );

  it('documents the one-time deployment-external private file without packaging it', () => {
    expect(packager).toContain('nantong-schedule.private.env');
    expect(packager).toContain('热包不会包含或覆盖该文件');
    expect(packager).not.toMatch(
      /\$rootRelativePaths\s*=\s*@\([\s\S]*?'nantong-schedule\.private\.env'/,
    );
  });

  it('ships the click-to-start wrapper and no longer requires an interactive deployment step', () => {
    expect(packager).toContain("'start.cmd'");
    expect(packager).toContain('覆盖完成后直接双击 start.cmd');
    expect(packager).not.toContain(
      '若启动曾显示对象存储 NOT CONFIGURED，请在应用根目录运行 powershell',
    );
  });
});
