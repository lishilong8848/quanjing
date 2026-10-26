param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

$scriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
if (!$Root.Trim()) {
  $Root = Split-Path -Parent $scriptDirectory
}
if (!(Test-Path -LiteralPath $Root -PathType Container)) {
  throw "Application root does not exist: $Root"
}

$rootPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).Path).TrimEnd('\', '/')
$rootPrefix = $rootPath + [IO.Path]::DirectorySeparatorChar
$removedCount = 0

function Get-SafeTargetPath {
  param([string]$RelativePath)

  $target = [IO.Path]::GetFullPath((Join-Path $rootPath $RelativePath))
  if (!$target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside the application root: $target"
  }
  return $target
}

function Assert-NoReparsePointInTargetPath {
  param([string]$Target)

  if (!$Target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to inspect a path outside the application root: $Target"
  }

  $relativePath = $Target.Substring($rootPath.Length).TrimStart('\', '/')
  $currentPath = $rootPath
  foreach ($segment in ($relativePath -split '[\\/]')) {
    if (!$segment) {
      continue
    }
    $currentPath = Join-Path $currentPath $segment
    if (!(Test-Path -LiteralPath $currentPath)) {
      break
    }
    $item = Get-Item -LiteralPath $currentPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to clean through a reparse point: $currentPath"
    }
  }
}

function Remove-LegacyItem {
  param([string]$RelativePath)

  $target = Get-SafeTargetPath -RelativePath $RelativePath
  Assert-NoReparsePointInTargetPath -Target $target
  if (!(Test-Path -LiteralPath $target)) {
    return
  }

  Remove-Item -LiteralPath $target -Recurse -Force
  $script:removedCount += 1
  Write-Host "[CLEAN] Removed legacy contract OCR artifact: $RelativePath"
}

$legacyFiles = @(
  'scripts/extract-contract-terms.py',
  'scripts/ocr-contract-pages.ps1',
  'scripts/install-contract-ocr-python-deps.ps1',
  'scripts/requirements-contract-ocr.txt',
  'scripts/requirements-contract-ocr-python.txt',
  'server/modules/contract-management/contract-payment-confirmation.service.ts',
  'server/modules/contract-management/contract-payment-confirmation.service.spec.ts',
  'server/modules/contract-management/contract-payment-difference-review.ts',
  'server/modules/contract-management/contract-payment-difference-review.spec.ts',
  'server/modules/contract-management/contract-payment-review.gateway.ts',
  'server/modules/contract-management/contract-payment-review.gateway.spec.ts',
  'server/modules/contract-management/contract-payment-terms.rules.ts',
  'server/modules/contract-management/contract-payment-terms.rules.spec.ts',
  'server/modules/contract-management/valid-contract-payment-review.service.ts',
  'server/modules/contract-management/valid-contract-payment-review.service.spec.ts',
  'client/src/pages/ContractManagement/ContractPaymentDetailDialog.tsx',
  'client/src/pages/ContractManagement/PaymentDifferenceReviewDialog.tsx',
  'client/src/pages/ContractManagement/PaymentDifferenceDetailsDialog.tsx',
  'client/src/pages/ContractManagement/ValidContractPaymentEvidenceDialog.tsx'
)

foreach ($relativePath in $legacyFiles) {
  Remove-LegacyItem -RelativePath $relativePath
}

$compiledDirectory = Get-SafeTargetPath -RelativePath 'dist/server/modules/contract-management'
$compiledBases = @(
  'contract-payment-confirmation.service',
  'contract-payment-difference-review',
  'contract-payment-review.gateway',
  'contract-payment-terms.rules',
  'valid-contract-payment-review.service'
)
Assert-NoReparsePointInTargetPath -Target $compiledDirectory
if (Test-Path -LiteralPath $compiledDirectory -PathType Container) {
  foreach ($baseName in $compiledBases) {
    Get-ChildItem -LiteralPath $compiledDirectory -File -Filter "$baseName.*" -ErrorAction SilentlyContinue |
      ForEach-Object {
        Assert-NoReparsePointInTargetPath -Target $_.FullName
        Remove-Item -LiteralPath $_.FullName -Force
        $removedCount += 1
        Write-Host "[CLEAN] Removed legacy compiled module: $($_.Name)"
      }
  }
}

$pythonCacheDirectory = Get-SafeTargetPath -RelativePath 'scripts/__pycache__'
Assert-NoReparsePointInTargetPath -Target $pythonCacheDirectory
if (Test-Path -LiteralPath $pythonCacheDirectory -PathType Container) {
  Get-ChildItem -LiteralPath $pythonCacheDirectory -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'extract-contract-terms*.pyc' -or $_.Name -like 'extract-contract-terms*.pyo' } |
    ForEach-Object {
      Assert-NoReparsePointInTargetPath -Target $_.FullName
      Remove-Item -LiteralPath $_.FullName -Force
      $removedCount += 1
      Write-Host "[CLEAN] Removed legacy Python cache: $($_.Name)"
    }
}

foreach ($directoryAndPattern in @(
  @{ Directory = '.runtime'; Pattern = 'contract-ocr*' },
  @{ Directory = 'logs'; Pattern = 'contract-ocr*' }
)) {
  $directory = Get-SafeTargetPath -RelativePath $directoryAndPattern.Directory
  Assert-NoReparsePointInTargetPath -Target $directory
  if (!(Test-Path -LiteralPath $directory -PathType Container)) {
    continue
  }

  Get-ChildItem -LiteralPath $directory -Force -Filter $directoryAndPattern.Pattern -ErrorAction SilentlyContinue |
    ForEach-Object {
      Assert-NoReparsePointInTargetPath -Target $_.FullName
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
      $removedCount += 1
      Write-Host "[CLEAN] Removed legacy runtime artifact: $($directoryAndPattern.Directory)/$($_.Name)"
    }
}

Write-Host "[OK] Legacy contract OCR cleanup completed. Removed $removedCount item(s)." -ForegroundColor Green
