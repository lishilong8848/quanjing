[CmdletBinding()]
param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "monthly-sealing-refresh-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$installerTemplatePath = Join-Path $repoRoot 'deploy/apply-construction-interaction-performance-hotfix.ps1'
$installerName = 'apply-monthly-sealing-refresh-hotfix.ps1'
$readmeName = 'README_MONTHLY_SEALING_REFRESH_HOTFIX.md'
$manifestName = 'hotfix-manifest.json'
$packageType = 'monthly-sealing-refresh-compiled-client-overlay'

function Assert-SafeChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childPath = [IO.Path]::GetFullPath($Child)
  $prefix = "$parentPath$([IO.Path]::DirectorySeparatorChar)"
  if (!$childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside its allowed root: $childPath"
  }
}

function Get-RelativeFiles {
  param([Parameter(Mandatory = $true)][string]$Root)

  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $rootPath -File -Force -Recurse |
      ForEach-Object {
        $_.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
      } |
      Sort-Object
  )
}

Assert-SafeChildPath -Parent $outputRoot -Child $stageDir -Label 'Stage directory'
Assert-SafeChildPath -Parent $outputRoot -Child $zipPath -Label 'ZIP output'
Assert-SafeChildPath -Parent $outputRoot -Child $checksumPath -Label 'Checksum output'

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:client
  if ($LASTEXITCODE -ne 0) {
    throw 'Client production build failed; hotfix package was not created.'
  }
}

$compiledClientPath = Join-Path $repoRoot $clientRelativePath
$mainJsPath = Join-Path $compiledClientPath 'main.js'
if (!(Test-Path -LiteralPath $compiledClientPath -PathType Container)) {
  throw "Compiled client directory is missing: $compiledClientPath"
}
if (!(Test-Path -LiteralPath $mainJsPath -PathType Leaf)) {
  throw "Compiled client entry is missing: $mainJsPath"
}
$compiledMainJs = Get-Content -LiteralPath $mainJsPath -Raw -Encoding UTF8
foreach ($marker in @('/api/sealing-info/', 'Cache-Control')) {
  if (!$compiledMainJs.Contains($marker)) {
    throw "Compiled client is missing required marker: $marker"
  }
}
if (!(Test-Path -LiteralPath $installerTemplatePath -PathType Leaf)) {
  throw "Installer template is missing: $installerTemplatePath"
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $checksumPath)
) {
  throw "Hotfix output already exists: $packageName"
}

New-Item -ItemType Directory -Path $stageDir | Out-Null
Copy-Item `
  -LiteralPath $compiledClientPath `
  -Destination (Join-Path $stageDir $clientRelativePath) `
  -Recurse `
  -Force

$installerContent = Get-Content -LiteralPath $installerTemplatePath -Raw -Encoding UTF8
$installerContent = $installerContent.Replace(
  'construction-interaction-performance-compiled-client-overlay',
  $packageType
)
$installerContent = $installerContent.Replace(
  'Construction interaction performance hotfix',
  'Monthly sealing refresh hotfix'
)
$installerContent = $installerContent.Replace(
  '.construction-client-hotfix-',
  '.monthly-sealing-refresh-hotfix-'
)
Set-Content `
  -LiteralPath (Join-Path $stageDir $installerName) `
  -Value $installerContent `
  -Encoding UTF8

$readmeLines = @(
  '# Monthly schedule sealing refresh hotfix',
  '',
  '## Scope',
  '',
  '- Replaces the complete compiled dist/client directory only.',
  '- Fixes stale sealing markers caused by long-lived client and browser caches.',
  '- Keeps a five-minute client cache, visible-page revalidation, and manual-sync forced sealing reload.',
  '',
  '## Install',
  '',
  '1. Stop the application service.',
  '2. Verify the ZIP SHA256 against the matching .sha256.txt file.',
  '3. Extract the ZIP into a separate directory.',
  '4. Run:',
  '',
  '```powershell',
  'powershell -NoProfile -ExecutionPolicy Bypass `',
  '  -File .\apply-monthly-sealing-refresh-hotfix.ps1 `',
  "  -TargetRoot 'D:\\path\\to\\application'",
  '```',
  '',
  '5. Start the service and use Ctrl+F5 in the browser.',
  '',
  'The installer validates every payload hash, backs up the existing dist/client directory under hotfix-backups, then replaces it atomically. A failed installation restores the backup automatically.',
  '',
  '## Rollback',
  '',
  'Stop the service, restore dist/client from the backup path printed by the installer, then restart.',
  '',
  '## Exclusions',
  '',
  'This package contains no server files, environment files, credentials, certificates, business data, logs, node_modules, source files, tests, or source maps.'
)
Set-Content `
  -LiteralPath (Join-Path $stageDir $readmeName) `
  -Value $readmeLines `
  -Encoding UTF8

$payloadRoot = Join-Path $stageDir $clientRelativePath
$payloadFiles = @(Get-RelativeFiles -Root $payloadRoot | ForEach-Object { "$clientRelativePath/$_" })
$manifestFiles = @(
  $payloadFiles | ForEach-Object {
    $fullPath = Join-Path $stageDir $_.Replace('/', [IO.Path]::DirectorySeparatorChar)
    [ordered]@{
      path = $_
      size = (Get-Item -LiteralPath $fullPath).Length
      sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToUpperInvariant()
    }
  }
)
[ordered]@{
  schemaVersion = 1
  packageType = $packageType
  packageName = $packageName
  createdAt = (Get-Date).ToString('o')
  replaceDirectories = @($clientRelativePath)
  files = $manifestFiles
} | ConvertTo-Json -Depth 5 | Set-Content `
  -LiteralPath (Join-Path $stageDir $manifestName) `
  -Encoding UTF8

$expectedArchiveEntries = @(Get-RelativeFiles -Root $stageDir)
[IO.Compression.ZipFile]::CreateFromDirectory(
  $stageDir,
  $zipPath,
  [IO.Compression.CompressionLevel]::Optimal,
  $false
)
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $archiveEntries = @(
    $archive.Entries |
      Where-Object { !$_.FullName.EndsWith('/') } |
      ForEach-Object { $_.FullName.TrimEnd('/').Replace('\', '/') } |
      Sort-Object
  )
  if (
    $archiveEntries.Count -ne $expectedArchiveEntries.Count -or
    @($archiveEntries | Where-Object { $_ -notin $expectedArchiveEntries }).Count -gt 0 -or
    @($expectedArchiveEntries | Where-Object { $_ -notin $archiveEntries }).Count -gt 0
  ) {
    throw 'ZIP entries do not exactly match staged package files.'
  }
} finally {
  $archive.Dispose()
}

$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
"$zipHash  $([IO.Path]::GetFileName($zipPath))" |
  Set-Content -LiteralPath $checksumPath -Encoding ASCII

Write-Host "[OK] Monthly sealing refresh hotfix created: $zipPath" -ForegroundColor Green
Write-Host "[OK] SHA256: $zipHash" -ForegroundColor Green
