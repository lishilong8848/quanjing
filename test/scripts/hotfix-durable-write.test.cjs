const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('Windows durable journal tolerates bounded contention without weakening atomicity', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync(path.resolve('scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8');
  const installer = source.match(/\$installer = @'\r?\n([\s\S]*?)\r?\n'@\r?\nSet-Content -LiteralPath \(Join-Path \$stageRoot 'INSTALL-HOTFIX\.ps1'\)/)[1];
  const primitive = name => {
    const start = installer.indexOf(`function ${name} {`);
    if (start < 0) return '';
    const tail = installer.slice(start);
    const next = tail.slice(1).search(/^function /m);
    return next < 0 ? tail : tail.slice(0, next + 1);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-durable-write-'));
  const nativeStart = installer.indexOf("if (-not ('NantongHotfixNativeMethods' -as [type]))");
  const nativeEnd = installer.indexOf('$script:installedDependencyProofCache', nativeStart);
  const harness = [
    "Set-StrictMode -Version Latest; $ErrorActionPreference='Stop'",
    installer.slice(nativeStart, nativeEnd),
    ...['Get-TextSha256', 'Get-HotfixTransactionPayload', 'Get-HotfixTransactionChecksum',
      'Get-FinalPathByHandle', 'Assert-PathHasNoReparsePointAncestors',
      'Assert-FinalPathContainedByRoot', 'Assert-NoAlternateDataStreamsAtPath',
      'Get-DurableAtomicFileState', 'Move-DurableAtomicFileWithRetry', 'Write-DurableHotfixTransaction'].map(primitive),
    `Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class DurableWriteFixture {
  public static void HoldRead(string file, int milliseconds) {
    FileStream stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.Read);
    Thread worker = new Thread(delegate() { Thread.Sleep(milliseconds); stream.Dispose(); });
    worker.IsBackground = true; worker.Start();
  }
  public static void TransientReadOnly(string file, int milliseconds, bool drift) {
    File.SetAttributes(file, FileAttributes.ReadOnly);
    Thread worker = new Thread(delegate() {
      Thread.Sleep(milliseconds); File.SetAttributes(file, FileAttributes.Normal);
      if (drift) File.WriteAllText(file, "external-change");
    });
    worker.IsBackground = true; worker.Start();
  }
}
'@`,
    `$root='${root.replaceAll("'", "''")}'`,
    '$results = [Collections.Generic.List[object]]::new()',
    `function Check([string]$Name,[scriptblock]$Action) { try { & $Action; $results.Add(@{name=$Name;passed=$true}) } catch { $results.Add(@{name=$Name;passed=$false;error=$_.Exception.Message}) } }`,
    `function Journal([string]$File) {
      $value=[pscustomobject]@{schemaVersion=1;transactionId='ec9f840c-3a90-40be-9e61-88362c18e4c4';deploymentId='nantong-safe-full-runtime-hotfix-20261023-081638';appRoot=$root;intent='deploy';phase='candidate-healthy';releaseFiles=@();transactionChecksum=''}
      return Write-DurableHotfixTransaction -Path $File -Transaction $value
    }`,
    `Check 'normal atomic replacement preserves checksum' {
      $file=Join-Path $root 'normal.json'; [IO.File]::WriteAllText($file,'old')
      $value=Journal $file; $actual=[IO.File]::ReadAllText($file)|ConvertFrom-Json
      if($actual.transactionChecksum -cne (Get-HotfixTransactionChecksum $actual) -or $actual.phase -cne 'candidate-healthy'){throw 'Invalid durable payload'}
    }`,
    `Check 'transient native sharing violation recovers atomically' {
      $file=Join-Path $root 'sharing.json'; [IO.File]::WriteAllText($file,'old')
      [DurableWriteFixture]::HoldRead($file,400)
      $null=Journal $file
      if(([IO.File]::ReadAllText($file)|ConvertFrom-Json).phase -cne 'candidate-healthy'){throw 'Not committed'}
    }`,
    `Check 'transient native Win32=5 recovers without changing attributes itself' {
      $file=Join-Path $root 'denied.json'; [IO.File]::WriteAllText($file,'old')
      [DurableWriteFixture]::TransientReadOnly($file,400,$false)
      $null=Journal $file
      if(([IO.File]::ReadAllText($file)|ConvertFrom-Json).phase -cne 'candidate-healthy'){throw 'Not committed'}
    }`,
    `Check 'persistent denial is bounded and preserves original journal' {
      $file=Join-Path $root 'permanent.json'; [IO.File]::WriteAllText($file,'old')
      [IO.File]::SetAttributes($file,[IO.FileAttributes]::ReadOnly)
      $clock=[Diagnostics.Stopwatch]::StartNew();$failure=''
      try{$null=Journal $file}catch{$failure=$_.Exception.Message}
      if($failure -notmatch 'Win32=5' -or $clock.ElapsedMilliseconds -gt 5000 -or [IO.File]::ReadAllText($file) -cne 'old' -or !([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReadOnly)){throw 'Denial bypassed or old journal changed'}
      [IO.File]::SetAttributes($file,[IO.FileAttributes]::Normal)
    }`,
    `Check 'other writer is detected during retry and never overwritten' {
      $file=Join-Path $root 'drift.json'; [IO.File]::WriteAllText($file,'old')
      [DurableWriteFixture]::TransientReadOnly($file,350,$true)
      $failure='';try{$null=Journal $file}catch{$failure=$_.Exception.Message}
      Start-Sleep -Milliseconds 500
      if($failure -notmatch 'changed' -or [IO.File]::ReadAllText($file) -cne 'external-change'){throw 'Concurrent bytes not protected'}
    }`,
    `Check 'directory destination is rejected without removal' {
      $file=Join-Path $root 'directory.json';$null=New-Item -ItemType Directory -Path $file
      $failure='';try{$null=Journal $file}catch{$failure=$_.Exception.Message}
      if(!$failure -or !(Test-Path -LiteralPath $file -PathType Container)){throw 'Directory was accepted'}
    }`,
    `Check 'alternate data stream destination is refused without change' {
      $file=Join-Path $root 'ads.json';[IO.File]::WriteAllText($file,'old');Set-Content -LiteralPath $file -Stream unexpected -Value 'keep' -NoNewline
      $failure='';try{$null=Journal $file}catch{$failure=$_.Exception.Message}
      if(!$failure -or [IO.File]::ReadAllText($file) -cne 'old' -or (Get-Content -LiteralPath $file -Stream unexpected -Raw) -cne 'keep'){throw 'ADS was ignored'}
    }`,
    `Check 'no orphan temporary write files remain' { if(@(Get-ChildItem -LiteralPath $root -Filter '*.tmp').Count){throw 'Temporary write remained'} }`,
    "Write-Output ('DURABLE-RESULT:' + ($results|ConvertTo-Json -Depth 5 -Compress))",
    'if(@($results|Where-Object {!$_.passed}).Count){exit 1}',
  ].join('\r\n');
  fs.writeFileSync(path.join(root, 'harness.ps1'), '\ufeff' + harness);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(root, 'harness.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    process.stdout.write(result.stdout || '');
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const records = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('DURABLE-RESULT:')).slice('DURABLE-RESULT:'.length));
    assert.equal(records.length, 8);
    assert.ok(records.every(item => item.passed));
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'nt-durable-write-')));
    for (const entry of fs.readdirSync(root)) {
      const file = path.join(root, entry);
      if (fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o666);
    }
    fs.rmSync(root, { recursive: true });
  }
});
