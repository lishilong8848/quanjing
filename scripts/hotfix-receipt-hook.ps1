# Embedded in ONE-CLICK-HOTFIX.ps1 by the wrapper generator. Not an installer.
function Invoke-HotfixReceiptRelay {
  param([string]$Root, [string]$NodePath, [string]$ManifestPath, [string]$InnerSha256)
  try {
    if ($env:NANTONG_HOTFIX_SMOKE_MODE -match '^(1|true)$') { return }
    $expectedRoot = 'C:\ai\nantong-schedule-20260428-101724'
    if (-not [string]::Equals([IO.Path]::GetFullPath($Root).TrimEnd('\'), $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Write-Host '[INFO] Receipt relay skipped for a non-production application root.'
      return
    }
    $receiptPath = Join-Path $Root '.hotfix-installed-release.json'
    $journalPath = Join-Path $Root '.hotfix-transaction.json'
    $relayRoot = Join-Path $Root '.hotfix-receipt-relay'
    foreach ($target in @($receiptPath, $journalPath, $ManifestPath, $relayRoot)) {
      $itemPath = [IO.Path]::GetFullPath($target)
      while (-not [string]::IsNullOrWhiteSpace($itemPath)) {
        if (Test-Path -LiteralPath $itemPath) {
          $item = Get-Item -LiteralPath $itemPath -Force
          if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked relay path rejected.' }
        }
        $parent = Split-Path -Parent $itemPath
        if ($parent -eq $itemPath) { break }
        $itemPath = $parent
      }
    }
    foreach ($file in @($receiptPath, $journalPath, $ManifestPath)) {
      if ((Get-Item -LiteralPath $file).Length -gt 4MB) { throw 'Oversized relay metadata.' }
    }
    $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
    $journal = [IO.File]::ReadAllText($journalPath) | ConvertFrom-Json
    $manifest = [IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    if ($journal.phase -cne 'finalized' -or $receipt.deploymentId -cne $manifest.packageId -or
        $journal.deploymentId -cne $receipt.deploymentId -or $receipt.appRoot -ine $expectedRoot -or
        $receipt.deploymentId -cnotmatch '^nantong-safe-full-runtime-hotfix-\d{8}-\d{6,9}$') { throw 'Relay evidence is not finalized.' }
    New-Item -ItemType Directory -Path $relayRoot -Force | Out-Null
    # SYSTEM runs only immutable helper bytes in this administrators-only directory.
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
      $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $relayRoot -AclObject $acl
    $pendingRoot = Join-Path $relayRoot 'pending'
    New-Item -ItemType Directory -Path $pendingRoot -Force | Out-Null
    $helperBytes = [Convert]::FromBase64String('__RELAY_BASE64__')
    $shaAlgorithm = [Security.Cryptography.SHA256]::Create()
    try { $helperSha = ([BitConverter]::ToString($shaAlgorithm.ComputeHash($helperBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $shaAlgorithm.Dispose() }
    $helperPath = Join-Path $relayRoot "relay-$helperSha.cjs"
    if (Test-Path -LiteralPath $helperPath) {
      if ((Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $helperSha) { throw 'Relay helper hash mismatch.' }
    } else { [IO.File]::WriteAllBytes($helperPath, $helperBytes) }
    $jobPath = Join-Path $pendingRoot "$($receipt.deploymentId).json"
    $sentPath = Join-Path (Join-Path $relayRoot 'sent') "$($receipt.deploymentId).json"
    if (-not (Test-Path -LiteralPath $sentPath)) {
      $job = [ordered]@{ schemaVersion = 1; innerSha256 = $InnerSha256; receipt = $receipt;
        journal = $journal; manifest = $manifest; completedAt = [DateTime]::UtcNow.ToString('o') }
      $jobBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($job | ConvertTo-Json -Depth 20 -Compress))
      $temporaryPath = "$jobPath.$([Guid]::NewGuid().ToString('N')).tmp"
      $stream = New-Object IO.FileStream($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $stream.Write($jobBytes, 0, $jobBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
      Move-Item -LiteralPath $temporaryPath -Destination $jobPath -Force
    }
    $workerScript = @'
$ErrorActionPreference = 'Stop'
$nodePath = '__NODE__'
$helperPath = '__HELPER__'
$root = '__ROOT__'
$taskName = '__TASK__'
try {
  $action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $helperPath + '" publish --app-root "' + $root + '"') -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 45) -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
} catch { Write-Warning 'Receipt retry task setup failed; local pending evidence is preserved.' }
& $nodePath $helperPath publish --app-root $root
exit $LASTEXITCODE
'@
    $workerScript = $workerScript.Replace('__NODE__', $NodePath.Replace("'", "''")).Replace('__HELPER__', $helperPath.Replace("'", "''")).Replace('__ROOT__', $Root.Replace("'", "''")).Replace('__TASK__', 'Nantong-Production-Receipt-Relay')
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerScript))
    $logId = [Guid]::NewGuid().ToString('N')
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
      -WorkingDirectory $Root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $relayRoot "publish-$logId.out.log") `
      -RedirectStandardError (Join-Path $relayRoot "publish-$logId.err.log") | Out-Null
    Write-Host '[INFO] Production receipt queued; background upload does not delay or change installation success.'
  } catch {
    Write-Host '[WARN] Installation succeeded, but receipt relay could not be queued. Production registration remains pending.' -ForegroundColor Yellow
  }
}
