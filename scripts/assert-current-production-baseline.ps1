[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaselineManifestPath,
  [Parameter(Mandatory = $true)][string]$ProductionReleaseStatePath,
  [Parameter(Mandatory = $true)][string]$ProductionPackageRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-Sha256 {
  param([string]$Path, [string]$Expected, [string]$Label)
  if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw "$Label has no valid SHA-256 in the production ledger." }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $Expected.ToLowerInvariant()) { throw "$Label SHA-256 does not match the confirmed production ledger." }
}

function Read-ZipJson {
  param([System.IO.Compression.ZipArchive]$Archive, [string]$EntryName)
  $entry = $Archive.GetEntry($EntryName)
  if ($null -eq $entry -or $entry.Length -gt 16777216) { throw "Missing or oversized ZIP manifest: $EntryName" }
  $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}

$state = Get-Content -LiteralPath $ProductionReleaseStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$production = $state.production
if ($null -eq $production -or [string]$production.deploymentId -notmatch '^nantong-safe-full-runtime-hotfix-[0-9]{8}-[0-9]{6}$') {
  throw 'No confirmed production deployment ID is available for baseline comparison.'
}
$expectedOuterName = ([string]$production.deploymentId).Replace('nantong-safe-full-runtime-hotfix-', 'nantong-one-click-hotfix-') + '.zip'
if ([string]$production.outerPackage -cne $expectedOuterName) { throw 'Production ledger package name does not match deployment ID.' }
$outerPath = Join-Path $ProductionPackageRoot $expectedOuterName
if (-not (Test-Path -LiteralPath $outerPath -PathType Leaf)) { throw "Confirmed production package is missing: $outerPath" }
Assert-Sha256 -Path $outerPath -Expected ([string]$production.outerSha256) -Label 'Production outer package'

$outer = [System.IO.Compression.ZipFile]::OpenRead($outerPath)
try {
  $payloadEntries = @($outer.Entries | Where-Object {
    $_.FullName -ceq '_hotfix-payload\hotfix-package.zip' -or
    $_.FullName -ceq '_hotfix-payload/hotfix-package.zip'
  })
  if ($payloadEntries.Count -ne 1) { throw 'Embedded production payload is missing or duplicated.' }
  $payloadEntry = $payloadEntries[0]
  if ($payloadEntry.Length -gt 1073741824) { throw 'Embedded production payload is missing or oversized.' }
  $memory = [System.IO.MemoryStream]::new()
  try {
    $stream = $payloadEntry.Open()
    try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
    $memory.Position = 0
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actualInnerSha = ([System.BitConverter]::ToString($sha.ComputeHash($memory)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($actualInnerSha -cne ([string]$production.innerSha256).ToLowerInvariant()) { throw 'Embedded production payload SHA-256 differs from the ledger.' }
    $memory.Position = 0
    $inner = [System.IO.Compression.ZipArchive]::new($memory, [System.IO.Compression.ZipArchiveMode]::Read, $true)
    try { $installedManifest = Read-ZipJson -Archive $inner -EntryName 'hotfix-manifest.json' } finally { $inner.Dispose() }
  } finally { $memory.Dispose() }
} finally { $outer.Dispose() }

if ([string]$installedManifest.packageId -cne [string]$production.deploymentId -or
    [string]$installedManifest.runtimeClosureFingerprint -cne [string]$production.runtimeClosureFingerprint) {
  throw 'Production package manifest does not match the confirmed ledger.'
}
$baseline = Get-Content -LiteralPath $BaselineManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$installedRootFiles = @{}
foreach ($file in @($installedManifest.releaseFiles)) {
  $path = [string]$file.targetPath
  if ($installedRootFiles.ContainsKey($path)) { throw "Duplicate production release target: $path" }
  $installedRootFiles[$path] = [string]$file.sha256
}
$requiredBasePaths = @('package.json', 'package-lock.json', 'start.ps1', 'start.cmd')
$seenBasePaths = @{}
$baseMaterial = @(
  foreach ($file in @($baseline.baseFiles)) {
    $path = [string]$file.path
    $sha256 = [string]$file.sha256
    if ($path -notin $requiredBasePaths -or $seenBasePaths.ContainsKey($path) -or $sha256 -notmatch '^[a-f0-9]{64}$') {
      throw "Invalid or duplicate baseline base file: $path"
    }
    $seenBasePaths[$path] = $true
    # baseFiles/baseFingerprint in the installed package describe its PRE-install input.
    # The next baseline must match the bytes actually installed by that package.
    if (-not $installedRootFiles.ContainsKey($path) -or $sha256 -cne $installedRootFiles[$path]) {
      throw "Selected baseline is not the confirmed installed root ($($production.deploymentId)): $path"
    }
    "$($path):$sha256"
  }
) -join "`n"
if ($seenBasePaths.Count -ne $requiredBasePaths.Count) { throw 'Baseline base files are incomplete.' }
$algorithm = [System.Security.Cryptography.SHA256]::Create()
try { $actualBaseFingerprint = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($baseMaterial))) -replace '-', '').ToLowerInvariant() }
finally { $algorithm.Dispose() }
if ($actualBaseFingerprint -cne [string]$baseline.baseFingerprint) { throw 'Selected baseline baseFingerprint does not match its base files.' }
$actualFiles = @{}
foreach ($file in @($baseline.files)) {
  $path = [string]$file.path
  if ($actualFiles.ContainsKey($path)) { throw "Duplicate baseline path: $path" }
  $actualFiles[$path] = [string]$file.sha256
}
foreach ($path in $installedRootFiles.Keys) {
  if (-not $actualFiles.ContainsKey($path) -or $actualFiles[$path] -cne $installedRootFiles[$path]) {
    throw "Selected baseline is missing or differs from confirmed production release target: $path"
  }
}
$expectedFiles = @{}
foreach ($file in @($installedManifest.payloadFiles)) {
  $path = [string]$file.path
  if ($path -notmatch '^dist/(server|shared|client)/') { continue }
  if ($expectedFiles.ContainsKey($path)) { throw "Duplicate production payload path: $path" }
  $expectedFiles[$path] = [string]$file.sha256
  if (-not $actualFiles.ContainsKey($path) -or $actualFiles[$path] -cne $expectedFiles[$path]) {
    throw "Selected baseline is not the confirmed production runtime ($($production.deploymentId)): $path"
  }
}
foreach ($path in $actualFiles.Keys) {
  if ($path -match '^dist/(server|shared)/' -and -not $expectedFiles.ContainsKey($path)) {
    throw "Selected baseline has an unexpected strict runtime file: $path"
  }
}
if ($expectedFiles.Count -lt 1) { throw 'Confirmed production package has no runtime payload files.' }
Write-Output "[OK] Baseline matches confirmed production $($production.deploymentId) ($($expectedFiles.Count) runtime files)."
