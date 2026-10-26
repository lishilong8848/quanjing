param(
  [Parameter(Mandatory = $true)][string]$SourceAppRoot,
  [Parameter(Mandatory = $true)][string]$BaselinePackageRoot,
  [Parameter(Mandatory = $true)][string]$PoolParent,
  [Parameter(Mandatory = $true)][string]$SlotName,
  [Parameter(Mandatory = $true)][string]$ExpectedDeploymentId,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [int]$HealthPort = 32115
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Resolve-PhysicalDirectory([string]$Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'A required source directory is not physical.'
  }
  return $fullPath
}

function Assert-RelativePath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('\') -or $Value.Contains(':') -or $Value.StartsWith('/') -or $Value.EndsWith('/')) {
    throw 'The package manifest contains an unsafe path.'
  }
  foreach ($part in $Value.Split('/')) {
    if ($part -eq '' -or $part -eq '.' -or $part -eq '..') {
      throw 'The package manifest contains an unsafe path.'
    }
  }
}

function Get-ManifestFile([string]$Root, [string]$RelativePath, [string]$ExpectedSha256, [long]$ExpectedSize) {
  Assert-RelativePath $RelativePath
  $path = Join-Path $Root ($RelativePath.Replace('/', '\'))
  $fullPath = [System.IO.Path]::GetFullPath($path)
  if (-not $fullPath.StartsWith($Root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The package manifest path escapes its root.'
  }
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $ExpectedSize) {
    throw 'A package source file is missing or unsafe.'
  }
  $actual = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $ExpectedSha256) {
    throw 'A package source file differs from its manifest.'
  }
  return $fullPath
}

function Copy-ProvenFile([string]$SourceRoot, [string]$SourceRelative, [string]$DestinationRoot, [string]$DestinationRelative, [string]$Sha256, [long]$Size) {
  $source = Get-ManifestFile $SourceRoot $SourceRelative $Sha256 $Size
  Assert-RelativePath $DestinationRelative
  $destination = Join-Path $DestinationRoot ($DestinationRelative.Replace('/', '\'))
  $fullDestination = [System.IO.Path]::GetFullPath($destination)
  if (-not $fullDestination.StartsWith($DestinationRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'A package destination path escapes the standby app.'
  }
  $destinationParent = Split-Path -Parent $fullDestination
  if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }
  if (Test-Path -LiteralPath $fullDestination) {
    throw 'A standby destination already exists.'
  }
  Copy-Item -LiteralPath $source -Destination $fullDestination
  [void](Get-ManifestFile $DestinationRoot $DestinationRelative $Sha256 $Size)
}

if ($SlotName -cnotmatch '^hotfix-smoke-[a-z0-9-]+$') {
  throw 'SlotName must start with hotfix-smoke- and use lowercase ASCII.'
}
$sourceRoot = Resolve-PhysicalDirectory $SourceAppRoot
$packageRoot = Resolve-PhysicalDirectory $BaselinePackageRoot
$poolRoot = Resolve-PhysicalDirectory $PoolParent
$nodeExecutable = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$nodeItem = Get-Item -LiteralPath $nodeExecutable -Force
if ($nodeItem.PSIsContainer -or ($nodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'NodePath must be a physical executable.'
}
$appRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $poolRoot $SlotName) 'app'))
if (-not ($appRoot -cmatch '^[\x20-\x7E]+$') -or $appRoot.StartsWith($projectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The standby app must be outside the workspace at a pure ASCII path.'
}
if (Test-Path -LiteralPath (Split-Path -Parent $appRoot)) {
  throw 'The standby slot already exists; nothing was overwritten.'
}
$manifestPath = Join-Path $packageRoot 'hotfix-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.packageId -cne $ExpectedDeploymentId -or $manifest.dependencyTreeMode -cne 'verified-existing-production-tree') {
  throw 'The selected package ID or dependency mode does not match this standby preparation.'
}
if ((& $nodeExecutable --version).TrimStart('v') -cne [string]$manifest.buildNodeVersion -or (Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$manifest.buildNodeSha256) {
  throw 'The selected Node executable differs from the proven package toolchain.'
}
if ((Get-FileHash -LiteralPath (Join-Path $sourceRoot 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$manifest.candidatePackageLockSha256) {
  throw 'The source fixture dependency lock differs from the production package.'
}
$sourceNodeModules = Join-Path $sourceRoot 'node_modules'
$sourceDependencies = Get-Item -LiteralPath $sourceNodeModules -Force
if (-not $sourceDependencies.PSIsContainer -or ($sourceDependencies.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'The source dependency tree is not an independent physical directory.'
}
foreach ($name in @('.env', '.env.local')) {
  $envPath = Join-Path $sourceRoot $name
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { continue }
  $envItem = Get-Item -LiteralPath $envPath -Force
  if ($envItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'The source fixture environment file is unsafe.'
  }
  if (Select-String -LiteralPath $envPath -Pattern '^\s*(?:export\s+)?(?:FEISHU_APP_(?:ID|SECRET)|DINGTALK_ATTENDANCE_(?:CLIENT_(?:ID|SECRET)|APP_(?:KEY|SECRET)))\s*=' -Quiet) {
    throw 'The source fixture contains Feishu or DingTalk credentials; do not copy secrets into the standby pool.'
  }
}

Write-Host '[INFO] Creating one independent standby fixture; an incomplete slot will be retained for diagnosis.'
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
$destinationDependencies = Join-Path $appRoot 'node_modules'
Write-Host '[INFO] Copying the physical production dependency tree once.'
& robocopy.exe $sourceNodeModules $destinationDependencies /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'The dependency copy failed; the incomplete slot was retained.' }

Write-Host '[INFO] Copying and hashing the confirmed production runtime and managed root files.'
foreach ($file in @($manifest.payloadFiles)) {
  Copy-ProvenFile $packageRoot ([string]$file.path) $appRoot ([string]$file.path) ([string]$file.sha256) ([long]$file.size)
}
foreach ($file in @($manifest.releaseFiles)) {
  Copy-ProvenFile $packageRoot ([string]$file.path) $appRoot ([string]$file.targetPath) ([string]$file.sha256) ([long]$file.size)
}
Copy-Item -LiteralPath (Join-Path $sourceRoot '.deps-ready.json') -Destination (Join-Path $appRoot '.deps-ready.json')
foreach ($name in @('.env', '.env.local')) {
  $envPath = Join-Path $sourceRoot $name
  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    Copy-Item -LiteralPath $envPath -Destination (Join-Path $appRoot $name)
  }
}

$preflight = & $nodeExecutable (Join-Path $projectRoot 'scripts/verify-hotfix-smoke-preflight.mjs') --app-root $appRoot --workspace-root $projectRoot --smoke-parent $poolRoot --port $HealthPort 2>&1
if ($LASTEXITCODE -ne 0) { throw "Standby isolation preflight failed: $($preflight | Select-Object -Last 1)" }

$cacheRoot = Join-Path $env:LOCALAPPDATA 'NantongSchedule\dependency-proof-cache'
if (-not (Test-Path -LiteralPath $cacheRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
}
$rootBytes = [System.Text.Encoding]::UTF8.GetBytes($appRoot.TrimEnd('\').ToLowerInvariant())
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try { $rootKey = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash($rootBytes)).Replace('-', '').ToLowerInvariant() }
finally { $hashAlgorithm.Dispose() }
$cachePath = Join-Path $cacheRoot "dependency-proof-$rootKey.json"
$verifier = Join-Path $projectRoot 'scripts/verify-hotfix-dependency-transition.mjs'
$proofArgs = @(
  $verifier,
  '--baseline-package', (Join-Path $appRoot 'package.json'),
  '--baseline-lock', (Join-Path $appRoot 'package-lock.json'),
  '--candidate-package', (Join-Path $appRoot 'package.json'),
  '--candidate-lock', (Join-Path $appRoot 'package-lock.json'),
  '--installed-node-modules', $destinationDependencies,
  '--proof-cache', $cachePath
)
Write-Host '[INFO] Proving the new physical dependency root once, outside the next release critical path.'
$firstOutput = @(& $nodeExecutable @proofArgs 2>&1)
if ($LASTEXITCODE -ne 0 -or $firstOutput.Count -ne 1) { throw "Standby dependency proof failed: $($firstOutput | Select-Object -Last 1)" }
$firstProof = $firstOutput[0] | ConvertFrom-Json
if ($firstProof.installedPhysicalTreeFingerprint -cne [string]$manifest.dependencyInstalledPhysicalTreeFingerprint -or $firstProof.fileCount -ne [int]$manifest.dependencyFileCount) {
  throw 'The independent standby dependency tree differs from the production package proof.'
}
$secondOutput = @(& $nodeExecutable @proofArgs 2>&1)
if ($LASTEXITCODE -ne 0 -or $secondOutput.Count -ne 1) { throw 'The standby dependency cache could not be rechecked.' }
$secondProof = $secondOutput[0] | ConvertFrom-Json
if ($secondProof.proofCache.status -cne 'hit' -or $secondProof.installedPhysicalTreeFingerprint -cne $firstProof.installedPhysicalTreeFingerprint) {
  throw 'The standby dependency cache did not hit; do not use this slot for a fast release.'
}
$ready = [ordered]@{
  schemaVersion = 1
  deploymentId = $ExpectedDeploymentId
  appRoot = $appRoot
  dependencyFingerprint = [string]$secondProof.installedPhysicalTreeFingerprint
  dependencyFileCount = [int]$secondProof.fileCount
  proofCache = 'hit'
  preparedAt = (Get-Date).ToString('o')
}
$ready | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $appRoot) 'standby-ready.json') -Encoding UTF8
Write-Host "[OK] Standby prepared: $appRoot; dependency cache hit; no service started."
