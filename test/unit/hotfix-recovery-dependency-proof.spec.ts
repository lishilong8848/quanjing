import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const source = readFileSync(join(root, 'scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8');
const installer = source.match(/\$installer = @'\r?\n([\s\S]*?)\r?\n'@\r?\nSet-Content -LiteralPath \(Join-Path \$stageRoot 'INSTALL-HOTFIX\.ps1'\)/)?.[1];
if (!installer) throw new Error('Embedded official installer not found');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const onWindows = process.platform === 'win32' ? describe : describe.skip;
jest.setTimeout(90_000);

// The real production dependency verifier scans a nine-file synthetic tree.
// Only its expected package byte anchors differ from production; its metadata,
// physical scan, cache and report validation implementations are unchanged.
const packageSpecifications = {
  fflate: { lockedVersion: '0.8.2', installedFingerprint: 'a5f335fb6d3447219f5d898f30eddcfaeb54fd7ab20d65b4f92ef8f2bb24c9c8', installedEntryCount: 4, installedFileCount: 3, installedBytes: 101 },
  multer: { lockedVersion: '2.0.2', installedFingerprint: 'cc8c92101434b0ca1a4e2b50165b0b48c0368957ce9c0a2f70450c7880fa4573', installedEntryCount: 4, installedFileCount: 3, installedBytes: 101 },
  rxjs: { lockedVersion: '7.8.2', installedFingerprint: '3f362364fe0087cbf92b65474dae2fa3385b1fe5643e533604660695353f383f', installedEntryCount: 4, installedFileCount: 3, installedBytes: 95 },
};
const integrities = {
  fflate: 'sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==',
  multer: 'sha512-u7f2xaZ/UG8oLXHvtF/oWTRvT44p9ecwBBqTwgJVq0+4BW1g8OW01TyMEGWBHbyMOYVHXslaut7qEQ1meATXgw==',
  rxjs: 'sha512-dhKf903U/PQZY6boNNtAGdWbG85WAbjT/1xYoZIC7FAY0yWapOBQVsVrDl58W86//e1VpMNBtRV4MaXfdMySFA==',
};

onWindows('official recovered-runtime dependency proof handoff', () => {
  let directory: string;
  let app: string;
  let pkg: string;
  let manifest: Record<string, unknown>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nt-recovery-physical-proof-'));
    app = join(directory, 'app'); pkg = join(directory, 'package');
    for (const folder of [app, join(app, 'dist/server'), join(pkg, 'release-root'), join(pkg, 'operations/scripts'), join(directory, 'cache')]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(directory, 'installer.ps1'), installer!);
    const dependencies = { fflate: '^0.8.2', multer: '2.0.2', rxjs: '^7.8.2' };
    const packages: Record<string, unknown> = { '': { name: 'fixture-app', version: '1.0.0', dependencies } };
    for (const [name, specification] of Object.entries(packageSpecifications)) {
      const folder = join(app, 'node_modules', name); mkdirSync(join(folder, 'lib'), { recursive: true });
      json(join(folder, 'package.json'), { name, version: specification.lockedVersion, main: 'index.js' });
      writeFileSync(join(folder, 'index.js'), `module.exports = '${name}';\n`);
      writeFileSync(join(folder, 'lib/helper.txt'), `${name}\n`);
      packages['node_modules/' + name] = { version: specification.lockedVersion,
        resolved: `https://registry.example.invalid/${name}-${specification.lockedVersion}.tgz`, integrity: integrities[name as keyof typeof integrities] };
    }
    for (const target of [app, join(pkg, 'release-root')]) {
      json(join(target, 'package.json'), { name: 'fixture-app', version: '1.0.0', dependencies });
      json(join(target, 'package-lock.json'), { name: 'fixture-app', version: '1.0.0', lockfileVersion: 3, requires: true, packages });
    }
    const verifier = join(pkg, 'operations/scripts/verify-hotfix-dependency-transition.mjs');
    writeFileSync(verifier, [
      `import { verifyHotfixDependencyTransition } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/verify-hotfix-dependency-transition.mjs')).href)};`,
      "import { writeFileSync } from 'node:fs';",
      "const names={'--baseline-package':'baselinePackagePath','--baseline-lock':'baselineLockPath','--candidate-package':'candidatePackagePath','--candidate-lock':'candidateLockPath','--installed-node-modules':'installedNodeModulesPath','--proof-cache':'proofCachePath'};",
      `const options={expectedPackages:${JSON.stringify(packageSpecifications)}};`,
      'for(let i=2;i<process.argv.length;i+=2) options[names[process.argv[i]]]=process.argv[i+1];',
      `writeFileSync(${JSON.stringify(join(directory, 'verifier-invoked.json'))},JSON.stringify({root:options.installedNodeModulesPath}));`,
      'try{console.log(JSON.stringify(await verifyHotfixDependencyTransition(options)));}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}',
    ].join('\n'));
    const report = spawnSync(process.execPath, [verifier, '--baseline-package', join(app, 'package.json'), '--baseline-lock', join(app, 'package-lock.json'),
      '--candidate-package', join(pkg, 'release-root/package.json'), '--candidate-lock', join(pkg, 'release-root/package-lock.json'), '--installed-node-modules', join(app, 'node_modules')], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (report.status !== 0) throw new Error('Synthetic physical proof setup failed: ' + report.stderr);
    const proof = JSON.parse(report.stdout.trim());
    manifest = { dependencyVerifierSha256: sha(verifier), candidatePackageSha256: sha(join(pkg, 'release-root/package.json')),
      candidatePackageLockSha256: sha(join(pkg, 'release-root/package-lock.json')), dependencyProofAlgorithm: proof.proofAlgorithm,
      dependencyLockPhysicalTreeFingerprint: proof.lockPhysicalTreeFingerprint, dependencyInstalledPhysicalTreeFingerprint: proof.installedPhysicalTreeFingerprint,
      dependencyPackageCount: proof.packageCount, dependencyFileCount: proof.fileCount, dependencyBytes: proof.bytes };
    json(join(directory, 'manifest.json'), manifest);
    writeFileSync(join(app, 'dist/server/main.js'), [
      "const fs=require('fs'),http=require('http');",
      'const capture={pid:process.pid,fingerprint:process.env.NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF||null,mode:process.env.NANTONG_ATOMIC_HOTFIX_MODE||null,recoveryNode:process.env.NANTONG_HOTFIX_RECOVERY_NODE_PATH||null};',
      'fs.writeFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify(capture));',
      "const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(capture));});",
      "server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_PORT,String(server.address().port)));",
      'setTimeout(()=>{server.close();process.exit(0);},15000);',
    ].join('\n'));
    const launcher = [
      'param([switch]$NoBrowser)', "$ErrorActionPreference='Stop'",
      "$start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=$env:FIXTURE_NODE;$start.Arguments='\"'+(Join-Path $PSScriptRoot 'dist/server/main.js')+'\"';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;",
      '$p=[Diagnostics.Process]::Start($start)',
      "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'app.pid'),([ordered]@{pid=$p.Id;appRoot=$PSScriptRoot;mainFile=(Join-Path $PSScriptRoot 'dist/server/main.js');startTime=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress))",
    ].join('\n');
    writeFileSync(join(app, 'start.ps1'), launcher); writeFileSync(join(app, '.rollback-start.ps1'), launcher);
  });
  afterEach(() => {
    // The PowerShell harness always checks the exact temporary entry point
    // before stopping its Node; no production/root process is targeted.
    if (dirname(directory) !== resolve(tmpdir()) || !directory.includes('nt-recovery-physical-proof-')) throw new Error('Unsafe synthetic cleanup root');
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  function run(mode: 'committed' | 'rollback', corrupt = false) {
    if (corrupt) writeFileSync(join(app, 'node_modules/fflate/index.js'), "module.exports = 'broken';\n");
    const script = [
      "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Import-Module Microsoft.PowerShell.Utility;Import-Module Microsoft.PowerShell.Management;Import-Module CimCmdlets;$tokens=$null;$errors=$null",
      `$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(join(directory, 'installer.ps1'))},[ref]$tokens,[ref]$errors)`,
      "if($errors.Count){throw 'Embedded installer parse failure'}",
      "$native=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith(\"if (-not ('NantongHotfixNativeMethods'\")})",
      "if($native.Count -ne 1){throw 'Native path verifier not found'};. ([scriptblock]::Create($native[0].Extent.Text))",
      'foreach($statement in $ast.EndBlock.Statements){if($statement -is [Management.Automation.Language.FunctionDefinitionAst]){. ([scriptblock]::Create($statement.Extent.Text))}}',
      '$script:installedDependencyProofCache=@{};$script:trustedHotfixNodeExecutablePath=$env:FIXTURE_NODE',
      'function Get-AppProcesses {param($Root) return @()}',
      "function Assert-PurchaseLedgerRuntimeCompatibility {param($Root,$RuntimeDist,[switch]$PassThru) if($PassThru){return [pscustomobject]@{runtimeCapability='isolated-fixture'}}}",
      'function Assert-CommittedRuntimeFiles {param($Root,$Transaction,$Manifest) if(-not (Test-Path (Join-Path $Root \'dist/server/main.js\'))){throw \'Missing fixture main\'}}',
      'function Stop-AppProcesses {param($Root,$Endpoint,[switch]$AllowNotRunning,[switch]$AllowStaleOwnedJsonPidRecord) $script:stopCalled=$true}',
      'function New-InstalledReleaseReceipt {param($Root,$Manifest,$DependencyProofReport) if(!$DependencyProofReport.physicalVerified){throw \'Unverified receipt\'};return [pscustomobject]@{deploymentId=\'synthetic-proof\'}}',
      'function Write-DurableInstalledReleaseReceipt {param($Path,$Receipt) return $Receipt}',
      'function Write-DurableDependencyReadyStamp {param($Root)}',
      'function Invoke-HotfixFaultInjection {param($Phase,$AppRoot)}',
      "function Set-HotfixTransactionPhase {param($Path,$Transaction,$Phase) $Transaction.phase=$Phase;return $Transaction}",
      'function Remove-TerminalHotfixDeploymentArtifacts {param($Root,$Transaction)}',
      'function Wait-AppHealth {param($TimeoutSeconds,$Endpoint,$Root,$LauncherProcess,$ExpectedProcessStartedAfterUtc)',
      ' if($null -eq $LauncherProcess){return $false};$deadline=(Get-Date).AddSeconds($TimeoutSeconds)',
      ' while((Get-Date)-lt $deadline){if((Test-Path $env:FIXTURE_PORT)-and (Test-Path (Join-Path $Root \'app.pid\'))){',
      '  $port=[IO.File]::ReadAllText($env:FIXTURE_PORT);$response=Invoke-RestMethod (\'http://127.0.0.1:\'+$port) -TimeoutSec 1',
      '  $record=Get-Content (Join-Path $Root \'app.pid\') -Raw|ConvertFrom-Json;$process=Get-Process -Id $record.pid',
      '  if($response.pid -ne $record.pid -or $process.Path -ine $env:FIXTURE_NODE){throw \'Unexpected synthetic listener\'};return $true',
      ' };Start-Sleep -Milliseconds 30};return $false}',
      `$app=${quote(app)};$pkg=${quote(pkg)};$manifest=Get-Content ${quote(join(directory, 'manifest.json'))} -Raw|ConvertFrom-Json`,
      '$failure=$null;$completed=$false',
      'try {',
      mode === 'committed'
        ? "$transaction=[pscustomobject]@{phase='committed';deploymentId='synthetic-proof'};$result=Complete-CommittedHotfixTransaction -Root $app -PackageRoot $pkg -JournalPath (Join-Path $app 'journal.json') -Transaction $transaction -Manifest $manifest -Endpoint 'http://127.0.0.1:1/session' -TimeoutSeconds 8;if($result.phase -ne 'finalized'){throw 'Not finalized'}"
        : "Start-RecoveredRuntime -Root $app -PackageRoot $pkg -Manifest $manifest -StartScriptPath (Join-Path $app '.rollback-start.ps1') -Endpoint 'http://127.0.0.1:1/session' -TimeoutSeconds 8",
      '$completed=$true',
      '}catch{$failure=$_.Exception.Message}finally{',
      " $pidFile=Join-Path $app 'app.pid';if(Test-Path $pidFile){$record=Get-Content $pidFile -Raw|ConvertFrom-Json;$owned=Get-CimInstance Win32_Process -Filter (\"ProcessId=\"+$record.pid) -ErrorAction SilentlyContinue;if($owned -and $owned.ExecutablePath -ieq $env:FIXTURE_NODE -and $owned.CommandLine.Contains((Join-Path $app 'dist/server/main.js'))){Stop-Process -Id $record.pid -ErrorAction Stop}}",
      '}',
      '[pscustomobject]@{completed=$completed;failure=$failure;launched=(Test-Path $env:FIXTURE_CAPTURE)}|ConvertTo-Json -Compress',
    ].join('\n');
    const ps = join(directory, 'exercise.ps1'); writeFileSync(ps, script);
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 25_000, cwd: directory,
      env: { ...process.env, PSModulePath: join(dirname(powershell), 'Modules'), LOCALAPPDATA: join(directory, 'cache'), FIXTURE_NODE: process.execPath,
        FIXTURE_CAPTURE: join(directory, 'runtime-capture.json'), FIXTURE_PORT: join(directory, 'port.txt') },
    });
    if (result.error || result.status !== 0) throw new Error(`Isolated recovery proof failed: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    return { summary, capture: existsSync(join(directory, 'runtime-capture.json')) ? JSON.parse(readFileSync(join(directory, 'runtime-capture.json'), 'utf8')) : null };
  }

  it('starts the committed candidate with a physically verified fingerprint in a fresh installer process', () => {
    const { summary, capture } = run('committed');
    expect(summary).toEqual({ completed: true, failure: null, launched: true });
    expect(capture).toMatchObject({ fingerprint: manifest.dependencyInstalledPhysicalTreeFingerprint, mode: 'verified-physical-tree', recoveryNode: null });
  });
  it('verifies the same installed tree before a rollback-specific launcher without enabling candidate mode', () => {
    const { summary, capture } = run('rollback');
    expect(summary).toEqual({ completed: true, failure: null, launched: true });
    expect(capture).toMatchObject({ fingerprint: null, mode: null, recoveryNode: process.execPath });
    const rollback = installer!.slice(installer!.indexOf('function Rollback-UncommittedHotfixTransaction'), installer!.indexOf('function Complete-CommittedHotfixTransaction'));
    expect(rollback).toMatch(/Start-RecoveredRuntime\s*`\s*-Root \$Root\s*`\s*-PackageRoot \$PackageRoot\s*`\s*-Manifest \$Manifest/u);
  });
  it.each(['committed', 'rollback'] as const)('refuses %s startup after dependency bytes drift, even with a matching manifest declaration', mode => {
    const { summary } = run(mode, true);
    expect(summary.completed).toBe(false); expect(summary.launched).toBe(false);
    expect(summary.failure).toMatch(/dependency|fingerprint|verifier/i);
  });
});
