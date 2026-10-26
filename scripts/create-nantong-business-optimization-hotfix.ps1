param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "nantong-business-optimization-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$serverRelativePath = 'dist/server'
$sharedRelativePath = 'dist/shared'
$manifestRelativePath = 'hotfix-manifest.json'
$readmeRelativePath = 'README_NANTONG_BUSINESS_OPTIMIZATION_HOTFIX.md'

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentPrefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') +
    [IO.Path]::DirectorySeparatorChar
  $childFullPath = [IO.Path]::GetFullPath($Child)
  if (!$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Copy-RequiredDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required compiled directory is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Copy-RuntimeFiles {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$AllowedExtensions
  )

  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required compiled directory is missing: $Source"
  }
  foreach ($file in Get-ChildItem -LiteralPath $Source -File -Recurse) {
    if ($file.Extension -notin $AllowedExtensions) {
      continue
    }
    $relativePath = $file.FullName.Substring($Source.Length).TrimStart('\', '/')
    $target = Join-Path $Destination $relativePath
    $targetParent = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}

function Get-StageRelativePaths {
  param([string]$Stage)

  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($Stage.Length).
          TrimStart('\', '/').
          Replace('\', '/')
      } |
      Sort-Object
  )
}

function Assert-CompiledFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file is missing: $RelativePath"
  }
  $content = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledFileExcludes {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $content = Get-Content `
    -LiteralPath (Join-Path $repoRoot $RelativePath) `
    -Raw `
    -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content.Contains($marker)) {
      throw "Compiled runtime still contains retired marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  $searchableFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Recurse |
      Where-Object { $_.Extension -in @('.js', '.html', '.css') }
  )
  foreach ($marker in $Markers) {
    $matches = @($searchableFiles | Select-String -SimpleMatch -Pattern $marker -List)
    if ($matches.Count -eq 0) {
      throw "Compiled client is missing required marker '$marker'."
    }
  }
}

function Assert-CompiledClientExcludes {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  $searchableFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Recurse |
      Where-Object { $_.Extension -in @('.js', '.html', '.css') }
  )
  foreach ($marker in $Markers) {
    $matches = @($searchableFiles | Select-String -SimpleMatch -Pattern $marker -List)
    if ($matches.Count -gt 0) {
      throw "Compiled client still contains retired marker '$marker'."
    }
  }
}

function ConvertFrom-Utf8Base64 {
  param([string]$Value)

  return [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($Value)
  )
}

function Assert-TodayOperationsPanelsAtBottom {
  param([string]$RelativePath)

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Today operations panorama source is missing: $RelativePath"
  }
  $content = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
  $alarmOverviewIndex = $content.LastIndexOf(
    '<AlarmOverview',
    [StringComparison]::Ordinal
  )
  $operationsPanelsIndex = $content.LastIndexOf(
    '<OperationsPanels',
    [StringComparison]::Ordinal
  )
  if (
    $alarmOverviewIndex -lt 0 -or
    $operationsPanelsIndex -le $alarmOverviewIndex
  ) {
    throw 'Operations panels must appear after the alarm overview.'
  }
  $operationsTail = $content.Substring($operationsPanelsIndex)
  if (
    $operationsTail -notmatch
      '(?s)<OperationsPanels[\s\S]*?/>\s*</div>\s*</div>\s*</main>'
  ) {
    throw 'Operations panels must be the final business section.'
  }
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

$clientRoot = Join-Path $repoRoot $clientRelativePath
$serverRoot = Join-Path $repoRoot $serverRelativePath
$sharedRoot = Join-Path $repoRoot $sharedRelativePath
foreach ($requiredPath in @(
    (Join-Path $clientRoot 'index.html'),
    (Join-Path $clientRoot 'main.js'),
    (Join-Path $serverRoot 'main.js')
  )) {
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required compiled entry is missing: $requiredPath"
  }
}
if (@(Get-ChildItem -LiteralPath $clientRoot -File -Recurse).Count -lt 10) {
  throw 'Compiled client tree is unexpectedly incomplete.'
}
if (@(Get-ChildItem -LiteralPath $serverRoot -File -Filter '*.js' -Recurse).Count -lt 50) {
  throw 'Compiled server runtime is unexpectedly incomplete.'
}
if (@(Get-ChildItem -LiteralPath $sharedRoot -File -Filter '*.js' -Recurse).Count -lt 5) {
  throw 'Compiled shared runtime is unexpectedly incomplete.'
}

Assert-TodayOperationsPanelsAtBottom `
  -RelativePath 'client/src/pages/TodayOperationsPanorama/index.tsx'

$localSyncCompleteServerMarker = ConvertFrom-Utf8Base64 '5o6S54+t5pys5Zyw5ZCM5q2l5a6M5oiQ'
$retiredCampusElectricityAnnotationMarker = ConvertFrom-Utf8Base64 '5Zut5Yy655So55S16YeP5Li6'
$retiredCampusWaterAnnotationMarker = ConvertFrom-Utf8Base64 '5Zut5Yy66ICX5rC06YeP5Li6'
$retiredPueScopeAnnotationMarker = ConvertFrom-Utf8Base64 'RC9FIOS4jeWPguS4juWbreWMuuW5s+Wdhw=='
$retiredOnDutyScopeAnnotationMarker = ConvertFrom-Utf8Base64 '55m954+t5LiO5aSc54+t5Zyo5bKX5Y+j5b6E'
$effectiveExecutionContractMarker = ConvertFrom-Utf8Base64 '5pyJ5pWI5omn6KGM5ZCI5ZCM'
$noPaymentRequiredMarker = ConvertFrom-Utf8Base64 '5peg6ZyA5LuY5qy+'
$restoredContractCardMarker = ConvertFrom-Utf8Base64 '5bey5oGi5aSN6K+l5ZCI5ZCM5Y2h54mH'
$paymentFollowUpDispositionMarker = ConvertFrom-Utf8Base64 '5LuY5qy+6Lef6L+b5aSE572u'
$existingPaymentPlanMarker = ConvertFrom-Utf8Base64 '6K+l5ZCI5ZCM5bey5a2Y5Zyo5LuY5qy+6K6h5YiS'
Assert-CompiledClientContains -Markers @(
  '/api/duty-schedules/sync-local-fast',
  '/api/bitable/today-leave-staff',
  '/api/duty-schedules/long-white-duty-staff',
  '/api/access/login',
  'suda-csrf-token',
  'same-origin',
  'screenshotShift',
  'screenshotToken',
  'data-screenshot-ready',
  'weatherWidget',
  'personnelMovements',
  '/api/bitable/weather/hourly',
  '/api/typhoon-path-screenshot/preview',
  'FORCE_SEND_TYPHOON_PATH',
  'training-dashboard-title-group',
  'grid-template-columns:394px 778px 700px',
  'training-detail-dialog',
  'training-detail-pagination',
  'grid-template-rows:56px 558px',
  'Asia/Shanghai',
  'expected:"yesterdayExpected",unexpected:"yesterdayUnexpected",unclassified:"yesterdayUnclassified"',
  '<9?"night":"white"',
  '#064fc5',
  $effectiveExecutionContractMarker,
  $noPaymentRequiredMarker,
  '/payment-follow-up-disposition',
  $restoredContractCardMarker
)
Assert-CompiledClientExcludes -Markers @(
  'minPointSize:2',
  $retiredCampusElectricityAnnotationMarker,
  $retiredCampusWaterAnnotationMarker,
  $retiredPueScopeAnnotationMarker,
  $retiredOnDutyScopeAnnotationMarker
)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/training-dashboard.details.js' `
  -Markers @(
    'assessmentPassScore',
    'reconciliationNotes',
    'actualParticipantKeys'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/duty-schedule.service.js' `
  -Markers @('syncDutyScheduleToLocalFast', $localSyncCompleteServerMarker)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/duty-schedule.automation.js' `
  -Markers @(
    'onApplicationBootstrap',
    'startupProgramModifiedRefreshScheduled',
    'programModifiedDutyStaffRefreshInFlight',
    'buildTyphoonPathWarningDeliveryKey'
  )
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/duty-schedule/duty-schedule.automation.js' `
  -Markers @('CreateDutyDailyReport', 'white-record', 'night-record')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/duty-screenshot.service.js' `
  -Markers @(
    'DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
    'sharedScreenshotUrl',
    'hasCompletedDutyOverviewDelivery',
    'hasStartedDutyOverviewDelivery',
    'isAutomaticGroupDeliveryAllowed',
    'daily-report-attachment-already-exists',
    'hasCompletedAutomaticArchive',
    'buildSiblingScreenshotPath',
    'createCampusOperationsScreenshotAccessToken',
    'screenshotShift',
    'captureVerifiedScreenshotTarget',
    'waitForStableScreenshotTarget'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/duty-schedule.controller.js' `
  -Markers @(
    'typhoon-path-screenshot/preview',
    'FORCE_SEND_TYPHOON_PATH',
    'forceSendTyphoonPathScreenshot',
    'expectedWarningKey'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/typhoon-warning-state-store.js' `
  -Markers @(
    'typhoon-warning-send-state.json',
    'acquireTyphoonWarningMonitorLease',
    'writeTyphoonWarningSendStateFile'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/typhoon-warning-monitor.service.js' `
  -Markers @(
    'onModuleInit',
    'runLocalTyphoonWarningMonitor',
    'monitorTyphoonWarningAndSendPathScreenshot'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/duty-daily-report-bitable.service.js' `
  -Markers @('DUTY_DAILY_REPORT_RECORD_MISSING', 'replaceExisting')
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/duty-schedule/duty-daily-report-bitable.service.js' `
  -Markers @('ensureDailyReportRecord', 'createDailyReportRecord')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/duty-daily-report-local-scheduler.service.js' `
  -Markers @(
    'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_LOOKBACK_DAYS',
    'DEFAULT_RECONCILE_LOOKBACK_DAYS',
    'DEFAULT_RECONCILE_INTERVAL_MS'
  )
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/duty-schedule/duty-daily-report-local-scheduler.service.js' `
  -Markers @('white-record', 'night-record')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/common/access/unified-access.guard.js' `
  -Markers @('verifyCampusOperationsScreenshotAccessToken', 'screenshotShift')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/monthly-schedule-screenshot-access.js' `
  -Markers @(
    'verifyMonthlyScheduleScreenshotAccessToken',
    'verifyCampusOperationsScreenshotAccessToken',
    'DEVELOPMENT_EPHEMERAL_SCREENSHOT_ACCESS_SECRET',
    'SCREENSHOT_ACCESS_TOKEN_TTL_MS',
    'isScreenshotAccessExpiryValid'
  )
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/duty-schedule/monthly-schedule-screenshot-access.js' `
  -Markers @('local-development-monthly-schedule-screenshot')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/bitable-sync.service.js' `
  -Markers @(
    'getTodayLeaveStaffFromFeishu',
    'forceRefresh',
    'screenshotDate',
    'screenshotShift',
    'getMissingCampusOperationsKeys',
    'resolvePreviousCampusOperationsShift'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/shared/campus-operations-shift.js' `
  -Markers @('resolvePreviousCampusOperationsShift')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.service.js' `
  -Markers @('PurchaseInventoryService')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.store.js' `
  -Markers @('lockPromise = null', '.recovery')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/today-operations-overview.service.js' `
  -Markers @('TodayOperationsOverviewService')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/today-operations-alarm.service.js' `
  -Markers @(
    "case 'unclassified':",
    "case 'yesterdayExpected':",
    "case 'yesterdayUnexpected':",
    "case 'yesterdayUnclassified':"
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/contract-management/contract-management.service.js' `
  -Markers @('ContractManagementService', 'dashboardCacheGeneration')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/contract-management/contract-payment-follow-up.service.js' `
  -Markers @(
    'no_payment_required',
    $paymentFollowUpDispositionMarker,
    $noPaymentRequiredMarker,
    $existingPaymentPlanMarker
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/contract-management/contract-management.controller.js' `
  -Markers @('payment-follow-up-disposition')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/contract-management/contract-management.mapper.js' `
  -Markers @($paymentFollowUpDispositionMarker, $noPaymentRequiredMarker)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/duty-schedule/construction-management.js' `
  -Markers @('normalizeConstruction')
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/duty-schedule/duty-staff-actual-field.js' `
  -Markers @('fld2xDxrRH')
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/duty-schedule/duty-schedule.service.js' `
  -Markers @('fld2xDxrRH')

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  Copy-RequiredDirectory `
    -Source $clientRoot `
    -Destination (Join-Path $stageDir $clientRelativePath)
  Copy-RuntimeFiles `
    -Source $serverRoot `
    -Destination (Join-Path $stageDir $serverRelativePath) `
    -AllowedExtensions @('.js', '.json')
  Copy-RuntimeFiles `
    -Source $sharedRoot `
    -Destination (Join-Path $stageDir $sharedRelativePath) `
    -AllowedExtensions @('.js')

  $readmeLines = @(
    '# Nantong business optimization minimal overlay',
    '',
    '## Scope',
    '',
    '- Duty schedule local-first reads, startup and four-hour rule refresh, fast local sync, fresh today cards, optimistic UI rollback, signed local duty/campus screenshots, previous-shift campus data selection, independent screenshot delivery, and two-day archive catch-up without historical group-message replay.',
    '- Daily report screenshots only append to an existing date-and-shift record. The service never creates report records; missing records stay unfinished and retry hourly.',
    '- Typhoon path group delivery requires an active warning by default. An administrator may explicitly confirm a no-warning send; the server rechecks warning state before delivery and uses a shared idempotency ledger to prevent duplicate messages across processes and restarts.',
    '- Campus training dashboard is optimized for a 1920x650 embedded viewport with a 394/778/700 three-column desktop layout, complete six-building rows, source-backed drill-down lists, and responsive fallback.',
    '- Construction page and server workflow improvements.',
    '- Purchase application, approval, execution, inventory, and stale workflow-lock recovery improvements.',
    '- Today operations panorama, KPI, and alarm improvements. Operations panels are the final business section after the alarm overview.',
    '- Contract dashboard, risk, payment follow-up, and lifecycle improvements. Framework contract cards count effective execution contracts only. The explanatory banner is removed.',
    '- Payment follow-up supports an instant no-payment-required action for contracts without payment plans, with backend persistence, stale-response protection, and precise rollback on synchronization failure.',
    '- Unified access login CSRF recovery, Feishu Base reads, and shared runtime dependency closure.',
    '',
    '## Deployment',
    '',
    '1. Verify the ZIP with the matching .sha256.txt file.',
    '2. Stop the service and back up dist/client, dist/server, dist/shared, and the external duty scheduler state directory.',
    '3. Remove or move the old three dist directories so stale chunks and retired runtime files cannot remain.',
    '4. Extract this ZIP into the application root, preserving the three dist paths.',
    '5. Preserve existing .env, .env.local, data, logs, certs, node_modules, runtime caches, and the sibling nantong-schedule-state directory. It contains duty-daily-report-task-state.json, duty-screenshot-delivery-state.json, and typhoon-warning-send-state.json. If DUTY_DAILY_REPORT_STATE_DIR is configured, preserve that exact directory instead.',
    '6. Start the service with the existing service manager and verify port 3001.',
    '7. Press Ctrl+F5, verify the five business areas, then run one controlled local schedule sync as an administrator.',
    '8. Keep the service running for at least one minute so the startup reconciler can catch up unfinished duty and campus screenshots for today and the previous two days. Historical or ended shifts are archive-only and never replay group messages; an existing same-name duty attachment also suppresses a duplicate group message. A missing target report record remains unfinished and retries after one hour.',
    '',
    'No npm dependency installation, manual Feishu Base schema edit, or server environment edit is required. The payment follow-up disposition text field is created automatically when first needed.',
    '',
    '## Rollback',
    '',
    'Stop the service, remove the three overlaid dist directories, restore the backups, and restart.',
    '',
    '## Exclusions',
    '',
    'No environment files, credentials, certificates, business data, logs, caches, scheduler state ledgers, node_modules, source files, tests, declarations, source maps, dependency manifests, or service scripts are included.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $payloadPaths = @(Get-StageRelativePaths -Stage $stageDir)
  $forbiddenFiles = @(
    $payloadPaths | Where-Object {
      $leafName = [IO.Path]::GetFileName($_)
      $extension = [IO.Path]::GetExtension($_)
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|sourcemaps|test|tests)(/|$)' -or
      $leafName -in @('package.json', 'package-lock.json') -or
      $leafName.EndsWith('.d.ts') -or
      $extension -in @('.map', '.ts', '.tsx', '.spec', '.log', '.pem', '.key', '.pfx', '.p12')
    }
  )
  if ($forbiddenFiles.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0])"
  }
  $reparsePoints = @(
    Get-ChildItem -LiteralPath $stageDir -Force -Recurse |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "Refusing to package a reparse point: $($reparsePoints[0].FullName)"
  }

  $manifestFiles = @(
    $payloadPaths | ForEach-Object {
      $fullPath = Join-Path $stageDir $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      [ordered]@{
        path = $_
        size = (Get-Item -LiteralPath $fullPath).Length
        sha256 = (
          Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
        ).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    packageType = 'minimal-compiled-runtime-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    replaceDirectories = @(
      $clientRelativePath,
      $serverRelativePath,
      $sharedRelativePath
    )
    scope = @(
      'duty-schedule',
      'duty-and-campus-screenshot-catch-up',
      'typhoon-warning-group-delivery',
      'campus-training-dashboard-layout',
      'construction-management',
      'purchase-inventory',
      'today-operations-panorama',
      'today-operations-panel-placement',
      'contract-management',
      'contract-effective-execution-count',
      'contract-no-payment-disposition',
      'unified-access-and-bitable-runtime'
    )
    secretsIncluded = $false
    dependencyInstallRequired = $false
    files = $manifestFiles
  } | ConvertTo-Json -Depth 7 |
    Set-Content `
      -LiteralPath (Join-Path $stageDir $manifestRelativePath) `
      -Encoding UTF8

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $expectedFiles = @($payloadPaths + $manifestRelativePath | Sort-Object)
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archivePaths = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Sort-Object
    )
    if (
      $archivePaths.Count -ne $actualFiles.Count -or
      @($archivePaths | Where-Object { $_ -notin $actualFiles }).Count -gt 0 -or
      @($archivePaths | Where-Object {
        $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match the staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = (
    Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII
} catch {
  foreach ($target in @($stageDir, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item `
        -LiteralPath $target `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Nantong business optimization hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
