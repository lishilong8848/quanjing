param([string]$AppRoot='', [string]$LedgerPath='', [string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$caseId='reczz28QKx6qoPZ6'
$caseCode='XJ-1180'
$purchaseId='reczz28PyQ7oAauG'
$purchaseCode='CG261021-602'
$messageIds=New-Object 'System.Collections.Generic.HashSet[string]'
$utf8=New-Object Text.UTF8Encoding($false)
$taskKinds=@('route_application','repair_station_chief_route','deliver_stage_cards','sync_leave_shift_details','apply_stage_action','sync_stage_action_cards','deliver_result_cards','deliver_substitute_adjustment_cards','deliver_substitute_update_notifications','deliver_stage_substitute_change_notifications','sync_approved_leave_schedule','apply_substitute_update','sync_personnel_handover','verify_future_manager_handover')
function Digest([byte[]]$Bytes) {
 $sha=[Security.Cryptography.SHA256]::Create()
 try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally {$sha.Dispose()}
}
function Safe-Path([string]$Value) {
 if([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith('\\') -or $Value -match '^[^:]+:[^\\/]' -or $Value -match '[\x00-\x1f]'){throw 'DIAG_UNSAFE_PATH'}
 $full=[IO.Path]::GetFullPath($Value)
 if($full.Substring(2).Contains(':')){throw 'DIAG_UNSAFE_PATH'}
 $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($full))
 if($drive.DriveType -eq [IO.DriveType]::Network){throw 'DIAG_UNSAFE_PATH'}
 $walk=$full
 while($walk) {
  if(Test-Path -LiteralPath $walk) {
   $item=Get-Item -LiteralPath $walk -Force
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DIAG_UNSAFE_PATH'}
  }
  $parent=[IO.Path]::GetDirectoryName($walk)
  if($parent -eq $walk){break};$walk=$parent
 }
 return $full
}
function Read-Bytes([string]$File,[int]$Limit,[bool]$Tail=$false) {
 $full=Safe-Path $File
 if(-not (Test-Path -LiteralPath $full -PathType Leaf)){return $null}
 $stream=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
 try {
  $size=$stream.Length
  if(-not $Tail -and $size -gt $Limit){throw 'DIAG_INPUT_TOO_LARGE'}
  $offset=if($Tail){[Math]::Max(0,$size-$Limit)}else{0}
  [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin)
  $buffer=New-Object byte[] ([int]($size-$offset));$read=0
  while($read -lt $buffer.Length){$n=$stream.Read($buffer,$read,$buffer.Length-$read);if($n -eq 0){break};$read+=$n}
  if($read -ne $buffer.Length){throw 'DIAG_INPUT_CHANGED'}
  return [pscustomobject]@{bytes=$buffer;size=$size;offset=$offset;sha256=(Digest $buffer)}
 } finally {$stream.Dispose()}
}
function Text-Of($Read) {return $utf8.GetString($Read.bytes).TrimStart([char]0xfeff)}
function Enum-Value($Value,[string[]]$Allowed) {if($null -ne $Value -and $Allowed -ccontains [string]$Value){return [string]$Value};return 'unknown'}
function Safe-Number($Value) {if($null -eq $Value){return $null};$n=0L;if([long]::TryParse([string]$Value,[ref]$n) -and $n -ge 0 -and $n -le 2147483647){return $n};return $null}
function Safe-Time($Value) {
 if([string]$Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$'){return $null}
 $date=[DateTimeOffset]::MinValue
 if([DateTimeOffset]::TryParse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$date)){return $date.ToUniversalTime().ToString('o')};return $null
}
function Safe-Message($Value) {if([string]$Value -cmatch '^om_[A-Za-z0-9_-]{1,124}$'){return [string]$Value};return $null}
function Error-Codes($Value) {return ,@([regex]::Matches([string]$Value,'\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EACCES|EPERM|429|500|502|503|504)\b')|ForEach-Object {$_.Value}|Select-Object -Unique)}
function Message-List($Values) {
 $items=@(foreach($v in $Values){$m=Safe-Message $v;if($m){[void]$messageIds.Add($m);$m}})
 return ,$items
}
function Read-Setting([string]$File,[string]$Fallback,[string]$SettingName='LEAVE_WORKFLOW_LEDGER_PATH') {
 $data=Read-Bytes $File 1048576
 if($null -eq $data){return [pscustomobject]@{found=$false;value=$Fallback}}
 $pattern='^\s*'+[regex]::Escape($SettingName)+'\s*='
 $matches=@((Text-Of $data) -split '\r?\n' | Where-Object {$_ -match $pattern})
 if(-not $matches.Count){return [pscustomobject]@{found=$false;value=$Fallback}}
 $value=($matches[-1] -replace ($pattern+'\s*'),'').Trim()
 if(($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))){$value=$value.Substring(1,$value.Length-2)}
 return [pscustomobject]@{found=$true;value=$value}
}
function Read-Ledger([string]$File,[string]$Role) {
 $result=[ordered]@{role=$Role;status='missing';snapshotSha256=$null;fileBytes=$null;applicationCount=$null;taskCount=$null;readHashParseElapsedMs=$null;queueSummary=@();applications=@();actions=@();tasks=@()}
 try {
  $readTimer=[Diagnostics.Stopwatch]::StartNew()
  $data=Read-Bytes $File 33554432
  if($null -eq $data){return $result}
  $result.snapshotSha256=$data.sha256;$result.fileBytes=$data.size
  try {$ledger=(Text-Of $data)|ConvertFrom-Json} catch {$result.status='invalid-json';return $result}
  $readTimer.Stop();$result.readHashParseElapsedMs=$readTimer.Elapsed.TotalMilliseconds
  if($ledger.version -ne 4 -or $null -eq $ledger.applications -or $null -eq $ledger.actions -or $null -eq $ledger.tasks){$result.status='unsupported-structure';return $result}
  $result.applicationCount=@($ledger.applications).Count;$result.taskCount=@($ledger.tasks).Count
  $queue=@{};$observedAt=[DateTimeOffset]::UtcNow
  foreach($task in $ledger.tasks) {
   $kind=Enum-Value $task.kind $taskKinds;$status=Enum-Value $task.status @('pending','processing','completed','failed');$key=$kind+':'+$status
   if(-not $queue.ContainsKey($key)){$queue[$key]=[ordered]@{kind=$kind;status=$status;count=0;overdueCount=0;unattemptedCount=0;hasErrorCount=0;oldestNextAttemptAt=$null}}
   $row=$queue[$key];$row.count++
   if((Safe-Number $task.attempts) -ceq 0){$row.unattemptedCount++}
   if(-not [string]::IsNullOrWhiteSpace([string]$task.lastError)){$row.hasErrorCount++}
   $next=Safe-Time $task.nextAttemptAt
   if($status -eq 'pending' -and $next) {
    if([DateTimeOffset]::Parse($next) -le $observedAt){$row.overdueCount++}
    if(-not $row.oldestNextAttemptAt -or $next -lt $row.oldestNextAttemptAt){$row.oldestNextAttemptAt=$next}
   }
  }
  $result.queueSummary=@($queue.Keys|Sort-Object|ForEach-Object {$queue[$_]})
  $apps=@($ledger.applications|Where-Object {$_.recordId -ceq $caseId})
  $result.status=if($apps.Count -gt 0){'matched'}else{'case-not-found'}
  $result.applications=@(foreach($app in $apps){
   $stage=$null
   if($null -ne $app.currentStage){$stage=@{key=(Enum-Value $app.currentStage.key @('supervisor','manager'));version=(Safe-Number $app.currentStage.version)}}
   $stageMessages=Message-List @($app.stageCards|ForEach-Object {$_.messageId})
   $resultMessages=Message-List @($app.resultCards|ForEach-Object {$_.messageId})
   $terminalMessages=Message-List $app.terminalCardMessageIds
   [ordered]@{status=(Enum-Value $app.status @('accepted','supervisor_pending','manager_pending','approved_syncing','approved','rejected_syncing','rejected','routing_failed','sync_error'));revision=(Safe-Number $app.revision);createdAt=(Safe-Time $app.createdAt);updatedAt=(Safe-Time $app.updatedAt);resolvedAt=(Safe-Time $app.resolvedAt);currentStage=$stage;stageMessageIds=$stageMessages;resultMessageIds=$resultMessages;terminalMessageIds=$terminalMessages;hasError=(-not [string]::IsNullOrWhiteSpace([string]$app.lastError))}
  })
  $result.actions=@(foreach($action in @($ledger.actions|Where-Object {$_.recordId -ceq $caseId})){
   $m=Safe-Message $action.messageId;if($m){[void]$messageIds.Add($m)}
   [ordered]@{stageKey=(Enum-Value $action.stageKey @('supervisor','manager'));stageVersion=(Safe-Number $action.stageVersion);action=(Enum-Value $action.action @('approve','reject'));messageId=$m;createdAt=(Safe-Time $action.createdAt)}
  })
  $kinds=$taskKinds
  $result.tasks=@(foreach($task in @($ledger.tasks|Where-Object {$_.recordId -ceq $caseId})){
   $progress=Message-List $task.payload.patchedMessageIds
   [ordered]@{keySha256=(Digest ($utf8.GetBytes([string]$task.key)));kind=(Enum-Value $task.kind $kinds);status=(Enum-Value $task.status @('pending','processing','completed','failed'));attempts=(Safe-Number $task.attempts);createdAt=(Safe-Time $task.createdAt);updatedAt=(Safe-Time $task.updatedAt);completedAt=(Safe-Time $task.completedAt);nextAttemptAt=(Safe-Time $task.nextAttemptAt);leaseUntil=(Safe-Time $task.leaseUntil);stageKey=(Enum-Value $task.payload.stageKey @('supervisor','manager'));stageVersion=(Safe-Number $task.payload.stageVersion);recovery=($task.payload.recovery -eq $true);patchedMessageIds=$progress;errorCodes=(Error-Codes $task.lastError);hasError=(-not [string]::IsNullOrWhiteSpace([string]$task.lastError))}
  })
  return $result
 } catch {if($_.Exception.Message -eq 'DIAG_UNSAFE_PATH'){throw};$result.status='unreadable-or-oversized';return $result}
}
function Log-Time([string]$Line) {
 $match=[regex]::Match($Line,'\b(2026[-/]10[-/]22[ T]\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?')
 $parsed=[DateTime]::MinValue
 if($match.Success) {
  $value=$match.Groups[1].Value.Replace('/','-').Replace('T',' ')
  if([DateTime]::TryParseExact($value,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)){return $parsed.ToString('yyyy-MM-dd HH:mm:ss')}
 }
 $us=[regex]::Match($Line,'\b10/22/2026,\s*\d{1,2}:\d{2}:\d{2}\s*[AP]M\b')
 if($us.Success) {
  $value=[regex]::Replace($us.Value,'\s+',' ')
  if([DateTime]::TryParseExact($value,'M/d/yyyy, h:mm:ss tt',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AllowWhiteSpaces,[ref]$parsed)){return $parsed.ToString('yyyy-MM-dd HH:mm:ss')}
 }
 return $null
}
function Read-PurchaseLedger([string]$File) {
 $result=[ordered]@{status='missing';snapshotSha256=$null;fileBytes=$null;readHashParseElapsedMs=$null;counts=@{};targetBatchCount=0;tasks=@()}
 try {
  $timer=[Diagnostics.Stopwatch]::StartNew();$data=Read-Bytes $File 33554432
  if($null -eq $data){return $result}
  $result.snapshotSha256=$data.sha256;$result.fileBytes=$data.size
  $ledger=(Text-Of $data)|ConvertFrom-Json;$timer.Stop();$result.readHashParseElapsedMs=$timer.Elapsed.TotalMilliseconds
  if($ledger.version -ne 2 -or $null -eq $ledger.notifications){$result.status='unsupported-structure';return $result}
  foreach($key in @('commands','notifications','cardActions','managerApprovalBatches','managerApprovalBatchActions','managerApprovalCards','managerApprovalActions')){$result.counts[$key]=if($null -eq $ledger.$key){0}else{@($ledger.$key).Count}}
  $batches=@($ledger.managerApprovalBatches|Where-Object {$_.recordIds -ccontains $purchaseId})
  $result.targetBatchCount=$batches.Count
  foreach($batch in $batches){$m=Safe-Message $batch.messageId;if($m){[void]$messageIds.Add($m)}}
  $result.tasks=@(foreach($task in @($ledger.notifications|Where-Object {$_.recordId -ceq $purchaseId})){
   $m=Safe-Message $task.messageId;if($m){[void]$messageIds.Add($m)}
   [ordered]@{kind=(Enum-Value $task.kind @('manager_batch_order_command','manager_batch_receipt_command','manager_batch_purchaser_requested','manager_batch_receipt_requested','manager_batch_state_changed','web_receipt_command'));status=(Enum-Value $task.status @('pending','processing','completed','failed','manual_reconciliation'));attempts=(Safe-Number $task.attempts);createdAt=(Safe-Time $task.createdAt);updatedAt=(Safe-Time $task.updatedAt);completedAt=(Safe-Time $task.completedAt);nextAttemptAt=(Safe-Time $task.nextAttemptAt);hasError=(-not [string]::IsNullOrWhiteSpace([string]$task.lastError));errorCodes=(Error-Codes $task.lastError);messageId=$m}
  })
  $result.status=if($batches.Count -or $result.tasks.Count){'matched'}else{'case-not-found'};return $result
 } catch {if($_.Exception.Message -eq 'DIAG_UNSAFE_PATH'){throw};$result.status='unreadable-or-oversized';return $result}
}
function Read-Log([string]$File,[string]$Label) {
 $result=[ordered]@{source=$Label;status='missing';fileBytes=$null;tailBytes=0;tailTruncated=$false;tailSha256=$null;coverage='missing';events=@();eventsTruncated=$false;timeAssumption='plain timestamps tested against UTC-compatible and Asia/Shanghai-compatible windows; actual server timezone unverified';unknownTimeCaseLines=0}
 try {
  $full=Safe-Path $File
  if(-not (Test-Path -LiteralPath $full -PathType Leaf)){return $result}
  $oversized=(Get-Item -LiteralPath $full).Length -gt 134217728
  $data=if($oversized){Read-Bytes $File 8388608 $true}else{Read-Bytes $File 134217728}
  if($null -eq $data){return $result}
  $result.coverage=if($oversized){'tail-only-oversized'}else{'complete-bounded-file'}
  $result.status='read';$result.fileBytes=$data.size;$result.tailBytes=$data.bytes.Length;$result.tailTruncated=($data.offset -gt 0);$result.tailSha256=$data.sha256
  $text=Text-Of $data
  if($data.offset -gt 0){$newline=$text.IndexOf("`n");$text=if($newline -ge 0){$text.Substring($newline+1)}else{''}}
  $events=New-Object 'System.Collections.Generic.List[object]'
  $caseCount=0;$windowCount=0
  foreach($line in ($text -split '\r?\n')) {
   $correlated=$line.Contains($caseId) -or $line.Contains($caseCode) -or $line.Contains($purchaseId) -or $line.Contains($purchaseCode)
   if(-not $correlated){foreach($m in $messageIds){if($line.Contains($m)){$correlated=$true;break}}}
   $category=if($line -match 'Feishu card action rejected'){ 'card-action-rejected' }elseif($line -match '\u5361\u7247|\u5ba1\u6279|\u4f11\u5047'){ 'approval-or-card-event' }else{'case-event'}
   if(-not $correlated -and $category -eq 'case-event'){continue}
   $time=Log-Time $line
   $shanghaiWindow=$time -and $time -ge '2026-10-22 13:00:00' -and $time -le '2026-10-22 15:30:00'
   $utcWindow=$time -and $time -ge '2026-10-22 05:00:00' -and $time -le '2026-10-22 07:30:00'
   $window=$shanghaiWindow -or $utcWindow
   if(-not $correlated -and -not ($window -and $category -ne 'case-event')){continue}
   if(($correlated -and $caseCount -ge 250) -or (-not $correlated -and $windowCount -ge 250)){$result.eventsTruncated=$true;continue}
   if($correlated){$caseCount++}else{$windowCount++}
   if($correlated -and -not $time){$result.unknownTimeCaseLines++}
   $codes=@([regex]::Matches($line,'\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EACCES|EPERM|429|500|502|503|504)\b')|ForEach-Object {$_.Value}|Select-Object -Unique)
   $taskKind=$null;foreach($kind in $taskKinds){if($line.Contains($kind+'/')){$taskKind=$kind;break}}
   $failureKind=if($line -match 'Feishu card action rejected' -and $line -match '\u5361\u7247\u56de\u8c03\u5904\u7406\u8d85\u65f6'){'callback-deadline'}elseif($line -match '\u8bf7\u4f11\u5047\u5de5\u4f5c\u6d41\u4efb\u52a1'){'leave-task-event'}elseif($line -match '\u8bf7\u4f11\u5047.*\u8f6e\u8be2\u5931\u8d25'){'leave-poll-failure'}elseif($line -match '\u8bf7\u4f11\u5047.*\u542f\u52a8\u6062\u590d\u5931\u8d25'){'leave-startup-recovery-failure'}else{'unclassified'}
   $basis=if($utcWindow){'UTC-compatible-unverified'}elseif($shanghaiWindow){'Asia-Shanghai-compatible-unverified'}else{'outside-both-windows-or-unknown'}
   $timing=$null
   if($line -match ('record='+[regex]::Escape($caseId)+' prepareMs=(\d+) commitMs=(\d+) totalMs=(\d+) claimed=(true|false)')){
    $timing=@{caseCode=$caseCode;prepareMs=(Safe-Number $Matches[1]);commitMs=(Safe-Number $Matches[2]);totalMs=(Safe-Number $Matches[3]);claimed=($Matches[4] -eq 'true')}
   } elseif($line -match ('record='+[regex]::Escape($purchaseId)+' action=(submit_order|submit_receipt) queueMs=(\d+) readMs=(\d+) decisionMs=(\d+) writeMs=(\d+) renderMs=(\d+) totalMs=(\d+) claimed=(true|false)')) {
    $timing=@{caseCode=$purchaseCode;action=$Matches[1];queueMs=(Safe-Number $Matches[2]);readMs=(Safe-Number $Matches[3]);decisionMs=(Safe-Number $Matches[4]);writeMs=(Safe-Number $Matches[5]);renderMs=(Safe-Number $Matches[6]);totalMs=(Safe-Number $Matches[7]);claimed=($Matches[8] -eq 'true')}
   }
   $events.Add([ordered]@{timeCandidate=$time;timeBasisCandidate=$basis;correlation=$(if($correlated){'case-or-message-id'}else{'window-only-not-case-proven'});category=$category;taskKindCandidate=$taskKind;failureKind=$failureKind;acceptanceTiming=$timing;errorCodes=$codes;decodedLineSha256=(Digest ($utf8.GetBytes($line)))})
  }
  $result.events=@($events.ToArray());return $result
 } catch {if($_.Exception.Message -eq 'DIAG_UNSAFE_PATH'){throw};$result.status='unreadable';return $result}
}
try {
 if([string]::IsNullOrWhiteSpace($AppRoot)) {
  $suggested=if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'start.ps1')){$PSScriptRoot}else{'C:\ai\nantong-schedule-20260428-101724'}
  Write-Host ('Read-only XJ-1180 / CG261021-602 diagnostic. Application directory ['+$suggested+']:')
  $answer=Read-Host
  $AppRoot=if([string]::IsNullOrWhiteSpace($answer)){$suggested}else{$answer.Trim().Trim('"')}
 }
 $root=Safe-Path $AppRoot
 foreach($anchor in @('start.ps1','dist/server/main.js')){if(-not (Test-Path -LiteralPath (Safe-Path (Join-Path $root $anchor)) -PathType Leaf)){throw 'DIAG_NOT_APPLICATION_ROOT'}}
 if([string]::IsNullOrWhiteSpace($OutputDirectory)){$OutputDirectory=$PSScriptRoot}
 $out=Safe-Path $OutputDirectory
 if($out.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $out.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'DIAG_OUTPUT_INSIDE_APPLICATION'}
 $source='explicit'
 if([string]::IsNullOrWhiteSpace($LedgerPath)) {
  $LedgerPath=$env:LEAVE_WORKFLOW_LEDGER_PATH;$source='process-environment'
  if([string]::IsNullOrWhiteSpace($LedgerPath)){$LedgerPath=Join-Path (Join-Path (Split-Path -Parent $root) 'nantong-schedule-state') 'leave-workflow-ledger.json';$source='startup-default'}
  foreach($file in @('.env','.env.local')){$setting=Read-Setting (Join-Path $root $file) $LedgerPath;if($setting.found){$LedgerPath=$setting.value;$source=$file}}
 }
 if([string]::IsNullOrWhiteSpace($LedgerPath)){throw 'DIAG_EMPTY_CONFIGURED_LEDGER'}
 if(-not [IO.Path]::IsPathRooted($LedgerPath)){$LedgerPath=Join-Path $root $LedgerPath}
 $selected=Safe-Path $LedgerPath
 $ledgers=@((Read-Ledger $selected 'configured-candidate'))
 $legacy=Safe-Path (Join-Path $root 'data/leave-workflow/ledger.json')
 if(-not $legacy.Equals($selected,[StringComparison]::OrdinalIgnoreCase)){$ledgers+=Read-Ledger $legacy 'legacy-not-proven-active'}
 $purchasePath=$env:PURCHASE_WORKFLOW_LEDGER_PATH
 if([string]::IsNullOrWhiteSpace($purchasePath)){$purchasePath=Join-Path $root '.runtime/purchase-workflow-ledger.json'}
 foreach($file in @('.env','.env.local')){$setting=Read-Setting (Join-Path $root $file) $purchasePath 'PURCHASE_WORKFLOW_LEDGER_PATH';if($setting.found){$purchasePath=$setting.value}}
 if(-not [IO.Path]::IsPathRooted($purchasePath)){$purchasePath=Join-Path $root $purchasePath}
 $purchaseLedger=Read-PurchaseLedger (Safe-Path $purchasePath)
 $logs=@((Read-Log (Join-Path $root 'logs/app.out.log') 'app.out.log'),(Read-Log (Join-Path $root 'logs/app.err.log') 'app.err.log'))
 $receipt=[ordered]@{status='missing';deploymentId=$null;schemaVersion=$null}
 $raw=Read-Bytes (Join-Path $root '.hotfix-installed-release.json') 4194304
 if($null -ne $raw){try{$parsed=(Text-Of $raw)|ConvertFrom-Json;$receipt.status='metadata-only';if([string]$parsed.deploymentId -cmatch '^nantong-safe-full-runtime-hotfix-\d{8}-\d{6}$'){$receipt.deploymentId=$parsed.deploymentId};$receipt.schemaVersion=Safe-Number $parsed.schemaVersion}catch{$receipt.status='invalid-json'}}
 $status=if($ledgers[0].status -eq 'matched' -and $purchaseLedger.status -eq 'matched'){'collected'}else{'incomplete'}
 $report=[ordered]@{schemaVersion=2;caseCode=$caseCode;caseRecordId=$caseId;collectedAt=[DateTime]::UtcNow.ToString('o');status=$status;networkCalls=0;applicationWrites=0;fullApprovalProof=$false;receiptVerified=$false;runtimeEnvironmentVerified=$false;pathResolution=@{source=$source;semantics='startup configuration candidate; not running-process environment proof'};installedReceiptMetadata=$receipt;ledgers=$ledgers;logs=$logs;limitations=@('No approval replay or message sends.','No raw lines, configuration contents, reasons, images or arbitrary payload exported.','Old logs cannot reconstruct unrecorded preclaim durations or historical PATCH acknowledgement times.','Task timestamps are persisted metadata, not measured step durations.','Collector read/hash/PowerShell parse timing is not Node callback or commit timing.','Queue counts contain no other application identities or payloads.','Mobile rendering and all-message terminal state remain unverified.','Logs up to128MiB are read completely; larger logs use8MiB tail explicitly. Rotated logs are not scanned.');collectorSha256=(Digest ([IO.File]::ReadAllBytes($PSCommandPath)))}
 $report.schemaVersion=3
 $report['purchaseCaseCode']=$purchaseCode;$report['purchaseRecordId']=$purchaseId;$report['purchaseLedger']=$purchaseLedger
 $report['purchasePathSemantics']='configured candidate only; not running-process environment proof'
 $report.limitations+=@('Purchase historical preclaim/commit timing was not recorded; ledger timestamps cannot reconstruct it.','Local schedule read defect is independently reproduced; this report must establish whether it caused this specific approval delay.')
 if(-not (Test-Path -LiteralPath $out -PathType Container)){[void][IO.Directory]::CreateDirectory($out)}
 [void](Safe-Path $out)
 $file=Join-Path $out ('approval-latency-diagnostics-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json')
 $bytes=$utf8.GetBytes(($report|ConvertTo-Json -Depth 18))
 $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 [Console]::WriteLine((@{status=$status;reportPath=$file;reportSha256=(Digest $bytes);networkCalls=0;applicationWrites=0}|ConvertTo-Json -Compress))
 if($status -eq 'incomplete'){exit 2};exit 0
} catch {
 $code=if($_.Exception.Message -match '^DIAG_[A-Z_]+$'){$_.Exception.Message}else{'DIAG_COLLECTION_FAILED'}
 [Console]::Error.WriteLine($code+'; no application files changed.');exit 1
}
