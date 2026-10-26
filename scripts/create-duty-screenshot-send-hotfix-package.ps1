param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "duty-screenshot-send-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$runtimeRelativePath = 'dist/server/modules/duty-schedule/duty-screenshot.service.js'
$readmeRelativePath = 'README_DUTY_SCREENSHOT_SEND_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'

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
    files = $files
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) -Encoding UTF8
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Server production build failed; hotfix package was not created.'
  }
}

$runtimeSource = Join-Path $repoRoot $runtimeRelativePath
if (!(Test-Path -LiteralPath $runtimeSource -PathType Leaf)) {
  throw "Compiled runtime file was not found: $runtimeSource"
}
$compiledSource = Get-Content -Raw -LiteralPath $runtimeSource -Encoding UTF8
if (
  $compiledSource -notmatch 'source\s*===\s*[''"]manual[''"]' -or
  $compiledSource -notmatch 'captureAndSendDutyOverview' -or
  $compiledSource -notmatch 'url\.pathname\s*=\s*[''"]\/monthly-schedule[''"]'
) {
  throw 'Compiled runtime does not contain the required duty screenshot hotfix behavior.'
}

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
  Copy-RequiredFile -Source $runtimeSource -Destination (Join-Path $stageDir $runtimeRelativePath)

  $readmeLines = @(
    '# Duty screenshot send minimal hotfix',
    '',
    '## Scope',
    '',
    'This package overwrites only dist/server/modules/duty-schedule/duty-screenshot.service.js.',
    'Manual Send Today Screenshot creates, uploads, and sends only the duty overview screenshot. It no longer waits for campus screenshot or daily report writes. The capture opens /monthly-schedule directly so screenshot authorization parameters are preserved and excluded lower panels are hidden. Scheduled automation keeps its daily report archive flow.',
    '',
    '## Deployment',
    '',
    '1. Verify the ZIP SHA256 against its .sha256.txt sidecar.',
    '2. Back up the existing dist/server/modules/duty-schedule/duty-screenshot.service.js on the server.',
    '3. Extract this ZIP into the existing application deployment root and overwrite the matching file. Do not extract into a new nested folder.',
    '4. Restart the existing Node service using the server deployment procedure, for example stop.cmd then start.cmd.',
    '5. Validate Send Today Screenshot once with an administrator and once with a sub-administrator.',
    '',
    '## Exclusions',
    '',
    'No .env, secrets, certificates, data, logs, node_modules, frontend files, or tests are included.'
  )
  Set-Content -LiteralPath (Join-Path $stageDir $readmeRelativePath) -Value $readmeLines -Encoding UTF8

  Write-HotfixManifest -Stage $stageDir -RelativePaths @(
    $runtimeRelativePath,
    $readmeRelativePath
  )

  $expectedFiles = @(
    $runtimeRelativePath,
    $readmeRelativePath,
    $manifestRelativePath
  ) | Sort-Object
  $actualFiles = Get-StageRelativePaths -Stage $stageDir
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected file.'
  }

  $forbiddenFiles = Get-ChildItem -LiteralPath $stageDir -Force -Recurse | Where-Object {
    $_.Name -in @('.env', '.env.local', 'node_modules', 'data', 'logs', 'certs', '.runtime')
  }
  if ($forbiddenFiles) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0].FullName)"
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content -LiteralPath $sidecarPath -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" -Encoding ASCII
} catch {
  Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  throw
}

Write-Host '[OK] Duty screenshot send minimal hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
