param(
  [string]$OutputDir = 'output/hotfix'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "startup-ledger-recovery-hotfix-$timestamp"
$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
  [System.IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$readmeName = 'README_STARTUP_LEDGER_RECOVERY_HOTFIX.md'
$manifestName = 'hotfix-manifest.json'
$payloadNames = @('start.ps1', $readmeName)

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childPath = [System.IO.Path]::GetFullPath($Child)
  if (
    !$childPath.StartsWith(
      $parentPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Unsafe output path: $childPath"
  }
}

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required file not found: $Source"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}
Assert-ChildPath -Parent $outputRoot -Child $stageDir
New-Item -ItemType Directory -Path $stageDir | Out-Null

try {
  $launcherSource = Join-Path $repoRoot 'deploy/start.ps1'
  $launcherDestination = Join-Path $stageDir 'start.ps1'
  Copy-RequiredFile -Source $launcherSource -Destination $launcherDestination
  Copy-RequiredFile `
    -Source (Join-Path $repoRoot "deploy/$readmeName") `
    -Destination (Join-Path $stageDir $readmeName)

  foreach ($requiredMarker in @(
    'function Resolve-PurchaseWorkflowLedgerLock',
    'Resolve-PurchaseWorkflowLedgerLock -Root $appRoot',
    '$process.WaitForExit()',
    'No startup status marker was found. Last stdout log:'
  )) {
    if (
      !(Select-String `
        -LiteralPath $launcherDestination `
        -SimpleMatch $requiredMarker `
        -Quiet)
    ) {
      throw "Packaged launcher is missing required marker: $requiredMarker"
    }
  }

  $forbiddenNames = @(
    '.env',
    '.env.local',
    'node_modules',
    'dist',
    'data',
    'logs',
    'certs',
    '.runtime'
  )
  $forbidden = Get-ChildItem -LiteralPath $stageDir -Force -Recurse |
    Where-Object { $_.Name -in $forbiddenNames }
  if ($forbidden) {
    throw "Refusing to package forbidden path: $($forbidden[0].FullName)"
  }

  $manifestFiles = @(
    $payloadNames | ForEach-Object {
      $payloadPath = Join-Path $stageDir $_
      [ordered]@{
        path = $_
        size = (Get-Item -LiteralPath $payloadPath).Length
        sha256 = (
          Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256
        ).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    packageType = 'startup-launcher-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    replaceFiles = @('start.ps1')
    preservePaths = @(
      '.env',
      '.env.local',
      'dist',
      'node_modules',
      'data',
      'logs',
      'certs',
      '.runtime'
    )
    scope = @('startup-ledger-lock-recovery', 'startup-diagnostics')
    secretsIncluded = $false
    dependencyInstallRequired = $false
    files = $manifestFiles
  } | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $stageDir $manifestName) -Encoding UTF8

  $actualFiles = @(
    Get-ChildItem -LiteralPath $stageDir -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($stageDir.Length).
          TrimStart('\', '/').
          Replace('\', '/')
      } |
      Sort-Object
  )
  $expectedFiles = @($payloadNames + $manifestName | Sort-Object)
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
      $archivePaths.Count -ne $expectedFiles.Count -or
      @($archivePaths | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
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
    -Value "$archiveHash  $([System.IO.Path]::GetFileName($zipPath))" `
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

Write-Host '[OK] Startup ledger recovery hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
