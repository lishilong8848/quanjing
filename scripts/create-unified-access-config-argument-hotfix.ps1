param(
  [Parameter(Mandatory = $true)]
  [string]$BaselineStage,
  [string]$OutputDir = 'release'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$baselineRoot = (Resolve-Path -LiteralPath $BaselineStage).Path
$baselineManifestPath = Join-Path $baselineRoot 'hotfix-manifest.json'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "unified-access-config-argument-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"

$payloads = [ordered]@{
  'scripts/configure-unified-access.ps1' = Join-Path $repoRoot 'scripts/configure-unified-access.ps1'
  'scripts/configure-inventory-access.ps1' = Join-Path $repoRoot 'scripts/configure-inventory-access.ps1'
  'scripts/configure-purchase-access.ps1' = Join-Path $repoRoot 'scripts/configure-purchase-access.ps1'
  'README_UNIFIED_ACCESS_ARGUMENT_HOTFIX.md' = Join-Path $repoRoot 'deploy/README_UNIFIED_ACCESS_ARGUMENT_HOTFIX.md'
}

function Test-ForbiddenRelativePath {
  param([string]$RelativePath)

  $segments = @($RelativePath.Replace('\', '/').Split('/') | Where-Object { $_ })
  foreach ($segment in $segments) {
    if ($segment.ToLowerInvariant() -in @(
      '.env',
      '.env.local',
      'data',
      'logs',
      'certs',
      '.runtime',
      'node_modules'
    )) {
      return $true
    }
  }
  return $false
}

function Resolve-VerifiedBaselinePath {
  param(
    [string]$Root,
    [string]$RelativePath
  )

  if (
    !$RelativePath.Trim() -or
    [IO.Path]::IsPathRooted($RelativePath) -or
    $RelativePath -match '(^|[\/])\.\.([\/]|$)'
  ) {
    throw "Invalid baseline manifest path: $RelativePath"
  }
  if (Test-ForbiddenRelativePath -RelativePath $RelativePath) {
    throw "Forbidden baseline manifest path: $RelativePath"
  }

  $normalized = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
  $candidate = [IO.Path]::GetFullPath((Join-Path $Root $normalized))
  $rootPrefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (!$candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Invalid baseline manifest path: $RelativePath"
  }
  return $candidate
}

if (!(Test-Path -LiteralPath $baselineManifestPath -PathType Leaf)) {
  throw "Baseline hotfix manifest was not found: $baselineManifestPath"
}

$baselineManifest = Get-Content -Raw -LiteralPath $baselineManifestPath -Encoding UTF8 | ConvertFrom-Json
if ($baselineManifest.schemaVersion -ne 1 -or !$baselineManifest.files) {
  throw 'Baseline hotfix manifest is invalid.'
}

$baselineEntries = @{}
foreach ($entry in @($baselineManifest.files)) {
  $relativePath = ([string]$entry.path).Replace('\', '/')
  if ($baselineEntries.ContainsKey($relativePath)) {
    throw "Duplicate baseline manifest path: $relativePath"
  }
  $expectedHash = ([string]$entry.sha256).Trim().ToUpperInvariant()
  if ($expectedHash -notmatch '^[A-F0-9]{64}$') {
    throw "Invalid baseline manifest hash: $relativePath"
  }
  $baselineFile = Resolve-VerifiedBaselinePath -Root $baselineRoot -RelativePath $relativePath
  if (!(Test-Path -LiteralPath $baselineFile -PathType Leaf)) {
    throw "Baseline manifest file is missing: $relativePath"
  }
  $actualHash = (Get-FileHash -LiteralPath $baselineFile -Algorithm SHA256).Hash.ToUpperInvariant()
  if (![string]::Equals($actualHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Baseline file integrity hash mismatch: $relativePath"
  }
  $baselineEntries[$relativePath] = [ordered]@{
    path = $relativePath
    sha256 = $expectedHash
  }
}

foreach ($source in $payloads.Values) {
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required argument hotfix payload was not found: $source"
  }
}

$wrapperChecks = [ordered]@{
  'scripts/configure-unified-access.ps1' = '\$arguments\s*=\s*@\(\s*[''"]--[''"]\s*,\s*\$nodeScript'
  'scripts/configure-inventory-access.ps1' = '&\s*\$nodeCommand\.Source\s+[''"]--[''"]\s+\$nodeScript'
  'scripts/configure-purchase-access.ps1' = '\$arguments\s*=\s*@\(\s*[''"]--[''"]\s*,\s*\$nodeScript'
}
foreach ($relativePath in $wrapperChecks.Keys) {
  $source = Get-Content -Raw -LiteralPath $payloads[$relativePath] -Encoding UTF8
  if (![regex]::IsMatch($source, $wrapperChecks[$relativePath])) {
    throw "Corrected wrapper is missing the Node argument separator before the script path: $relativePath"
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Argument hotfix output already exists: $packageName"
}

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  foreach ($relativePath in $payloads.Keys) {
    if (Test-ForbiddenRelativePath -RelativePath $relativePath) {
      throw "Forbidden argument hotfix payload path: $relativePath"
    }
    $destination = Join-Path $stageDir $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $parent = Split-Path -Parent $destination
    if ($parent) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath $payloads[$relativePath] -Destination $destination -Force
    $baselineEntries[$relativePath] = [ordered]@{
      path = $relativePath
      sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToUpperInvariant()
    }
  }

  $manifestEntries = @(
    $baselineEntries.Values |
      Sort-Object { ([string]$_.path).ToLowerInvariant() }
  )
  [ordered]@{
    schemaVersion = 1
    files = $manifestEntries
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stageDir 'hotfix-manifest.json') -Encoding UTF8

  $stagedFiles = @(
    Get-ChildItem -LiteralPath $stageDir -File -Recurse |
      ForEach-Object { $_.FullName.Substring($stageDir.Length).TrimStart('\', '/').Replace('\', '/') }
  )
  $expectedStageFiles = @($payloads.Keys) + @('hotfix-manifest.json')
  if (
    $stagedFiles.Count -ne $expectedStageFiles.Count -or
    @($stagedFiles | Where-Object { $_ -notin $expectedStageFiles }).Count -gt 0
  ) {
    throw 'Argument hotfix staging contains an unexpected file.'
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII
} catch {
  Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  throw
}

Write-Host '[OK] Unified access configuration argument hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
