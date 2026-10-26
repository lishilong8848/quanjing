import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(
  process.cwd(),
  'scripts/create-purchase-single-procurement-order-hotfix-package.ps1',
);

describe('purchase single procurement order hotfix package', () => {
  const readScript = () => readFileSync(scriptPath, 'utf8');

  it('packages the complete client and exactly three required server runtime files', () => {
    const script = readScript();
    const whitelist = script.match(
      /\$serverRelativePaths\s*=\s*@\(([\s\S]*?)\r?\n\)/,
    );

    expect(script).toContain("$clientRelativePath = 'dist/client'");
    expect(script).toContain('Copy-RequiredDirectory');
    expect(whitelist).not.toBeNull();
    expect(
      Array.from(whitelist?.[1].matchAll(/'([^']+)'/g) ?? []).map(
        (match) => match[1],
      ),
    ).toEqual([
      'dist/server/modules/purchase-inventory/purchase-application.validation.js',
      'dist/server/modules/purchase-inventory/purchase-application.service.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
    ]);
  });

  it('rejects compiled output without the required client and server semantics', () => {
    const script = readScript();

    expect(script).toContain('function ConvertFrom-Utf8Base64Array');
    expect(script).toContain('function Assert-CompiledClientTreeContains');
    expect(script).toContain('function Assert-CompiledFileContains');
    expect(readSingleQuotedArray(script, 'clientMarkerBase64')).toEqual([
      '5LiJ5pa55q+U5Lu3',
      '5Y2V5LiA6YeH6LSt',
      '5Y2V5LiA5Y6f5Zug',
      '5o+Q5Lqk5Lit',
    ]);
    expect(readSingleQuotedArray(script, 'clientSemanticMarkers')).toEqual([
      'loading',
      'showSpinner',
    ]);
    expect(readSingleQuotedArray(script, 'validationMarkerBase64')).toEqual([
      '5Y2V5LiA5Y6f5Zug',
      '6YeH6LSt5b2i5byP',
    ]);
    expect(readSingleQuotedArray(script, 'serviceMarkers')).toEqual([
      'selectComparisonFiles',
      'procurementForm',
    ]);
    expect(readSingleQuotedArray(script, 'mapperMarkerBase64')).toEqual([
      '5Y2V5LiA5Y6f5Zug',
      '5LiJ5pa55q+U5Lu3',
      '5Y2V5LiA6YeH6LSt',
    ]);
    expect(script).toContain(
      'Assert-CompiledClientTreeContains -Root $clientRoot',
    );
    expect(script).toContain(
      'Assert-CompiledFileContains -RelativePath $serverRelativePaths[0]',
    );
    expect(script).toContain(
      'Assert-CompiledFileContains -RelativePath $serverRelativePaths[1]',
    );
    expect(script).toContain(
      'Assert-CompiledFileContains -RelativePath $serverRelativePaths[2]',
    );
  });

  it('hashes every payload file and rejects unsafe paths or archive entries', () => {
    const script = readScript();

    for (const contract of [
      'function Assert-ChildPath',
      'function Assert-SafePayloadPaths',
      'function Assert-NoReparsePoints',
      'function Get-StageRelativePaths',
      'function Write-HotfixManifest',
      'Get-FileHash -LiteralPath',
      "'hotfix-manifest.json'",
      '$zipPath.sha256.txt',
      'CreateFromDirectory',
      'OpenRead($zipPath)',
      'ZIP entries do not exactly match the staged hotfix files.',
      'Hotfix staging contains an unexpected or missing file.',
    ]) {
      expect(script).toContain(contract);
    }
    for (const forbidden of [
      '.env',
      'node_modules',
      '/data/',
      '/logs/',
      '/certs/',
      '.runtime',
      'sourcemaps',
      '.map',
      '.ts',
      '.tsx',
      '.spec',
      '.log',
      '.pem',
      '.cer',
      '.crt',
      '.key',
      'package.json',
      'package-lock.json',
    ]) {
      expect(script).toContain(forbidden);
    }
    expect(script).toContain('[IO.FileAttributes]::ReparsePoint');
    for (const target of ['stageDir', 'zipPath', 'sidecarPath']) {
      expect(
        occurrences(
          script,
          `Assert-ChildPath -Parent $outputRoot -Child $${target}`,
        ),
      ).toBeGreaterThanOrEqual(2);
      expect(script).toContain(`Remove-Item -LiteralPath $${target}`);
    }
  });

  it.each([
    'dist/client/Node_Modules/pkg/index.js',
    'dist/client/Logs/application.txt',
    'dist/client/Data/cache.json',
    'dist/client/Certs/client.txt',
    'dist/client/.Runtime/state.json',
    'dist/client/SourceMaps/main.js',
    'dist/client/Package.JSON',
    'dist/client/main.TS',
    'dist/client/.ENV.Production',
    'dist/client/feature.SpEc.js',
  ])('rejects the case-insensitive forbidden payload path %s', (payloadPath) => {
    const result = runPayloadPathValidation(payloadPath);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `Refusing to package forbidden path: ${payloadPath}`,
    );
  });

  it('allows a normal runtime path through the isolated safety function', () => {
    const result = runPayloadPathValidation('dist/client/main.js');

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('does not expand the packaging parameter surface for safety tests', () => {
    const script = readScript();
    const parameterBlock = script.match(
      /^param\(([\s\S]*?)\r?\n\)/,
    );

    expect(parameterBlock).not.toBeNull();
    expect(
      Array.from(parameterBlock?.[1].matchAll(/\$(\w+)/g) ?? []).map(
        (entry) => entry[1],
      ),
    ).toEqual(['OutputDir', 'SkipBuild']);
  });

  it('uses the claimed stage directory to clean partial archive outputs safely', () => {
    const script = readScript();

    expect(script).toContain(
      'if ($stageCreated -and (Test-Path -LiteralPath $zipPath))',
    );
    expect(script).toContain(
      'if ($stageCreated -and (Test-Path -LiteralPath $sidecarPath))',
    );
  });

  it('builds by default and documents whole-client deployment and rollback', () => {
    const script = readScript();

    expect(script).toContain('if (!$SkipBuild)');
    expect(script).toContain('npm run build:prod');
    expect(script).toContain('$LASTEXITCODE -ne 0');
    expect(script).toContain(
      'Production build failed; hotfix package was not created.',
    );
    for (const readmeContract of [
      '$readmeLines = @(',
      'Stop the application',
      'Back up the entire `dist/client` directory',
      'Delete the existing `dist/client` directory',
      'overwrite exactly these three compiled server files',
      '$serverRelativePaths | ForEach-Object',
      'Start the application',
      'Ctrl+F5',
      'Acceptance checks',
      '## Rollback',
      'production build of the current working tree',
      'content-hashed',
      'replacing only one client chunk is unsafe',
      'No Feishu Base schema or structure change is required.',
      'No dependency installation is required.',
      'No `.env` change is required.',
    ]) {
      expect(script).toContain(readmeContract);
    }
    expect(script).not.toContain('npm install');
  });
});

function readSingleQuotedArray(script: string, variable: string): string[] {
  const match = script.match(
    new RegExp(`\\$${variable}\\s*=\\s*@\\(([\\s\\S]*?)\\r?\\n\\)`),
  );
  expect(match).not.toBeNull();
  return Array.from(match?.[1].matchAll(/'([^']+)'/g) ?? []).map(
    (entry) => entry[1],
  );
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

function runPayloadPathValidation(payloadPath: string) {
  const script = readFileSync(scriptPath, 'utf8');
  const functionSource = script.match(
    /function Assert-SafePayloadPaths \{[\s\S]*?\r?\n\}(?=\r?\n\r?\nfunction Assert-NoReparsePoints)/,
  )?.[0];
  if (!functionSource) {
    throw new Error('Assert-SafePayloadPaths could not be extracted safely');
  }
  const escapedPath = payloadPath.replace(/'/g, "''");
  const command = `${functionSource}\nAssert-SafePayloadPaths -Paths @('${escapedPath}')`;
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') {
    args.push('-ExecutionPolicy', 'Bypass');
  }
  args.push('-Command', command);
  return spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
}
