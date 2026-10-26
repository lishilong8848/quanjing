param(
  [int]$Port = 0,
  [string]$HostName = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Resolve-AppRoot {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  if (Test-Path (Join-Path $scriptDir 'dist/server/main.js')) {
    return $scriptDir
  }
  return (Split-Path -Parent $scriptDir)
}

function Copy-LegacyStateFileIfMissing {
  param(
    [string]$LegacyPath,
    [string]$DestinationPath
  )

  if (!(Test-Path -LiteralPath $LegacyPath -PathType Leaf) -or
      (Test-Path -LiteralPath $DestinationPath)) {
    return
  }
  $legacyFullPath = [System.IO.Path]::GetFullPath($LegacyPath)
  $destinationFullPath = [System.IO.Path]::GetFullPath($DestinationPath)
  if ([string]::Equals($legacyFullPath, $destinationFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return
  }

  $destinationDirectory = Split-Path -Parent $destinationFullPath
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  $temporaryPath = "$destinationFullPath.migrating.$PID"
  try {
    Copy-Item -LiteralPath $legacyFullPath -Destination $temporaryPath -Force
    try {
      [System.IO.File]::Move($temporaryPath, $destinationFullPath)
      Write-Host "[OK] Migrated persistent workflow state: $destinationFullPath" -ForegroundColor Green
    } catch {
      if (!(Test-Path -LiteralPath $destinationFullPath -PathType Leaf)) {
        throw
      }
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-NativeCommandCaptured {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $Executable @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  return [pscustomobject]@{
    Output = $output
    ExitCode = $exitCode
  }
}

function Test-HttpsCertificateReady {
  param(
    [string]$Root,
    [string]$CertificatePath,
    [string]$PrivateKeyPath
  )

  $hasCertificate = ![string]::IsNullOrWhiteSpace($CertificatePath)
  $hasPrivateKey = ![string]::IsNullOrWhiteSpace($PrivateKeyPath)
  if (!$hasCertificate -and !$hasPrivateKey) {
    return $true
  }
  if (!$hasCertificate -or !$hasPrivateKey) {
    Write-Host '[ERROR] HTTPS_CERT_PATH and HTTPS_KEY_PATH must be configured together.' -ForegroundColor Red
    return $false
  }

  $resolvedCertificatePath = if ([System.IO.Path]::IsPathRooted($CertificatePath)) {
    $CertificatePath
  } else {
    Join-Path $Root $CertificatePath
  }
  $resolvedPrivateKeyPath = if ([System.IO.Path]::IsPathRooted($PrivateKeyPath)) {
    $PrivateKeyPath
  } else {
    Join-Path $Root $PrivateKeyPath
  }

  if (!(Test-Path -LiteralPath $resolvedCertificatePath -PathType Leaf)) {
    Write-Host "[ERROR] HTTPS certificate file not found: $resolvedCertificatePath" -ForegroundColor Red
    return $false
  }
  if (!(Test-Path -LiteralPath $resolvedPrivateKeyPath -PathType Leaf)) {
    Write-Host "[ERROR] HTTPS private key file not found: $resolvedPrivateKeyPath" -ForegroundColor Red
    return $false
  }

  try {
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolvedCertificatePath)
  } catch {
    Write-Host "[ERROR] HTTPS certificate cannot be read: $resolvedCertificatePath" -ForegroundColor Red
    return $false
  }

  $now = Get-Date
  if ($now -lt $certificate.NotBefore) {
    Write-Host "[ERROR] HTTPS certificate is not valid before $($certificate.NotBefore.ToString('yyyy-MM-dd HH:mm:ss zzz'))." -ForegroundColor Red
    Write-Host '[ERROR] Replace the certificate and private key, then run start.cmd again.' -ForegroundColor Red
    return $false
  }
  if ($now -gt $certificate.NotAfter) {
    Write-Host "[ERROR] HTTPS certificate expired at $($certificate.NotAfter.ToString('yyyy-MM-dd HH:mm:ss zzz'))." -ForegroundColor Red
    Write-Host '[ERROR] Replace the certificate and private key, then run start.cmd again.' -ForegroundColor Red
    return $false
  }

  $remainingDays = [Math]::Floor(($certificate.NotAfter - $now).TotalDays)
  if ($remainingDays -le 30) {
    Write-Host "[WARN] HTTPS certificate expires at $($certificate.NotAfter.ToString('yyyy-MM-dd HH:mm:ss zzz')) ($remainingDays day(s) remaining)." -ForegroundColor Yellow
  } else {
    Write-Host "[OK] HTTPS certificate validity: READY until $($certificate.NotAfter.ToString('yyyy-MM-dd HH:mm:ss zzz'))." -ForegroundColor Green
  }
  return $true
}

function Import-UserEnvironmentFallback {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $processValue = [Environment]::GetEnvironmentVariable(
      $name,
      [EnvironmentVariableTarget]::Process
    )
    if (![string]::IsNullOrWhiteSpace($processValue)) {
      continue
    }

    $userValue = [Environment]::GetEnvironmentVariable(
      $name,
      [EnvironmentVariableTarget]::User
    )
    if (![string]::IsNullOrWhiteSpace($userValue)) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $userValue,
        [EnvironmentVariableTarget]::Process
      )
      continue
    }

    $machineValue = [Environment]::GetEnvironmentVariable(
      $name,
      [EnvironmentVariableTarget]::Machine
    )
    if (![string]::IsNullOrWhiteSpace($machineValue)) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $machineValue,
        [EnvironmentVariableTarget]::Process
      )
    }
  }
}

function Get-DotEnvValue {
  param(
    [string]$FilePath,
    [string]$Name,
    [string]$DefaultValue = ''
  )

  if (!(Test-Path $FilePath)) {
    return $DefaultValue
  }

  $line = Get-Content -LiteralPath $FilePath |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -Last 1

  if (!$line) {
    return $DefaultValue
  }

  $value = ($line -replace "^\s*$([regex]::Escape($Name))\s*=\s*", '').Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Import-DotEnvCredentialFallback {
  param(
    [string]$FilePath,
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $value = Get-DotEnvValue -FilePath $FilePath -Name $name -DefaultValue ''
    if (![string]::IsNullOrWhiteSpace($value)) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $value,
        [EnvironmentVariableTarget]::Process
      )
    }
  }
}

function Get-RequiredNodeMajor {
  param([string]$Root)

  $defaultMajor = 22
  $packagePath = Join-Path $Root 'package.json'
  if (!(Test-Path $packagePath)) {
    return $defaultMajor
  }

  try {
    $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
    $engine = [string]$package.engines.node
    if ($engine -match '>=\s*(\d+)') {
      return [int]$matches[1]
    }
  } catch {
    return $defaultMajor
  }

  return $defaultMajor
}

function Test-NodeVersion {
  param(
    [string]$NodePath,
    [int]$RequiredMajor
  )

  if (!$NodePath -or !(Test-Path $NodePath)) {
    return $false
  }

  try {
    $versionText = & $NodePath -v
    $major = [int]($versionText.TrimStart('v').Split('.')[0])
    return ($major -ge $RequiredMajor)
  } catch {
    return $false
  }
}

function Assert-PathInside {
  param(
    [string]$Path,
    [string]$Parent
  )

  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  if (!$pathFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside runtime directory: $pathFull"
  }
}

function Get-PortableNodeDir {
  param([string]$Root)
  return (Join-Path (Join-Path $Root '.runtime') 'node')
}

function Get-NodeCommand {
  param([string]$Root = '')

  if ($Root) {
    $portableNode = Join-Path (Get-PortableNodeDir -Root $Root) 'node.exe'
    if (Test-Path $portableNode) {
      return $portableNode
    }
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    return $node.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs/node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  return $candidates | Select-Object -First 1
}

function Get-NpmCommand {
  param([string]$Root = '')

  if ($Root) {
    $portableNpm = Join-Path (Get-PortableNodeDir -Root $Root) 'npm.cmd'
    if (Test-Path $portableNpm) {
      return $portableNpm
    }
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs/npm.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs/npm.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/npm.cmd')
  ) | Where-Object { $_ -and (Test-Path $_) }

  return $candidates | Select-Object -First 1
}

function Get-NodeDistArch {
  $archValues = @($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432) -join ';'
  if ($archValues -match 'ARM64') {
    return 'win-arm64'
  }
  if ([Environment]::Is64BitOperatingSystem) {
    return 'win-x64'
  }
  return 'win-x86'
}

function Install-PortableNodeRuntime {
  param(
    [string]$Root,
    [int]$RequiredMajor
  )

  $runtimeRoot = Join-Path $Root '.runtime'
  $runtimeDir = Get-PortableNodeDir -Root $Root
  $downloadDir = Join-Path $runtimeRoot 'downloads'
  $extractDir = Join-Path $runtimeRoot ("extract-" + [guid]::NewGuid().ToString('N'))

  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

  $arch = Get-NodeDistArch
  $zipFileKey = "$arch-zip"
  Write-Host "[INFO] Downloading portable Node.js LTS for $arch..." -ForegroundColor Cyan

  $mirrors = @(
    'https://nodejs.org/dist',
    'https://npmmirror.com/mirrors/node'
  )

  $selectedBaseUrl = ''
  $nodeInfo = $null

  foreach ($baseUrl in $mirrors) {
    try {
      $indexResponse = Invoke-WebRequest -Uri "$baseUrl/index.json" -UseBasicParsing -TimeoutSec 60
      $index = $indexResponse.Content | ConvertFrom-Json
      $nodeInfo = $index |
        Where-Object {
          $_.lts -and
          $_.version -match '^v(\d+)\.' -and
          ([int]$matches[1]) -ge $RequiredMajor -and
          $_.files -contains $zipFileKey
        } |
        Select-Object -First 1

      if (!$nodeInfo) {
        $nodeInfo = $index |
          Where-Object {
            $_.version -match '^v(\d+)\.' -and
            ([int]$matches[1]) -ge $RequiredMajor -and
            $_.files -contains $zipFileKey
          } |
          Select-Object -First 1
      }

      if ($nodeInfo) {
        $selectedBaseUrl = $baseUrl
        break
      }
    } catch {
      Write-Host "[WARN] Node.js index unavailable at $baseUrl. Trying next mirror..." -ForegroundColor Yellow
    }
  }

  if (!$nodeInfo) {
    throw "Cannot find a downloadable Node.js version for $arch with major >= $RequiredMajor."
  }

  $version = $nodeInfo.version
  $zipName = "node-$version-$arch.zip"
  $zipPath = Join-Path $downloadDir $zipName
  $downloadUrl = "$selectedBaseUrl/$version/$zipName"

  if (!(Test-Path $zipPath)) {
    Write-Host "[INFO] Download URL: $downloadUrl"
    try {
      Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
    } catch {
      if ($selectedBaseUrl -eq $mirrors[0]) {
        $downloadUrl = "$($mirrors[1])/$version/$zipName"
        Write-Host "[WARN] Primary download failed. Trying mirror: $downloadUrl" -ForegroundColor Yellow
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
      } else {
        throw
      }
    }
  }

  if (!(Test-Path $zipPath)) {
    throw "Node.js archive was not downloaded: $zipPath"
  }

  if (Test-Path $extractDir) {
    Assert-PathInside -Path $extractDir -Parent $runtimeRoot
    Remove-Item -LiteralPath $extractDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

  $extractedDir = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
  if (!$extractedDir) {
    throw 'Node.js archive extracted no runtime directory.'
  }

  if (Test-Path $runtimeDir) {
    Assert-PathInside -Path $runtimeDir -Parent $runtimeRoot
    Remove-Item -LiteralPath $runtimeDir -Recurse -Force
  }

  Assert-PathInside -Path $extractedDir.FullName -Parent $extractDir
  Move-Item -LiteralPath $extractedDir.FullName -Destination $runtimeDir

  Assert-PathInside -Path $extractDir -Parent $runtimeRoot
  Remove-Item -LiteralPath $extractDir -Recurse -Force

  $nodePath = Join-Path $runtimeDir 'node.exe'
  if (!(Test-NodeVersion -NodePath $nodePath -RequiredMajor $RequiredMajor)) {
    throw "Portable Node.js was downloaded but cannot satisfy Node.js $RequiredMajor+."
  }

  $env:PATH = "$runtimeDir;$env:PATH"
  Write-Host "[OK] Portable Node.js ready: $version" -ForegroundColor Green
  return $nodePath
}

function Ensure-NodeRuntime {
  param(
    [string]$Root,
    [int]$RequiredMajor
  )

  $nodePath = Get-NodeCommand -Root $Root
  if ($nodePath -and (Test-NodeVersion -NodePath $nodePath -RequiredMajor $RequiredMajor)) {
    $nodeDir = Split-Path -Parent $nodePath
    $env:PATH = "$nodeDir;$env:PATH"
    return $nodePath
  }

  if ($nodePath) {
    $versionText = & $nodePath -v
    Write-Host "[WARN] Node.js version is $versionText. Node.js $RequiredMajor+ is required." -ForegroundColor Yellow
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host '[INFO] Installing Node.js LTS with winget...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
      $env:PATH = "$env:ProgramFiles\nodejs;$env:LOCALAPPDATA\Programs\nodejs;$env:PATH"
      $nodePath = Get-NodeCommand -Root $Root
      if ($nodePath -and (Test-NodeVersion -NodePath $nodePath -RequiredMajor $RequiredMajor)) {
        return $nodePath
      }
    } else {
      Write-Host '[WARN] winget Node.js installation failed. Trying portable runtime instead.' -ForegroundColor Yellow
    }
  } else {
    Write-Host '[WARN] winget is unavailable. Trying portable runtime instead.' -ForegroundColor Yellow
  }

  try {
    return (Install-PortableNodeRuntime -Root $Root -RequiredMajor $RequiredMajor)
  } catch {
    Write-Host "[ERROR] Automatic Node.js setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[ERROR] Please install Node.js LTS $RequiredMajor+ manually, then run start.cmd again." -ForegroundColor Red
    exit 1
  }
}

function Get-FileSha256 {
  param([string]$Path)

  if (!(Test-Path $Path)) {
    return ''
  }

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-DependencyStampPath {
  param([string]$Root)
  return (Join-Path $Root '.deps-ready.json')
}

function New-DependencyFingerprint {
  param([string]$Root)

  return [ordered]@{
    packageJson = Get-FileSha256 -Path (Join-Path $Root 'package.json')
    packageLock = Get-FileSha256 -Path (Join-Path $Root 'package-lock.json')
    postinstallScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/postinstall.mjs')
    feishuCardPatchScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/ensure-feishu-card-ws-sdk-patch.mjs')
  }
}

function Write-DependencyStamp {
  param([string]$Root)

  $stampPath = Get-DependencyStampPath -Root $Root
  $stamp = New-DependencyFingerprint -Root $Root
  $stamp.installedAt = (Get-Date).ToString('s')
  $stamp | ConvertTo-Json | Set-Content -LiteralPath $stampPath -Encoding UTF8
}

function Test-DependencyStamp {
  param([string]$Root)

  $stampPath = Get-DependencyStampPath -Root $Root
  if (!(Test-Path $stampPath)) {
    return $false
  }

  try {
    $stamp = Get-Content -Raw -LiteralPath $stampPath | ConvertFrom-Json
    $current = New-DependencyFingerprint -Root $Root
    return (
      $stamp.packageJson -eq $current.packageJson -and
      $stamp.packageLock -eq $current.packageLock -and
      $stamp.postinstallScript -eq $current.postinstallScript -and
      $stamp.feishuCardPatchScript -eq $current.feishuCardPatchScript
    )
  } catch {
    return $false
  }
}

function Test-CriticalServerDependencies {
  param([string]$Root)

  $nodeModules = Join-Path $Root 'node_modules'
  if (!(Test-Path $nodeModules)) {
    return $false
  }

  $criticalDependencies = @(
    '@nestjs/core',
    '@nestjs/common',
    '@nestjs/platform-express',
    '@nestjs/swagger',
    '@nestjs/axios',
    '@lark-apaas/fullstack-nestjs-core',
    '@larksuiteoapi/node-sdk',
    'axios',
    'dotenv',
    'drizzle-orm',
    'hbs',
    'reflect-metadata',
    'rxjs',
    'tslib',
    'xlsx-js-style'
  )

  foreach ($dependency in $criticalDependencies) {
    if ($dependency.StartsWith('@')) {
      $parts = $dependency.Split('/')
      $dependencyPath = Join-Path (Join-Path $nodeModules $parts[0]) $parts[1]
    } else {
      $dependencyPath = Join-Path $nodeModules $dependency
    }

    if (!(Test-Path $dependencyPath)) {
      Write-Host "[INFO] Missing server dependency: $dependency"
      return $false
    }
  }

  return $true
}

function Test-ProductionDependencies {
  param([string]$Root)

  if (!(Test-DependencyStamp -Root $Root)) {
    Write-Host '[INFO] Production dependency declarations changed or have not been installed yet.'
    return $false
  }

  return (Test-CriticalServerDependencies -Root $Root)
}

function Ensure-ProductionDependencies {
  param(
    [string]$Root,
    [string]$NpmPath
  )

  if (Test-ProductionDependencies -Root $Root) {
    Write-Host '[OK] Production dependencies are complete.' -ForegroundColor Green
    return
  }

  $nodeModulesPath = Join-Path $Root 'node_modules'
  if (Test-Path -LiteralPath $nodeModulesPath) {
    $nodeModulesItem = Get-Item -LiteralPath $nodeModulesPath -Force
    if (($nodeModulesItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Write-Host '[ERROR] Refusing to install dependencies through a node_modules reparse point.' -ForegroundColor Red
      Write-Host '[ERROR] Create an isolated physical node_modules directory before startup.' -ForegroundColor Red
      exit 1
    }
  }

  Write-Host '[INFO] Installing production dependencies. This may take a few minutes...'
  $env:NPM_CONFIG_CACHE = Join-Path $Root '.npm-cache'
  & $NpmPath ci --omit=dev
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] Dependency installation failed. Check network/npm configuration.' -ForegroundColor Red
    exit $LASTEXITCODE
  }

  Write-DependencyStamp -Root $Root
  Write-Host '[OK] Production dependencies installed.' -ForegroundColor Green
}

function Assert-FeishuCardCallbackSdkPatch {
  param(
    [string]$Root,
    [string]$NodePath
  )

  $patchPath = Join-Path $Root 'scripts/ensure-feishu-card-ws-sdk-patch.mjs'
  if (!(Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    Write-Host "[ERROR] Feishu card callback SDK patch gate is missing: $patchPath" -ForegroundColor Red
    return $false
  }

  Write-Host '[INFO] Checking Feishu card callback SDK runtime patch...'
  & $NodePath $patchPath $Root
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] Feishu card callback SDK runtime patch is not ready. Startup stopped.' -ForegroundColor Red
    return $false
  }

  Write-Host '[OK] Feishu card callback SDK runtime patch is ready.' -ForegroundColor Green
  return $true
}

function Test-OvertimeWorkflowEnabled {
  param(
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  $configured = $env:OVERTIME_WORKFLOW_PROGRAM_ENABLED
  if ([string]::IsNullOrWhiteSpace($configured)) {
    $configured = 'true'
  }
  $configured = Get-DotEnvValue -FilePath $EnvPath -Name 'OVERTIME_WORKFLOW_PROGRAM_ENABLED' -DefaultValue $configured
  $configured = Get-DotEnvValue -FilePath $EnvLocalPath -Name 'OVERTIME_WORKFLOW_PROGRAM_ENABLED' -DefaultValue $configured

  return @('false', '0', 'off', 'no') -notcontains $configured.Trim().ToLowerInvariant()
}

function Test-ConfiguredWorkflowFlag {
  param(
    [string]$Name,
    [bool]$DefaultEnabled,
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  $configured = [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($configured)) {
    $configured = if ($DefaultEnabled) { 'true' } else { 'false' }
  }
  $configured = Get-DotEnvValue -FilePath $EnvPath -Name $Name -DefaultValue $configured
  $configured = Get-DotEnvValue -FilePath $EnvLocalPath -Name $Name -DefaultValue $configured
  $normalized = $configured.Trim().ToLowerInvariant()

  if ($DefaultEnabled) {
    return @('false', '0', 'off', 'no') -notcontains $normalized
  }
  return @('true', '1', 'on', 'yes') -contains $normalized
}

function Test-ConfiguredValuePresent {
  param(
    [string]$Name,
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  $configured = [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
  $configured = Get-DotEnvValue -FilePath $EnvPath -Name $Name -DefaultValue $configured
  $configured = Get-DotEnvValue -FilePath $EnvLocalPath -Name $Name -DefaultValue $configured
  return ![string]::IsNullOrWhiteSpace($configured)
}

function Test-InventoryOutboundApprovalWorkflowEnabled {
  param(
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  foreach ($name in @(
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID'
  )) {
    if (!(Test-ConfiguredValuePresent -Name $name -EnvPath $EnvPath -EnvLocalPath $EnvLocalPath)) {
      return $false
    }
  }

  return (
    (Test-ConfiguredValuePresent -Name 'FEISHU_WAREHOUSE_APP_TOKEN' -EnvPath $EnvPath -EnvLocalPath $EnvLocalPath) -or
    (Test-ConfiguredValuePresent -Name 'FEISHU_WAREHOUSE_SOURCE_URL' -EnvPath $EnvPath -EnvLocalPath $EnvLocalPath)
  )
}

function Test-CardCallbackWorkflowEnabled {
  param(
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  if (Test-InventoryOutboundApprovalWorkflowEnabled -EnvPath $EnvPath -EnvLocalPath $EnvLocalPath) {
    return $true
  }

  $workflowFlags = @(
    @{ Name = 'OVERTIME_WORKFLOW_PROGRAM_ENABLED'; DefaultEnabled = $true },
    @{ Name = 'LEAVE_WORKFLOW_PROGRAM_ENABLED'; DefaultEnabled = $true },
    @{ Name = 'PURCHASE_WORKFLOW_PROGRAM_ENABLED'; DefaultEnabled = $false },
    @{ Name = 'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED'; DefaultEnabled = $false }
  )
  foreach ($workflowFlag in $workflowFlags) {
    if (Test-ConfiguredWorkflowFlag `
      -Name $workflowFlag.Name `
      -DefaultEnabled $workflowFlag.DefaultEnabled `
      -EnvPath $EnvPath `
      -EnvLocalPath $EnvLocalPath) {
      return $true
    }
  }
  return $false
}

function Test-LeaveWorkflowEnabled {
  param(
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  $configured = Test-ConfiguredWorkflowFlag -Name 'LEAVE_WORKFLOW_PROGRAM_ENABLED' -DefaultEnabled $true -EnvPath $EnvPath -EnvLocalPath $EnvLocalPath
  return $configured
}

function Test-CardCallbackConsumerEnabled {
  param(
    [string]$Root,
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  $configured = [Environment]::GetEnvironmentVariable(
    'FEISHU_CARD_ACTION_CONSUMER_ENABLED',
    [EnvironmentVariableTarget]::Process
  )
  $configured = Get-DotEnvValue `
    -FilePath $EnvPath `
    -Name 'FEISHU_CARD_ACTION_CONSUMER_ENABLED' `
    -DefaultValue $configured
  $configured = Get-DotEnvValue `
    -FilePath $EnvLocalPath `
    -Name 'FEISHU_CARD_ACTION_CONSUMER_ENABLED' `
    -DefaultValue $configured
  if (![string]::IsNullOrWhiteSpace($configured)) {
    return @('true', '1', 'on', 'yes') -contains $configured.Trim().ToLowerInvariant()
  }

  return Test-Path `
    -LiteralPath (Join-Path $Root '.feishu-card-action-consumer-release') `
    -PathType Leaf
}

function Get-NormalizedClientBasePath {
  param(
    [string]$EnvPath,
    [string]$EnvLocalPath
  )

  $configured = [Environment]::GetEnvironmentVariable('CLIENT_BASE_PATH', [EnvironmentVariableTarget]::Process)
  $configured = Get-DotEnvValue -FilePath $EnvPath -Name 'CLIENT_BASE_PATH' -DefaultValue $configured
  $configured = Get-DotEnvValue -FilePath $EnvLocalPath -Name 'CLIENT_BASE_PATH' -DefaultValue $configured
  $normalized = [string]$configured
  $normalized = $normalized.Trim().Trim('/')
  if (!$normalized) {
    return ''
  }
  return "/$normalized"
}

function Assert-OvertimeWorkflowSchema {
  param(
    [string]$Root,
    [string]$NpmPath
  )

  $runnerPath = Join-Path $Root 'scripts/run-with-env.mjs'
  $migrationPath = Join-Path $Root 'scripts/ensure-overtime-workflow-fields.mjs'
  foreach ($requiredPath in @($runnerPath, $migrationPath)) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      Write-Host "[ERROR] Overtime workflow schema gate dependency is missing: $requiredPath" -ForegroundColor Red
      Write-Host '[ERROR] Restore the complete migration package before starting the service.' -ForegroundColor Red
      return $false
    }
  }

  Write-Host '[INFO] Checking overtime workflow fields (read-only)...'
  $fieldCheckResult = Invoke-NativeCommandCaptured `
    -Executable $NpmPath `
    -Arguments @('run', 'migrate:overtime-workflow-fields:check')
  $fieldCheckOutput = @($fieldCheckResult.Output)
  $fieldCheckExitCode = $fieldCheckResult.ExitCode
  $fieldCheckOutput | ForEach-Object { Write-Host $_ }
  if ($fieldCheckExitCode -ne 0) {
    Write-Host '[ERROR] Overtime workflow fields are missing, invalid, or point to the wrong table.' -ForegroundColor Red
    Write-Host '[ERROR] Run: npm run migrate:overtime-workflow-fields' -ForegroundColor Red
    Write-Host '[ERROR] If the fields already exist, verify FEISHU_APP_ID, FEISHU_APP_SECRET, and network access.' -ForegroundColor Red
    return $false
  }

  Write-Host '[OK] Overtime workflow field schema is ready.' -ForegroundColor Green
  return $true
}

function Assert-LeaveWorkflowSchema {
  param(
    [string]$Root,
    [string]$NpmPath
  )

  $runnerPath = Join-Path $Root 'scripts/run-with-env.mjs'
  $fieldMigrationPath = Join-Path $Root 'scripts/ensure-leave-workflow-fields.mjs'
  foreach ($requiredPath in @($runnerPath, $fieldMigrationPath)) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      Write-Host "[ERROR] Leave workflow schema gate dependency is missing: $requiredPath" -ForegroundColor Red
      Write-Host '[ERROR] Restore the complete leave-workflow package before starting the service.' -ForegroundColor Red
      return $false
    }
  }

  $previousIdentity = $env:FEISHU_LEAVE_MIGRATION_IDENTITY
  try {
    $env:FEISHU_LEAVE_MIGRATION_IDENTITY = 'bot'
    Write-Host '[INFO] Checking leave workflow fields (read-only)...'
    $fieldCheckResult = Invoke-NativeCommandCaptured `
      -Executable $NpmPath `
      -Arguments @('run', 'migrate:leave-workflow-fields:check')
    $fieldCheckOutput = @($fieldCheckResult.Output)
    $fieldCheckExitCode = $fieldCheckResult.ExitCode
    $fieldCheckOutput | ForEach-Object { Write-Host $_ }
    if ($fieldCheckExitCode -ne 0) {
      Write-Host '[ERROR] Leave workflow fields are missing, invalid, or point to the wrong table.' -ForegroundColor Red
      Write-Host '[ERROR] Run: npm run migrate:leave-workflow-fields' -ForegroundColor Red
      return $false
    }
  } finally {
    $env:FEISHU_LEAVE_MIGRATION_IDENTITY = $previousIdentity
  }

  Write-Host '[OK] Leave workflow field schema is ready.' -ForegroundColor Green
  return $true
}

function Assert-InventoryOutboundApprovalSchema {
  param(
    [string]$Root,
    [string]$NpmPath
  )

  $runnerPath = Join-Path $Root 'scripts/run-with-env.mjs'
  $migrationPath = Join-Path $Root 'scripts/ensure-inventory-outbound-approval-fields.mjs'
  foreach ($requiredPath in @($runnerPath, $migrationPath)) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      Write-Host "[ERROR] Inventory outbound approval schema gate dependency is missing: $requiredPath" -ForegroundColor Red
      Write-Host '[ERROR] Restore the complete inventory outbound approval package before starting the service.' -ForegroundColor Red
      return $false
    }
  }

  Write-Host '[INFO] Checking inventory outbound approval fields (read-only)...'
  $fieldCheckResult = Invoke-NativeCommandCaptured `
    -Executable $NpmPath `
    -Arguments @('run', 'migrate:inventory-outbound-approval-fields:check')
  $fieldCheckOutput = @($fieldCheckResult.Output)
  $fieldCheckExitCode = $fieldCheckResult.ExitCode
  $fieldCheckOutput | ForEach-Object { Write-Host $_ }
  if ($fieldCheckExitCode -ne 0) {
    Write-Host '[ERROR] Inventory outbound read-only startup check failed; see the detailed cause above.' -ForegroundColor Red
    Write-Host '[ERROR] Do not migrate fields for network or permission failures. Repair schema only when OUTBOUND_PREFLIGHT_SCHEMA is reported.' -ForegroundColor Red
    return $false
  }

  Write-Host '[OK] Inventory outbound approval field schema is ready.' -ForegroundColor Green
  return $true
}

function Get-BrowserCommand {
  $commands = @('msedge.exe', 'chrome.exe')
  foreach ($command in $commands) {
    $found = Get-Command $command -ErrorAction SilentlyContinue
    if ($found) {
      return $found.Source
    }
  }

  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft/Edge/Application/msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google/Chrome/Application/chrome.exe'),
    (Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google/Chrome/Application/chrome.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  return $candidates | Select-Object -First 1
}

function Resolve-ReadinessHost {
  param([string]$ConfiguredHost)

  $normalizedHost = $ConfiguredHost.Trim()
  if ($normalizedHost -eq '0.0.0.0') {
    return '127.0.0.1'
  }
  if (!$normalizedHost) {
    return '127.0.0.1'
  }
  if ($normalizedHost -eq '::') {
    return '[::1]'
  }
  if ($normalizedHost.Contains(':') -and !$normalizedHost.StartsWith('[')) {
    return "[$normalizedHost]"
  }
  return $normalizedHost
}

function Test-AppUrlWithNode {
  param(
    [string]$NodePath,
    [string]$Url
  )

  if (!$NodePath -or !(Test-Path $NodePath)) {
    return $false
  }

  $probeScript = @'
const rawUrl = process.argv[1];
const url = new URL(rawUrl);
const client = url.protocol === 'https:' ? require('https') : require('http');
const request = client.get(url, {
  rejectUnauthorized: false,
  timeout: 2000,
}, (response) => {
  const ok = response.statusCode >= 200 && response.statusCode < 500;
  response.resume();
  response.on('end', () => process.exit(ok ? 0 : 2));
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
'@

  & $NodePath -e $probeScript $Url *> $null
  return ($LASTEXITCODE -eq 0)
}

function Test-HealthyEndpointWithNode {
  param(
    [string]$NodePath,
    [string]$Url
  )

  if (!$NodePath -or !(Test-Path $NodePath)) {
    return $false
  }

  $probeScript = @'
const rawUrl = process.argv[1];
const url = new URL(rawUrl);
const client = url.protocol === 'https:' ? require('https') : require('http');
const request = client.get(url, {
  rejectUnauthorized: false,
  timeout: 2000,
}, (response) => {
  const ok = response.statusCode >= 200 && response.statusCode < 300;
  response.resume();
  response.on('end', () => process.exit(ok ? 0 : 2));
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
'@

  & $NodePath -e $probeScript $Url *> $null
  return ($LASTEXITCODE -eq 0)
}

function Wait-HealthyEndpoint {
  param(
    [string]$Url,
    [string]$NodePath,
    [int]$TimeoutSeconds = 30,
    [System.Diagnostics.Process]$Process = $null
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) {
      return $false
    }
    if (Test-HealthyEndpointWithNode -NodePath $NodePath -Url $Url) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-AppReadinessTimeoutSeconds {
  [int]$configuredTimeout = 0
  if (
    [int]::TryParse([string]$env:APP_STARTUP_TIMEOUT_SECONDS, [ref]$configuredTimeout) -and
    $configuredTimeout -ge 60 -and
    $configuredTimeout -le 1800
  ) {
    return $configuredTimeout
  }
  return 300
}

function Wait-AppReady {
  param(
    [string]$Url,
    [string]$NodePath = '',
    [int]$TimeoutSeconds = 300,
    [System.Diagnostics.Process]$Process = $null
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempt = 0
  $lastError = ''
  $lastProgressAt = Get-Date
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) {
      Write-Host ''
      return $false
    }

    $attempt += 1
    try {
      if (Test-AppUrlWithNode -NodePath $NodePath -Url $Url) {
        Write-Host ''
        return $true
      }

      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Write-Host ''
        return $true
      }
    } catch {
      $lastError = $_.Exception.Message
      if ($Process -and $Process.HasExited) {
        Write-Host ''
        return $false
      }
      if (($attempt % 5) -eq 0) {
        Write-Host '.' -NoNewline
      }
      if ($Process -and ((Get-Date) - $lastProgressAt).TotalSeconds -ge 15) {
        Write-Host ''
        Write-Host '[INFO] App process is still running; runtime modules are loading...'
        $lastProgressAt = Get-Date
      }
      Start-Sleep -Milliseconds 700
    }
  }
  Write-Host ''
  if ($lastError) {
    Write-Host "[WARN] Last readiness error: $lastError" -ForegroundColor Yellow
  }
  return $false
}

function Open-AppBrowser {
  param(
    [string]$Url,
    [string]$Root
  )

  $browser = Get-BrowserCommand
  $browserPidFile = Join-Path $Root 'browser.pid'
  $browserProfile = Join-Path $Root 'browser-profile'
  New-Item -ItemType Directory -Force -Path $browserProfile | Out-Null

  if ($browser) {
    $args = @(
      "--user-data-dir=$browserProfile",
      '--no-first-run',
      '--disable-extensions',
      '--new-window',
      $Url
    )
    $browserProcess = Start-Process -FilePath $browser -ArgumentList $args -PassThru
    Set-Content -LiteralPath $browserPidFile -Value $browserProcess.Id -Encoding ASCII
    Write-Host "[OK] Browser opened. PID: $($browserProcess.Id)" -ForegroundColor Green
  } else {
    Start-Process $Url
    Write-Host '[WARN] Edge/Chrome was not found. Opened URL with default browser; stop.cmd may not close that tab automatically.' -ForegroundColor Yellow
  }
}

function Stop-PidFileProcess {
  param([string]$PidFile)

  if (!(Test-Path $PidFile)) {
    return
  }

  $pidValue = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($pidValue -match '^\d+$') {
    $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      Write-Host "[OK] Stopped previous app PID: $($process.Id)" -ForegroundColor Green
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Stop-ListeningProcessesOnPort {
  param([int]$Port)

  if ($Port -le 0) {
    return
  }

  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (!$process) {
      continue
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Stopped process listening on port $Port`: $($process.ProcessName) PID $($process.Id)" -ForegroundColor Green
  }
}

function Stop-AllScheduleNodeProcesses {
  $currentPid = $PID
  $processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.CommandLine -and
      $_.CommandLine -match 'dist[\\/]+server[\\/]+main(?:\.js)?'
    }

  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Stopped schedule Node process PID $($process.ProcessId)" -ForegroundColor Green
  }
}

function Get-FileSha256 {
  param([string]$Path)
  if (!(Test-Path $Path)) {
    return ''
  }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Test-ServedClientBundle {
  param(
    [string]$Url,
    [string]$Root
  )

  $localMainJs = Join-Path $Root 'dist/client/main.js'
  $localHash = Get-FileSha256 -Path $localMainJs
  if (!$localHash) {
    Write-Host '[WARN] Cannot verify frontend bundle: dist/client/main.js not found.' -ForegroundColor Yellow
    return
  }

  try {
    $cacheBuster = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $remoteUrl = ($Url.TrimEnd('/')) + "/main.js?ts=$cacheBuster"
    $response = Invoke-WebRequest -Uri $remoteUrl -UseBasicParsing -TimeoutSec 5 -Headers @{
      'Cache-Control' = 'no-cache'
      'Pragma' = 'no-cache'
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$response.Content)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $remoteHash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    } finally {
      $sha.Dispose()
    }

    if ($remoteHash -ne $localHash) {
      Write-Host '[ERROR] Running frontend bundle does not match this folder.' -ForegroundColor Red
      Write-Host "[ERROR] Local main.js SHA : $localHash" -ForegroundColor Red
      Write-Host "[ERROR] Served main.js SHA: $remoteHash" -ForegroundColor Red
      Write-Host '[ERROR] Another old process or reverse proxy is still serving port 3001.' -ForegroundColor Red
      return
    }

    Write-Host '[OK] Frontend bundle verified: served main.js matches this folder.' -ForegroundColor Green
  } catch {
    Write-Host "[WARN] Could not verify served frontend bundle: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

$appRoot = Resolve-AppRoot
Set-Location $appRoot

$envFile = Join-Path $appRoot '.env'
$envLocalFile = Join-Path $appRoot '.env.local'
$sharedPrivateEnvFile = Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule.private.env'
$envExample = Join-Path $appRoot '.env.example'
$pidFile = Join-Path $appRoot 'app.pid'
$logDir = Join-Path $appRoot 'logs'
$mainFile = Join-Path $appRoot 'dist/server/main.js'

$changeStorageCredentialNames = @(
  'CONTRACT_ATTACHMENT_ENCRYPTION_KEY'
  'COS_SECRET_ID'
  'COS_SECRET_KEY'
  'COS_SESSION_TOKEN'
  'TENCENTCLOUD_SECRET_ID'
  'TENCENTCLOUD_SECRET_KEY'
  'TENCENTCLOUD_SESSION_TOKEN'
)
Import-UserEnvironmentFallback -Names @(
  'CONTRACT_ATTACHMENT_ENCRYPTION_KEY'
  'COS_SECRET_ID'
  'COS_SECRET_KEY'
  'COS_SESSION_TOKEN'
  'TENCENTCLOUD_SECRET_ID'
  'TENCENTCLOUD_SECRET_KEY'
  'TENCENTCLOUD_SESSION_TOKEN'
)
Import-DotEnvCredentialFallback -FilePath $sharedPrivateEnvFile -Names $changeStorageCredentialNames
Import-DotEnvCredentialFallback -FilePath $envFile -Names $changeStorageCredentialNames
Import-DotEnvCredentialFallback -FilePath $envLocalFile -Names $changeStorageCredentialNames
$defaultChangeStorageIndexPath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'change-attachment-cos-index.json'
$changeStorageIndexPath = $env:COS_CHANGE_INDEX_PATH
if ([string]::IsNullOrWhiteSpace($changeStorageIndexPath)) {
  $changeStorageIndexPath = $defaultChangeStorageIndexPath
}
$changeStorageIndexPath = Get-DotEnvValue -FilePath $sharedPrivateEnvFile -Name 'COS_CHANGE_INDEX_PATH' -DefaultValue $changeStorageIndexPath
$changeStorageIndexPath = Get-DotEnvValue -FilePath $envFile -Name 'COS_CHANGE_INDEX_PATH' -DefaultValue $changeStorageIndexPath
$changeStorageIndexPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'COS_CHANGE_INDEX_PATH' -DefaultValue $changeStorageIndexPath
if ([string]::IsNullOrWhiteSpace($changeStorageIndexPath)) {
  $changeStorageIndexPath = $defaultChangeStorageIndexPath
}
$env:COS_CHANGE_INDEX_PATH = $changeStorageIndexPath
$changeStorageConfigured = (
  (![string]::IsNullOrWhiteSpace($env:COS_SECRET_ID) -or
    ![string]::IsNullOrWhiteSpace($env:TENCENTCLOUD_SECRET_ID)) -and
  (![string]::IsNullOrWhiteSpace($env:COS_SECRET_KEY) -or
    ![string]::IsNullOrWhiteSpace($env:TENCENTCLOUD_SECRET_KEY))
)
if ($changeStorageConfigured) {
  Write-Host '[INFO] Change attachment object storage credentials: READY (values redacted).'
} else {
  Write-Host '[WARN] Change attachment object storage credentials: NOT CONFIGURED.' -ForegroundColor Yellow
  Write-Host '[WARN] Checked current process, Windows User/Machine environment, .env and .env.local; change attachment upload is unavailable.' -ForegroundColor Yellow
  Write-Host "[WARN] One-time private config path: $sharedPrivateEnvFile" -ForegroundColor Yellow
}

if (!(Test-Path $mainFile)) {
  Write-Host '[ERROR] dist/server/main.js not found. Please use the migration package generated after build.' -ForegroundColor Red
  exit 1
}

if (!(Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
  }
  Write-Host '[ERROR] .env is missing. A template has been created. Fill .env and run start.cmd again.' -ForegroundColor Red
  exit 1
}

$requiredNodeMajor = Get-RequiredNodeMajor -Root $appRoot
$nodePath = Ensure-NodeRuntime -Root $appRoot -RequiredMajor $requiredNodeMajor
$contractPreflightScript = Join-Path $appRoot 'scripts/verify-contract-storage-startup.mjs'
if (!(Test-Path -LiteralPath $contractPreflightScript -PathType Leaf)) {
  Write-Host '[ERROR] Contract storage read-only preflight is missing; existing service was not stopped.' -ForegroundColor Red
  exit 1
}
& $nodePath $contractPreflightScript --root $appRoot
if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] Contract storage read-only preflight failed; existing service was not stopped.' -ForegroundColor Red
  exit 1
}
$npmPath = Get-NpmCommand -Root $appRoot
if (!$npmPath) {
  Write-Host '[ERROR] npm was not found. Please reinstall Node.js LTS or delete .runtime and retry start.cmd.' -ForegroundColor Red
  exit 1
}

Ensure-ProductionDependencies -Root $appRoot -NpmPath $npmPath

if (!(Assert-FeishuCardCallbackSdkPatch -Root $appRoot -NodePath $nodePath)) {
  exit 1
}

$overtimeWorkflowEnabled = Test-OvertimeWorkflowEnabled -EnvPath $envFile -EnvLocalPath $envLocalFile
$leaveWorkflowEnabled = Test-LeaveWorkflowEnabled -EnvPath $envFile -EnvLocalPath $envLocalFile
$cardCallbackConsumerEnabled = Test-CardCallbackConsumerEnabled -Root $appRoot -EnvPath $envFile -EnvLocalPath $envLocalFile
$hotfixSmokeMode = @('true', '1', 'on', 'yes') -contains ([string]$env:NANTONG_HOTFIX_SMOKE_MODE).Trim().ToLowerInvariant()
if ($hotfixSmokeMode) {
  $overtimeWorkflowEnabled = $false
  $leaveWorkflowEnabled = $false
  $cardCallbackConsumerEnabled = $false
  foreach ($name in @(
    'ALI_MONTHLY_REPORT_SCHEDULER_ENABLED'
    'ATTENDANCE_AUTOMATION_ENABLED'
    'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_ENABLED'
    'FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED'
    'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED'
    'TODAY_OPERATIONS_ANOMALY_ENABLED'
    'TODAY_OPERATIONS_ANOMALY_SCHEDULER_ENABLED'
    'TYPHOON_WARNING_LOCAL_MONITOR_ENABLED'
  )) {
    [Environment]::SetEnvironmentVariable($name, 'false', [EnvironmentVariableTarget]::Process)
  }
}
$cardCallbackWorkflowEnabled = $cardCallbackConsumerEnabled -and (Test-CardCallbackWorkflowEnabled -EnvPath $envFile -EnvLocalPath $envLocalFile)
$env:FEISHU_CARD_ACTION_CONSUMER_ENABLED = if ($cardCallbackConsumerEnabled) { 'true' } else { 'false' }
$env:LEAVE_WORKFLOW_PROGRAM_ENABLED = if ($leaveWorkflowEnabled) { 'true' } else { 'false' }
$leaveStartupRecoveryCodes = $env:LEAVE_WORKFLOW_STARTUP_RECOVERY_CODES
if ([string]::IsNullOrWhiteSpace($leaveStartupRecoveryCodes)) {
  $leaveStartupRecoveryCodes = ''
}
$leaveStartupRecoveryCodes = Get-DotEnvValue -FilePath $envFile -Name 'LEAVE_WORKFLOW_STARTUP_RECOVERY_CODES' -DefaultValue $leaveStartupRecoveryCodes
$leaveStartupRecoveryCodes = Get-DotEnvValue -FilePath $envLocalFile -Name 'LEAVE_WORKFLOW_STARTUP_RECOVERY_CODES' -DefaultValue $leaveStartupRecoveryCodes
if ($hotfixSmokeMode) {
  $leaveStartupRecoveryCodes = ''
}
$env:LEAVE_WORKFLOW_STARTUP_RECOVERY_CODES = $leaveStartupRecoveryCodes
if ($overtimeWorkflowEnabled -and !(Assert-OvertimeWorkflowSchema -Root $appRoot -NpmPath $npmPath)) {
  exit 1
}
if ($leaveWorkflowEnabled -and !(Assert-LeaveWorkflowSchema -Root $appRoot -NpmPath $npmPath)) {
  exit 1
}
$inventoryOutboundApprovalEnabled = Test-InventoryOutboundApprovalWorkflowEnabled `
  -EnvPath $envFile `
  -EnvLocalPath $envLocalFile
if ($inventoryOutboundApprovalEnabled -and !(Assert-InventoryOutboundApprovalSchema -Root $appRoot -NpmPath $npmPath)) {
  exit 1
}

$databaseUrl = $env:SUDA_DATABASE_URL
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  $databaseUrl = Get-DotEnvValue -FilePath $envFile -Name 'SUDA_DATABASE_URL' -DefaultValue ''
  $databaseUrl = Get-DotEnvValue -FilePath $envLocalFile -Name 'SUDA_DATABASE_URL' -DefaultValue $databaseUrl
}
$env:NODE_ENV = 'production'
if ($databaseUrl.Trim()) {
  $env:FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false'
  Write-Host '[INFO] Database URL found. Starting in production database mode.'
} else {
  $env:FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true'
  Write-Host '[INFO] SUDA_DATABASE_URL is empty. Starting in standalone Feishu/local-cache mode.'
}

$configuredPort = Get-DotEnvValue -FilePath $envFile -Name 'SERVER_PORT' -DefaultValue '3000'
$configuredPort = Get-DotEnvValue -FilePath $envLocalFile -Name 'SERVER_PORT' -DefaultValue $configuredPort
$configuredHost = Get-DotEnvValue -FilePath $envFile -Name 'SERVER_HOST' -DefaultValue 'localhost'
$configuredHost = Get-DotEnvValue -FilePath $envLocalFile -Name 'SERVER_HOST' -DefaultValue $configuredHost
$httpsCertPath = Get-DotEnvValue -FilePath $envFile -Name 'HTTPS_CERT_PATH' -DefaultValue ''
$httpsCertPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'HTTPS_CERT_PATH' -DefaultValue $httpsCertPath
$httpsKeyPath = Get-DotEnvValue -FilePath $envFile -Name 'HTTPS_KEY_PATH' -DefaultValue ''
$httpsKeyPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'HTTPS_KEY_PATH' -DefaultValue $httpsKeyPath
$httpsCaPath = Get-DotEnvValue -FilePath $envFile -Name 'HTTPS_CA_PATH' -DefaultValue ''
$httpsCaPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'HTTPS_CA_PATH' -DefaultValue $httpsCaPath
$publicBaseUrl = Get-DotEnvValue -FilePath $envFile -Name 'PUBLIC_BASE_URL' -DefaultValue ''
$browserOpenUrl = Get-DotEnvValue -FilePath $envFile -Name 'BROWSER_OPEN_URL' -DefaultValue ''
$defaultInventoryOutboundApprovalLedgerPath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'inventory-outbound-approval-ledger.json'
$inventoryOutboundApprovalLedgerPath = $env:INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH
if ([string]::IsNullOrWhiteSpace($inventoryOutboundApprovalLedgerPath)) {
  $inventoryOutboundApprovalLedgerPath = $defaultInventoryOutboundApprovalLedgerPath
}
$inventoryOutboundApprovalLedgerPath = Get-DotEnvValue -FilePath $envFile -Name 'INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH' -DefaultValue $inventoryOutboundApprovalLedgerPath
$inventoryOutboundApprovalLedgerPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH' -DefaultValue $inventoryOutboundApprovalLedgerPath
if (![System.IO.Path]::IsPathRooted($inventoryOutboundApprovalLedgerPath)) {
  $inventoryOutboundApprovalLedgerPath = Join-Path $appRoot $inventoryOutboundApprovalLedgerPath
}
$env:INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH = [System.IO.Path]::GetFullPath($inventoryOutboundApprovalLedgerPath)

$defaultOvertimeWorkflowLedgerPath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'overtime-workflow-ledger.json'
$overtimeWorkflowLedgerPath = $env:OVERTIME_WORKFLOW_LEDGER_PATH
if ([string]::IsNullOrWhiteSpace($overtimeWorkflowLedgerPath)) {
  $overtimeWorkflowLedgerPath = $defaultOvertimeWorkflowLedgerPath
}
$overtimeWorkflowLedgerPath = Get-DotEnvValue -FilePath $envFile -Name 'OVERTIME_WORKFLOW_LEDGER_PATH' -DefaultValue $overtimeWorkflowLedgerPath
$overtimeWorkflowLedgerPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'OVERTIME_WORKFLOW_LEDGER_PATH' -DefaultValue $overtimeWorkflowLedgerPath
if (![System.IO.Path]::IsPathRooted($overtimeWorkflowLedgerPath)) {
  $overtimeWorkflowLedgerPath = Join-Path $appRoot $overtimeWorkflowLedgerPath
}
$env:OVERTIME_WORKFLOW_LEDGER_PATH = [System.IO.Path]::GetFullPath($overtimeWorkflowLedgerPath)

$defaultLeaveWorkflowLedgerPath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'leave-workflow-ledger.json'
$leaveWorkflowLedgerPath = $env:LEAVE_WORKFLOW_LEDGER_PATH
if ([string]::IsNullOrWhiteSpace($leaveWorkflowLedgerPath)) {
  $leaveWorkflowLedgerPath = $defaultLeaveWorkflowLedgerPath
}
$leaveWorkflowLedgerPath = Get-DotEnvValue -FilePath $envFile -Name 'LEAVE_WORKFLOW_LEDGER_PATH' -DefaultValue $leaveWorkflowLedgerPath
$leaveWorkflowLedgerPath = Get-DotEnvValue -FilePath $envLocalFile -Name 'LEAVE_WORKFLOW_LEDGER_PATH' -DefaultValue $leaveWorkflowLedgerPath
if (![System.IO.Path]::IsPathRooted($leaveWorkflowLedgerPath)) {
  $leaveWorkflowLedgerPath = Join-Path $appRoot $leaveWorkflowLedgerPath
}
$env:LEAVE_WORKFLOW_LEDGER_PATH = [System.IO.Path]::GetFullPath($leaveWorkflowLedgerPath)
Copy-LegacyStateFileIfMissing `
  -LegacyPath (Join-Path $appRoot 'data/leave-workflow/ledger.json') `
  -DestinationPath $env:LEAVE_WORKFLOW_LEDGER_PATH

$defaultWeatherWarningAutomationStatePath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'weather-warning-automation-state.json'
$weatherWarningAutomationStatePath = $env:FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH
$weatherWarningAutomationStatePath = Get-DotEnvValue -FilePath $envFile -Name 'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH' -DefaultValue $weatherWarningAutomationStatePath
$weatherWarningAutomationStatePath = Get-DotEnvValue -FilePath $envLocalFile -Name 'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH' -DefaultValue $weatherWarningAutomationStatePath
if ([string]::IsNullOrWhiteSpace($weatherWarningAutomationStatePath)) {
  $weatherWarningAutomationStateDirectory = $env:FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR
  $weatherWarningAutomationStateDirectory = Get-DotEnvValue -FilePath $envFile -Name 'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR' -DefaultValue $weatherWarningAutomationStateDirectory
  $weatherWarningAutomationStateDirectory = Get-DotEnvValue -FilePath $envLocalFile -Name 'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR' -DefaultValue $weatherWarningAutomationStateDirectory
  if ([string]::IsNullOrWhiteSpace($weatherWarningAutomationStateDirectory)) {
    $weatherWarningAutomationStatePath = $defaultWeatherWarningAutomationStatePath
  } else {
    if (![System.IO.Path]::IsPathRooted($weatherWarningAutomationStateDirectory)) {
      $weatherWarningAutomationStateDirectory = Join-Path $appRoot $weatherWarningAutomationStateDirectory
    }
    $weatherWarningAutomationStatePath = Join-Path $weatherWarningAutomationStateDirectory 'weather-warning-automation-state.json'
  }
}
if (![System.IO.Path]::IsPathRooted($weatherWarningAutomationStatePath)) {
  $weatherWarningAutomationStatePath = Join-Path $appRoot $weatherWarningAutomationStatePath
}
$env:FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH = [System.IO.Path]::GetFullPath($weatherWarningAutomationStatePath)
Copy-LegacyStateFileIfMissing `
  -LegacyPath (Join-Path $appRoot 'data/weather-warning-automation-state.json') `
  -DestinationPath $env:FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH

if ($Port -gt 0) {
  $configuredPort = [string]$Port
}
if ($HostName.Trim()) {
  $configuredHost = $HostName.Trim()
}
if (!(Test-HttpsCertificateReady -Root $appRoot -CertificatePath $httpsCertPath -PrivateKeyPath $httpsKeyPath)) {
  exit 1
}
$env:SERVER_PORT = $configuredPort
$env:SERVER_HOST = $configuredHost
$env:HTTPS_CERT_PATH = $httpsCertPath
$env:HTTPS_KEY_PATH = $httpsKeyPath
$env:HTTPS_CA_PATH = $httpsCaPath

$scheme = if ($httpsCertPath.Trim() -and $httpsKeyPath.Trim()) { 'https' } else { 'http' }
if ($scheme -eq 'https') {
  $allowSelfSigned = Get-DotEnvValue -FilePath $envFile -Name 'HTTPS_ALLOW_SELF_SIGNED' -DefaultValue 'true'
  $allowSelfSigned = Get-DotEnvValue -FilePath $envLocalFile -Name 'HTTPS_ALLOW_SELF_SIGNED' -DefaultValue $allowSelfSigned
  if ($allowSelfSigned.Trim().ToLowerInvariant() -ne 'false') {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  }
}

$hostForUrl = Resolve-ReadinessHost -ConfiguredHost $configuredHost
$clientBasePath = Get-NormalizedClientBasePath -EnvPath $envFile -EnvLocalPath $envLocalFile
$appUrl = "${scheme}://${hostForUrl}:$configuredPort/"
$readinessUrl = "${scheme}://${hostForUrl}:$configuredPort${clientBasePath}/api/access/session"
$cardCallbackHealthUrl = "${scheme}://${hostForUrl}:$configuredPort${clientBasePath}/api/feishu-card-callback/health"
$displayUrl = if ($publicBaseUrl.Trim()) { $publicBaseUrl.TrimEnd('/') + '/' } else { $appUrl }
$openUrl = if ($browserOpenUrl.Trim()) { $browserOpenUrl.TrimEnd('/') + '/' } else { $appUrl }

Stop-PidFileProcess -PidFile $pidFile
Stop-AllScheduleNodeProcesses
Stop-ListeningProcessesOnPort -Port ([int]$configuredPort)

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stdout = Join-Path $logDir 'app.out.log'
$stderr = Join-Path $logDir 'app.err.log'
$stdin = Join-Path $logDir 'app.stdin'
[System.IO.File]::WriteAllText($stdin, '', $utf8NoBom)
Write-Host "[INFO] Starting app on $appUrl ..."
if ($displayUrl -ne $appUrl) {
  Write-Host "[INFO] Public URL: $displayUrl"
}
if ($openUrl -ne $appUrl) {
  Write-Host "[INFO] Browser URL: $openUrl"
}
$process = Start-Process `
  -FilePath $nodePath `
  -ArgumentList @('dist/server/main.js') `
    -WorkingDirectory $appRoot `
    -RedirectStandardInput $stdin `
    -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII

Start-Sleep -Seconds 2
if ($process.HasExited) {
  Write-Host '[ERROR] App exited immediately. Last error log:' -ForegroundColor Red
  if (Test-Path $stderr) {
    Get-Content -LiteralPath $stderr -Tail 60
  }
  exit 1
}

$appReadinessTimeoutSeconds = Get-AppReadinessTimeoutSeconds
Write-Host "[INFO] Startup readiness timeout: $appReadinessTimeoutSeconds seconds."
if (!(Wait-AppReady -Url $readinessUrl -NodePath $nodePath -TimeoutSeconds $appReadinessTimeoutSeconds -Process $process)) {
  Write-Host "[ERROR] App process started, but $readinessUrl is still not ready after $appReadinessTimeoutSeconds seconds." -ForegroundColor Red
  if ($process.HasExited) {
    Write-Host "[ERROR] App process has exited. Exit code: $($process.ExitCode)" -ForegroundColor Red
  }
  Write-Host "[ERROR] Check logs: $logDir" -ForegroundColor Red
  if (Test-Path $stderr) {
    Write-Host '[ERROR] Last error log:' -ForegroundColor Red
    Get-Content -LiteralPath $stderr -Tail 80
  }
  exit 1
} else {
  if ($cardCallbackWorkflowEnabled) {
    if (!(Wait-HealthyEndpoint -Url $cardCallbackHealthUrl -NodePath $nodePath -Process $process)) {
      Write-Host "[ERROR] Feishu shared card callback is not online: $cardCallbackHealthUrl" -ForegroundColor Red
      Write-Host "[ERROR] Check logs: $logDir" -ForegroundColor Red
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      exit 1
    }
    Write-Host "[OK] Feishu shared card callback is online: $cardCallbackHealthUrl" -ForegroundColor Green
  }
  Write-Host "[OK] App started. PID: $($process.Id)" -ForegroundColor Green
}

Open-AppBrowser -Url $openUrl -Root $appRoot
Test-ServedClientBundle -Url $appUrl -Root $appRoot
Write-Host "[OK] URL: $displayUrl"
Write-Host "[OK] Local URL: $openUrl"
Write-Host "[OK] Logs: $logDir"
