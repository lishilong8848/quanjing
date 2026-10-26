import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('startup ledger recovery hotfix package', () => {
  const scriptPath = resolve(
    __dirname,
    '../../scripts/create-startup-ledger-recovery-hotfix-package.ps1',
  );

  it('packages only the launcher overlay with instructions and integrity metadata', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain("Join-Path $repoRoot 'deploy/start.ps1'");
    expect(script).toContain("Join-Path $stageDir 'start.ps1'");
    expect(script).toContain(
      "README_STARTUP_LEDGER_RECOVERY_HOTFIX.md",
    );
    expect(script).toContain('hotfix-manifest.json');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('.sha256.txt');
    expect(script).toContain("dependencyInstallRequired = $false");
    expect(script).toContain("secretsIncluded = $false");
    expect(script).toContain("'start.ps1'");
    expect(script).toContain('.FullName.Substring($stageDir.Length)');
    expect(script).not.toContain('[System.IO.Path]::GetRelativePath');
    expect(script).not.toContain("Join-Path $stageDir 'dist'");
    expect(script).not.toContain("Join-Path $stageDir '.env'");
  });

  it('is valid PowerShell', () => {
    const quotedPath = scriptPath.replace(/'/g, "''");
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '$tokens = $null',
          '$errors = $null',
          `[void][System.Management.Automation.Language.Parser]::ParseFile('${quotedPath}', [ref]$tokens, [ref]$errors)`,
          'if ($errors.Count -gt 0) {',
          '  $errors | ForEach-Object { Write-Error $_.Message }',
          '  exit 1',
          '}',
        ].join('; '),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  });
});
