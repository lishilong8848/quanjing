const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const runtimeFiles = [
  'scripts/weekly-report/bridge.py',
  'scripts/weekly-report/nantong_weekly_report.py',
  'scripts/weekly-report/env_loader.py',
  'scripts/weekly-report/native_feishu.py',
];

function readLiteralTable(relativePath, variable, table) {
  const sourcePath = path.join(root, relativePath).replace(/'/g, "''");
  const code = `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${sourcePath}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PowerShell parse failed' }
$assignment = $ast.Find({param($item) $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $item.Left.VariablePath.UserPath -ceq '${variable}'}, $false)
if (-not $assignment) { throw 'Required literal assignment absent' }
$literal = $assignment.Find({param($item) $item -is [System.Management.Automation.Language.${table ? 'HashtableAst' : 'ArrayExpressionAst'}]}, $true)
if (-not $literal) { throw 'Required literal absent' }
$value = $literal.SafeGetValue()
ConvertTo-Json -InputObject $value -Compress -Depth 3
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(code, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('weekly runtime files are exact managed release targets, not an entire directory allowlist', () => {
  const targets = readLiteralTable('scripts/create-safe-full-runtime-hotfix-package.ps1', 'releaseFileSources', true);
  assert.deepEqual(Object.keys(targets).filter((file) => file.startsWith('scripts/weekly-report/')).sort(), [...runtimeFiles].sort());
  for (const file of runtimeFiles) {
    assert.equal(targets[file], file, `Missing managed weekly runtime: ${file}`);
    assert.equal(fs.statSync(path.join(root, file)).isFile(), true);
  }
});

test('future baseline export covers every packaged weekly runtime file', () => {
  const optional = readLiteralTable('scripts/export-server-hotfix-baseline.ps1', 'optionalFiles', false);
  for (const file of runtimeFiles) {
    assert.ok(optional.includes(file), `Baseline export omits ${file}`);
  }
});

test('weekly test code, caches and private configuration are not release-root targets', () => {
  const targets = readLiteralTable('scripts/create-safe-full-runtime-hotfix-package.ps1', 'releaseFileSources', true);
  for (const file of [
    'scripts/weekly-report/test_bridge.py',
    'scripts/weekly-report/test_native_feishu.py',
    'scripts/weekly-report/__pycache__/bridge.cpython-312.pyc',
    'scripts/weekly-report/config/nantong_weekly_report.json',
  ]) assert.equal(Object.hasOwn(targets, file), false);
});
