param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "construction-progress-ui-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$clientIndexRelativePath = 'dist/client/index.html'
$sourceRelativePath =
  'client/src/pages/ConstructionManagement/index.tsx'
$readmeName = 'README_CONSTRUCTION_PROGRESS_UI_HOTFIX.md'
$manifestName = 'hotfix-manifest.json'
$baselineName =
  'purchase-supply-chain-hotfix-20260723-114113.zip'
$baselineSha256 =
  '26284F28600B91105ED3D9BDC027EFD337D63D1CC0F1BBA6A09D2A60DB998BAF'
$baselinePath = Join-Path $repoRoot "output/hotfix/$baselineName"
$baselineExtractDir = Join-Path $outputRoot (
  ".construction-progress-baseline-$timestamp-$PID"
)
$baselineClientDir = Join-Path $baselineExtractDir $clientRelativePath
$baselineVerifierPath = Join-Path $repoRoot (
  'scripts/verify-construction-progress-client-baseline.mjs'
)
$expectedClientFileCount = 88

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

function Assert-SourceFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Required source file is missing: $fullPath"
  }
  $content = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Source file is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  if (!(Test-Path -LiteralPath $clientRoot -PathType Container)) {
    throw "Compiled client directory is missing: $clientRoot"
  }
  $searchableFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Recurse |
      Where-Object { $_.Extension -in @('.js', '.html', '.css') }
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

function Get-ZipEntryHash {
  param([System.IO.Compression.ZipArchiveEntry]$Entry)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  $stream = $Entry.Open()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return ([BitConverter]::ToString($bytes)).Replace('-', '')
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
Assert-ChildPath -Parent $outputRoot -Child $baselineExtractDir

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (!(Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
  throw "Required client baseline ZIP is missing: $baselinePath"
}
$actualBaselineHash = (
  Get-FileHash -LiteralPath $baselinePath -Algorithm SHA256
).Hash.ToUpperInvariant()
if ($actualBaselineHash -ne $baselineSha256) {
  throw "Client baseline SHA256 mismatch: $baselineName"
}
if (!(Test-Path -LiteralPath $baselineVerifierPath -PathType Leaf)) {
  throw "Client baseline verifier is missing: $baselineVerifierPath"
}

Assert-SourceFileContains `
  -RelativePath $sourceRelativePath `
  -Markers @(
    'min-[84rem]:grid-cols-[minmax(0,1fr)_31rem]',
    'lg:flex',
    'aria-label={`${stage.label}完成进度`}'
  )

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:client
  if ($LASTEXITCODE -ne 0) {
    throw 'Client production build failed; hotfix package was not created.'
  }
}

Assert-CompiledClientContains -Markers @(
  '每日施工进展',
  '当天开工前完成人员核查',
  '完成进度',
  '84rem'
)

$semanticDiff = $null
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $baselineExtractDir | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory(
    $baselinePath,
    $baselineExtractDir
  )
  if (!(Test-Path -LiteralPath $baselineClientDir -PathType Container)) {
    throw "Baseline client directory is missing: $baselineClientDir"
  }
  $baselineIndexPath = Join-Path $baselineExtractDir (
    $clientIndexRelativePath
  )
  $currentIndexPath = Join-Path $repoRoot $clientIndexRelativePath
  if (
    !(Test-Path -LiteralPath $baselineIndexPath -PathType Leaf) -or
    !(Test-Path -LiteralPath $currentIndexPath -PathType Leaf)
  ) {
    throw 'Client index entry is missing from the baseline or build.'
  }
  Copy-Item `
    -LiteralPath $baselineIndexPath `
    -Destination $currentIndexPath `
    -Force
  $semanticDiffJson = & node `
    $baselineVerifierPath `
    $baselineClientDir `
    (Join-Path $repoRoot $clientRelativePath) `
    "--expected-count=$expectedClientFileCount"
  if ($LASTEXITCODE -ne 0) {
    throw 'Client build contains changes outside the construction hotfix.'
  }
  $semanticDiff = $semanticDiffJson | ConvertFrom-Json
} finally {
  if (Test-Path -LiteralPath $baselineExtractDir) {
    Assert-ChildPath -Parent $outputRoot -Child $baselineExtractDir
    Remove-Item `
      -LiteralPath $baselineExtractDir `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
}

if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

$sourceRevision = (& git rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or !$sourceRevision) {
  $sourceRevision = 'unknown'
} else {
  $sourceRevision = $sourceRevision.Trim()
}
$sourceWorktreeDirty = [bool](& git status --porcelain 2>$null)

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

  $readmeLines = @(
    '# 施工管理每日进度界面热包',
    '',
    '## 覆盖内容',
    '',
    '- 完整替换 `dist/client`；前端入口和异步 chunk 使用内容哈希，禁止混用新旧文件。',
    '- 修复每日施工进度卡片的分栏、阶段箭头、文字可读性、提示层遮挡和进度语义。',
    '- 保留兼容基线的 `index.html`，避免带入构建工具新增的入口兼容脚本。',
    '- 不修改服务端接口、环境配置或业务数据。',
    '',
    '## 兼容基线',
    '',
    "- 必须已部署：$baselineName",
    "- 基线 SHA256：$baselineSha256",
    '- 打包时已自动验证：除施工 chunk 3668 和两条 lg:flex 样式外，无其他前端功能差异。',
    '',
    '## 部署',
    '',
    '1. 使用同名 `.sha256.txt` 校验 ZIP。',
    '2. 确认服务器已安装上述兼容基线。',
    '3. 停止服务，完整备份现有 `dist/client`。',
    '4. 删除服务器旧的 `dist/client`，将 ZIP 解压到程序根目录。',
    '5. 保留现有环境文件、数据、日志、证书和依赖目录。',
    '6. 启动服务，在浏览器按 Ctrl+F5 强制刷新。',
    '',
    '## 验证',
    '',
    '- 打开施工管理页面，检查“每日施工进展”区域。',
    '- 768px 宽度不显示阶段连接箭头；1024px 及以上三阶段卡片对齐。',
    '- 帮助提示不被卡片裁切，进度条和文字无洋红色渲染异常。',
    '',
    '## 回滚',
    '',
    '停止服务，删除本次 `dist/client`，恢复备份目录后重新启动。',
    '',
    '## 排除项',
    '',
    '本包不包含 .env、账号凭据、飞书密钥、证书、data、logs、node_modules、sourcemaps、`.ts` / `.tsx` 源码、`.spec` 测试或 `.map` source map。'
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
    packageType = 'construction-progress-client-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    sourceRevision = $sourceRevision
    sourceWorktreeDirty = $sourceWorktreeDirty
    buildCommand = 'npm run build:client'
    entryPointPolicy = 'baseline-index-preserved'
    baseline = [ordered]@{
      file = $baselineName
      sha256 = $baselineSha256
    }
    semanticDiff = [ordered]@{
      clientFileCount = $semanticDiff.clientFileCount
      changedJavaScript = @($semanticDiff.changedJavaScript)
      addedCssRules = $semanticDiff.addedCssRules
      removedCssRules = $semanticDiff.removedCssRules
    }
    replaceDirectories = @($clientRelativePath)
    replaceFiles = @()
    scope = @(
      'construction-management-daily-progress-layout',
      'construction-management-progress-card-rendering',
      'construction-management-help-tooltip',
      'construction-management-progress-accessibility'
    )
    secretsIncluded = $false
    files = $manifestFiles
  } | ConvertTo-Json -Depth 7 |
    Set-Content `
      -LiteralPath (Join-Path $stageDir $manifestName) `
      -Encoding UTF8

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $expectedFiles = @($payloadPaths + $manifestName | Sort-Object)
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  $unexpectedFiles = @(
    $actualFiles | Where-Object {
      $_ -ne $readmeName -and
      $_ -ne $manifestName -and
      !$_.StartsWith("$clientRelativePath/")
    }
  )
  if ($unexpectedFiles.Count -gt 0) {
    throw "Refusing to package unexpected path: $($unexpectedFiles[0])"
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

  $manifestHashes = @{}
  foreach ($file in $manifestFiles) {
    $manifestHashes[$file.path] = $file.sha256
  }
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archiveEntries = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        Sort-Object FullName
    )
    $archivePaths = @(
      $archiveEntries |
        ForEach-Object { $_.FullName.Replace('\', '/') }
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
    foreach ($entry in $archiveEntries) {
      $relativePath = $entry.FullName.Replace('\', '/')
      if ($manifestHashes.ContainsKey($relativePath)) {
        $entryHash = Get-ZipEntryHash -Entry $entry
        if ($entryHash -ne $manifestHashes[$relativePath]) {
          throw "ZIP entry hash mismatch: $relativePath"
        }
      }
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
  $recordedHash = (
    Get-Content -LiteralPath $sidecarPath -Raw
  ).Trim().Split(' ')[0]
  if ($recordedHash -ne $archiveHash) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
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

Write-Host '[OK] Construction progress UI hotfix created.' `
  -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
