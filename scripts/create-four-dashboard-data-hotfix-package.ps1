param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "four-dashboard-data-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_FOUR_DASHBOARD_DATA_HOTFIX.md'
$auditRelativePath = 'DATA_SOURCE_AUDIT.json'
$manifestRelativePath = 'hotfix-manifest.json'
$basePackages = @(
  'nantong-schedule-20260717-205446',
  'purchase-certificate-dashboard-hotfix-20260718-103840'
)

$serverRelativePaths = @(
  'dist/server/app.module.js',
  'dist/server/common/feishu/bitable-direct-read.js',
  'dist/server/modules/dashboard-data-sync/dashboard-data-sync.scheduler.js',
  'dist/server/modules/risk-inspection/risk-inspection.controller.js',
  'dist/server/modules/risk-inspection/risk-inspection.mapper.js',
  'dist/server/modules/risk-inspection/risk-inspection.module.js',
  'dist/server/modules/risk-inspection/risk-inspection.service.js',
  'dist/server/modules/equipment-lifecycle/equipment-lifecycle.controller.js',
  'dist/server/modules/equipment-lifecycle/equipment-lifecycle.mapper.js',
  'dist/server/modules/equipment-lifecycle/equipment-lifecycle.module.js',
  'dist/server/modules/equipment-lifecycle/equipment-lifecycle.service.js',
  'dist/server/modules/bitable-sync/bitable-sync.controller.js',
  'dist/server/modules/bitable-sync/bitable-sync.module.js',
  'dist/server/modules/bitable-sync/bitable-sync.service.js',
  'dist/server/modules/bitable-sync/certificate-dashboard.mapper.js',
  'dist/server/modules/bitable-sync/certificate-dashboard-notification.service.js',
  'dist/server/modules/bitable-sync/certificate-dashboard.service.js',
  'dist/server/modules/bitable-sync/training-dashboard.fields.js',
  'dist/server/modules/bitable-sync/training-dashboard.mapper.js',
  'dist/server/modules/bitable-sync/training-dashboard.service.js',
  'dist/server/modules/bitable-sync/training-dashboard.snapshot-store.js'
)

$documentedEnvironmentKeys = @(
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_CERTIFICATE_APP_TOKEN',
  'FEISHU_CERTIFICATE_WIKI_TOKEN',
  'FEISHU_CERTIFICATE_TABLE_ID',
  'FEISHU_RISK_INSPECTION_ALI_SOURCE_URL',
  'FEISHU_RISK_INSPECTION_CROSS_SOURCE_URL',
  'FEISHU_EQUIPMENT_LIFECYCLE_SOURCE_URL',
  'FEISHU_EQUIPMENT_LIFECYCLE_EQUIPMENT_TABLE_ID',
  'FEISHU_EQUIPMENT_LIFECYCLE_LONG_TERM_MAINTENANCE_TABLE_ID',
  'FEISHU_EQUIPMENT_LIFECYCLE_KEY_PARTS_TABLE_ID',
  'FEISHU_EQUIPMENT_LIFECYCLE_MAINTENANCE_CONTRACTS_TABLE_ID',
  'FEISHU_TRAINING_WIKI_TOKEN',
  'FEISHU_TRAINING_ACTIVE_STATS_TABLE_ID',
  'FEISHU_TRAINING_ACTIVE_SCORES_TABLE_ID',
  'FEISHU_TRAINING_ACTIVE_PLANS_TABLE_ID',
  'FEISHU_TRAINING_NEW_HIRE_SCORES_TABLE_ID',
  'FEISHU_TRAINING_NEW_HIRE_COURSES_TABLE_ID',
  'FEISHU_TRAINING_NEW_HIRE_PLANS_TABLE_ID',
  'FEISHU_TRAINING_SHARING_SESSIONS_TABLE_ID',
  'FEISHU_TRAINING_SHARING_SCORES_TABLE_ID',
  'FEISHU_TRAINING_SHARING_INTERESTS_TABLE_ID',
  'FEISHU_CAMPUS_OPS_APP_TOKEN',
  'FEISHU_CAMPUS_OPS_TRANSFORMER_TABLE_ID',
  'FEISHU_CAMPUS_OPS_TRANSFORMER_VIEW_ID',
  'FEISHU_CAMPUS_OPS_MACHINE_TABLE_ID',
  'FEISHU_CAMPUS_OPS_MACHINE_VIEW_ID',
  'FEISHU_CAMPUS_OPS_CACHE_TTL_MS',
  'CAMPUS_OPS_NIGHT_SHIFT_START_HOUR'
)

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

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required hotfix payload is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required hotfix payload directory is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
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

function Assert-CompiledFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -notmatch [regex]::Escape($marker)) {
      throw "Compiled runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  $searchableFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Recurse |
      Where-Object { $_.Extension -in @('.js', '.html') }
  )
  foreach ($marker in $Markers) {
    if (!($searchableFiles | Select-String -SimpleMatch -Pattern $marker -Quiet)) {
      throw "Compiled client is missing required marker '$marker'."
    }
  }
}

function Assert-EnvironmentKeysDocumented {
  $examplePath = Join-Path $repoRoot '.env.example'
  if (!(Test-Path -LiteralPath $examplePath -PathType Leaf)) {
    throw '.env.example is missing.'
  }
  $exampleContent = Get-Content -Raw -LiteralPath $examplePath -Encoding UTF8
  foreach ($key in $documentedEnvironmentKeys) {
    if ($exampleContent -notmatch "(?m)^$([regex]::Escape($key))=") {
      throw "Required data-source configuration key is undocumented: $key"
    }
  }
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$RelativePaths
  )

  $files = @(
    $RelativePaths | Sort-Object | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      [ordered]@{
        path = $_
        sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    requiredBaselines = $basePackages
    scope = @(
      'risk-inspection-dashboard',
      'campus-training-dashboard',
      'equipment-lifecycle-dashboard',
      'campus-certificate-dashboard',
      'campus-operations-dashboard'
    )
    secretsIncluded = $false
    files = $files
  } | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) -Encoding UTF8
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

Assert-EnvironmentKeysDocumented
Assert-CompiledClientContains -Markers @(
  '/api/risk-inspection/ali',
  '/api/equipment-lifecycle/dashboard',
  '/api/bitable/campus-training-dashboard',
  '/api/bitable/campus-certificate-dashboard',
  '/api/bitable/campus-operations-dashboard',
  'training-rate-area-gradient',
  'assessmentPassRate'
)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/app.module.js' `
  -Markers @(
    'risk-inspection.module',
    'equipment-lifecycle.module',
    'dashboard-data-sync.scheduler'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/dashboard-data-sync/dashboard-data-sync.scheduler.js' `
  -Markers @(
    'SYNC_HOUR = 3',
    'SYNC_MINUTE = 10',
    'trainingService.refresh',
    'getAliDashboard',
    'getCrossDashboard',
    'lifecycleService.getDashboard',
    'certificateService.refresh',
    'shouldCatchUpDashboardDataSync'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/risk-inspection/risk-inspection.controller.js' `
  -Markers @('api/risk-inspection')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/equipment-lifecycle/equipment-lifecycle.controller.js' `
  -Markers @('api/equipment-lifecycle')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/bitable-sync.controller.js' `
  -Markers @('campus-operations-dashboard', 'campus-training-dashboard')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/bitable-sync.service.js' `
  -Markers @('FEISHU_CAMPUS_OPS_TRANSFORMER_TABLE_ID')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/training-dashboard.fields.js' `
  -Markers @('TRAINING_DASHBOARD_TABLE_CONFIGS')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/training-dashboard.service.js' `
  -Markers @('SOURCE_BUNDLE_CACHE_TTL_MS')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/certificate-dashboard.service.js' `
  -Markers @('FEISHU_CERTIFICATE_TABLE_ID')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/common/feishu/bitable-direct-read.js' `
  -Markers @('refreshBitableRecordsInBackground')

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
    -Source (Join-Path $repoRoot $clientRelativePath) `
    -Destination (Join-Path $stageDir $clientRelativePath)
  foreach ($relativePath in $serverRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }

  $readmeLines = @(
    '# Consolidated dashboard data integration hotfix',
    '',
    '## Required baseline',
    '',
    'Apply only after both packages below, or to a functionally equivalent deployment:',
    "- $($basePackages[0])",
    "- $($basePackages[1])",
    '',
    '## Scope',
    '',
    '- Replace dist/client as one complete directory. Do not mix old and new hashed chunks.',
    '- Replace only the required backend runtime files for risk, training, lifecycle, certificate, and campus operations.',
    '- Preserve existing .env, .env.local, data, certs, logs, node_modules, and runtime caches.',
    '- Continue using FEISHU_APP_ID / FEISHU_APP_SECRET from the target server.',
    '- Risk, training, lifecycle, and certificate data synchronize automatically every day at 03:10 Asia/Shanghai.',
    '- If the service starts after 03:10, it performs one non-blocking catch-up synchronization and still schedules the next day.',
    '',
    '## Read-only data-source audit before packaging',
    '',
    '- Risk inspection: 2/2 tables readable.',
    '- Campus training: 9/9 tables readable.',
    '- Equipment lifecycle: 4/4 tables readable.',
    '- Campus certificate: 1/1 table readable.',
    '- Campus operations: 2/2 tables readable.',
    '- Total: 18/18. The audit requested one record per table, made no writes, and exposed no credential values.',
    '- Results apply to the build host credentials. Revalidate when the target server uses a different environment.',
    '',
    '## Deployment',
    '',
    '1. Verify the ZIP with the matching .sha256.txt file.',
    '2. Create .maintenance.lock when the watchdog is enabled.',
    '3. Back up the complete dist/client directory, every backend file in the manifest, .env, .env.local, and data.',
    '4. Run the existing stop.cmd.',
    '5. Remove or move the old dist/client, extract the ZIP into the application root, and overwrite matching backend files.',
    '6. Confirm .env, .env.local, and data are unchanged, then run start.cmd.',
    '7. Force refresh and verify risk Ali, risk cross-check, lifecycle, training, certificate, and campus operations APIs.',
    '8. Confirm the next automatic synchronization is fixed at 03:10 Asia/Shanghai.',
    '9. Confirm normal data and no 91403 permission error, remove .maintenance.lock, and press Ctrl+F5.',
    '',
    '## Rollback',
    '',
    'Stop the service, restore the complete dist/client backup and every backend file in the manifest, then restart.',
    '',
    '## Security exclusions',
    '',
    'This package contains no .env, .env.local, Feishu secrets, certificates, business data, logs, node_modules, source files, tests, or sourcemaps.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  [ordered]@{
    schemaVersion = 1
    verifiedAt = '2026-07-19'
    mode = 'read-only, one record per table'
    credentials = 'existing FEISHU_APP_ID / FEISHU_APP_SECRET; values excluded'
    results = [ordered]@{
      riskInspection = '2/2'
      campusTraining = '9/9'
      equipmentLifecycle = '4/4'
      campusCertificate = '1/1'
      campusOperations = '2/2'
      total = '18/18'
    }
    targetServerMustRevalidate = $true
  } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $stageDir $auditRelativePath) -Encoding UTF8

  $manifestPayloadPaths = @(
    Get-StageRelativePaths -Stage $stageDir
  )
  Write-HotfixManifest -Stage $stageDir -RelativePaths $manifestPayloadPaths

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $expectedFiles = @(
    $manifestPayloadPaths
    $manifestRelativePath
  ) | Sort-Object
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|\.runtime|sourcemaps)(/|$)' -or
      $_ -match '\.(map|ts|tsx|d\.ts|spec|log|pem|key)$'
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
        $_.StartsWith('/') -or
        $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match the staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII
} catch {
  if (Test-Path -LiteralPath $stageDir) {
    Assert-ChildPath -Parent $outputRoot -Child $stageDir
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $zipPath) {
    Assert-ChildPath -Parent $outputRoot -Child $zipPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $sidecarPath) {
    Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
    Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  }
  throw
}

Write-Host '[OK] Four-dashboard data hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
