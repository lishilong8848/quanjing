param([string]$AppRoot='', [string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$taskUtf8=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=$taskUtf8
$OutputEncoding=$taskUtf8
try {
  if ([string]::IsNullOrWhiteSpace($AppRoot) -and (Test-Path -LiteralPath 'C:\ai\nantong-schedule-20260428-101724\dist\server\main.js' -PathType Leaf)) { $AppRoot='C:\ai\nantong-schedule-20260428-101724' }
  if ([string]::IsNullOrWhiteSpace($AppRoot)) { $AppRoot=Read-Host 'Application root (e.g. C:\ai\nantong-schedule-20260428-101724)' }
  $AppRoot=[IO.Path]::GetFullPath($AppRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'dist/server/main.js') -PathType Leaf)) { throw 'APPLICATION_ROOT_REQUIRED' }
  $taskCandidates=@((Join-Path $AppRoot '.runtime/node/node.exe'))
  $taskNode=Get-Command node.exe -ErrorAction SilentlyContinue
  if ($taskNode) { $taskCandidates+= $taskNode.Source }
  $taskNodePath=$taskCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $taskNodePath) { throw 'NODE_REQUIRED' }
  $taskResult=& $taskNodePath (Join-Path $PSScriptRoot 'collect-feishu-login.cjs') $AppRoot
  if ($LASTEXITCODE -ne 0) { throw 'READ_ONLY_CHECK_FAILED' }
  $taskParsed=($taskResult -join "`n") | ConvertFrom-Json
  if ($taskParsed.schemaVersion -ne 1) { throw 'RESULT_INVALID' }
  if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory=$PSScriptRoot }
  if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw 'OUTPUT_DIRECTORY_REQUIRED' }
  $taskOutput=Join-Path $OutputDirectory ('feishu-login-diagnostics-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json')
  $taskBytes=$taskUtf8.GetBytes(($taskResult -join "`n"))
  $taskStream=[IO.File]::Open($taskOutput,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $taskStream.Write($taskBytes,0,$taskBytes.Length) } finally { $taskStream.Dispose() }
  Write-Host ('[OK] '+$taskOutput)
  exit 0
} catch { Write-Host '[FAILED] LOGIN_DIAGNOSTIC_REFUSED_OR_UNAVAILABLE'; exit 1 }
