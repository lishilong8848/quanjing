param([Parameter(Mandatory=$true)][string]$DeliveryPath,[switch]$DeleteLocalZip,[ValidateSet('deliver','restore')][string]$Mode='deliver')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if($Mode -eq 'restore' -and $DeleteLocalZip){throw 'Restoration cannot delete ZIPs'}
if(-not [IO.Path]::IsPathRooted($DeliveryPath)){$DeliveryPath=Join-Path $root $DeliveryPath}
$DeliveryPath=[IO.Path]::GetFullPath($DeliveryPath)
$leases=New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
try {
 foreach($p in @((Join-Path $root 'output/.nantong-full-runtime-hotfix-build.lock'),(Join-Path $root '.nantong-full-runtime-hotfix-build.lock'))){$leases.Add([IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None))}
 $launcher=(Get-Command lark-cli.ps1 -ErrorAction Stop).Source
 $entry=Join-Path (Split-Path $launcher -Parent) 'node_modules/@larksuite/cli/scripts/run.js'
 Push-Location $root
 try {
  $cliArgs=@($DeliveryPath,$entry)
  if($Mode -eq 'restore'){$cliArgs+='restore'}
  $output=& (Join-Path $root 'output/runtime-tools/node-v24.15.0-win-x64/node.exe') (Join-Path $PSScriptRoot 'deliver-hotfix-feishu.mjs') @cliArgs
  if($LASTEXITCODE -ne 0){throw 'Feishu delivery incomplete; ZIP retained'}
 } finally {Pop-Location}
 $r=($output -join "`n")|ConvertFrom-Json
 if($Mode -eq 'restore'){
  $output
  return
 }
 if(-not $r.downloadVerified -or -not $r.fileMessageId -or -not $r.metadataMessageId){throw 'Delivery proof incomplete'}
 if($DeleteLocalZip){
  $d=Get-Content -Raw -Encoding UTF8 -LiteralPath $DeliveryPath|ConvertFrom-Json
  if(-not $d.source.archive -or -not $d.source.sourceRoot -or -not (Test-Path -LiteralPath $d.source.sourceRoot -PathType Container) -or (Get-FileHash -LiteralPath $d.source.archive -Algorithm SHA256).Hash -ine $d.source.archiveSha256){throw 'Retained source archive/sourceRoot not proven'}
  $suffix=$d.packageId.Replace('nantong-safe-full-runtime-hotfix-','')
  $outer=[IO.Path]::GetFullPath((Join-Path $root ('output/hotfix/nantong-one-click-hotfix-'+$suffix+'.zip')))
  $inner=[IO.Path]::GetFullPath((Join-Path $root ('output/hotfix/'+$d.packageId+'.zip')))
  if([IO.Path]::GetFullPath($d.outerPath) -ine $outer -or [IO.Path]::GetFullPath($d.innerPath) -ine $inner){throw 'ZIP cleanup boundary differs'}
  $targets=@(@{path=$outer;sha256=$d.outerSha256},@{path=$inner;sha256=$d.innerSha256},@{path=$r.downloadPath;sha256=$d.outerSha256})
  $rows=@()
  foreach($row in $targets){
   $p=[IO.Path]::GetFullPath($row.path)
   if(-not $p.StartsWith((Join-Path $root 'output')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'ZIP outside output'}
   if(Test-Path -LiteralPath $p){
    $item=Get-Item -LiteralPath $p -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ine $row.sha256){throw 'ZIP cleanup identity changed'}
    $rows+=@{path=$p;type='ordinary-zip';size=$item.Length;deploymentId=$d.packageId;sha256=$row.sha256;reason='User approved removal after successful bot attachment delivery; original outer recoverable from verified Feishu message';referenceCheck='Exact current package only; no source/archive/baseline/dependency/transaction directories deleted'}
   }
  }
  $dir=Split-Path $r.receiptPath -Parent
  $plan=[ordered]@{deploymentId=$d.packageId;fileMessageId=$r.fileMessageId;fileKey=$r.fileKey;outerSha256=$d.outerSha256;remoteDownloadVerified=$true;files=$rows;preserved='Source archive/sourceRoot, baseline, dependency proof, acceptance/hash summaries and previous rollback materials';createdAt=[DateTime]::UtcNow.ToString('o')}
  $cleanupId=[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')+'-'+[Guid]::NewGuid().ToString('N')
  $planPath=Join-Path $dir ($d.packageId+'.cleanup-'+$cleanupId+'-plan.json')
  [IO.File]::WriteAllText($planPath,($plan|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  $result=[ordered]@{passed=$true;deploymentId=$d.packageId;deletedFiles=$rows.Count;releasedBytes=[long](($rows|ForEach-Object {[long]$_.size}|Measure-Object -Sum).Sum);recoverableFromFeishu=$true;planSha256=(Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant();finishedAt=[DateTime]::UtcNow.ToString('o')}
  foreach($row in $rows){if((Get-FileHash -LiteralPath $row.path -Algorithm SHA256).Hash -ine $row.sha256){throw 'ZIP changed before deletion'};Remove-Item -LiteralPath $row.path -Force -ErrorAction Stop;if(Test-Path -LiteralPath $row.path){throw 'ZIP deletion incomplete'}}
  [IO.File]::WriteAllText((Join-Path $dir ($d.packageId+'.cleanup-'+$cleanupId+'-result.json')),($result|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
  $result|ConvertTo-Json -Depth 6
 } else {$output}
} finally {foreach($lease in $leases){$lease.Dispose()}}
