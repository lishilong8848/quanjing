param(
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BaseToken = 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_INVENTORY_APP_TOKEN'
$CodeField = '采购编码'
$DefaultBuilding = 'H楼'
$BuildingNumbers = @{
  'A楼' = '1'
  'B楼' = '2'
  'C楼' = '3'
  'D楼' = '4'
  'E楼' = '5'
  'H楼' = '6'
  '110站' = '7'
}

$TableSpecs = @(
  @{
    Id = 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_EXECUTION_TABLE_ID'
    Name = '采购执行明细'
    PersonFields = @('需求人')
    ItemFields = @('物品名称')
    QuantityFields = @('采购申请数量')
    BuildingField = '申请楼栋'
    CreatedField = '创建日期'
    FieldIds = @('fldRvSQjN7', 'fld5Hmt9R5', 'fldOarHcyQ', 'fldSqzYQ9U', 'fldqE598Mp', 'fldHbEVfzV')
  },
  @{
    Id = 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_SUBMISSION_TABLE_ID'
    Name = '采购申请清单'
    PersonFields = @('业务申请人', '需求人')
    ItemFields = @('非新增物品名称', '新增物品名称')
    QuantityFields = @('采购数量')
    BuildingField = '申请楼栋（多楼请选H楼，备注里填写详情）'
    CreatedField = '创建日期'
    FieldIds = @('fldGacGWEx', 'fldhsBmmEm', 'fld5Hmt9R5', 'fldOarHcyQ', 'fldSqzYQ9U', 'fldqE598Mp', 'fld4ITzJtQ', 'fldHbEVfzV')
  }
)

function Invoke-LarkJson {
  param([string[]]$CliArgs)

  $raw = & lark-cli @CliArgs
  if ($LASTEXITCODE -ne 0) {
    throw "lark-cli failed while executing $($CliArgs[0..1] -join ' ')"
  }
  $payload = ($raw | Out-String | ConvertFrom-Json)
  if (-not $payload.ok) {
    throw "lark-cli returned an unsuccessful response: $($payload | ConvertTo-Json -Compress -Depth 8)"
  }
  return $payload
}

function Get-TableRows {
  param([hashtable]$Spec)

  $result = @()
  $offset = 0
  do {
    $cliArgs = @(
      'base', '+record-list',
      '--base-token', $BaseToken,
      '--table-id', $Spec.Id,
      '--limit', '200',
      '--offset', "$offset",
      '--format', 'json',
      '--as', 'user'
    )
    foreach ($fieldId in $Spec.FieldIds) {
      $cliArgs += @('--field-id', $fieldId)
    }
    $payload = Invoke-LarkJson -CliArgs $cliArgs
    $rows = @($payload.data.data)
    $recordIds = @($payload.data.record_id_list)
    if ($rows.Count -ne $recordIds.Count) {
      throw "$($Spec.Name) query returned mismatched row and record-id counts"
    }
    $fieldNames = @($payload.data.fields)
    for ($index = 0; $index -lt $rows.Count; $index += 1) {
      $values = @($rows[$index])
      $fields = @{}
      for ($fieldIndex = 0; $fieldIndex -lt $fieldNames.Count; $fieldIndex += 1) {
        $fields[$fieldNames[$fieldIndex]] = $values[$fieldIndex]
      }
      $result += [pscustomobject]@{
        TableId = $Spec.Id
        TableName = $Spec.Name
        RecordId = [string]$recordIds[$index]
        Fields = $fields
        PersonFields = $Spec.PersonFields
        ItemFields = $Spec.ItemFields
        QuantityFields = $Spec.QuantityFields
        BuildingField = $Spec.BuildingField
      }
    }
    $offset += $rows.Count
  } while ($payload.data.has_more -and $rows.Count -gt 0)
  return $result
}

function Get-Text {
  param($Value)

  if ($null -eq $Value) { return '' }
  if ($Value -is [System.Array]) {
    if ($Value.Count -eq 0) { return '' }
    return Get-Text -Value $Value[0]
  }
  if ($Value -is [pscustomobject] -and $null -ne $Value.name) {
    return [string]$Value.name
  }
  return ([string]$Value).Trim()
}

function Get-ApplicantId {
  param($Value)

  if ($null -eq $Value) { return '' }
  if ($Value -is [System.Array]) {
    if ($Value.Count -eq 0) { return '' }
    return Get-ApplicantId -Value $Value[0]
  }
  if ($Value -is [pscustomobject]) {
    if ($null -ne $Value.id) { return ([string]$Value.id).Trim() }
    if ($null -ne $Value.open_id) { return ([string]$Value.open_id).Trim() }
    if ($null -ne $Value.name) { return ([string]$Value.name).Trim() }
  }
  return ([string]$Value).Trim()
}

function Get-FirstText {
  param(
    [hashtable]$Fields,
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $text = Get-Text -Value $Fields[$name]
    if ($text) { return $text }
  }
  return ''
}

function Get-FirstApplicantId {
  param(
    [hashtable]$Fields,
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $applicant = Get-ApplicantId -Value $Fields[$name]
    if ($applicant) { return $applicant }
  }
  return ''
}

function Invoke-BatchUpdate {
  param(
    [string]$TableId,
    [string[]]$RecordIds,
    [hashtable]$Patch
  )

  $uniqueRecordIds = @($RecordIds | Select-Object -Unique)
  for ($start = 0; $start -lt $uniqueRecordIds.Count; $start += 200) {
    $end = [Math]::Min($start + 199, $uniqueRecordIds.Count - 1)
    $chunk = @($uniqueRecordIds[$start..$end])
    $body = @{
      record_id_list = @($chunk)
      patch = $Patch
    } | ConvertTo-Json -Compress -Depth 8
    $escapedBody = $body -replace '"', '\"'
    $null = Invoke-LarkJson -CliArgs @(
      'base', '+record-batch-update',
      '--base-token', $BaseToken,
      '--table-id', $TableId,
      '--json', $escapedBody,
      '--as', 'user',
      '--format', 'json'
    )
  }
}

$rawRows = foreach ($spec in $TableSpecs) {
  Get-TableRows -Spec $spec
}

$records = foreach ($row in $rawRows) {
  $code = Get-Text -Value $row.Fields[$CodeField]
  $applicant = Get-FirstApplicantId -Fields $row.Fields -Names $row.PersonFields
  if (-not $applicant) { $applicant = "record:$($row.RecordId)" }
  $building = Get-Text -Value $row.Fields[$row.BuildingField]
  $usesDefaultBuilding = -not $building
  if ($usesDefaultBuilding) {
    throw "Missing building on $($row.TableName) record $($row.RecordId). Do not default to H楼; run scripts/reconcile-purchase-table-codes.mjs first."
  }
  if (-not $BuildingNumbers.ContainsKey($building)) {
    throw "Unsupported building '$building' on $($row.TableName) record $($row.RecordId)"
  }
  $createdText = Get-Text -Value $row.Fields['创建日期']
  try {
    $createdAt = [datetime]::ParseExact(
      $createdText,
      'yyyy-MM-dd HH:mm:ss',
      [Globalization.CultureInfo]::InvariantCulture
    )
  } catch {
    throw "Invalid creation time '$createdText' on $($row.TableName) record $($row.RecordId)"
  }
  [pscustomobject]@{
    Key = "$($row.TableId):$($row.RecordId)"
    TableId = $row.TableId
    TableName = $row.TableName
    RecordId = $row.RecordId
    BuildingField = $row.BuildingField
    Code = $code
    Applicant = $applicant
    Building = $building
    UsesDefaultBuilding = $usesDefaultBuilding
    CreatedAt = $createdAt
    ItemName = Get-FirstText -Fields $row.Fields -Names $row.ItemFields
    Quantity = Get-FirstText -Fields $row.Fields -Names $row.QuantityFields
  }
}

$defaultBuildingGroups = $records |
  Where-Object UsesDefaultBuilding |
  Group-Object TableId
Write-Host "Read $($records.Count) records from two purchase tables."
$missingBuildingCount = @($records | Where-Object UsesDefaultBuilding).Count
Write-Host "Missing buildings to default to H楼: $missingBuildingCount"

function Normalize-ComparableText {
  param([string]$Value)
  return ($Value -replace '[\s\p{P}\p{S}]', '').ToUpperInvariant()
}

function Test-HistoricalPair {
  param($Submission, $Execution)

  if ($Submission.Applicant -ne $Execution.Applicant) { return $false }
  if ($Submission.Building -ne $Execution.Building) { return $false }
  if (-not $Submission.ItemName -or -not $Execution.ItemName) { return $false }
  if ((Normalize-ComparableText $Submission.ItemName) -ne (Normalize-ComparableText $Execution.ItemName)) { return $false }
  if ($Submission.Quantity -and $Execution.Quantity -and $Submission.Quantity -ne $Execution.Quantity) { return $false }
  return [Math]::Abs(($Submission.CreatedAt - $Execution.CreatedAt).TotalMinutes) -lt 10
}

$submissions = @($records | Where-Object { $_.TableId -eq 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_SUBMISSION_TABLE_ID' })
$executions = @($records | Where-Object { $_.TableId -eq 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_EXECUTION_TABLE_ID' })
$pairedSubmissionKeys = [System.Collections.Generic.HashSet[string]]::new()
$confirmedPairs = @()
$pairedExecutionCount = 0
foreach ($execution in $executions) {
  $candidates = @($submissions | Where-Object {
    -not $pairedSubmissionKeys.Contains($_.Key) -and (Test-HistoricalPair $_ $execution)
  })
  if ($candidates.Count -eq 1) {
    $null = $pairedSubmissionKeys.Add($candidates[0].Key)
    $confirmedPairs += [pscustomobject]@{
      SubmissionKey = $candidates[0].Key
      ExecutionKey = $execution.Key
    }
    $pairedExecutionCount += 1
  }
}
Write-Host "Unambiguous cross-table item pairs within 10 minutes: $pairedExecutionCount"

if ($Apply) {
  foreach ($group in $defaultBuildingGroups) {
    $sample = $group.Group[0]
    Invoke-BatchUpdate -TableId $group.Name -RecordIds @($group.Group.RecordId) -Patch @{
      $sample.BuildingField = $DefaultBuilding
    }
  }
}

$batches = @()
$records |
  Group-Object { "$($_.CreatedAt.ToString('yyyy-MM-dd'))|$($_.Building)|$($_.Applicant)" } |
  ForEach-Object {
    $current = $null
    foreach ($record in @($_.Group | Sort-Object CreatedAt, RecordId)) {
      if ($null -eq $current -or ($record.CreatedAt - $current.StartAt).TotalMinutes -ge 10) {
        $current = [pscustomobject]@{
          Id = $batches.Count
          Date = $record.CreatedAt.ToString('yyyy-MM-dd')
          Building = $record.Building
          Applicant = $record.Applicant
          StartAt = $record.CreatedAt
          Records = @()
        }
        $batches += $current
      }
      $current.Records += $record
    }
  }

$batchParents = @{}
$recordBatchIds = @{}
foreach ($batch in $batches) {
  $batchParents[$batch.Id] = $batch.Id
  foreach ($record in $batch.Records) {
    $recordBatchIds[$record.Key] = $batch.Id
  }
}

function Get-BatchRoot {
  param([int]$BatchId)

  $root = $BatchId
  while ($batchParents[$root] -ne $root) {
    $root = $batchParents[$root]
  }
  return $root
}

function Merge-Batches {
  param(
    [int]$LeftId,
    [int]$RightId
  )

  $leftRoot = Get-BatchRoot -BatchId $LeftId
  $rightRoot = Get-BatchRoot -BatchId $RightId
  if ($leftRoot -ne $rightRoot) {
    $batchParents[$rightRoot] = $leftRoot
  }
}

foreach ($pair in $confirmedPairs) {
  Merge-Batches -LeftId $recordBatchIds[$pair.SubmissionKey] -RightId $recordBatchIds[$pair.ExecutionKey]
}

$mergedBatches = @{}
foreach ($batch in $batches) {
  $root = Get-BatchRoot -BatchId $batch.Id
  if (-not $mergedBatches.ContainsKey($root)) {
    $mergedBatches[$root] = [pscustomobject]@{
      Date = $batch.Date
      Building = $batch.Building
      Applicant = $batch.Applicant
      StartAt = $batch.StartAt
      Records = @()
    }
  }
  $merged = $mergedBatches[$root]
  if ($batch.StartAt -lt $merged.StartAt) { $merged.StartAt = $batch.StartAt }
  $merged.Records += $batch.Records
}
$batches = @($mergedBatches.Values)

$expectedCodes = @{}
$batches |
  Group-Object { "$($_.Date)|$($_.Building)" } |
  ForEach-Object {
    $sequence = 0
    foreach ($batch in @($_.Group | Sort-Object StartAt, Applicant)) {
      $sequence += 1
      if ($sequence -gt 99) {
        throw "More than 99 purchase batches on $($batch.Date) for $($batch.Building)"
      }
      $datePart = $batch.Date.Substring(2).Replace('-', '')
      $code = "CG$datePart-$($BuildingNumbers[$batch.Building])$($sequence.ToString('00'))"
      foreach ($record in $batch.Records) {
        $expectedCodes[$record.Key] = $code
      }
    }
  }

$pending = @()
foreach ($record in $records) {
  $expectedCode = $expectedCodes[$record.Key]
  if ($record.Code -and $record.Code -ne $expectedCode) {
    throw "Existing code mismatch on $($record.TableName) record $($record.RecordId): '$($record.Code)' should be '$expectedCode'"
  }
  if (-not $record.Code) {
    $pending += [pscustomobject]@{
      TableId = $record.TableId
      RecordId = $record.RecordId
      Code = $expectedCode
    }
  }
}

Write-Host "Planned purchase batches: $($batches.Count)"
Write-Host "Records needing purchase codes: $($pending.Count)"
Write-Host "Distinct purchase codes: $(($expectedCodes.Values | Select-Object -Unique).Count)"
$confirmedPairMismatches = @($confirmedPairs | Where-Object {
  $expectedCodes[$_.SubmissionKey] -ne $expectedCodes[$_.ExecutionKey]
})
if ($confirmedPairMismatches.Count) {
  throw "Planned codes differ for $($confirmedPairMismatches.Count) confirmed cross-table record pairs"
}
Write-Host "Confirmed cross-table pairs with the same planned code: $($confirmedPairs.Count)"

if (-not $Apply) {
  Write-Host 'Dry run only. Re-run with -Apply to write the planned values.'
  exit 0
}

$pending |
  Group-Object { "$($_.TableId)|$($_.Code)" } |
  ForEach-Object {
    $parts = $_.Name.Split('|', 2)
    Invoke-BatchUpdate -TableId $parts[0] -RecordIds @($_.Group.RecordId) -Patch @{
      $CodeField = $parts[1]
    }
  }

$verifiedRows = foreach ($spec in $TableSpecs) {
  Get-TableRows -Spec $spec
}
$verifiedCodes = @{}
foreach ($row in $verifiedRows) {
  $verifiedCodes["$($row.TableId):$($row.RecordId)"] = Get-Text -Value $row.Fields[$CodeField]
}
$mismatches = @($expectedCodes.Keys | Where-Object {
  $verifiedCodes[$_] -ne $expectedCodes[$_]
})
if ($mismatches.Count) {
  throw "Verification failed for $($mismatches.Count) records after backfill"
}

Write-Host "Backfill complete and verified: $($expectedCodes.Count) records have the expected purchase code."
