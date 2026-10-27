import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Ali monthly report server runtime hotfix package', () => {
  const scriptPath = join(
    process.cwd(),
    'scripts',
    'create-ali-monthly-report-server-runtime-hotfix-package.ps1',
  );
  const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';

  it('provides a dedicated server-only packager', () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(script).toContain('npm run build:server');
    expect(script).toContain('ali-monthly-report-server-runtime-hotfix');
    expect(script).not.toContain("'dist/client'");
    expect(script).not.toContain('purchase-inventory');
  });

  it('uses an UTF-8 BOM so Windows PowerShell 5 can parse Chinese paths', () => {
    const bytes = readFileSync(scriptPath);

    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('packages the exact Ali server module and runtime tools', () => {
    for (const runtimeFile of [
      'ali-monthly-report.controller.js',
      'ali-monthly-report-feishu.js',
      'ali-monthly-report.module.js',
      'ali-monthly-report-task-coordinator.service.js',
      'ali-monthly-report-task-state.js',
      'ali-monthly-report.scheduler.js',
      'ali-monthly-report.service.js',
      'tools/ali-monthly-report/four_item_bundle_runner.py',
      'tools/ali-monthly-report/python_dependency_probe.py',
      'tools/ali-monthly-report-email/app.py',
      'tools/ali-monthly-report-email/resources/vnet_logo.png',
    ]) {
      expect(script).toContain(runtimeFile);
    }
  });

  it('embeds and verifies preinstalled CPython 3.12 x64 dependencies', () => {
    for (const marker of [
      'python/ali-monthly-report-packages',
      '--no-index',
      '--find-links',
      '--target',
      'python_dependency_probe.py',
      "'legacy'",
      'dependencyInstallRequired = $false',
      'preinstalledPythonPackagesIncluded = $true',
      "pythonRuntimeTarget = 'cp312-win_amd64'",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('uses quote-safe Python runtime inspection under Windows PowerShell', () => {
    expect(script).toContain('json.dumps(dict(');
    expect(script).not.toContain('"major": sys.version_info.major');
  });

  it('validates markers in their actual compiled JavaScript form', () => {
    expect(script).toContain('$compiledServiceMarkers');
    expect(script).toContain("'ali-monthly-report-packages'");
    expect(script).toContain("'PYTHONPATH'");
  });

  it('copies a prepared runtime with bounded native Windows retries', () => {
    expect(script).toContain('robocopy');
    expect(script).toContain("'/R:1'");
    expect(script).toContain("'/W:1'");
    expect(script).toContain('$LASTEXITCODE -gt 7');
  });

  it('allows only the bundled Certifi public CA PEM exception', () => {
    expect(script).toContain('$isBundledCertifiCa');
    expect(script).toContain("'certifi/cacert.pem'");
    expect(script).toContain('!$isBundledCertifiCa');
  });

  it('writes a hash manifest and rejects unsafe or secret payloads', () => {
    for (const marker of [
      'hotfix-manifest.json',
      'Get-FileHash',
      'SHA256',
      'secretsIncluded = $false',
      'Refusing to package forbidden path',
      'CreateFromDirectory',
      '.sha256.txt',
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('documents a power workbook attachment and a visible-only Mei copy recipient', () => {
    expect(script).toContain('超功耗工作簿同时作为正文数据源和唯一 Excel 附件');
    expect(script).toContain(
      'mei.bingbing@vnet.com 仅显示在邮件正文抄送名单中，不加入默认收件人和实际投递地址',
    );
    expect(script).toContain(
      '旧环境变量或配置中的自定义邮箱会保留，同时自动补齐两名默认收件人',
    );
    expect(script).not.toContain('请改为两个目标邮箱或删除该变量');
    expect(script).toContain("'email-visible-copy-list'");
  });

  it('documents the single scheduled catch-up window', () => {
    expect(script).toContain('scheduled-primary-and-catchup-only');
    expect(script).toContain('3 日 09:00');
    expect(script).toContain('5 日 09:00');
  });
});
