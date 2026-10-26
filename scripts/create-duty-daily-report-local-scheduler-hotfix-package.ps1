param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "duty-daily-report-local-scheduler-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$readmeRelativePath = 'README_DUTY_DAILY_REPORT_LOCAL_SCHEDULER_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$basePackageName = 'nantong-schedule-20260719-221003.zip'
$basePackageSha256 = 'BDD7C469E20B40BCB2D3BA042BB7DC2C6898C54FDC9D0AE78C4DBE94EEB044FB'
$requiredOverlayName = 'nantong-minimal-overlay-after-20260719-221003-20260720-074815-fixed.zip'
$requiredOverlaySha256 = 'AB3F36BCF6779CB4493E2447FBAFAE90B767B8AF0A59E64E09BAED7B945ADE89'
$runtimeRelativePaths = @(
  'dist/server/modules/duty-schedule/duty-daily-report-local-scheduler.service.js',
  'dist/server/modules/duty-schedule/duty-daily-report-task-coordinator.service.js',
  'dist/server/modules/duty-schedule/duty-daily-report-state-path.js',
  'dist/server/modules/duty-schedule/duty-schedule.automation.js',
  'dist/server/modules/duty-schedule/duty-schedule.module.js',
  'dist/server/modules/duty-schedule/duty-screenshot.service.js',
  'dist/server/modules/duty-schedule/duty-daily-report-bitable.service.js'
)
$forbiddenRootNames = @('.env', '.env.local', 'node_modules', 'data', 'logs', 'certs', '.runtime', 'server', 'test')

function Copy-RequiredFile {
  param([string]$Source, [string]$Destination)

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required hotfix payload is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-StageRelativePaths {
  param([string]$Stage)

  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($Stage.Length).TrimStart('\', '/').Replace('\', '/')
      } |
      Sort-Object
  )
}

function Write-HotfixManifest {
  param([string]$Stage, [string[]]$RelativePaths)

  $files = @(
    $RelativePaths | Sort-Object | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace('/', [IO.Path]::DirectorySeparatorChar)
      [ordered]@{
        path = $_
        sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    package = 'duty-daily-report-local-scheduler-hotfix'
    basePackage = [ordered]@{
      name = $basePackageName
      sha256 = $basePackageSha256
    }
    requiredOverlay = [ordered]@{
      name = $requiredOverlayName
      sha256 = $requiredOverlaySha256
    }
    secretsIncluded = $false
    files = $files
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) -Encoding UTF8
}

function Assert-SafeStagePath {
  param([string]$Path)

  $root = [IO.Path]::GetFullPath($outputRoot).TrimEnd('\', '/')
  $candidate = [IO.Path]::GetFullPath($Path)
  $prefix = "$root$([IO.Path]::DirectorySeparatorChar)"
  if (!$candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a staging path outside the output directory: $candidate"
  }
}

function Assert-CompiledMarker {
  param([string]$RelativePath, [string[]]$Markers)

  $sourcePath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $sourcePath"
  }
  $compiledSource = Get-Content -Raw -LiteralPath $sourcePath -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$compiledSource.Contains($marker)) {
      throw "Compiled runtime does not contain required marker '$marker': $RelativePath"
    }
  }
}

function New-CanonicalZipArchive {
  param(
    [string]$Stage,
    [string]$Destination,
    [string[]]$RelativePaths
  )

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipStream = [IO.File]::Open(
    $Destination,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
  $archive = [System.IO.Compression.ZipArchive]::new(
    $zipStream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    foreach ($relativePath in ($RelativePaths | Sort-Object)) {
      if (
        $relativePath -match '(^|/)\.\.(/|$)' -or
        $relativePath -match '^[\\/]' -or
        $relativePath -match '^[A-Za-z]:'
      ) {
        throw "Refusing to create unsafe ZIP entry: $relativePath"
      }

      $sourcePath = Join-Path $Stage $relativePath.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      if (!(Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "ZIP source file is missing: $sourcePath"
      }

      $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
      $sourceStream = [IO.File]::OpenRead($sourcePath)
      $entryStream = $entry.Open()
      try {
        $sourceStream.CopyTo($entryStream)
      } finally {
        $entryStream.Dispose()
        $sourceStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
    $zipStream.Dispose()
  }
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Server production build failed; hotfix package was not created.'
  }
}

Assert-CompiledMarker -RelativePath $runtimeRelativePaths[0] -Markers @(
  'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS',
  'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS',
  'Asia/Shanghai'
)
Assert-CompiledMarker -RelativePath $runtimeRelativePaths[1] -Markers @(
  'DUTY_DAILY_REPORT_TASK_STATE_PATH',
  'DUTY_DAILY_REPORT_STATE_DIR',
  'white-screenshot',
  'night-screenshot'
)
Assert-CompiledMarker -RelativePath $runtimeRelativePaths[2] -Markers @(
  'nantong-schedule-state',
  'production'
)
Assert-CompiledMarker -RelativePath $runtimeRelativePaths[3] -Markers @(
  'dutyDailyReportTaskCoordinatorService',
  'autoSendDutyOverviewScreenshotAt0850',
  'autoSendDutyOverviewScreenshotAt1750'
)
Assert-CompiledMarker -RelativePath $runtimeRelativePaths[4] -Markers @(
  'DutyDailyReportTaskCoordinatorService',
  'DutyDailyReportLocalSchedulerService'
)
Assert-CompiledMarker -RelativePath $runtimeRelativePaths[5] -Markers @(
  'nantong-duty-overview-',
  'nantong-campus-operations-',
  'DUTY_SCREENSHOT_DELIVERY_STATE_PATH',
  'duty-screenshot-delivery-state.json',
  'duty-${digest.slice(0, 40)}'
)
Assert-CompiledMarker -RelativePath $runtimeRelativePaths[6] -Markers @(
  'attachment.name === fileName',
  'appended'
)

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-SafeStagePath -Path $stageDir
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  foreach ($runtimeRelativePath in $runtimeRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $runtimeRelativePath) `
      -Destination (Join-Path $stageDir $runtimeRelativePath)
  }

  $readmeLines = @(
    '# Duty daily report local scheduler minimal hotfix',
    '',
    '## Scope',
    '',
    'This package adds a standalone local scheduler for the 06:00 white-shift record, 08:50 white-shift screenshots, 16:00 night-shift record, and 17:50 night-shift screenshots in Asia/Shanghai.',
    'When the application restarts after a scheduled time, due tasks for the current Shanghai date are reconciled after 30 seconds and retried every 5 minutes until successful.',
    'Completed tasks and per-recipient card/image deliveries are persisted. In production the default directory is the shared sibling nantong-schedule-state directory, so switching to a new timestamped release directory does not lose the ledgers.',
    'Automatic screenshot attachment names are deterministic, and an existing same-name Bitable attachment is reused instead of uploaded again. Each automatic Feishu card and image also uses a deterministic uuid and a persistent delivery checkpoint, so a retry resumes only failed recipients or message types.',
    'Platform BindTrigger actions remain registered and use the same coordinator. The local scheduler starts only when FORCE_FRAMEWORK_DISABLE_DATAPASS=true, which start.ps1 sets automatically when SUDA_DATABASE_URL is empty.',
    '',
    '## Required base',
    '',
    "Base package: $basePackageName",
    "Base package SHA256: $basePackageSha256",
    "Required fixed overlay: $requiredOverlayName",
    "Required fixed overlay SHA256: $requiredOverlaySha256",
    'Apply this hotfix only after the fixed overlay. That overlay contains the shared runtime dependency required by the current deployment.',
    '',
    '## Deployment',
    '',
    '1. Verify the ZIP SHA256 against its .sha256.txt sidecar.',
    '2. Back up every matching file listed in hotfix-manifest.json.',
    '3. Extract this ZIP into the existing application deployment root and overwrite the matching dist files. Do not extract into a new nested folder.',
    '4. Restart the existing Node service using the server deployment procedure, for example stop.cmd then start.cmd.',
    '5. Confirm the log contains the local scheduler startup message. If today has missed tasks, wait at least 30 seconds and confirm the corresponding row and attachments in Bitable.',
    '6. Preserve the shared nantong-schedule-state directory across later releases, restarts, and overlays. It contains duty-daily-report-task-state.json and duty-screenshot-delivery-state.json.',
    '',
    '## Optional controls',
    '',
    '- DUTY_DAILY_REPORT_LOCAL_SCHEDULER_ENABLED=false disables only this local scheduler.',
    '- DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS changes the startup catch-up delay; minimum 1000 ms.',
    '- DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS changes the retry interval; minimum 1000 ms.',
    '- DUTY_DAILY_REPORT_STATE_DIR overrides the shared directory used by both durable ledgers.',
    '- DUTY_DAILY_REPORT_TASK_STATE_PATH changes the durable completion-state file path.',
    '- DUTY_SCREENSHOT_DELIVERY_STATE_PATH changes the per-recipient message-delivery state file path.',
    '',
    '## Rollback',
    '',
    '1. Stop the Node service.',
    '2. Restore the seven backed-up dist/server/modules/duty-schedule JavaScript files listed in hotfix-manifest.json.',
    '3. Preserve the shared nantong-schedule-state directory; do not delete either ledger during rollback.',
    '4. Start the Node service and confirm the previous behavior.',
    '',
    '## Exclusions',
    '',
    'No .env, secrets, certificates, data, logs, node_modules, source files, or tests are included.'
  )
  Set-Content -LiteralPath (Join-Path $stageDir $readmeRelativePath) -Value $readmeLines -Encoding UTF8

  Write-HotfixManifest -Stage $stageDir -RelativePaths @(
    $runtimeRelativePaths
    $readmeRelativePath
  )

  $expectedFiles = @(
    $runtimeRelativePaths
    $readmeRelativePath
    $manifestRelativePath
  ) | Sort-Object
  $actualFiles = Get-StageRelativePaths -Stage $stageDir
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected file.'
  }

  $forbiddenTopLevelPaths = Get-ChildItem -LiteralPath $stageDir -Force | Where-Object {
    $_.Name -in $forbiddenRootNames
  }
  if ($forbiddenTopLevelPaths) {
    throw "Refusing to package forbidden path: $($forbiddenTopLevelPaths[0].FullName)"
  }

  New-CanonicalZipArchive `
    -Stage $stageDir `
    -Destination $zipPath `
    -RelativePaths $actualFiles
  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content -LiteralPath $sidecarPath -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" -Encoding ASCII
} catch {
  Assert-SafeStagePath -Path $stageDir
  Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  throw
}

Write-Host '[OK] Duty daily report local scheduler minimal hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
