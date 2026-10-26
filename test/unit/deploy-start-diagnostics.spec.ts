import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const powerShellLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

describe('deploy/start.ps1 startup diagnostics', () => {
  it('redacts quoted and header credentials while retaining useful errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schedule-diagnostics-'));
    const stdoutPath = join(directory, 'app.out.log');
    const stderrPath = join(directory, 'app.err.log');
    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    writeFileSync(
      stdoutPath,
      [
        '{"severityText":"ERROR","authorization":"Bearer sample-token-123","cookie":"session=secret-cookie","message":"startup failed"}',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      stderrPath,
      'Authorization: Basic Zm9vOmJhcg==\n',
      'utf8',
    );

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      "$names = @('Protect-StartupDiagnosticLine', 'Write-AppStartupDiagnostics')",
      '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
      "if ($definitions.Count -ne $names.Count) { throw 'startup diagnostic functions are missing' }",
      'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
      `Write-AppStartupDiagnostics -StdoutPath ${powerShellLiteral(stdoutPath)} -StderrPath ${powerShellLiteral(stderrPath)}`,
    ].join('\r\n');

    try {
      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('startup failed');
      expect(completed.stdout).toContain('***');
      expect(completed.stdout).not.toContain('sample-token-123');
      expect(completed.stdout).not.toContain('secret-cookie');
      expect(completed.stdout).not.toContain('Zm9vOmJhcg==');
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });
});
