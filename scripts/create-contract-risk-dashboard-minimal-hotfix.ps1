param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "contract-risk-dashboard-minimal-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$baselineName =
  'nantong-minimal-overlay-after-20260719-221003-20260720-074815-fixed.zip'
$baselinePath = Join-Path $repoRoot "release\$baselineName"
$supersededPackage =
  'contract-management-overview-client-hotfix-20260720-120335.zip'
$readmeName = 'README_CONTRACT_RISK_DASHBOARD_HOTFIX.md'
$manifestName = 'HOTFIX_MANIFEST.json'
$clientRelativePath = 'dist/client'
$serverRelativePaths = @(
  'dist/server/modules/risk-inspection/risk-inspection.controller.js',
  'dist/server/modules/risk-inspection/risk-inspection.mapper.js',
  'dist/server/modules/risk-inspection/risk-inspection.service.js'
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
    throw "Refusing to use a path outside the output directory: $Child"
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

function Assert-CompiledClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  if (!(Test-Path -LiteralPath $clientRoot -PathType Container)) {
    throw "Compiled client directory is missing: $clientRoot"
  }
  $searchableFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Recurse |
      Where-Object { $_.Extension -in @('.js', '.html') }
  )
  foreach ($marker in $Markers) {
    $matches = @(
      $searchableFiles |
        Select-String -SimpleMatch -Pattern $marker -List
    )
    if ($matches.Count -eq 0) {
      throw "Compiled client is missing required marker '$marker'."
    }
  }
}

function Assert-CompiledFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled server file is missing: $fullPath"
  }
  $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $fullPath
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled server file is missing marker '$marker': $RelativePath"
    }
  }
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

if (!(Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
  throw "Required baseline ZIP is missing: $baselinePath"
}
$baselineHash = (
  Get-FileHash -LiteralPath $baselinePath -Algorithm SHA256
).Hash.ToUpperInvariant()

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

Assert-CompiledClientContains -Markers @(
  '/contract-management',
  'payment-plan',
  '/api/risk-inspection/cross/guides',
  'closureRate'
)
Assert-CompiledFileContains `
  -RelativePath $serverRelativePaths[0] `
  -Markers @('api/risk-inspection', 'cross/guides')
Assert-CompiledFileContains `
  -RelativePath $serverRelativePaths[1] `
  -Markers @('closureRate', 'mapCrossInspectionGuides')
Assert-CompiledFileContains `
  -RelativePath $serverRelativePaths[2] `
  -Markers @(
    'getCrossGuides',
    'tbl59899bfa825ba',
    'tblb434ca9548528',
    'tbl83174d3ae2e32',
    'tbl645137e7274a5'
  )

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
  New-Item `
    -ItemType Directory `
    -Force `
    -Path (Join-Path $stageDir 'dist') |
    Out-Null
  Copy-Item `
    -LiteralPath (Join-Path $repoRoot $clientRelativePath) `
    -Destination (Join-Path $stageDir $clientRelativePath) `
    -Recurse `
    -Force
  foreach ($relativePath in $serverRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }

  $readmeLines = @(
    '# Contract and risk dashboard minimal hotfix',
    '',
    '## Compatible baseline',
    '',
    "- Baseline: $baselineName",
    "- Baseline SHA256: $baselineHash",
    "- Supersedes: $supersededPackage",
    '- Compatible with contract-payment-link-hotfix-20260720-091439.zip and duty-daily-report-local-scheduler-hotfix-20260720-111121.zip.',
    '',
    '## Scope',
    '',
    '- Preserves the previous contract overview, payment trend, and missing payment-plan client fixes.',
    '- Updates the risk inspection and cross-inspection dashboard client.',
    '- Corrects legacy unresolved and issue closure-rate metric definitions.',
    '- Adds month selection, concrete issue lists, and the standards-and-guidance dialog.',
    '- Replaces only the three changed risk runtime server files: controller, mapper, and service.',
    '- The client uses content-hashed chunks. Replace dist/client as one complete directory.',
    '',
    '## Deployment',
    '',
    '1. Verify the ZIP with the matching .sha256.txt file.',
    '2. Confirm the compatible baseline and back up dist/client plus the three server files listed in manifest.json.',
    '3. Stop the service, remove the old dist/client directory, then extract this ZIP into the application root.',
    '4. Preserve the existing .env, .env.local, data, logs, certs, and node_modules.',
    '5. Start the service, verify port 3001, and force-refresh the browser with Ctrl+F5.',
    '6. Verify contract management, risk inspection, cross inspection, and the standards-and-guidance dialog.',
    '',
    '## Rollback',
    '',
    'Stop the service, restore the backed-up dist/client and three risk runtime files, then restart.',
    '',
    '## Exclusions',
    '',
    'This package contains no environment files, credentials, Feishu secrets, certificates, business data, logs, node_modules, source files, tests, or source maps.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeName) `
    -Value $readmeLines `
    -Encoding UTF8

  $payloadPaths = @(Get-StageRelativePaths -Stage $stageDir)
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
    packageType = 'minimal-client-and-risk-server-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    baseline = [ordered]@{
      file = $baselineName
      sha256 = $baselineHash
    }
    supersedes = $supersededPackage
    compatibleServerOverlays = @(
      'contract-payment-link-hotfix-20260720-091439.zip',
      'duty-daily-report-local-scheduler-hotfix-20260720-111121.zip'
    )
    replaceDirectories = @($clientRelativePath)
    replaceFiles = $serverRelativePaths
    scope = @(
      'contract-management-overview',
      'contract-payment-trend',
      'missing-payment-plan-list',
      'risk-inspection-dashboard',
      'cross-inspection-dashboard',
      'cross-inspection-guide-dialog',
      'cross-inspection-closure-metrics'
    )
    secretsIncluded = $false
    files = $manifestFiles
  } | ConvertTo-Json -Depth 7 |
    Set-Content -LiteralPath (Join-Path $stageDir $manifestName) -Encoding UTF8

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $expectedFiles = @($payloadPaths + $manifestName | Sort-Object)
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|sourcemaps)(/|$)' -or
      $_ -match '\.(map|ts|tsx|d\.ts|spec|log|pem|key)$'
    }
  )
  if ($forbiddenFiles.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0])"
  }
  $reparsePoints = @(
    Get-ChildItem -LiteralPath $stageDir -Force -Recurse |
      Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
      }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "Refusing to package reparse point: $($reparsePoints[0].FullName)"
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
      throw 'ZIP entries do not exactly match staged hotfix files.'
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
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Contract and risk dashboard minimal hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
