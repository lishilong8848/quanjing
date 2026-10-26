param([string]$AppRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if (!(Test-Path -LiteralPath (Join-Path $AppRoot '.env') -PathType Leaf)) {
  $AppRoot = Read-Host '请输入系统安装目录（包含 .env 的目录）'
}
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
if (!(Test-Path -LiteralPath (Join-Path $AppRoot '.env') -PathType Leaf)) { throw '未找到系统配置文件，未修改密码。' }
$candidates = @((Join-Path $AppRoot '.runtime\node\node.exe'))
$pathNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($pathNode) { $candidates += $pathNode.Source }
foreach ($folder in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($folder) { $candidates += (Join-Path $folder 'nodejs\node.exe'); $candidates += (Join-Path $folder 'Programs\nodejs\node.exe') }
}
$node = $null
foreach ($candidate in $candidates) {
  if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $version = & $candidate --version
  if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { $node = $candidate; break }
}
if (!$node) { throw '需要 Node.js 24 或以上版本，未修改密码。' }
function Read-PlainSecret([Security.SecureString]$value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$first = $null; $second = $null; $plain = $null; $confirmation = $null
try {
  Write-Host '设置基地备用账号密码（不修改其他账号，不自动重启服务）'
  $first = Read-Host '输入新密码（8至256字符）' -AsSecureString
  $second = Read-Host '再次输入新密码' -AsSecureString
  $plain = Read-PlainSecret $first; $confirmation = Read-PlainSecret $second
  if ($plain -cne $confirmation) { throw '两次密码不一致，未修改密码。' }
  $env:SITE_MEMBER_BACKUP_NEW_PASSWORD = $plain
  & $node (Join-Path $PSScriptRoot 'set-site-member-backup-password.mjs') $AppRoot
  if ($LASTEXITCODE -ne 0) { throw '密码设置未成功，请查看上方提示。' }
  Write-Host "`n基地备用密码已设置。安装包含此账号的新包并正常重启应用后，在‘备用登录’输入该密码。"
} finally {
  Remove-Item Env:SITE_MEMBER_BACKUP_NEW_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null; $confirmation = $null
  if ($first) { $first.Dispose() }; if ($second) { $second.Dispose() }
}
