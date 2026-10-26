param(
  [ValidateSet('env', 'user')]
  [string]$Target = 'env',
  [string]$EnvFile = (Join-Path $PSScriptRoot '..\.env')
)

$ErrorActionPreference = 'Stop'
$fields = [ordered]@{
  LOCAL_ADMIN_PASSWORD_HASH = '系统管理员'
  LOCAL_EDITOR_PASSWORD_HASH = '子管理员'
  LOCAL_PURCHASE_ADMIN_PASSWORD_HASH = '采购与合同管理员'
  LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH = '施工管理员'
  LOCAL_INVENTORY_ADMIN_A_PASSWORD_HASH = 'A楼库存管理员'
  LOCAL_INVENTORY_ADMIN_B_PASSWORD_HASH = 'B楼库存管理员'
  LOCAL_INVENTORY_ADMIN_C_PASSWORD_HASH = 'C楼库存管理员'
  LOCAL_INVENTORY_ADMIN_D_PASSWORD_HASH = 'D楼库存管理员'
  LOCAL_INVENTORY_ADMIN_E_PASSWORD_HASH = 'E楼库存管理员'
  LOCAL_INVENTORY_ADMIN_H_PASSWORD_HASH = 'H楼库存管理员'
  LOCAL_PURCHASE_APPLICANT_A_PASSWORD_HASH = 'A楼采购申请人'
  LOCAL_PURCHASE_APPLICANT_B_PASSWORD_HASH = 'B楼采购申请人'
  LOCAL_PURCHASE_APPLICANT_C_PASSWORD_HASH = 'C楼采购申请人'
  LOCAL_PURCHASE_APPLICANT_D_PASSWORD_HASH = 'D楼采购申请人'
  LOCAL_PURCHASE_APPLICANT_E_PASSWORD_HASH = 'E楼采购申请人'
  LOCAL_PURCHASE_APPLICANT_H_PASSWORD_HASH = 'H楼采购申请人'
  LOCAL_BUILDING_ADMIN_A_PASSWORD_HASH = 'A楼楼栋管理员'
  LOCAL_BUILDING_ADMIN_B_PASSWORD_HASH = 'B楼楼栋管理员'
  LOCAL_BUILDING_ADMIN_C_PASSWORD_HASH = 'C楼楼栋管理员'
  LOCAL_BUILDING_ADMIN_D_PASSWORD_HASH = 'D楼楼栋管理员'
  LOCAL_BUILDING_ADMIN_E_PASSWORD_HASH = 'E楼楼栋管理员'
  LOCAL_BUILDING_ADMIN_110_PASSWORD_HASH = '110站楼栋管理员'
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

$appRoot = Split-Path -Parent $PSScriptRoot
$nodeCandidates = New-Object System.Collections.Generic.List[string]
$nodeCandidates.Add((Join-Path $appRoot '.runtime\node\node.exe'))
$pathNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($pathNode) { $nodeCandidates.Add($pathNode.Source) }
foreach ($directory in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if ($directory) { $nodeCandidates.Add((Join-Path $directory 'nodejs\node.exe')) }
}
if ($env:LOCALAPPDATA) {
  $nodeCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
}
$node = $null
foreach ($candidate in $nodeCandidates) {
  if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  try {
    $version = & $candidate --version
    if ($version -match '^v([0-9]+)\.' -and [int]$Matches[1] -ge 24) {
      $node = $candidate
      break
    }
  } catch {
    continue
  }
}
if (!$node) { throw 'Node.js 24 or newer is required before passwords can be reset. Existing configuration was preserved.' }

$passwords = @{}
try {
  $entries = @($fields.GetEnumerator())
  Write-Host '0. 重置全部角色密码'
  for ($index = 0; $index -lt $entries.Count; $index++) {
    Write-Host "$($index + 1). $($entries[$index].Value)"
  }
  $importOption = $entries.Count + 1
  Write-Host "$importOption. 从同目录 p.txt 导入并重置全部角色密码"
  $selection = Read-Host '输入要重置的角色编号'
  if ($selection -notmatch '^(0|[1-9][0-9]*)$' -or [int]$selection -gt $importOption) {
    throw '角色编号无效，未写入任何配置。'
  }
  if ([int]$selection -eq $importOption) {
    $passwordFile = Join-Path $PSScriptRoot 'p.txt'
    if (!(Test-Path -LiteralPath $passwordFile -PathType Leaf)) {
      Write-Host '未找到与脚本同目录的 p.txt，未修改任何配置。'
      exit 1
    }
    & $node (Join-Path $PSScriptRoot 'reset-all-access-passwords.mjs') "--target=$Target" "--env-file=$EnvFile" "--password-file=$passwordFile"
    if ($LASTEXITCODE -ne 0) {
      Write-Host '密码导入失败，请查看上方错误；如提示回滚未完成，请勿重启应用。'
      exit 1
    }
    Write-Host '密码导入成功。p.txt 含明文密码，请在确认后安全移走或删除。'
    return
  }
  $selectedEntries = if ([int]$selection -eq 0) { $entries } else { @($entries[[int]$selection - 1]) }
  Write-Host '密码为 6–256 个字符，可使用纯数字。输入内容不会显示。'
  foreach ($entry in $selectedEntries) {
    $secure = Read-Host "设置 $($entry.Value) 的密码" -AsSecureString
    $plain = ConvertTo-PlainText $secure
    if ($plain.Length -lt 6 -or $plain.Length -gt 256) {
      throw "$($entry.Value) 的密码长度必须为 6–256 个字符。未写入任何配置。"
    }
    if ($passwords.Values -ccontains $plain) {
      throw "$($entry.Value) 的密码与前面角色重复。未写入任何配置。"
    }
    $passwords[$entry.Key] = $plain
    $secure = $null
    $plain = $null
  }
  foreach ($entry in $passwords.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable("RESET_$($entry.Key)", $entry.Value, 'Process')
  }
  $role = if ([int]$selection -eq 0) { 'all' } else { $selectedEntries[0].Key }
  & $node (Join-Path $PSScriptRoot 'reset-all-access-passwords.mjs') "--target=$Target" "--env-file=$EnvFile" "--role=$role"
  if ($LASTEXITCODE -ne 0) { throw '密码重置失败，请查看上方错误；如提示回滚未完成，请勿重启应用。' }
} finally {
  foreach ($name in $fields.Keys) {
    Remove-Item "Env:RESET_$name" -ErrorAction SilentlyContinue
  }
  $passwords.Clear()
}
