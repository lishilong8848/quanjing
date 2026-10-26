[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceHotfixZip,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$sourcePath = (Resolve-Path -LiteralPath $SourceHotfixZip).Path
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Source hotfix ZIP does not exist: $SourceHotfixZip"
}
if ([System.IO.Path]::GetExtension($sourcePath) -cne '.zip') {
  throw 'Source hotfix package must be a ZIP file.'
}

$sourceShaPath = "$sourcePath.sha256"
if (-not (Test-Path -LiteralPath $sourceShaPath -PathType Leaf)) {
  throw "Source hotfix SHA-256 file does not exist: $sourceShaPath"
}
$declaredShaText = [System.IO.File]::ReadAllText($sourceShaPath, $utf8NoBom).Trim()
if ($declaredShaText -notmatch '^(?<sha>[0-9a-fA-F]{64})(?:\s|$)') {
  throw 'Source hotfix SHA-256 file is invalid.'
}
$declaredSha = $Matches.sha.ToLowerInvariant()
$actualSha = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha -cne $declaredSha) {
  throw 'Source hotfix SHA-256 does not match. No one-click package was created.'
}

$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($outputFullPath) -cne '.zip') {
  throw 'One-click output path must end with .zip.'
}
$outputDirectory = Split-Path -Parent $outputFullPath
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
$outputShaPath = "$outputFullPath.sha256"
$partialOutput = "$outputFullPath.partial.zip"
foreach ($target in @($outputFullPath, $outputShaPath, $partialOutput)) {
  if (Test-Path -LiteralPath $target) {
    throw "One-click output target already exists: $target"
  }
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$installerTemplate = Join-Path $scriptRoot 'install-hotfix-one-click.ps1'
$launcherTemplate = Join-Path $scriptRoot 'install-hotfix-one-click.cmd'
$credentialLauncherTemplate = Join-Path $scriptRoot 'update-dingtalk-credentials-one-click.cmd'
foreach ($templatePath in @($installerTemplate, $launcherTemplate, $credentialLauncherTemplate)) {
  if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw "One-click template is missing: $templatePath"
  }
}

$stageRoot = Join-Path $outputDirectory ".one-click-hotfix-$([Guid]::NewGuid().ToString('N'))"
try {
  $payloadDirectory = Join-Path $stageRoot '_hotfix-payload'
  $launcherName = [string]::Concat(
    [char]0x4e00,
    [char]0x952e,
    [char]0x66f4,
    [char]0x65b0,
    [char]0x5e76,
    [char]0x542f,
    [char]0x52a8,
    '.cmd'
  )
  $credentialLauncherName = [string]::Concat(
    [char]0x66f4,
    [char]0x65b0,
    [char]0x9489,
    [char]0x9489,
    [char]0x51ed,
    [char]0x8bc1,
    [char]0x5e76,
    [char]0x4e00,
    [char]0x952e,
    [char]0x66f4,
    [char]0x65b0,
    '.cmd'
  )
  New-Item -ItemType Directory -Path $payloadDirectory -Force | Out-Null
  Copy-Item -LiteralPath $installerTemplate -Destination (Join-Path $stageRoot 'ONE-CLICK-HOTFIX.ps1')
  Copy-Item -LiteralPath $launcherTemplate -Destination (Join-Path $stageRoot $launcherName)
  Copy-Item -LiteralPath $credentialLauncherTemplate -Destination (Join-Path $stageRoot $credentialLauncherName)
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $payloadDirectory 'hotfix-package.zip')
  Copy-Item -LiteralPath $sourceShaPath -Destination (Join-Path $payloadDirectory 'hotfix-package.zip.sha256')

  $readme = @(
    'Nantong Schedule One-Click Hotfix',
    '',
    '1. Extract this ZIP into the server application root and allow the one-click helper files to be overwritten.',
    '2. Double-click the CMD file whose name starts with the Chinese words for one-click update.',
    '   To replace an already-valid DingTalk credential pair, use the CMD whose name starts with the Chinese words for update DingTalk credentials.',
    '3. Success requires the final [OK] message for update, health check, and DingTalk preflight.',
    '',
    'The helper verifies the nested package SHA-256 and runs one DingTalk CLI self-test before installation.',
    'INSTALL-HOTFIX.ps1 then performs the atomic runtime switch, installed-file verification, health check, and rollback.'
  ) -join "`r`n"
  [System.IO.File]::WriteAllText((Join-Path $stageRoot 'ONE-CLICK-README.txt'), $readme, $utf8NoBom)

  Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $partialOutput -CompressionLevel NoCompression
  Move-Item -LiteralPath $partialOutput -Destination $outputFullPath
  $outerSha = (Get-FileHash -LiteralPath $outputFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $shaLine = "$outerSha  $([System.IO.Path]::GetFileName($outputFullPath))`n"
  [System.IO.File]::WriteAllText($outputShaPath, $shaLine, [System.Text.Encoding]::ASCII)

  [pscustomobject]@{
    outputPath = $outputFullPath
    sha256Path = $outputShaPath
    sha256 = $outerSha
    sourceSha256 = $actualSha
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $partialOutput) {
    Remove-Item -LiteralPath $partialOutput -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
