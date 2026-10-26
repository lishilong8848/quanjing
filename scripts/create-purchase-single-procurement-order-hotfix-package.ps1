param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-single-procurement-order-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_PURCHASE_SINGLE_PROCUREMENT_ORDER_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$serverRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js'
)
$clientMarkerBase64 = @(
  '5LiJ5pa55q+U5Lu3',
  '5Y2V5LiA6YeH6LSt',
  '5Y2V5LiA5Y6f5Zug',
  '5o+Q5Lqk5Lit'
)
$clientSemanticMarkers = @(
  'loading',
  'showSpinner'
)
$validationMarkerBase64 = @(
  '5Y2V5LiA5Y6f5Zug',
  '6YeH6LSt5b2i5byP'
)
$serviceMarkers = @(
  'selectComparisonFiles',
  'procurementForm'
)
$mapperMarkerBase64 = @(
  '5Y2V5LiA5Y6f5Zug',
  '5LiJ5pa55q+U5Lu3',
  '5Y2V5LiA6YeH6LSt'
)

function ConvertFrom-Utf8Base64Array {
  param([string[]]$Values)

  return @(
    $Values | ForEach-Object {
      [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))
    }
  )
}

function Assert-CompiledClientTreeContains {
  param(
    [string]$Root,
    [string[]]$Markers,
    [string[]]$SemanticMarkers
  )

  if (!(Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Compiled client directory was not found: $Root"
  }
  $textFiles = @(
    Get-ChildItem -LiteralPath $Root -File -Recurse |
      Where-Object {
        [IO.Path]::GetExtension($_.Name) -in @('.html', '.js', '.css')
      }
  )
  if ($textFiles.Count -eq 0) {
    throw "Compiled client tree has no searchable runtime files: $Root"
  }
  $contents = @(
    $textFiles | ForEach-Object {
      Get-Content -Raw -LiteralPath $_.FullName -Encoding UTF8
    }
  )
  foreach ($marker in @($Markers) + @($SemanticMarkers)) {
    $found = @(
      $contents | Where-Object { $_.Contains($marker) }
    ).Count -gt 0
    if (!$found) {
      throw "Compiled client tree is missing required marker: $marker"
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
    throw "Compiled server runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled server runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentFullPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childFullPath = [IO.Path]::GetFullPath($Child)
  $parentPrefix = $parentFullPath + [IO.Path]::DirectorySeparatorChar
  if (
    $childFullPath.Equals(
      $parentFullPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    !$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Assert-SafePayloadPaths {
  param([string[]]$Paths)

  $forbiddenPathFragments = @(
    '/node_modules/',
    '/data/',
    '/logs/',
    '/certs/',
    '/.runtime/',
    '/sourcemaps/'
  )
  $forbiddenFileNames = @(
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock'
  )
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.spec',
    '.log',
    '.pem',
    '.cer',
    '.crt',
    '.cert',
    '.key',
    '.pfx',
    '.p12'
  )

  foreach ($path in $Paths) {
    $normalized = $path.Replace('\', '/').TrimStart('/')
    $guardPath = "/$normalized/"
    $leafName = [IO.Path]::GetFileName($normalized)
    $extension = [IO.Path]::GetExtension($normalized)
    $regexOptions =
      [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
      [Text.RegularExpressions.RegexOptions]::CultureInvariant
    $hasForbiddenPathFragment = @(
      $forbiddenPathFragments |
        Where-Object {
          $guardPath.IndexOf(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          ) -ge 0
        }
    ).Count -gt 0
    $hasForbiddenFileName = @(
      $forbiddenFileNames |
        Where-Object {
          $leafName.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasForbiddenExtension = @(
      $forbiddenExtensions |
        Where-Object {
          $extension.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasEnvironmentSegment = [Text.RegularExpressions.Regex]::IsMatch(
      $normalized,
      '(^|/)\.env[^/]*(/|$)',
      $regexOptions
    )
    $hasSpecFileName = [Text.RegularExpressions.Regex]::IsMatch(
      $leafName,
      '(^|[.])spec([.]|$)',
      $regexOptions
    )
    if (
      [IO.Path]::IsPathRooted($path) -or
      $normalized -match '(^|/)\.\.(/|$)' -or
      $hasEnvironmentSegment -or
      $hasForbiddenPathFragment -or
      $hasForbiddenFileName -or
      $hasSpecFileName -or
      $hasForbiddenExtension
    ) {
      throw "Refusing to package forbidden path: $path"
    }
  }
}

function Assert-NoReparsePoints {
  param([string]$Root)

  if (!(Test-Path -LiteralPath $Root)) {
    throw "Required payload path was not found: $Root"
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  $items = @($rootItem)
  if ($rootItem.PSIsContainer) {
    $items += @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  }
  $reparsePoint = @(
    $items |
      Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
      }
  ) | Select-Object -First 1
  if ($reparsePoint) {
    throw "Refusing to package a reparse point: $($reparsePoint.FullName)"
  }
}

function Get-RelativeFilePaths {
  param(
    [string]$Root,
    [string]$Prefix
  )

  $rootFullPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse |
      ForEach-Object {
        $relative = $_.FullName.Substring($rootFullPath.Length)
        $relative = $relative.TrimStart('\', '/')
        $relative = $relative.Replace('\', '/')
        "$Prefix/$relative"
      } |
      Sort-Object
  )
}

function Get-StageRelativePaths {
  param([string]$Stage)

  $stageFullPath = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $relative = $_.FullName.Substring($stageFullPath.Length)
        $relative = $relative.TrimStart('\', '/')
        $relative.Replace('\', '/')
      } |
      Sort-Object
  )
}

function Assert-ExactPathSet {
  param(
    [string[]]$Actual,
    [string[]]$Expected,
    [string]$FailureMessage
  )

  $actualPaths = @($Actual | Sort-Object)
  $expectedPaths = @($Expected | Sort-Object)
  if (
    $actualPaths.Count -ne $expectedPaths.Count -or
    @($actualPaths | Where-Object { $_ -notin $expectedPaths }).Count -gt 0 -or
    @($expectedPaths | Where-Object { $_ -notin $actualPaths }).Count -gt 0
  ) {
    throw $FailureMessage
  }
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths
  )

  $files = @(
    $PayloadPaths | Sort-Object | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      $fileHash = Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
      [ordered]@{
        path = $_
        sha256 = $fileHash.Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    package = $packageName
    packageType = 'purchase-single-procurement-order-hotfix'
    replaceDirectories = @($clientRelativePath)
    replaceFiles = @($serverRelativePaths)
    files = $files
  } | ConvertTo-Json -Depth 5 |
    Set-Content `
      -LiteralPath (Join-Path $Stage $manifestRelativePath) `
      -Encoding UTF8
}

function Assert-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths
  )

  $manifestPath = Join-Path $Stage $manifestRelativePath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  $manifestFiles = @($manifest.files)
  Assert-ExactPathSet `
    -Actual @($manifestFiles | ForEach-Object { $_.path }) `
    -Expected $PayloadPaths `
    -FailureMessage 'Hotfix manifest entries do not match the payload files.'
  foreach ($entry in $manifestFiles) {
    $fullPath = Join-Path $Stage ([string]$entry.path).Replace(
      '/',
      [IO.Path]::DirectorySeparatorChar
    )
    $fileHash = Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
    $actualHash = $fileHash.Hash.ToUpperInvariant()
    if ($actualHash -ne ([string]$entry.sha256).ToUpperInvariant()) {
      throw "Hotfix manifest hash mismatch: $($entry.path)"
    }
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

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

$clientRoot = Join-Path $repoRoot $clientRelativePath
if (!(Test-Path -LiteralPath (Join-Path $clientRoot 'index.html') -PathType Leaf)) {
  throw 'Compiled client index.html was not found.'
}
$decodedClientMarkers = ConvertFrom-Utf8Base64Array -Values $clientMarkerBase64
Assert-CompiledClientTreeContains -Root $clientRoot `
  -Markers $decodedClientMarkers `
  -SemanticMarkers $clientSemanticMarkers
Assert-CompiledFileContains -RelativePath $serverRelativePaths[0] `
  -Markers (ConvertFrom-Utf8Base64Array -Values $validationMarkerBase64)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[1] `
  -Markers $serviceMarkers
Assert-CompiledFileContains -RelativePath $serverRelativePaths[2] `
  -Markers (ConvertFrom-Utf8Base64Array -Values $mapperMarkerBase64)

Assert-NoReparsePoints -Root $clientRoot
foreach ($relativePath in $serverRelativePaths) {
  Assert-NoReparsePoints -Root (Join-Path $repoRoot $relativePath)
}

$expectedClientPaths = Get-RelativeFilePaths `
  -Root $clientRoot `
  -Prefix $clientRelativePath
$expectedPayloadPaths = @($expectedClientPaths) +
  @($serverRelativePaths) +
  @($readmeRelativePath)
Assert-SafePayloadPaths -Paths $expectedPayloadPaths

$readmeLines = @(
  '# Purchase single procurement order hotfix',
  '',
  '## Package provenance and scope',
  '',
  '- The complete `dist/client` tree comes from a production build of the current working tree.',
  '- Client assets are content-hashed; replacing only one client chunk is unsafe and unsupported.',
  '- `-SkipBuild` is only for a production build already generated from this same working tree.',
  '- No Feishu Base schema or structure change is required.',
  '- No dependency installation is required.',
  '- No `.env` change is required.',
  '',
  '## Deployment',
  '',
  '1. Stop the application with the existing stop script or service manager.',
  '2. Back up the entire `dist/client` directory and the three compiled server files listed below.',
  '3. Delete the existing `dist/client` directory so stale content-hashed chunks cannot remain.',
  '4. Extract this ZIP into the application root, replace the complete `dist/client`, and overwrite exactly these three compiled server files:'
) + @(
  $serverRelativePaths | ForEach-Object { '- `' + $_ + '`' }
) + @(
  '5. Start the application with the existing start script or service manager.',
  '6. Press Ctrl+F5 in the browser before verification.',
  '',
  '## Acceptance checks',
  '',
  "- Confirm the purchase form offers '$($decodedClientMarkers[0])' and '$($decodedClientMarkers[1])'.",
  "- Confirm '$($decodedClientMarkers[1])' requires '$($decodedClientMarkers[2])' and does not upload hidden comparison files.",
  "- Confirm offline '$($decodedClientMarkers[0])' still requires its comparison attachment.",
  "- Submit one controlled request, confirm the '$($decodedClientMarkers[3])' state appears, and verify the resulting purchase order.",
  '',
  '## Rollback',
  '',
  'Stop the application, delete the deployed `dist/client`, restore the complete backed-up `dist/client` and all three backed-up server files, start the application, and press Ctrl+F5.',
  '',
  '## Exclusions',
  '',
  'This package contains no source files, source maps, tests, secrets, dependency manifests, dependencies, business data, logs, certificates, runtime state, environment files, or start/stop scripts.'
)

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-NoReparsePoints -Root $outputRoot
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

$stageCreated = $false
$archiveHash = ''
try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stageCreated = $true

  Copy-RequiredDirectory `
    -Source $clientRoot `
    -Destination (Join-Path $stageDir $clientRelativePath)
  foreach ($relativePath in $serverRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $stagedPayloadPaths = Get-StageRelativePaths -Stage $stageDir
  Assert-ExactPathSet `
    -Actual $stagedPayloadPaths `
    -Expected $expectedPayloadPaths `
    -FailureMessage 'Hotfix staging contains an unexpected or missing file.'
  Assert-SafePayloadPaths -Paths $stagedPayloadPaths
  Assert-NoReparsePoints -Root $stageDir

  Write-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths
  Assert-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths

  $actualStagePaths = Get-StageRelativePaths -Stage $stageDir
  $expectedStagePaths = @($expectedPayloadPaths) + @($manifestRelativePath)
  Assert-ExactPathSet `
    -Actual $actualStagePaths `
    -Expected $expectedStagePaths `
    -FailureMessage 'Hotfix staging contains an unexpected or missing file.'
  Assert-SafePayloadPaths -Paths $actualStagePaths

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
      @(
        $archivePaths |
          Where-Object {
            $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
          }
      ).Count -gt 0
    ) {
      throw 'ZIP contains an unsafe entry path.'
    }
    Assert-ExactPathSet `
      -Actual $archivePaths `
      -Expected $actualStagePaths `
      -FailureMessage 'ZIP entries do not exactly match the staged hotfix files.'
  } finally {
    $archive.Dispose()
  }

  $zipHash = Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  $archiveHash = $zipHash.Hash.ToUpperInvariant()
  $sidecarValue = "$archiveHash  $([IO.Path]::GetFileName($zipPath))"
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value $sidecarValue `
    -Encoding ASCII
  if (
    (Get-Content -Raw -LiteralPath $sidecarPath -Encoding ASCII).Trim() -ne
    $sidecarValue
  ) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
} catch {
  if ($stageCreated -and (Test-Path -LiteralPath $stageDir)) {
    Assert-ChildPath -Parent $outputRoot -Child $stageDir
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($stageCreated -and (Test-Path -LiteralPath $zipPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $zipPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
  if ($stageCreated -and (Test-Path -LiteralPath $sidecarPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
    Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  }
  throw
}

Write-Host '[OK] Purchase single procurement order hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
