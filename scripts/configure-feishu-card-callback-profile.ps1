param(
  [ValidateSet('production', 'disabled', 'local-test')]
  [string]$Mode,
  [string]$AppRoot = '',
  [switch]$NonInteractive,
  [switch]$SkipRuntimeControl
)

$ErrorActionPreference = 'Stop'
$script:ManagedTaskName = 'NantongScheduleInventoryWorkflows'

function Resolve-AppRoot {
  param([string]$RequestedRoot)

  $candidates = [Collections.Generic.List[string]]::new()
  if (![string]::IsNullOrWhiteSpace($RequestedRoot)) {
    $candidates.Add($RequestedRoot)
  } else {
    $candidates.Add($PSScriptRoot)
    $candidates.Add((Split-Path -Parent $PSScriptRoot))
    $candidates.Add((Get-Location).Path)
  }

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate) -or !(Test-Path -LiteralPath $candidate -PathType Container)) {
      continue
    }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    $hasPackage = Test-Path -LiteralPath (Join-Path $resolved 'package.json') -PathType Leaf
    $hasRuntime = Test-Path -LiteralPath (Join-Path $resolved 'dist/server/main.js') -PathType Leaf
    $hasWatchdog = (
      (Test-Path -LiteralPath (Join-Path $resolved 'watchdog.ps1') -PathType Leaf) -or
      (Test-Path -LiteralPath (Join-Path $resolved 'deploy/watchdog.ps1') -PathType Leaf)
    )
    if ($hasPackage -or $hasRuntime -or $hasWatchdog) {
      return [IO.Path]::GetFullPath($resolved).TrimEnd('\')
    }
  }

  throw '未找到南通排班应用根目录。请把工具放到应用根目录，或将应用根目录作为第一个参数传给 CMD。'
}

function Read-DotEnvMap {
  param([string[]]$Paths)

  $values = @{}
  foreach ($path in $Paths) {
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
      continue
    }
    foreach ($line in [IO.File]::ReadAllLines($path)) {
      $match = [regex]::Match($line, '^\s*(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$')
      if (!$match.Success) {
        continue
      }
      $value = $match.Groups['value'].Value.Trim()
      if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last = $value.Substring($value.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
          $value = $value.Substring(1, $value.Length - 2)
        }
      }
      $values[$match.Groups['name'].Value] = $value
    }
  }
  return $values
}

function Get-EffectiveValue {
  param(
    [string]$Name,
    [Collections.IDictionary]$FileValues
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (![string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }
  if ($FileValues.Contains($Name) -and ![string]::IsNullOrWhiteSpace([string]$FileValues[$Name])) {
    return ([string]$FileValues[$Name]).Trim()
  }
  return ''
}

function ConvertTo-PlainText {
  param([Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Format-DotEnvValue {
  param([string]$Value)

  if ($null -eq $Value -or $Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains([char]0)) {
    throw '环境变量值包含不允许的换行或空字符。'
  }
  if ($Value -match '^[A-Za-z0-9._:/+=-]+$') {
    return $Value
  }
  $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
  return '"' + $escaped + '"'
}

function Test-ByteArraysEqual {
  param(
    [byte[]]$Left,
    [byte[]]$Right
  )

  if ($Left.Length -ne $Right.Length) {
    return $false
  }
  for ($index = 0; $index -lt $Left.Length; $index += 1) {
    if ($Left[$index] -ne $Right[$index]) {
      return $false
    }
  }
  return $true
}

function Update-DotEnvFileAtomically {
  param(
    [string]$Path,
    [Collections.IDictionary]$Updates
  )

  $exists = Test-Path -LiteralPath $Path -PathType Leaf
  $bytes = if ($exists) { [IO.File]::ReadAllBytes($Path) } else { [byte[]]@() }
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $offset = if ($hasBom) { 3 } else { 0 }
  $text = if ($bytes.Length -gt $offset) {
    [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset)
  } else {
    ''
  }
  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $hadTrailingNewline = $text.EndsWith("`r`n") -or $text.EndsWith("`n") -or $text.EndsWith("`r")
  $sourceLines = if ($text.Length -eq 0) { @() } else { [regex]::Split($text, '\r\n|\n|\r') }
  if ($hadTrailingNewline -and $sourceLines.Count -gt 0 -and $sourceLines[$sourceLines.Count - 1] -eq '') {
    $sourceLines = if ($sourceLines.Count -eq 1) { @() } else { @($sourceLines[0..($sourceLines.Count - 2)]) }
  }

  $nextLines = [Collections.Generic.List[string]]::new()
  $written = @{}
  foreach ($line in $sourceLines) {
    $match = [regex]::Match($line, '^\s*(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=')
    $name = if ($match.Success) { $match.Groups['name'].Value } else { '' }
    if ($name -and $Updates.Contains($name)) {
      if (!$written.Contains($name)) {
        $nextLines.Add($name + '=' + (Format-DotEnvValue -Value ([string]$Updates[$name])))
        $written[$name] = $true
      }
      continue
    }
    $nextLines.Add($line)
  }

  foreach ($name in $Updates.Keys) {
    if (!$written.Contains([string]$name)) {
      $nextLines.Add(([string]$name) + '=' + (Format-DotEnvValue -Value ([string]$Updates[$name])))
    }
  }

  $nextText = [string]::Join($newline, $nextLines)
  if ($hadTrailingNewline -or !$exists) {
    $nextText += $newline
  }
  $encoding = [Text.UTF8Encoding]::new($hasBom)
  $nextBytes = $encoding.GetBytes($nextText)
  if ($hasBom) {
    $nextBytes = $encoding.GetPreamble() + $nextBytes
  }
  if ($exists -and (Test-ByteArraysEqual -Left $bytes -Right $nextBytes)) {
    return $false
  }

  $directory = Split-Path -Parent $Path
  if (!(Test-Path -LiteralPath $directory -PathType Container)) {
    throw '目标环境文件目录不存在。'
  }
  $temporaryPath = Join-Path $directory ('.env.local.' + [guid]::NewGuid().ToString('N') + '.tmp')
  $backupPath = Join-Path $directory ('.env.local.' + [guid]::NewGuid().ToString('N') + '.backup')
  try {
    [IO.File]::WriteAllBytes($temporaryPath, $nextBytes)
    if ($exists) {
      [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
    } else {
      [IO.File]::Move($temporaryPath, $Path)
    }
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
  return $true
}

function Get-WatchdogCandidates {
  param([string]$Root)

  return @(
    [IO.Path]::GetFullPath((Join-Path $Root 'watchdog.ps1')),
    [IO.Path]::GetFullPath((Join-Path $Root 'deploy/watchdog.ps1'))
  )
}

function Get-FileArgument {
  param([string]$Arguments)

  if ([string]::IsNullOrWhiteSpace($Arguments)) {
    return ''
  }
  $match = [regex]::Match(
    $Arguments,
    '(?i)(?:^|\s)-File\s+(?:"(?<double>[^"]+)"|''(?<single>[^'']+)''|(?<bare>\S+))'
  )
  if (!$match.Success) {
    return ''
  }
  foreach ($name in @('double', 'single', 'bare')) {
    if ($match.Groups[$name].Success) {
      return [Environment]::ExpandEnvironmentVariables($match.Groups[$name].Value)
    }
  }
  return ''
}

function Test-IsManagedWatchdogPath {
  param(
    [string]$Path,
    [string[]]$Candidates
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }
  try {
    $resolved = [IO.Path]::GetFullPath($Path)
  } catch {
    return $false
  }
  foreach ($candidate in $Candidates) {
    if ([string]::Equals($resolved, $candidate, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Disable-ScopedWatchdog {
  param([string]$Root)

  $candidates = Get-WatchdogCandidates -Root $Root
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $task = Get-ScheduledTask -TaskName $script:ManagedTaskName -ErrorAction SilentlyContinue
    if ($task) {
      $matchesRoot = $false
      foreach ($action in @($task.Actions)) {
        $fileArgument = Get-FileArgument -Arguments ([string]$action.Arguments)
        if (Test-IsManagedWatchdogPath -Path $fileArgument -Candidates $candidates) {
          $matchesRoot = $true
          break
        }
      }
      if ($matchesRoot) {
        Stop-ScheduledTask -TaskName $script:ManagedTaskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $script:ManagedTaskName -ErrorAction Stop | Out-Null
        Write-Host '[OK] 本项目自动启动任务已停止并禁用。'
      } else {
        Write-Host '[WARN] 同名自动启动任务不属于当前应用目录，已保留。' -ForegroundColor Yellow
      }
    }
  }

  $currentPid = $PID
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.Name -in @('powershell.exe', 'pwsh.exe') -and
      $_.CommandLine
    }
  foreach ($process in $processes) {
    $fileArgument = Get-FileArgument -Arguments ([string]$process.CommandLine)
    if (Test-IsManagedWatchdogPath -Path $fileArgument -Candidates $candidates) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host "[OK] 本项目 watchdog 已停止：PID $($process.ProcessId)"
    }
  }

  $stopScript = @(
    (Join-Path $Root 'deploy/stop.ps1'),
    (Join-Path $Root 'stop.ps1')
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($stopScript) {
    & $stopScript
  } else {
    $mainFile = [IO.Path]::GetFullPath((Join-Path $Root 'dist/server/main.js'))
    $nodeProcesses = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $currentPid -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($mainFile, [StringComparison]::OrdinalIgnoreCase) -ge 0
      }
    foreach ($process in $nodeProcesses) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host "[OK] 本项目 Node 服务已停止：PID $($process.ProcessId)"
    }
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($Mode)) {
    if ($NonInteractive) {
      throw '非交互运行必须指定模式：production、disabled 或 local-test。'
    }
    Write-Host '============================================================'
    Write-Host '  飞书卡片回调一键配置'
    Write-Host '============================================================'
    Write-Host '  1. 生产服务器：由生产应用消费回调'
    Write-Host '  2. 本地普通开发：关闭卡片长连接'
    Write-Host '  3. 本地卡片联调：仅连接独立测试应用'
    Write-Host '  Q. 退出'
    Write-Host ''
    $selection = (Read-Host '请选择 [1/2/3/Q]').Trim().ToUpperInvariant()
    switch ($selection) {
      '1' { $Mode = 'production' }
      '2' { $Mode = 'disabled' }
      '3' { $Mode = 'local-test' }
      'Q' { exit 0 }
      default { throw '无效选择，请重新运行并选择 1、2、3 或 Q。' }
    }
  }

  $resolvedRoot = Resolve-AppRoot -RequestedRoot $AppRoot
  $envPath = Join-Path $resolvedRoot '.env'
  $envLocalPath = Join-Path $resolvedRoot '.env.local'
  $fileValues = Read-DotEnvMap -Paths @($envPath, $envLocalPath)
  $productionAppId = Get-EffectiveValue -Name 'FEISHU_APP_ID' -FileValues $fileValues
  $productionAppSecret = Get-EffectiveValue -Name 'FEISHU_APP_SECRET' -FileValues $fileValues
  $updates = [ordered]@{}

  if ($Mode -eq 'production') {
    if ([string]::IsNullOrWhiteSpace($productionAppId) -or [string]::IsNullOrWhiteSpace($productionAppSecret)) {
      throw '生产模式要求 FEISHU_APP_ID 和 FEISHU_APP_SECRET 已存在；本工具不会询问、复制或显示生产密钥。'
    }
    $updates['FEISHU_CARD_ACTION_CONSUMER_PROFILE'] = 'production'
    $updates['FEISHU_CARD_ACTION_CONSUMER_ENABLED'] = 'true'
  } elseif ($Mode -eq 'disabled') {
    $updates['FEISHU_CARD_ACTION_CONSUMER_PROFILE'] = 'disabled'
    $updates['FEISHU_CARD_ACTION_CONSUMER_ENABLED'] = 'false'
  } else {
    if ([string]::IsNullOrWhiteSpace($productionAppId)) {
      throw '本地联调前必须能读取生产 FEISHU_APP_ID，用于阻止误填生产应用。'
    }
    $testAppId = Get-EffectiveValue -Name 'FEISHU_CARD_ACTION_TEST_APP_ID' -FileValues $fileValues
    $testAppSecret = Get-EffectiveValue -Name 'FEISHU_CARD_ACTION_TEST_APP_SECRET' -FileValues $fileValues
    if (!$NonInteractive -and [string]::IsNullOrWhiteSpace($testAppId)) {
      $testAppId = (Read-Host '请输入独立测试飞书应用 App ID').Trim()
    }
    if (!$NonInteractive -and [string]::IsNullOrWhiteSpace($testAppSecret)) {
      $secureSecret = Read-Host '请输入独立测试飞书应用 App Secret（输入不可见）' -AsSecureString
      try {
        $testAppSecret = ConvertTo-PlainText -SecureValue $secureSecret
      } finally {
        $secureSecret = $null
      }
    }
    if ([string]::IsNullOrWhiteSpace($testAppId) -or [string]::IsNullOrWhiteSpace($testAppSecret)) {
      throw 'local-test 模式缺少独立测试应用 App ID 或 App Secret，未修改任何文件。'
    }
    if ([string]::Equals($testAppId.Trim(), $productionAppId.Trim(), [StringComparison]::OrdinalIgnoreCase)) {
      throw '测试 App ID 与生产 App ID 相同，已拒绝配置且不会回退到生产应用。'
    }
    $updates['FEISHU_CARD_ACTION_CONSUMER_PROFILE'] = 'local-test'
    $updates['FEISHU_CARD_ACTION_CONSUMER_ENABLED'] = 'false'
    $updates['FEISHU_CARD_ACTION_TEST_APP_ID'] = $testAppId.Trim()
    $updates['FEISHU_CARD_ACTION_TEST_APP_SECRET'] = $testAppSecret.Trim()
  }

  if (!$SkipRuntimeControl -and $Mode -in @('disabled', 'local-test')) {
    Disable-ScopedWatchdog -Root $resolvedRoot
  }

  $changed = Update-DotEnvFileAtomically -Path $envLocalPath -Updates $updates
  $changeText = if ($changed) { '已原子更新' } else { '无需变更' }
  Write-Host "[OK] 飞书卡片回调模式：$Mode"
  Write-Host "[OK] .env.local：$changeText"
  if ($Mode -eq 'production') {
    Write-Host '[INFO] 未自动重启生产服务；请按既有发布流程安装热包或重启。'
  } elseif ($Mode -eq 'local-test') {
    Write-Host '[INFO] 本地仅会连接独立测试应用；请手动运行 npm run dev:server 开始联调。'
  } else {
    Write-Host '[INFO] 本地卡片长连接已关闭。'
  }
  exit 0
} catch {
  [Console]::Error.WriteLine('[ERROR] ' + $_.Exception.Message)
  exit 1
}
