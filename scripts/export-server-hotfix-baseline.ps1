[CmdletBinding()]
param(
  [string]$AppRoot,
  [string]$SearchRoot = 'C:\ai',
  [string]$OutputDirectory,
  [double]$MaxUncompressedMiB = 256,
  [switch]$PruneHistoricalClientChunks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-FullPath {
  param([string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-AppRootCandidate {
  param([string]$CandidateRoot)
  if (-not (Test-Path -LiteralPath $CandidateRoot -PathType Container)) {
    return $false
  }
  foreach ($relativePath in @(
    'package.json',
    'package-lock.json',
    'start.ps1',
    'start.cmd',
    'dist/server/main.js',
    'dist/client/index.html'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $CandidateRoot $relativePath) -PathType Leaf)) {
      return $false
    }
  }
  foreach ($relativePath in @('dist/server', 'dist/shared', 'dist/client')) {
    if (-not (Test-Path -LiteralPath (Join-Path $CandidateRoot $relativePath) -PathType Container)) {
      return $false
    }
  }
  return $true
}

function Find-ApplicationRoot {
  param([string]$Root)
  $searchRootPath = (Resolve-Path -LiteralPath $Root).Path
  if (-not (Test-Path -LiteralPath $searchRootPath -PathType Container)) {
    throw "SearchRoot is not a directory: $Root"
  }
  $candidates = @(
    Get-ChildItem -LiteralPath $searchRootPath -Directory -Force |
      Where-Object {
        $_.Name -like 'nantong-schedule-*' -and
        (Test-AppRootCandidate -CandidateRoot $_.FullName)
      }
  )
  if ($candidates.Count -eq 1) {
    return $candidates[0].FullName
  }
  if ($candidates.Count -eq 0) {
    throw "No Nantong application root was found below: $searchRootPath"
  }
  throw 'More than one Nantong application root was detected. Pass -AppRoot explicitly.'
}

function Assert-PathInsideRoot {
  param(
    [string]$Root,
    [string]$Candidate
  )
  $rootPath = Get-FullPath -Path $Root
  $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
  $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $candidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes the application root: $Candidate"
  }
  return $candidatePath
}

function Get-RelativeUnixPath {
  param(
    [string]$Root,
    [string]$FullPath
  )
  $rootPath = Get-FullPath -Path $Root
  $candidatePath = Assert-PathInsideRoot -Root $rootPath -Candidate $FullPath
  return $candidatePath.Substring($rootPath.Length + 1).Replace('\', '/')
}

function Get-TextSha256 {
  param([string]$Text)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-PathSortKey {
  param([string]$Path)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path)
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Write-ExportCandidateSizeSummary {
  param(
    [Parameter(Mandatory = $true)][string]$Heading,
    [Parameter(Mandatory = $true)][object[]]$Candidates,
    [Parameter(Mandatory = $true)][scriptblock]$GroupBy
  )

  Write-Host "[INFO] $Heading"
  $summaries = @(
    $Candidates |
      Group-Object -Property $GroupBy |
      ForEach-Object {
        $bytes = [int64](($_.Group | Measure-Object -Property Length -Sum).Sum)
        [pscustomobject]@{
          Name = [string]$_.Name
          Count = [int]$_.Count
          Bytes = $bytes
        }
      }
  )
  foreach ($summary in @(
    $summaries |
      Sort-Object -Property @{ Expression = 'Bytes'; Descending = $true }, @{ Expression = 'Name'; Descending = $false }
  )) {
    $nameJson = ConvertTo-Json -InputObject ([string]$summary.Name) -Compress
    $sizeMiB = ([double]$summary.Bytes / 1MB).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-Host "[INFO] $sizeMiB MiB  $($summary.Count) files  $nameJson"
  }
}

function Resolve-TrustedNodeExecutable {
  param([Parameter(Mandatory = $true)][string]$AppRoot)

  $candidates = New-Object System.Collections.Generic.List[object]
  [void]$candidates.Add([pscustomobject]@{
    Path = Join-Path (Join-Path $AppRoot '.runtime') 'node/node.exe'
    Label = 'application portable Node'
  })
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $pathNode) {
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
  }
  if ($pathNode) {
    [void]$candidates.Add([pscustomobject]@{
      Path = [string]$pathNode.Source
      Label = 'Node from PATH'
    })
  }
  foreach ($standardCandidate in @(
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs/node.exe' }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs/node.exe' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe' })
  )) {
    if (-not [string]::IsNullOrWhiteSpace([string]$standardCandidate)) {
      [void]$candidates.Add([pscustomobject]@{
        Path = [string]$standardCandidate
        Label = 'Node from a standard Windows installation'
      })
    }
  }

  $seenPaths = @{}
  foreach ($candidate in $candidates) {
    $candidatePath = [string]$candidate.Path
    if ([string]::IsNullOrWhiteSpace($candidatePath) -or -not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      continue
    }
    $fullPath = [System.IO.Path]::GetFullPath($candidatePath)
    $pathKey = $fullPath.ToLowerInvariant()
    if ($seenPaths.ContainsKey($pathKey)) {
      continue
    }
    $seenPaths[$pathKey] = $true
    Assert-NotReparsePoint -Path $fullPath
    return [pscustomobject]@{
      Path = $fullPath
      Label = [string]$candidate.Label
    }
  }

  throw 'No trusted Node.js runtime was found for client asset graph verification.'
}

function Invoke-ClientAssetGraphVerifier {
  param(
    [Parameter(Mandatory = $true)][string]$VerifierPath,
    [Parameter(Mandatory = $true)][string]$ClientRoot,
    [Parameter(Mandatory = $true)][string]$NodePath
  )

  if (-not (Test-Path -LiteralPath $VerifierPath -PathType Leaf)) {
    throw 'Client asset graph verifier is missing from the baseline collector.'
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = "`"$VerifierPath`" --root `"$ClientRoot`" --json"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw 'Client asset graph verifier could not be started.'
    }
    $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
    $standardErrorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
      try { $process.Kill() } catch {}
      throw 'Client asset graph verifier exceeded 30000ms.'
    }
    $standardOutput = $standardOutputTask.Result.Trim()
    $standardError = $standardErrorTask.Result.Trim()
    if ($process.ExitCode -ne 0) {
      if ([string]::IsNullOrWhiteSpace($standardError)) {
        throw "Client asset graph verifier failed with exit code $($process.ExitCode)."
      }
      throw "Client asset graph verifier failed: $standardError"
    }
    if ([string]::IsNullOrWhiteSpace($standardOutput)) {
      throw 'Client asset graph verifier returned no JSON report.'
    }
    try {
      $report = $standardOutput | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw 'Client asset graph verifier returned invalid JSON.'
    }
    if ($null -eq $report -or $report.ok -ne $true) {
      throw 'Client asset graph verifier did not confirm a complete graph.'
    }
    return $report
  } finally {
    $process.Dispose()
  }
}

function Assert-NotReparsePoint {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse points are not allowed in the baseline whitelist: $Path"
  }
}

function Assert-NoAlternateDataStreams {
  param(
    [string]$Path,
    [switch]$AllowZoneIdentifier
  )
  $isWindowsPlatform = $env:OS -eq 'Windows_NT'
  if (-not $isWindowsPlatform) {
    return
  }
  try {
    foreach ($stream in @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop)) {
      if ($stream.Stream -in @(':$DATA', '$DATA')) {
        continue
      }
      if ($AllowZoneIdentifier -and $stream.Stream -eq 'Zone.Identifier') {
        continue
      }
      throw "Alternate data streams are not allowed in the baseline whitelist: $Path"
    }
  } catch {
    if ($_.Exception.Message -like 'Alternate data streams are not allowed*') {
      throw
    }
    # Some non-Windows file providers do not implement -Stream.
  }
}

function Assert-SafeRelativePath {
  param(
    [string]$RelativePath,
    [switch]$AllowSourceMapMetadata
  )
  $normalized = $RelativePath.Replace('\', '/')
  $lower = $normalized.ToLowerInvariant()
  if (
    [System.IO.Path]::IsPathRooted($normalized) -or
    $normalized.Contains(':') -or
    @($normalized.Split('/')) -contains '..'
  ) {
    throw "Unsafe baseline path: $RelativePath"
  }

  $forbiddenSegments = @(
    '.git',
    '.runtime',
    '.cache',
    'node_modules',
    'nantong-schedule-state',
    'logs',
    'certs',
    'uploads',
    'attachments',
    'backups'
  )
  foreach ($segment in @($lower.Split('/'))) {
    if ($segment.StartsWith('.env', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Environment files are forbidden in a server baseline export: $RelativePath"
    }
    if ($forbiddenSegments -contains $segment) {
      throw "Runtime or sensitive path is forbidden in a server baseline export: $RelativePath"
    }
  }

  $forbiddenFileNames = @('.npmrc', 'app.pid')
  if ($forbiddenFileNames -contains [System.IO.Path]::GetFileName($lower)) {
    throw "Sensitive or runtime file is forbidden in a server baseline export: $RelativePath"
  }
  $forbiddenExtensions = @(
    '.map',
    '.pem',
    '.key',
    '.pfx',
    '.p12',
    '.crt',
    '.cer',
    '.der',
    '.jks',
    '.keystore',
    '.db',
    '.sqlite',
    '.bak',
    '.zip',
    '.7z',
    '.rar'
  )
  $extension = [System.IO.Path]::GetExtension($lower)
  if (
    $forbiddenExtensions -contains $extension -and
    -not ($AllowSourceMapMetadata -and $extension -eq '.map')
  ) {
    throw "Forbidden file type in a server baseline export: $RelativePath"
  }
}

function Assert-NoEmbeddedCredential {
  param(
    [string]$Path,
    [string]$RelativePath
  )
  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  $textExtensions = @('.js', '.json', '.html', '.css', '.ps1', '.cmd', '.mjs', '.txt', '.d.ts')
  if ($textExtensions -notcontains $extension -and -not $Path.EndsWith('.d.ts', [System.StringComparison]::OrdinalIgnoreCase)) {
    return
  }
  $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  $credentialPatterns = @(
    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?im)^\s*(?:(?:const|let|var)\s+)?(?:FEISHU_APP_SECRET|LARK_APP_SECRET|CLIENT_SECRET|APP_SECRET|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|DATABASE_URL|PASSWORD)\s*[:=]\s*["''][^"'']{12,}["'']',
    '(?im)^\s*\$env:(?:FEISHU_APP_SECRET|LARK_APP_SECRET|CLIENT_SECRET|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|DATABASE_URL|PASSWORD)\s*=\s*["''][^"'']{12,}["'']',
    '(?i)["''](?:appSecret|app_secret|clientSecret|client_secret|privateKey|private_key|secretKey|secret_key|accessToken|access_token|databaseUrl|database_url|password)["'']\s*:\s*["''][^"'']{12,}["'']'
  )
  foreach ($pattern in $credentialPatterns) {
    if ($content -match $pattern) {
      throw "Potential embedded credential detected in baseline file: $RelativePath"
    }
  }
}

function Copy-FileWithRetry {
  param(
    [string]$Source,
    [string]$Destination,
    [int]$Attempts = 5
  )
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    $sourceStream = $null
    $destinationStream = $null
    try {
      $sourceStream = [System.IO.File]::Open(
        $Source,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
      )
      $destinationStream = [System.IO.File]::Open(
        $Destination,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
      )
      $sourceStream.CopyTo($destinationStream)
      $destinationStream.Flush()
      return
    } catch {
      if ($attempt -eq $Attempts) {
        throw
      }
      Start-Sleep -Milliseconds 200
    } finally {
      if ($destinationStream) {
        $destinationStream.Dispose()
      }
      if ($sourceStream) {
        $sourceStream.Dispose()
      }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($AppRoot)) {
  $AppRoot = Find-ApplicationRoot -Root $SearchRoot
  Write-Host "[INFO] Auto-detected application root: $AppRoot"
}
$appRootPath = Get-FullPath -Path (Resolve-Path -LiteralPath $AppRoot).Path
if (-not (Test-Path -LiteralPath $appRootPath -PathType Container)) {
  throw "Application root is not a directory: $AppRoot"
}
Assert-NotReparsePoint -Path $appRootPath

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path (Split-Path -Parent $appRootPath) 'nantong-server-baseline-export'
}
$outputRootPath = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
$appPrefix = $appRootPath + [System.IO.Path]::DirectorySeparatorChar
if (
  $outputRootPath.Equals($appRootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
  $outputRootPath.StartsWith($appPrefix, [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw 'OutputDirectory must be outside the running application root.'
}
if ($MaxUncompressedMiB -le 0) {
  throw 'MaxUncompressedMiB must be greater than zero.'
}

$requiredFiles = @(
  'package.json',
  'package-lock.json',
  'start.ps1',
  'start.cmd',
  'dist/server/main.js',
  'dist/client/index.html'
)
$runtimeRoots = @('dist/server', 'dist/shared', 'dist/client')
$optionalFiles = @(
  '.feishu-card-action-consumer-release',
  'stop.ps1',
  'watchdog.ps1',
  'scripts/run-with-env.mjs',
  'scripts/remove-legacy-contract-ocr.ps1',
  'scripts/ensure-feishu-card-ws-sdk-patch.mjs',
  'scripts/postinstall.mjs',
  'scripts/ensure-overtime-workflow-fields.mjs',
  'scripts/ensure-purchase-inventory-config.mjs',
  'scripts/verify-contract-storage-startup.mjs',
  'scripts/verify-feishu-access-startup.mjs',
  'scripts/install-contract-preview-python-deps.ps1',
  'scripts/requirements-contract-preview.txt',
  'scripts/weekly-report/bridge.py',
  'scripts/weekly-report/nantong_weekly_report.py',
  'scripts/weekly-report/env_loader.py',
  'scripts/weekly-report/native_feishu.py',
  'scripts/ensure-inventory-outbound-approval-fields.mjs',
  'scripts/ensure-leave-workflow-fields.mjs',
  'scripts/migrate-leave-shift-substitute-details.mjs',
  'scripts/backfill-dingtalk-attendance-archive.mjs',
  'scripts/dingtalk-attendance-cli.mjs',
  'scripts/ensure-attendance-archive-summary-fields.mjs',
  'scripts/ensure-today-operations-follow-up-fields.mjs',
  'scripts/migrate-dingtalk-attendance-credentials.ps1',
  'scripts/migrate-legacy-exception-follow-ups.mjs',
  'scripts/reset-all-access-passwords.cmd',
  'scripts/reset-all-access-passwords.ps1',
  'scripts/reset-all-access-passwords.mjs'
)

function Get-BaselineSourceFiles {
  param(
    [string]$Root,
    [string[]]$RuntimeRoots,
    [string[]]$OptionalFiles
  )
  $filesByRelativePath = [ordered]@{}
  foreach ($relativePath in @('package.json', 'package-lock.json', 'start.ps1', 'start.cmd')) {
    $filesByRelativePath[$relativePath] = Join-Path $Root $relativePath
  }
  foreach ($relativeRoot in $RuntimeRoots) {
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Root $relativeRoot) -File -Force -Recurse | Sort-Object FullName)) {
      $relativePath = Get-RelativeUnixPath -Root $Root -FullPath $file.FullName
      if ($filesByRelativePath.Contains($relativePath)) {
        throw "Duplicate baseline path (case-insensitive): $relativePath"
      }
      $filesByRelativePath[$relativePath] = $file.FullName
    }
  }
  foreach ($relativePath in $OptionalFiles) {
    $fullPath = Join-Path $Root $relativePath
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
      $normalizedRelativePath = $relativePath.Replace('\', '/')
      if ($filesByRelativePath.Contains($normalizedRelativePath)) {
        throw "Duplicate baseline path (case-insensitive): $normalizedRelativePath"
      }
      $filesByRelativePath[$normalizedRelativePath] = $fullPath
    }
  }
  return $filesByRelativePath
}

foreach ($relativePath in $requiredFiles) {
  $fullPath = Join-Path $appRootPath $relativePath
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Required server baseline file is missing: $relativePath"
  }
}
foreach ($relativeRoot in $runtimeRoots) {
  $fullRoot = Join-Path $appRootPath $relativeRoot
  if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
    throw "Required server runtime directory is missing: $relativeRoot"
  }
  Assert-NotReparsePoint -Path $fullRoot
  foreach ($item in @(Get-ChildItem -LiteralPath $fullRoot -Force -Recurse)) {
    Assert-NotReparsePoint -Path $item.FullName
  }
  if (@(Get-ChildItem -LiteralPath $fullRoot -File -Force -Recurse).Count -eq 0) {
    throw "Required server runtime directory is empty: $relativeRoot"
  }
}

$sourceFilesByRelativePath = Get-BaselineSourceFiles -Root $appRootPath -RuntimeRoots $runtimeRoots -OptionalFiles $optionalFiles
$clientAssetGraphVerifierPath = Join-Path $PSScriptRoot 'verify-client-asset-graph.mjs'
$clientAssetGraphNodeRuntime = Resolve-TrustedNodeExecutable -AppRoot $appRootPath
Write-Host "[INFO] Client asset graph verifier runtime: $($clientAssetGraphNodeRuntime.Label)."
$clientAssetGraph = Invoke-ClientAssetGraphVerifier `
  -VerifierPath $clientAssetGraphVerifierPath `
  -ClientRoot (Join-Path $appRootPath 'dist/client') `
  -NodePath ([string]$clientAssetGraphNodeRuntime.Path)
$activeClientChunkPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($assetPathValue in @($clientAssetGraph.activeChunkAssets)) {
  $assetPath = ([string]$assetPathValue).Replace('\', '/')
  if ($assetPath -notmatch '^chunks/[^/\\]+\.[0-9a-fA-F]{8,64}(?:\.legacy)?\.(?:js|css)$') {
    throw "Client asset graph contains an unsupported chunk path: $assetPath"
  }
  $baselinePath = "dist/client/$assetPath"
  Assert-SafeRelativePath -RelativePath $baselinePath
  if (-not $sourceFilesByRelativePath.Contains($baselinePath)) {
    throw "Client asset graph references a file outside the frozen baseline set: $baselinePath"
  }
  if (-not $activeClientChunkPaths.Add($baselinePath)) {
    throw "Client asset graph contains a duplicate chunk path: $baselinePath"
  }
}
if ($activeClientChunkPaths.Count -eq 0) {
  throw 'Client asset graph did not identify any active hashed chunks.'
}

if ($PruneHistoricalClientChunks) {
  $chunksRoot = Join-Path $appRootPath 'dist/client/chunks'
  $historicalChunkFiles = @(
    Get-ChildItem -LiteralPath $chunksRoot -File -Force |
      Where-Object {
        $_.Name -match '^[^/\\]+\.[0-9a-fA-F]{8,64}(?:\.legacy)?\.(?:js|css)$' -and
        -not $activeClientChunkPaths.Contains("dist/client/chunks/$($_.Name)")
      } |
      Sort-Object FullName
  )
  if ($historicalChunkFiles.Count -gt 0) {
    $applicationParent = Split-Path -Parent $appRootPath
    $quarantineRoot = Join-Path $applicationParent '.nantong-client-chunk-quarantine'
    if (Test-Path -LiteralPath $quarantineRoot) {
      Assert-NotReparsePoint -Path $quarantineRoot
    } else {
      [void](New-Item -ItemType Directory -Path $quarantineRoot -Force)
    }
    $cleanupId = (Get-Date).ToString('yyyyMMdd-HHmmssfff')
    $quarantineSessionRoot = Join-Path $quarantineRoot "$([System.IO.Path]::GetFileName($appRootPath))-$cleanupId"
    $quarantinedChunksRoot = Join-Path $quarantineSessionRoot 'chunks'
    $replacementChunksRoot = Join-Path (Split-Path -Parent $chunksRoot) "chunks.cleanup-staging-$cleanupId"
    if (Test-Path -LiteralPath $quarantineSessionRoot) {
      throw "Client chunk quarantine target already exists: $quarantineSessionRoot"
    }
    if (Test-Path -LiteralPath $replacementChunksRoot) {
      throw "Client chunk replacement staging path already exists: $replacementChunksRoot"
    }

    [void](New-Item -ItemType Directory -Path $replacementChunksRoot -Force)
    try {
      $historicalPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
      foreach ($file in $historicalChunkFiles) {
        [void]$historicalPaths.Add($file.FullName)
      }
      foreach ($file in @(Get-ChildItem -LiteralPath $chunksRoot -File -Force -Recurse | Sort-Object FullName)) {
        Assert-NotReparsePoint -Path $file.FullName
        if ($historicalPaths.Contains($file.FullName)) {
          continue
        }
        $relativeChunkPath = Get-RelativeUnixPath -Root $chunksRoot -FullPath $file.FullName
        $destinationPath = Join-Path $replacementChunksRoot $relativeChunkPath.Replace('/', '\')
        [void](New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force)
        Copy-Item -LiteralPath $file.FullName -Destination $destinationPath -Force
      }

      [void](New-Item -ItemType Directory -Path $quarantineSessionRoot -Force)
      Move-Item -LiteralPath $chunksRoot -Destination $quarantinedChunksRoot
      try {
        Move-Item -LiteralPath $replacementChunksRoot -Destination $chunksRoot
        $verifiedGraph = Invoke-ClientAssetGraphVerifier `
          -VerifierPath $clientAssetGraphVerifierPath `
          -ClientRoot (Join-Path $appRootPath 'dist/client') `
          -NodePath ([string]$clientAssetGraphNodeRuntime.Path)
        $verifiedActivePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($assetPathValue in @($verifiedGraph.activeChunkAssets)) {
          [void]$verifiedActivePaths.Add("dist/client/$(([string]$assetPathValue).Replace('\', '/'))")
        }
        if (
          $verifiedActivePaths.Count -ne $activeClientChunkPaths.Count -or
          @($activeClientChunkPaths | Where-Object { -not $verifiedActivePaths.Contains($_) }).Count -gt 0
        ) {
          throw 'Client asset graph changed during historical chunk cleanup.'
        }
        $remainingHistoricalChunks = @(
          Get-ChildItem -LiteralPath $chunksRoot -File -Force |
            Where-Object {
              $_.Name -match '^[^/\\]+\.[0-9a-fA-F]{8,64}(?:\.legacy)?\.(?:js|css)$' -and
              -not $activeClientChunkPaths.Contains("dist/client/chunks/$($_.Name)")
            }
        )
        if ($remainingHistoricalChunks.Count -gt 0) {
          throw 'Historical client chunks remain after cleanup.'
        }
      } catch {
        $failedReplacementRoot = Join-Path $quarantineSessionRoot 'failed-replacement-chunks'
        if (Test-Path -LiteralPath $chunksRoot) {
          Move-Item -LiteralPath $chunksRoot -Destination $failedReplacementRoot
        }
        Move-Item -LiteralPath $quarantinedChunksRoot -Destination $chunksRoot
        throw
      }
    } finally {
      if (Test-Path -LiteralPath $replacementChunksRoot) {
        Remove-Item -LiteralPath $replacementChunksRoot -Recurse -Force
      }
    }
    Write-Host "[OK] Quarantined $($historicalChunkFiles.Count) historical client chunks: $quarantineSessionRoot"
    $sourceFilesByRelativePath = Get-BaselineSourceFiles -Root $appRootPath -RuntimeRoots $runtimeRoots -OptionalFiles $optionalFiles
  } else {
    Write-Host '[INFO] No historical client chunks require cleanup.'
  }
}

$nonExportedReasonByRelativePath = @{}
$historicalClientChunkBytes = [int64]0
foreach ($entry in $sourceFilesByRelativePath.GetEnumerator()) {
  $relativePath = ([string]$entry.Key).Replace('\', '/')
  $extension = [System.IO.Path]::GetExtension($relativePath)
  if ($extension.Equals('.map', [System.StringComparison]::OrdinalIgnoreCase)) {
    $nonExportedReasonByRelativePath[$relativePath] = 'source-map-content-not-exported'
    continue
  }
  if (
    $relativePath.StartsWith('dist/client/chunks/', [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $activeClientChunkPaths.Contains($relativePath)
  ) {
    $fileName = [System.IO.Path]::GetFileName($relativePath)
    if ($fileName -match '^[^/\\]+\.[0-9a-fA-F]{8,64}(?:\.legacy)?\.(?:js|css)$') {
      $nonExportedReasonByRelativePath[$relativePath] = 'unreferenced-client-chunk-content-not-exported'
      $historicalClientChunkBytes += [int64](Get-Item -LiteralPath ([string]$entry.Value)).Length
    }
  }
}
Write-Host "[INFO] Client asset graph: $($activeClientChunkPaths.Count) active chunks; $(@($nonExportedReasonByRelativePath.GetEnumerator() | Where-Object { $_.Value -eq 'unreferenced-client-chunk-content-not-exported' }).Count) historical client chunks kept as metadata only ($(([double]$historicalClientChunkBytes / 1MB).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)) MiB)."

$totalBytes = [int64]0
$exportCandidateSizes = [System.Collections.Generic.List[object]]::new()
foreach ($entry in $sourceFilesByRelativePath.GetEnumerator()) {
  $relativePath = ([string]$entry.Key).Replace('\', '/')
  $isMetadataOnlySourceMap = [System.IO.Path]::GetExtension($relativePath).Equals('.map', [System.StringComparison]::OrdinalIgnoreCase)
  $isMetadataOnlyRuntimeFile = $nonExportedReasonByRelativePath.ContainsKey($relativePath)
  if ($isMetadataOnlySourceMap) {
    Assert-SafeRelativePath -RelativePath $relativePath -AllowSourceMapMetadata
    if (
      -not $relativePath.StartsWith('dist/server/', [System.StringComparison]::OrdinalIgnoreCase) -and
      -not $relativePath.StartsWith('dist/shared/', [System.StringComparison]::OrdinalIgnoreCase) -and
      -not $relativePath.StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      throw "Metadata-only server baseline path must be a source map under dist: $relativePath"
    }
  } else {
    Assert-SafeRelativePath -RelativePath $relativePath
  }
  Assert-NotReparsePoint -Path ([string]$entry.Value)
  Assert-NoAlternateDataStreams -Path ([string]$entry.Value) -AllowZoneIdentifier
  if (-not $isMetadataOnlyRuntimeFile) {
    $fileLength = [int64](Get-Item -LiteralPath ([string]$entry.Value)).Length
    $totalBytes += $fileLength
    $exportCandidateSizes.Add([pscustomobject]@{
      RelativePath = $relativePath
      Length = $fileLength
    })
  }
}
$limitBytes = [int64]($MaxUncompressedMiB * 1MB)
if ($totalBytes -gt $limitBytes) {
  $exportCandidateArray = @($exportCandidateSizes)
  Write-ExportCandidateSizeSummary `
    -Heading 'Export candidate totals by runtime root:' `
    -Candidates $exportCandidateArray `
    -GroupBy {
      $candidatePath = [string]$_.RelativePath
      if ($candidatePath.StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase)) { return 'dist/client' }
      if ($candidatePath.StartsWith('dist/server/', [System.StringComparison]::OrdinalIgnoreCase)) { return 'dist/server' }
      if ($candidatePath.StartsWith('dist/shared/', [System.StringComparison]::OrdinalIgnoreCase)) { return 'dist/shared' }
      return 'project-root-files'
    }
  $clientExportCandidates = @(
    $exportCandidateArray |
      Where-Object { ([string]$_.RelativePath).StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase) }
  )
  if ($clientExportCandidates.Count -gt 0) {
    Write-ExportCandidateSizeSummary `
      -Heading 'dist/client totals by first path segment:' `
      -Candidates $clientExportCandidates `
      -GroupBy {
        $candidatePath = [string]$_.RelativePath
        $tail = $candidatePath.Substring('dist/client/'.Length)
        $separatorIndex = $tail.IndexOf('/')
        if ($separatorIndex -lt 0) { return 'dist/client/(root)' }
        return "dist/client/$($tail.Substring(0, $separatorIndex))"
      }
  }
  Write-ExportCandidateSizeSummary `
    -Heading 'Export candidate totals by file extension:' `
    -Candidates $exportCandidateArray `
    -GroupBy {
      $extension = [System.IO.Path]::GetExtension([string]$_.RelativePath)
      if ([string]::IsNullOrWhiteSpace($extension)) { return '(no extension)' }
      return $extension.ToLowerInvariant()
    }
  Write-Host '[INFO] Largest export candidates (relative paths only):'
  $largestExportCandidates = @(
    $exportCandidateSizes |
      Sort-Object -Property @{ Expression = 'Length'; Descending = $true }, @{ Expression = 'RelativePath'; Descending = $false } |
      Select-Object -First 20
  )
  foreach ($candidate in $largestExportCandidates) {
    $relativePathJson = ConvertTo-Json -InputObject ([string]$candidate.RelativePath) -Compress
    $sizeMiB = ([double]$candidate.Length / 1MB).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-Host "[INFO] $sizeMiB MiB  $relativePathJson"
  }
  throw "Baseline whitelist exceeds the size limit: $([math]::Round($totalBytes / 1MB, 2)) MiB > $MaxUncompressedMiB MiB."
}

New-Item -ItemType Directory -Path $outputRootPath -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$exportId = "nantong-server-baseline-$timestamp"
$stageRoot = Join-Path $outputRootPath "$exportId-stage"
$baselineStageRoot = Join-Path $stageRoot 'baseline'
$zipPath = Join-Path $outputRootPath "$exportId.zip"
$partialZipPath = "$zipPath.partial"
$shaPath = "$zipPath.sha256"
foreach ($path in @($stageRoot, $zipPath, $partialZipPath, $shaPath)) {
  if (Test-Path -LiteralPath $path) {
    throw "Export target already exists: $path"
  }
}

$completed = $false
try {
  New-Item -ItemType Directory -Path $baselineStageRoot -Force | Out-Null
  $capturedFiles = New-Object System.Collections.Generic.List[object]
  $nonExportedCapturedFiles = New-Object System.Collections.Generic.List[object]
  $allCapturedFiles = New-Object System.Collections.Generic.List[object]
  foreach ($entry in $sourceFilesByRelativePath.GetEnumerator()) {
    $relativePath = ([string]$entry.Key).Replace('\', '/')
    $sourcePath = [string]$entry.Value
    $sourceHashBefore = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceSizeBefore = (Get-Item -LiteralPath $sourcePath).Length
    $capturedEntry = [ordered]@{
      path = $relativePath
      sha256 = $sourceHashBefore
      size = $sourceSizeBefore
      sourcePath = $sourcePath
    }
    [void]$allCapturedFiles.Add($capturedEntry)
    if ($nonExportedReasonByRelativePath.ContainsKey($relativePath)) {
      $capturedEntry['reason'] = [string]$nonExportedReasonByRelativePath[$relativePath]
      [void]$nonExportedCapturedFiles.Add($capturedEntry)
      continue
    }
    $destinationPath = Join-Path $baselineStageRoot $relativePath.Replace('/', '\')
    Copy-FileWithRetry -Source $sourcePath -Destination $destinationPath
    Assert-NoAlternateDataStreams -Path $destinationPath
    $copiedHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copiedHash -ne $sourceHashBefore -or (Get-Item -LiteralPath $destinationPath).Length -ne $sourceSizeBefore) {
      throw "Baseline file changed or copied incompletely: $relativePath"
    }
    Assert-NoEmbeddedCredential -Path $destinationPath -RelativePath $relativePath
    [void]$capturedFiles.Add([ordered]@{
      path = $relativePath
      sha256 = $copiedHash
      size = $sourceSizeBefore
      sourcePath = $sourcePath
    })
  }

  foreach ($captured in @($allCapturedFiles | ForEach-Object { $_ })) {
    $sourceHashAfter = (Get-FileHash -LiteralPath ([string]$captured.sourcePath) -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceSizeAfter = (Get-Item -LiteralPath ([string]$captured.sourcePath)).Length
    if ($sourceHashAfter -ne [string]$captured.sha256 -or $sourceSizeAfter -ne [int64]$captured.size) {
      throw "Server files changed during baseline capture; retry after deployment activity stops: $($captured.path)"
    }
  }

  $sourceFilesAfterCapture = Get-BaselineSourceFiles -Root $appRootPath -RuntimeRoots $runtimeRoots -OptionalFiles $optionalFiles
  $sourcePathsBefore = @($sourceFilesByRelativePath.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  $sourcePathsAfter = @($sourceFilesAfterCapture.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  if (
    $sourcePathsBefore.Count -ne $sourcePathsAfter.Count -or
    (Compare-Object -ReferenceObject $sourcePathsBefore -DifferenceObject $sourcePathsAfter -CaseSensitive)
  ) {
    throw 'Server file set changed during baseline capture; retry after deployment activity stops.'
  }

  $baseEntries = @(
    foreach ($relativePath in @('package.json', 'package-lock.json', 'start.ps1', 'start.cmd')) {
      $captured = @($allCapturedFiles | Where-Object { $_.path -eq $relativePath })[0]
      [ordered]@{
        path = $relativePath
        sha256 = [string]$captured.sha256
      }
    }
  )
  $fingerprintMaterial = ($baseEntries | ForEach-Object { "$($_.path):$($_.sha256)" }) -join "`n"
  $manifestFiles = @(
    $capturedFiles |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object {
        [ordered]@{
          path = [string]$_.path
          sha256 = [string]$_.sha256
          size = [int64]$_.size
        }
      }
  )
  $nonExportedRuntimeFiles = @(
    $nonExportedCapturedFiles |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object {
        [ordered]@{
          path = [string]$_.path
          sha256 = [string]$_.sha256
          size = [int64]$_.size
          reason = [string]$_.reason
        }
      }
  )
  $allBaselineManifestFiles = @(
    (@($manifestFiles) + @($nonExportedRuntimeFiles)) |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) }
  )
  $distFingerprints = [ordered]@{}
  foreach ($runtimeRoot in $runtimeRoots) {
    $runtimePrefix = $runtimeRoot.Replace('\', '/') + '/'
    $runtimeFingerprintMaterial = @(
      $allBaselineManifestFiles |
        Where-Object { $_.path.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase) } |
        Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
        ForEach-Object { "$($_.path):$($_.size):$($_.sha256)" }
    ) -join "`n"
    $distFingerprints[$runtimeRoot.Replace('\', '/')] = Get-TextSha256 -Text $runtimeFingerprintMaterial
  }
  $allFilesFingerprintMaterial = @(
    $allBaselineManifestFiles |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object { "$($_.path):$($_.size):$($_.sha256)" }
  ) -join "`n"
  $exportPlanFingerprintMaterial = @(
    @(
      $manifestFiles |
        ForEach-Object {
          [pscustomobject]@{
            path = [string]$_.path
            material = "payload`0$($_.path)`0$($_.size)`0$($_.sha256)"
          }
        }
    ) + @(
      $nonExportedRuntimeFiles |
        ForEach-Object {
          [pscustomobject]@{
            path = [string]$_.path
            material = "metadata`0$($_.reason)`0$($_.path)`0$($_.size)`0$($_.sha256)"
          }
        }
    ) |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object { [string]$_.material }
  ) -join "`n"
  $optionalFilePresence = [ordered]@{}
  foreach ($relativePath in $optionalFiles) {
    $normalizedRelativePath = $relativePath.Replace('\', '/')
    $optionalFilePresence[$normalizedRelativePath] = $sourceFilesByRelativePath.Contains($normalizedRelativePath)
  }
  $nodeVersion = try { (& ([string]$clientAssetGraphNodeRuntime.Path) --version 2>$null | Select-Object -First 1) } catch { 'unavailable' }
  $npmVersion = try { (& npm.cmd --version 2>$null | Select-Object -First 1) } catch { 'unavailable' }
  $manifest = [ordered]@{
    schemaVersion = 3
    exportId = $exportId
    exportType = 'server-hotfix-baseline-read-only'
    createdAt = (Get-Date).ToString('o')
    baseFingerprint = Get-TextSha256 -Text $fingerprintMaterial
    baselineFingerprint = Get-TextSha256 -Text $allFilesFingerprintMaterial
    exportPlanAlgorithm = 'webpack-main-runtime-map-v1'
    exportPlanFingerprint = Get-TextSha256 -Text $exportPlanFingerprintMaterial
    baseFiles = $baseEntries
    distFingerprints = $distFingerprints
    optionalFilePresence = $optionalFilePresence
    runtime = [ordered]@{
      node = [string]$nodeVersion
      npm = [string]$npmVersion
      powershell = $PSVersionTable.PSVersion.ToString()
      os = [System.Environment]::OSVersion.VersionString
      architecture = [System.Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
    }
    uncompressedBytes = $totalBytes
    fileCount = $manifestFiles.Count
    baselineFileCount = $allBaselineManifestFiles.Count
    nonExportedRuntimeFileCount = $nonExportedRuntimeFiles.Count
    files = $manifestFiles
    nonExportedRuntimeFiles = $nonExportedRuntimeFiles
    excluded = @('.env*', '.runtime', 'logs', 'node_modules', 'certs', 'uploads', 'attachments', 'source map contents (metadata only)', 'unreferenced historical client chunk contents (metadata only)', 'archives')
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stageRoot 'server-baseline-manifest.json') -Encoding utf8

  $archiveWriter = [System.IO.Compression.ZipFile]::Open(
    $partialZipPath,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    foreach ($file in @(Get-ChildItem -LiteralPath $stageRoot -File -Force -Recurse | Sort-Object FullName)) {
      $entryName = Get-RelativeUnixPath -Root $stageRoot -FullPath $file.FullName
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archiveWriter,
        $file.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
    }
  } finally {
    $archiveWriter.Dispose()
  }
  $archive = [System.IO.Compression.ZipFile]::OpenRead($partialZipPath)
  try {
    $seenEntries = @{}
    foreach ($zipEntry in @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })) {
      $entryPath = $zipEntry.FullName.Replace('\', '/')
      Assert-SafeRelativePath -RelativePath $entryPath
      $key = $entryPath.ToLowerInvariant()
      if ($seenEntries.ContainsKey($key)) {
        throw "Duplicate ZIP entry detected: $entryPath"
      }
      $seenEntries[$key] = $true
    }
    if ($seenEntries.Count -ne ($manifestFiles.Count + 1)) {
      throw "ZIP entry count mismatch: expected $($manifestFiles.Count + 1), got $($seenEntries.Count)."
    }
  } finally {
    $archive.Dispose()
  }

  Move-Item -LiteralPath $partialZipPath -Destination $zipPath

  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content -LiteralPath $shaPath -Value "$archiveHash  $([System.IO.Path]::GetFileName($zipPath))" -Encoding ascii
  $completed = $true
  Write-Host "[OK] Baseline ZIP: $zipPath"
  Write-Host "[OK] SHA256: $archiveHash"
  Write-Host "[OK] Uncompressed whitelist size: $([math]::Round($totalBytes / 1MB, 2)) MiB"
  if ($PruneHistoricalClientChunks) {
    Write-Host '[OK] No service process was stopped; only the verified client chunks directory was replaced.'
  } else {
    Write-Host '[OK] No service process was stopped or modified.'
  }
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
  if (-not $completed) {
    foreach ($path in @($zipPath, $partialZipPath, $shaPath)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
      }
    }
  }
}
