[CmdletBinding()]
param(
  [string]$OutputRoot,
  [string]$ClientRoot,
  [switch]$SkipBuild,
  [switch]$FrozenPurchase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $projectRoot 'output\hotfix'
}
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "nantong-latest-combined-hotfix-$timestamp"
$clientRelativePath = 'dist/client'

# Keep this list explicit. The package is an overlay for leave, overtime,
# change requests, adjustments and summaries, substitute validation, duty screenshots,
# emergency duty schedules, weather warnings, purchase and purchase inbound;
# it deliberately does not replace dependency manifests, runtime data, or
# environment files.
$serverRelativePaths = @(
  'dist/server/app.module.js'
  'dist/server/runtime-env.js'
  'dist/server/common/access/unified-access.module.js'
  'dist/server/common/access/unified-access.controller.js'
  'dist/server/common/access/unified-access.service.js'
  'dist/server/common/access/unified-access.guard.js'
  'dist/server/common/feishu/bitable-direct-read.js'
  'dist/server/common/feishu/leave-approval-source.js'
  'dist/server/common/filters/exception.filter.js'
  'dist/server/common/interfaces/api_response.interface.js'
  'dist/server/modules/bitable-sync/bitable-sync.controller.js'
  'dist/server/modules/bitable-sync/bitable-sync.module.js'
  'dist/server/modules/bitable-sync/bitable-sync.service.js'
  'dist/server/modules/bitable-sync/active-personnel-directory.js'
  'dist/server/modules/bitable-sync/change-request-submitter-directory.js'
  'dist/server/modules/bitable-sync/person-profile-source.js'
  'dist/server/modules/bitable-sync/person-profile-contact.js'
  'dist/server/modules/bitable-sync/today-operations-kpi.service.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.card.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.callback.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.gateway.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.rules.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.scheduler.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.service.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.store.js'
  'dist/server/modules/bitable-sync/today-operations-anomaly.types.js'
  'dist/server/modules/bitable-sync/today-operations-schedule-consistency.js'
  'dist/server/modules/bitable-sync/today-operations-schedule-consistency.service.js'
  'dist/server/modules/duty-schedule/bitable-record-update.js'
  'dist/server/modules/duty-schedule/change-adjustment-record.js'
  'dist/server/modules/duty-schedule/change-adjustment.service.js'
  'dist/server/modules/duty-schedule/change-drill-report.service.js'
  'dist/server/modules/duty-schedule/change-summary-report.service.js'
  'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.js'
  'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.js'
  'dist/server/modules/duty-schedule/change-attachment-storage.service.js'
  'dist/server/modules/duty-schedule/change-attachment-temp-directory.js'
  'dist/server/modules/duty-schedule/change-attachment-upload.js'
  'dist/server/modules/duty-schedule/change-request-document-validator.js'
  'dist/server/modules/duty-schedule/china-work-calendar.controller.js'
  'dist/server/modules/duty-schedule/china-work-calendar-source.js'
  'dist/server/modules/duty-schedule/china-work-calendar-state-store.js'
  'dist/server/modules/duty-schedule/china-work-calendar.service.js'
  'dist/server/modules/duty-schedule/duty-daily-report-state-path.js'
  'dist/server/modules/duty-schedule/emergency-duty.controller.js'
  'dist/server/modules/duty-schedule/emergency-duty.service.js'
  'dist/server/modules/duty-schedule/duty-schedule.controller.js'
  'dist/server/modules/duty-schedule/duty-schedule.module.js'
  'dist/server/modules/duty-schedule/duty-schedule.service.js'
  'dist/server/modules/duty-schedule/duty-screenshot.service.js'
  'dist/server/modules/duty-schedule/approved-leave-visibility.js'
  'dist/server/modules/duty-schedule/leave-substitute-audit.js'
  'dist/server/modules/duty-schedule/long-white-duty-staff.js'
  'dist/server/modules/duty-schedule/monthly-schedule-screenshot-access.js'
  'dist/server/modules/leave-workflow/leave-workflow.callback.js'
  'dist/server/modules/leave-workflow/leave-workflow.card.js'
  'dist/server/modules/leave-workflow/leave-workflow.gateway.js'
  'dist/server/modules/leave-workflow/leave-workflow.module.js'
  'dist/server/modules/leave-workflow/leave-workflow.rules.js'
  'dist/server/modules/leave-workflow/leave-workflow.scheduler.js'
  'dist/server/modules/leave-workflow/leave-workflow.service.js'
  'dist/server/modules/leave-workflow/leave-workflow.store.js'
  'dist/server/modules/leave-workflow/leave-workflow.types.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.callback.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.card-action.consumer.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.card.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.controller.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.gateway.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.module.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.rules.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.scheduler.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.service.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.store.js'
  'dist/server/modules/overtime-workflow/overtime-workflow.types.js'
  'dist/server/modules/view/view.controller.js'
  'dist/server/modules/inventory-management/inventory-access-policy.js'
  'dist/server/modules/inventory-management/inventory-inbound-catalog.rules.js'
  'dist/server/modules/inventory-management/inventory-management.controller.js'
  'dist/server/modules/inventory-management/inventory-management.mapper.js'
  'dist/server/modules/inventory-management/inventory-management.module.js'
  'dist/server/modules/inventory-management/inventory-management.query.js'
  'dist/server/modules/inventory-management/inventory-management.service.js'
  'dist/server/modules/inventory-management/inventory-movement-command.rules.js'
  'dist/server/modules/inventory-management/inventory-movement-command.service.js'
  'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js'
  'dist/server/modules/inventory-management/inventory-movement-deletion.service.js'
  'dist/server/modules/inventory-management/inventory-movement-operation-coordinator.js'
  'dist/server/modules/inventory-management/inventory-outbound-canonical.js'
  'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'
  'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'
  'dist/server/modules/inventory-management/inventory-storage-location.rules.js'
  'dist/server/modules/inventory-management/inventory-storage-location.service.js'
  'dist/server/modules/inventory-management/inventory-workflow.gateway.js'
  'dist/server/modules/inventory-management/inventory-workflow.rules.js'
  'dist/server/modules/inventory-management/inventory-workflow.scheduler.js'
  'dist/server/modules/inventory-management/inventory-workflow.service.js'
  'dist/server/modules/inventory-management/inventory-workflow.store.js'
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js'
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js'
  'dist/server/modules/inventory-management/purchase-inbound-category-task-ledger.store.js'
  'dist/server/modules/inventory-management/purchase-inbound-category-task.service.js'
  'dist/server/modules/purchase-inventory/purchase-access-policy.service.js'
  'dist/server/modules/purchase-inventory/purchase-application-task-ledger.store.js'
  'dist/server/modules/purchase-inventory/purchase-application.service.js'
  'dist/server/modules/purchase-inventory/purchase-application.validation.js'
  'dist/server/modules/purchase-inventory/purchase-code.rules.js'
  'dist/server/modules/purchase-inventory/purchase-code.service.js'
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js'
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js'
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js'
  'dist/server/modules/purchase-inventory/purchase-inventory.service.js'
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js'
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js'
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js'
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js'
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js'
  'dist/server/modules/purchase-inventory/purchase-online-approval.service.js'
  'dist/server/modules/purchase-inventory/purchase-record-deletion.service.js'
  'dist/server/modules/purchase-inventory/purchase-record-edit.service.js'
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js'
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js'
  'dist/server/modules/purchase-inventory/purchase-workflow-card.js'
  'dist/server/modules/purchase-inventory/feishu-card-action.router.js'
  'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js'
  'dist/server/modules/purchase-inventory/purchase-workflow-session.js'
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js'
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js'
  'dist/server/modules/purchase-inventory/purchase-workflow.scheduler.js'
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js'
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js'
  'dist/server/modules/weather-warning/weather-warning-action-templates.js'
  'dist/server/modules/weather-warning/weather-warning-automation.config.js'
  'dist/server/modules/weather-warning/weather-warning-automation-state-store.js'
  'dist/server/modules/weather-warning/weather-warning-automation.service.js'
  'dist/server/modules/weather-warning/weather-warning-bitable.service.js'
  'dist/server/modules/weather-warning/weather-warning-card.js'
  'dist/server/modules/weather-warning/weather-warning-check-scope.js'
  'dist/server/modules/weather-warning/weather-warning-delivery-state-store.js'
  'dist/server/modules/weather-warning/weather-warning-notification.service.js'
  'dist/server/modules/weather-warning/weather-warning-registration.config.js'
  'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'
  'dist/server/modules/weather-warning/weather-warning-registration.service.js'
  'dist/server/modules/weather-warning/weather-warning-registration-link.js'
  'dist/server/modules/weather-warning/weather-warning-registration.rules.js'
  'dist/server/modules/weather-warning/weather-warning-rules.js'
  'dist/server/modules/weather-warning/weather-warning.scheduler.js'
  'dist/server/modules/weather-warning/weather-warning-snapshot.service.js'
  'dist/server/modules/weather-warning/weather-warning-source-status.js'
  'dist/server/modules/weather-warning/weather-warning-test-simulation.js'
  'dist/server/modules/weather-warning/weather-warning.config.js'
  'dist/server/modules/weather-warning/weather-warning.controller.js'
  'dist/server/modules/weather-warning/weather-warning.module.js'
)

$sharedRelativePaths = @(
  'dist/shared/api.interface.js'
  'dist/shared/access-control.interface.js'
  'dist/shared/change-adjustment.js'
  'dist/shared/change-drill-report.js'
  'dist/shared/change-request.js'
  'dist/shared/change-summary-report.js'
  'dist/shared/china-work-calendar.js'
  'dist/shared/duty-staff-name.js'
  'dist/shared/emergency-duty.interface.js'
  'dist/shared/leave-request-impact.js'
  'dist/shared/overtime-request-impact.js'
  'dist/shared/inventory-management.interface.js'
)

# These source-independent operational scripts are required for the idempotent
# Base field migration and the exact-marker real-data create/adjust/cleanup
# verification. They contain no credentials and are copied verbatim.
$operationalScriptRelativePaths = @(
  'start.cmd'
  'start.ps1'
  'deploy/configure-change-attachment-storage.ps1'
  'scripts/ensure-change-adjustment-fields.mjs'
  'scripts/ensure-change-drill-report-fields.mjs'
  'scripts/ensure-change-summary-report-fields.mjs'
  'scripts/ensure-leave-workflow-fields.mjs'
  'scripts/run-with-env.mjs'
  'scripts/self-test-change-adjustment.mjs'
  'scripts/self-test-change-summary-report.mjs'
)

$effectiveServerRelativePaths = @($serverRelativePaths)
if ($FrozenPurchase) {
  $effectiveServerRelativePaths = @(
    $serverRelativePaths |
      Where-Object {
        -not $_.StartsWith(
          'dist/server/modules/purchase-inventory/',
          [System.StringComparison]::OrdinalIgnoreCase
        )
      }
  )
}

$duplicateExplicitPaths = @(
  @($effectiveServerRelativePaths + $sharedRelativePaths + $operationalScriptRelativePaths) |
    Group-Object |
    Where-Object { $_.Count -gt 1 }
)
if ($duplicateExplicitPaths.Count -gt 0) {
  throw "Duplicate explicit hotfix paths: $($duplicateExplicitPaths.Name -join ', ')"
}

$blockedFileNames = @(
  '.env'
  '.env.local'
  '.env.production'
  'nantong-schedule.private.env'
  '.npmrc'
  '.netrc'
  'credentials'
  'credentials.json'
  'secrets.json'
  'id_rsa'
  'id_ed25519'
)

$blockedExtensions = @(
  '.map'
  '.pem'
  '.key'
  '.pfx'
  '.p12'
  '.p7b'
  '.p7c'
  '.jks'
  '.keystore'
  '.kdb'
  '.ovpn'
  '.ppk'
  '.pkcs8'
  '.secret'
  '.secrets'
  '.db'
  '.sqlite'
  '.sqlite3'
  '.log'
  '.bak'
  '.ts'
  '.tsx'
)

$sensitiveTextExtensions = @('.css', '.html', '.js', '.mjs', '.ps1', '.json', '.md', '.svg', '.txt', '.xml')
$sensitiveRecipientIdentifierPattern = '\b(?:ou|oc)_[A-Za-z0-9_-]{16,}\b'
$blockedSensitiveContentPatterns = @(
  '-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----'
  '(?im)^\s*(?:FEISHU_APP_SECRET|APP_SECRET|CLIENT_SECRET|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN)\s*=\s*\S+\s*$'
  '(?i)"(?:app_secret|client_secret|password|access_token|refresh_token)"\s*:\s*"[^"\r\n]+"'
  '(?im)^\s*\$env:(?:COS_SECRET_ID|COS_SECRET_KEY|COS_SESSION_TOKEN|TENCENTCLOUD_SECRET_ID|TENCENTCLOUD_SECRET_KEY|TENCENTCLOUD_SESSION_TOKEN)\s*=\s*[''"][^''"\r\n]+[''"]\s*$'
  '(?is)\[Environment\]::SetEnvironmentVariable\(\s*[''"](?:COS_SECRET_ID|COS_SECRET_KEY|COS_SESSION_TOKEN|TENCENTCLOUD_SECRET_ID|TENCENTCLOUD_SECRET_KEY|TENCENTCLOUD_SESSION_TOKEN)[''"]\s*,\s*[''"][^''"\r\n]+[''"]'
)

# These compiled runtime files contain historical default Feishu recipients.
# Each exception is constrained by archive path, full SHA-256 fingerprint, and
# exact occurrence count. No raw identifier is stored here, and any path,
# fingerprint, or count change fails closed.
$allowedRuntimeSensitiveIdentifierFingerprintsByPath = @{
  'dist/server/modules/bitable-sync/certificate-dashboard-notification.service.js' = @{
    '0427af2d7ed87da860ffa1fe77c819090d7e4b9a0adfa65555017305a0a26511' = 1
  }
  'dist/server/modules/duty-schedule/duty-schedule.service.js' = @{
    '100c860f172f34296327e299574bb47484b97616132ec9939a2454998daf8671' = 1
  }
  'dist/server/modules/duty-schedule/duty-screenshot.service.js' = @{
    '100c860f172f34296327e299574bb47484b97616132ec9939a2454998daf8671' = 1
    '1238beb1e34ecc1ba0c16ff22f5eb9d705d4a01e086dc7cd96a14bca801d44a8' = 1
  }
  'dist/server/modules/duty-schedule/typhoon-warning-alert.js' = @{
    '1238beb1e34ecc1ba0c16ff22f5eb9d705d4a01e086dc7cd96a14bca801d44a8' = 1
  }
  'dist/server/modules/inventory-management/inventory-workflow.rules.js' = @{
    '14f08388f85662d4ae0d1af52a3f194ad71243efd6a522c94440127e294ce85f' = 1
    '273a213c1910a0bd51020957e6f913f414ecd2b0c214753b8c9b803fe216ad02' = 1
    '5512054f12509ae04f7a2cdc6d96e828573df810a6a84cf413b08d605beb5f42' = 1
    '81149d2489de58681a444a67ff064dda3922e76b9d5ae49ca722005fcae26534' = 6
    'ae736ad31e6435795ba897941cc57e3592df1dbf8d1e40f175f0780fb026ce28' = 1
    'c3d8f95e09f2afa68fae8c7e0f793ea49eb6ec90ca3b22df812556d1e30b1251' = 1
    'c97e4c8f1d9876a755ecd0b4ba6abb6ec6f0986f3c00059e29e2a118c4ae24ad' = 1
    'cf9e8cdd6f88f76f2814d9c77050c395574da8522920cc92e0e7d6ec2b22039f' = 1
    'ea1dd8d7d547095e383ee5ed99323844709e0c4d76d6f440793b40f9da609881' = 1
    'f4023f83957d17c1ce419a5bc7a6ac819fde0dd79b87511f4a36f6fc58d2c4f5' = 1
  }
}

function Assert-NoReparsePointPath {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $current = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse-point path: $current"
      }
    }

    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) {
      break
    }
    $current = $parent.FullName
  }
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory)]
    [string]$Root,
    [Parameter(Mandatory)]
    [string]$Candidate
  )

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
  $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar

  Assert-NoReparsePointPath -Path $rootFull
  Assert-NoReparsePointPath -Path $candidateFull

  if (-not $candidateFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the allowed root: $Candidate"
  }

  return $candidateFull
}

function Convert-ToArchivePath {
  param(
    [Parameter(Mandatory)]
    [string]$Root,
    [Parameter(Mandatory)]
    [string]$Path
  )

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $pathFull = Assert-ChildPath -Root $rootFull -Candidate $Path
  return $pathFull.Substring($rootFull.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
}

function Assert-AllowedRelativePath {
  param(
    [Parameter(Mandatory)]
    [string]$RelativePath
  )

  $normalized = $RelativePath.Replace('\', '/')
  $fileName = [System.IO.Path]::GetFileName($normalized).ToLowerInvariant()
  $extension = [System.IO.Path]::GetExtension($fileName).ToLowerInvariant()

  if ($blockedFileNames -contains $fileName -or $fileName.StartsWith('.env.', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Blocked source, runtime, or credential file: $RelativePath"
  }
  if ($blockedExtensions -contains $extension) {
    throw "Blocked source, runtime, or credential file: $RelativePath"
  }

  foreach ($segment in ($normalized -split '/')) {
    if (@('data', 'logs', 'node_modules', 'state') -contains $segment.ToLowerInvariant()) {
      throw "Blocked runtime directory: $RelativePath"
    }
  }
}

function Assert-SafeSourceItem {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [bool]$ExpectDirectory
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Required build artifact is missing: $Path"
  }

  Assert-NoReparsePointPath -Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -ne $ExpectDirectory) {
    throw "Unexpected artifact type: $Path"
  }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing reparse-point artifact: $Path"
  }

  return $item
}

function Assert-NoSensitiveContent {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$RelativePath
  )

  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($sensitiveTextExtensions -notcontains $extension) {
    return
  }

  $content = [System.IO.File]::ReadAllText($Path)
  $normalizedRelativePath = $RelativePath.Replace('\', '/')
  $recipientMatches = [System.Text.RegularExpressions.Regex]::Matches(
    $content,
    $sensitiveRecipientIdentifierPattern
  )
  $hasAuditedRecipients = $allowedRuntimeSensitiveIdentifierFingerprintsByPath.ContainsKey(
    $normalizedRelativePath
  )

  if ($recipientMatches.Count -gt 0 -or $hasAuditedRecipients) {
    if (-not $hasAuditedRecipients) {
      throw "Blocked non-audited recipient identifier in packaged artifact: $RelativePath"
    }

    $actualFingerprints = @{}
    foreach ($match in $recipientMatches) {
      $sha256 = [System.Security.Cryptography.SHA256]::Create()
      try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($match.Value)
        $fingerprint = [System.BitConverter]::ToString(
          $sha256.ComputeHash($bytes)
        ).Replace('-', '').ToLowerInvariant()
      } finally {
        $sha256.Dispose()
      }

      if ($actualFingerprints.ContainsKey($fingerprint)) {
        $actualFingerprints[$fingerprint] = [int]$actualFingerprints[$fingerprint] + 1
      } else {
        $actualFingerprints[$fingerprint] = 1
      }
    }

    $expectedFingerprints = $allowedRuntimeSensitiveIdentifierFingerprintsByPath[$normalizedRelativePath]
    $matchesAudit = $actualFingerprints.Count -eq $expectedFingerprints.Count
    if ($matchesAudit) {
      foreach ($fingerprint in $expectedFingerprints.Keys) {
        if (
          -not $actualFingerprints.ContainsKey($fingerprint) -or
          [int]$actualFingerprints[$fingerprint] -ne [int]$expectedFingerprints[$fingerprint]
        ) {
          $matchesAudit = $false
          break
        }
      }
    }
    if (-not $matchesAudit) {
      throw "Audited runtime recipient identifiers changed in packaged artifact: $RelativePath"
    }
  }

  foreach ($pattern in $blockedSensitiveContentPatterns) {
    if ([System.Text.RegularExpressions.Regex]::IsMatch($content, $pattern)) {
      throw "Blocked sensitive content in packaged artifact: $RelativePath"
    }
  }
}

function Copy-RequiredFile {
  param(
    [Parameter(Mandatory)]
    [string]$Source,
    [Parameter(Mandatory)]
    [string]$Destination,
    [Parameter(Mandatory)]
    [string]$RelativePath
  )

  Assert-AllowedRelativePath -RelativePath $RelativePath
  [void](Assert-SafeSourceItem -Path $Source -ExpectDirectory $false)
  Assert-NoSensitiveContent -Path $Source -RelativePath $RelativePath
  $destinationParent = Split-Path -Parent $Destination
  [void](New-Item -ItemType Directory -Path $destinationParent -Force)
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory {
  param(
    [Parameter(Mandatory)]
    [string]$Source,
    [Parameter(Mandatory)]
    [string]$Destination,
    [Parameter(Mandatory)]
    [string]$RelativeRoot
  )

  $sourceItem = Assert-SafeSourceItem -Path $Source -ExpectDirectory $true
  $sourceFull = $sourceItem.FullName.TrimEnd([char[]]@('\', '/'))
  $destinationFull = [System.IO.Path]::GetFullPath($Destination)
  foreach ($item in @(Get-ChildItem -LiteralPath $sourceFull -Force -Recurse)) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing reparse-point artifact: $($item.FullName)"
    }
    Assert-NoReparsePointPath -Path $item.FullName
    $relativeTail = $item.FullName.Substring($sourceFull.Length).TrimStart([char[]]@('\', '/'))
    $relativePath = Join-Path $RelativeRoot $relativeTail
    Assert-AllowedRelativePath -RelativePath $relativePath
    if ($item.PSIsContainer) {
      $destinationDirectory = Join-Path $destinationFull $relativeTail
      Assert-NoReparsePointPath -Path $destinationDirectory
      [void](New-Item -ItemType Directory -Path $destinationDirectory -Force)
    }
  }

  Assert-NoReparsePointPath -Path $destinationFull
  [void](New-Item -ItemType Directory -Path $destinationFull -Force)
  foreach ($file in @(Get-ChildItem -LiteralPath $sourceFull -Force -Recurse -File)) {
    $relativeTail = $file.FullName.Substring($sourceFull.Length).TrimStart([char[]]@('\', '/'))
    $relativePath = Join-Path $RelativeRoot $relativeTail
    $destinationPath = Join-Path $destinationFull $relativeTail
    Copy-RequiredFile `
      -Source $file.FullName `
      -Destination $destinationPath `
      -RelativePath $relativePath
  }
}

function Test-ClientIndexLoadsRootMainBundle {
  param(
    [Parameter(Mandatory)]
    [string]$Html
  )

  $tagPattern = [System.Text.RegularExpressions.Regex]::new(
    '(?is)<(?:"[^"]*"|''[^'']*''|[^''">])*>'
  )
  $tagNamePattern = [System.Text.RegularExpressions.Regex]::new(
    '(?is)^<(?<closing>/)?(?<name>[A-Za-z][A-Za-z0-9:_-]*)'
  )
  $closingScriptPattern = [System.Text.RegularExpressions.Regex]::new(
    '(?is)</script\s*>'
  )
  $attributePattern = [System.Text.RegularExpressions.Regex]::new(
    '(?is)^\s*(?<name>[^\s"''=<>/`]+)(?:\s*=\s*(?:"(?<double>[^"]*)"|''(?<single>[^'']*)''|(?<unquoted>[^\s"''=<>`]+)))?'
  )
  $rootMainPattern = [System.Text.RegularExpressions.Regex]::new(
    '(?is)^(?:/|\./)?main\.js(?:[?#].*)?$'
  )

  $inertContainerNames = @('template', 'noscript')
  $rawTextElementNames = @('textarea', 'title', 'style', 'xmp', 'iframe', 'noembed', 'noframes')
  $inertDepth = 0
  $htmlOffset = 0
  while ($htmlOffset -lt $Html.Length) {
    $lessThanIndex = $Html.IndexOf('<', $htmlOffset, [System.StringComparison]::Ordinal)
    if ($lessThanIndex -lt 0) {
      break
    }
    if ($Html.Substring($lessThanIndex).StartsWith('<!--', [System.StringComparison]::Ordinal)) {
      $commentEnd = $Html.IndexOf('-->', $lessThanIndex + 4, [System.StringComparison]::Ordinal)
      if ($commentEnd -lt 0) {
        break
      }
      $htmlOffset = $commentEnd + 3
      continue
    }

    $tag = $tagPattern.Match($Html, $lessThanIndex)
    if (-not $tag.Success -or $tag.Index -ne $lessThanIndex) {
      $htmlOffset = $lessThanIndex + 1
      continue
    }
    $htmlOffset = $tag.Index + $tag.Length
    $tagName = $tagNamePattern.Match($tag.Value)
    if (-not $tagName.Success) {
      continue
    }
    $elementName = $tagName.Groups['name'].Value.ToLowerInvariant()
    $isClosingTag = $tagName.Groups['closing'].Success
    if ($inertContainerNames -contains $elementName) {
      if ($isClosingTag) {
        if ($inertDepth -gt 0) {
          $inertDepth -= 1
        }
      } else {
        $inertDepth += 1
      }
      continue
    }
    if (-not $isClosingTag -and $rawTextElementNames -contains $elementName) {
      $escapedElementName = [System.Text.RegularExpressions.Regex]::Escape($elementName)
      $closingRawTextPattern = [System.Text.RegularExpressions.Regex]::new(
        "(?is)</$escapedElementName\s*>"
      )
      $closingRawText = $closingRawTextPattern.Match($Html, $htmlOffset)
      if (-not $closingRawText.Success) {
        break
      }
      $htmlOffset = $closingRawText.Index + $closingRawText.Length
      continue
    }
    if ($isClosingTag -or $elementName -ne 'script') {
      continue
    }

    if ($inertDepth -eq 0) {
      $attributes = $tag.Value.Substring(
        $tagName.Length,
        $tag.Value.Length - $tagName.Length - 1
      )
      $attributeOffset = 0
      $attributesValid = $true
      $srcSeen = $false
      $duplicateSrc = $false
      $srcValue = $null
      while ($attributeOffset -lt $attributes.Length) {
        $remaining = $attributes.Substring($attributeOffset)
        if ([System.Text.RegularExpressions.Regex]::IsMatch($remaining, '^\s*/?\s*$')) {
          break
        }
        $attribute = $attributePattern.Match($remaining)
        if (-not $attribute.Success -or $attribute.Length -eq 0) {
          $attributesValid = $false
          break
        }
        if ($attribute.Groups['name'].Value -ieq 'src') {
          if ($srcSeen) {
            $duplicateSrc = $true
            break
          }
          $srcSeen = $true
          foreach ($groupName in @('double', 'single', 'unquoted')) {
            if ($attribute.Groups[$groupName].Success) {
              $srcValue = $attribute.Groups[$groupName].Value
              break
            }
          }
        }
        $attributeOffset += $attribute.Length
      }
      if (
        $attributesValid -and
        -not $duplicateSrc -and
        $srcSeen -and
        $null -ne $srcValue -and
        $rootMainPattern.IsMatch($srcValue)
      ) {
        return $true
      }
    }

    $closingScript = $closingScriptPattern.Match($Html, $htmlOffset)
    if (-not $closingScript.Success) {
      break
    }
    $htmlOffset = $closingScript.Index + $closingScript.Length
  }
  return $false
}

function Test-ClientJavaScriptReachableFromMainBundle {
  param(
    [Parameter(Mandatory)]
    [string]$RelativePath,
    [Parameter(Mandatory)]
    [string]$MainBundleContent
  )

  $normalized = $RelativePath.Replace('\', '/')
  if ($normalized -eq 'main.js') {
    return $true
  }

  $chunkMatch = [System.Text.RegularExpressions.Regex]::Match(
    $normalized,
    '^chunks/(?<id>\d+)\.(?<hash>[a-f0-9]+)\.js$',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $chunkMatch.Success) {
    return $false
  }

  $chunkId = $chunkMatch.Groups['id'].Value
  $chunkHash = $chunkMatch.Groups['hash'].Value
  $hasLoadCall =
    $MainBundleContent.Contains('.e("' + $chunkId + '")') -or
    $MainBundleContent.Contains(".e('" + $chunkId + "')")
  $hasHashMapping =
    $MainBundleContent.Contains($chunkId + ':"' + $chunkHash + '"') -or
    $MainBundleContent.Contains('"' + $chunkId + '":"' + $chunkHash + '"')
  return $hasLoadCall -and $hasHashMapping
}

function Assert-ClientHotfixBoundary {
  param(
    [Parameter(Mandatory)]
    [string]$Root,
    [switch]$FrozenPurchase
  )

  [void](Assert-SafeSourceItem -Path $Root -ExpectDirectory $true)
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $requiredClientAssets = @(
    'favicon.svg'
    'index.html'
    'main.css'
    'main.js'
    'main.legacy.css'
    'polyfills.js'
    'routes.json'
  )
  foreach ($assetName in $requiredClientAssets) {
    $assetPath = Assert-ChildPath -Root $rootFull -Candidate (Join-Path $rootFull $assetName)
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
      throw "Client build is missing required client asset: $assetName"
    }
    [void](Assert-SafeSourceItem -Path $assetPath -ExpectDirectory $false)
  }
  $indexPath = Assert-ChildPath -Root $rootFull -Candidate (Join-Path $rootFull 'index.html')
  $indexContent = [System.IO.File]::ReadAllText($indexPath)
  if (-not (Test-ClientIndexLoadsRootMainBundle -Html $indexContent)) {
    throw 'Client index.html does not load main.js'
  }
  $mainBundlePath = Assert-ChildPath -Root $rootFull -Candidate (Join-Path $rootFull 'main.js')
  $mainBundleContent = [System.IO.File]::ReadAllText($mainBundlePath)
  foreach ($file in @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force)) {
    Assert-NoReparsePointPath -Path $file.FullName
    $relativeTail = $file.FullName.Substring($rootFull.Length).TrimStart([char[]]@('\', '/'))
    $relativePath = Join-Path $clientRelativePath $relativeTail
    Assert-AllowedRelativePath -RelativePath $relativePath
    Assert-NoSensitiveContent -Path $file.FullName -RelativePath $relativePath
  }
  $javaScriptFiles = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.js')
  if ($javaScriptFiles.Count -eq 0) {
    throw "Client build contains no JavaScript: $Root"
  }
  $requiredWeatherMarkers = @(
    '预警与戒备信息'
    '检查附件'
    'application/pdf'
    'PDF 扫描件'
    '提交戒备登记'
  )
  $foundWeatherMarkers = @{}
  $requiredOvertimeMarkers = @(
    '/api/duty-schedules/overtime-request'
    '加班申请'
    '加班工时：'
    '加班申请已受理，正在后台同步'
    '加班举证'
    'overtime-evidence'
    '长白班工作日加班仅可选择 09:00 前或 18:00 后'
    '所选加班与本人排班连续值守达到 24 小时，请缩短或调整时段'
  )
  $foundOvertimeMarkers = @{}
  $requiredChangeMarkers = @(
    '/api/duty-schedules/change-request'
    '/api/duty-schedules/change-adjustment'
    '/api/duty-schedules/change-drill-report'
    '/api/duty-schedules/change-attachments/stage'
    '变更申请'
    '变更调整'
    '演练提交'
    '演练报告'
    '请从人员名单中选择提交人'
    '变更调整正在后台同步'
    '单个不超过 200 MB'
  )
  $foundChangeMarkers = @{}
  $requiredAccessMarkers = @(
    '统一权限登录'
    '当前页面需要登录权限'
  )
  $foundAccessMarkers = @{}
  $requiredPurchaseMarkers = if ($FrozenPurchase) {
    @()
  } else {
    @(
      '采购形式'
      '单一采购'
      '单一原因'
      '确认到货签收'
      'aria-busy'
      '提交中'
    )
  }
  $forbiddenFrozenPurchaseMarkers = @(
    '采购形式'
    '单一采购'
    '单一原因'
  )
  $foundPurchaseMarkers = @{}
  $requiredPurchaseActiveSyncMarkers = if ($FrozenPurchase) {
    @()
  } else {
    @(
      '采购基础数据正在同步，本次申请已先显示。'
      '正在同步采购数据'
      '正在使用原申请编号自动找回受理任务'
    )
  }
  $foundPurchaseActiveSyncMarkers = @{}
  $requiredInventoryStorageLocationMarkers = @(
    '/api/inventory-management/storage-locations'
    '新增位置'
    '存放位置分类'
    '库内'
    '库外'
    'locationRecordId'
    'clientMutationId'
    '保存并选中'
    '当前内容已保留，请重试'
  )
  $requiredInventoryStorageLocationRootMarkers = @(
    '/api/inventory-management/storage-locations'
    'clientMutationId'
  )
  $requiredInventoryStorageLocationUiMarkers = @(
    $requiredInventoryStorageLocationMarkers |
      Where-Object { $_ -notin $requiredInventoryStorageLocationRootMarkers }
  )
  $foundInventoryStorageLocationMarkers = @{}
  $requiredInventoryOutboundMarkers = @(
    '/api/inventory-management/outbounds/'
    'clientMutationId'
    '待库房确认'
    '查看并确认'
    '库房确认出库'
    '确认出库'
    '恢复草稿已锁定，请使用原出库编号重试'
    '结果暂不确定；请使用原编号安全重试'
    '任务均已取得服务端编号，可继续办理下一笔；系统会在后台逐笔核对。'
  )
  $requiredInventoryOutboundRootMarkers = @(
    '/api/inventory-management/outbounds/'
    'clientMutationId'
  )
  $requiredInventoryOutboundUiMarkers = @(
    $requiredInventoryOutboundMarkers |
      Where-Object { $_ -notin $requiredInventoryOutboundRootMarkers }
  )
  $foundInventoryOutboundMarkers = @{}
  $requiredInventoryMovementDeletionMarkers = @(
    '/api/inventory-management/movements/deletions'
    '/api/inventory-management/movements/deletions/tasks/'
    '记录已从当前清单隐藏，正在后台同步删除'
    '后台尚未确认的记录不能删除'
  )
  $requiredInventoryMovementDeletionRootMarkers = @(
    '/api/inventory-management/movements/deletions'
    '/api/inventory-management/movements/deletions/tasks/'
  )
  $requiredInventoryMovementDeletionUiMarkers = @(
    $requiredInventoryMovementDeletionMarkers |
      Where-Object { $_ -notin $requiredInventoryMovementDeletionRootMarkers }
  )
  $foundInventoryMovementDeletionMarkers = @{}
  $purchaseReceiptBundleFound = $false
  $inventoryStorageLocationUiBundles = @()
  $inventoryOutboundUiBundles = @()
  $inventoryMovementDeletionUiBundles = @()
  foreach ($file in $javaScriptFiles) {
    Assert-NoReparsePointPath -Path $file.FullName
    $content = [System.IO.File]::ReadAllText($file.FullName)
    $relativeTail = $file.FullName.Substring($rootFull.Length).TrimStart([char[]]@('\', '/'))
    $isReachableFromMainBundle = Test-ClientJavaScriptReachableFromMainBundle `
      -RelativePath $relativeTail `
      -MainBundleContent $mainBundleContent
    foreach ($marker in $requiredWeatherMarkers) {
      if ($content.Contains($marker)) {
        $foundWeatherMarkers[$marker] = $true
      }
    }
    foreach ($marker in $requiredOvertimeMarkers) {
      $hasMarker = if ($marker -eq '加班申请') {
        [System.Text.RegularExpressions.Regex]::IsMatch(
          $content,
          '(?<![\p{L}\p{N}_])加班申请(?![\p{L}\p{N}_])'
        )
      } else {
        $content.Contains($marker)
      }
      if ($hasMarker) {
        $foundOvertimeMarkers[$marker] = $true
      }
    }
    foreach ($marker in $requiredChangeMarkers) {
      if ($content.Contains($marker)) {
        $foundChangeMarkers[$marker] = $true
      }
    }
    foreach ($marker in $requiredAccessMarkers) {
      if ($content.Contains($marker)) {
        $foundAccessMarkers[$marker] = $true
      }
    }
    if ($FrozenPurchase) {
      foreach ($marker in $forbiddenFrozenPurchaseMarkers) {
        if ($content.Contains($marker)) {
          throw "Frozen-purchase client contains current purchase-page marker '$marker'"
        }
      }
    }
    foreach ($marker in $requiredPurchaseMarkers) {
      if ($content.Contains($marker)) {
        $foundPurchaseMarkers[$marker] = $true
      }
    }
    foreach ($marker in $requiredPurchaseActiveSyncMarkers) {
      if ($isReachableFromMainBundle -and $content.Contains($marker)) {
        $foundPurchaseActiveSyncMarkers[$marker] = $true
      }
    }
    if ($isReachableFromMainBundle) {
      foreach ($marker in $requiredInventoryStorageLocationMarkers) {
        if ($content.Contains($marker)) {
          $foundInventoryStorageLocationMarkers[$marker] = $true
        }
      }
      $hasEveryStorageLocationUiMarker = $true
      foreach ($marker in $requiredInventoryStorageLocationUiMarkers) {
        if (-not $content.Contains($marker)) {
          $hasEveryStorageLocationUiMarker = $false
          break
        }
      }
      if ($hasEveryStorageLocationUiMarker) {
        $inventoryStorageLocationUiBundles += $file.FullName
      }
      foreach ($marker in $requiredInventoryOutboundMarkers) {
        if ($content.Contains($marker)) {
          $foundInventoryOutboundMarkers[$marker] = $true
        }
      }
      $hasEveryInventoryOutboundUiMarker = $true
      foreach ($marker in $requiredInventoryOutboundUiMarkers) {
        if (-not $content.Contains($marker)) {
          $hasEveryInventoryOutboundUiMarker = $false
          break
        }
      }
      if ($hasEveryInventoryOutboundUiMarker) {
        $inventoryOutboundUiBundles += $file.FullName
      }
      foreach ($marker in $requiredInventoryMovementDeletionMarkers) {
        if ($content.Contains($marker)) {
          $foundInventoryMovementDeletionMarkers[$marker] = $true
        }
      }
      $hasEveryInventoryMovementDeletionUiMarker = $true
      foreach ($marker in $requiredInventoryMovementDeletionUiMarkers) {
        if (-not $content.Contains($marker)) {
          $hasEveryInventoryMovementDeletionUiMarker = $false
          break
        }
      }
      if ($hasEveryInventoryMovementDeletionUiMarker) {
        $inventoryMovementDeletionUiBundles += $file.FullName
      }
    }
    if ($content.Contains('确认到货签收') -and $content.Contains('receiptPhotos')) {
      $purchaseReceiptBundleFound = $true
      if (-not $FrozenPurchase) {
        foreach ($marker in @('采购形式', '单一采购', '单一原因', 'showSpinner', 'aria-busy', '提交中')) {
          if (-not $content.Contains($marker)) {
            throw "Purchase receipt action-state marker is missing from one bundle: $marker"
          }
        }
        if (-not [System.Text.RegularExpressions.Regex]::IsMatch(
          $content,
          'return\{disabled:(?<disabled>[\w$]+)\|\|(?<loading>[\w$]+),showSpinner:\k<loading>\}'
        )) {
          throw 'Purchase receipt action-state does not separate disabled and loading'
        }
        if (-not [System.Text.RegularExpressions.Regex]::IsMatch(
          $content,
          'receiptPhotos:[\w$]+,invoices:[\w$]+,disabled:[\w$]+,loading:!1'
        )) {
          throw 'Purchase receipt form does not release loading before background sync'
        }
      }
    }
    if ($content.Contains('预警卡片测试')) {
      throw "Client build still contains the removed weather test control: $($file.FullName)"
    }
    if ($isReachableFromMainBundle -and $content.Contains('跨楼栋待确认')) {
      throw "Client build still contains the removed outbound status: 跨楼栋待确认"
    }
  }

  foreach ($marker in $requiredWeatherMarkers) {
    if (-not $foundWeatherMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required weather marker '$marker'"
    }
  }
  foreach ($marker in $requiredOvertimeMarkers) {
    if (-not $foundOvertimeMarkers.ContainsKey($marker)) {
      if ($marker -eq '加班申请') {
        throw "Client main bundle and reachable chunks are missing the required overtime product name marker '$marker'"
      }
      throw "Client main bundle and reachable chunks are missing the required overtime marker '$marker'"
    }
  }
  foreach ($marker in $requiredChangeMarkers) {
    if (-not $foundChangeMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required change marker '$marker'"
    }
  }
  foreach ($marker in $requiredAccessMarkers) {
    if (-not $foundAccessMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required access marker '$marker'"
    }
  }
  foreach ($marker in $requiredPurchaseMarkers) {
    if (-not $foundPurchaseMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required purchase marker '$marker'"
    }
  }
  foreach ($marker in $requiredPurchaseActiveSyncMarkers) {
    if (-not $foundPurchaseActiveSyncMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required purchase active-sync marker '$marker'"
    }
  }
  foreach ($marker in $requiredInventoryStorageLocationRootMarkers) {
    if (-not $mainBundleContent.Contains($marker)) {
      throw "Client main bundle is missing the required marker '$marker'"
    }
  }
  foreach ($marker in $requiredInventoryStorageLocationMarkers) {
    if (-not $foundInventoryStorageLocationMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required inventory storage-location marker '$marker'"
    }
  }
  if ($inventoryStorageLocationUiBundles.Count -ne 1) {
    throw "Client must contain exactly one reachable inventory storage-location UI bundle; found $($inventoryStorageLocationUiBundles.Count)"
  }
  foreach ($marker in $requiredInventoryOutboundRootMarkers) {
    if (-not $mainBundleContent.Contains($marker)) {
      throw "Client main bundle is missing the required inventory outbound marker '$marker'"
    }
  }
  foreach ($marker in $requiredInventoryOutboundMarkers) {
    if (-not $foundInventoryOutboundMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required inventory outbound marker '$marker'"
    }
  }
  if ($inventoryOutboundUiBundles.Count -ne 1) {
    throw "Client must contain exactly one reachable inventory outbound UI bundle; found $($inventoryOutboundUiBundles.Count)"
  }
  foreach ($marker in $requiredInventoryMovementDeletionRootMarkers) {
    if (-not $mainBundleContent.Contains($marker)) {
      throw "Client main bundle is missing the required inventory movement-deletion marker '$marker'"
    }
  }
  foreach ($marker in $requiredInventoryMovementDeletionMarkers) {
    if (-not $foundInventoryMovementDeletionMarkers.ContainsKey($marker)) {
      throw "Client main bundle and reachable chunks are missing the required inventory movement-deletion marker '$marker'"
    }
  }
  if ($inventoryMovementDeletionUiBundles.Count -ne 1) {
    throw "Client must contain exactly one reachable inventory movement-deletion UI bundle; found $($inventoryMovementDeletionUiBundles.Count)"
  }
  if (-not $FrozenPurchase -and -not $purchaseReceiptBundleFound) {
    throw 'Client build is missing the purchase receipt action-state bundle'
  }
}

function Resolve-LocalRuntimeDependency {
  param(
    [Parameter(Mandatory)]
    [string]$Root,
    [Parameter(Mandatory)]
    [string]$FromRelativePath,
    [Parameter(Mandatory)]
    [string]$Request
  )

  if (-not $Request.StartsWith('.')) {
    return $null
  }

  Assert-AllowedRelativePath -RelativePath $FromRelativePath
  $fromPath = Assert-ChildPath -Root $Root -Candidate (Join-Path $Root $FromRelativePath)
  [void](Assert-SafeSourceItem -Path $fromPath -ExpectDirectory $false)

  $candidateStem = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $fromPath) $Request))
  $candidates = @(
    $candidateStem
    "$candidateStem.js"
    (Join-Path $candidateStem 'index.js')
  )

  foreach ($candidate in $candidates) {
    $safeCandidate = Assert-ChildPath -Root $Root -Candidate $candidate
    if (-not (Test-Path -LiteralPath $safeCandidate -PathType Leaf)) {
      continue
    }

    [void](Assert-SafeSourceItem -Path $safeCandidate -ExpectDirectory $false)
    $relativePath = Convert-ToArchivePath -Root $Root -Path $safeCandidate
    Assert-AllowedRelativePath -RelativePath $relativePath

    $isServerRuntime = $relativePath.StartsWith('dist/server/', [System.StringComparison]::OrdinalIgnoreCase)
    $isSharedRuntime = $relativePath.StartsWith('dist/shared/', [System.StringComparison]::OrdinalIgnoreCase)
    if (-not ($isServerRuntime -or $isSharedRuntime)) {
      throw "Local runtime dependency is outside the allowed compiled output: $FromRelativePath -> $Request"
    }
    return $relativePath
  }

  throw "Missing local runtime dependency: $FromRelativePath -> $Request"
}

function Get-LocalRuntimeDependencyClosure {
  param(
    [Parameter(Mandatory)]
    [string]$Root,
    [Parameter(Mandatory)]
    [string[]]$EntryRelativePaths
  )

  $visited = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $pending = [System.Collections.Generic.Queue[string]]::new()
  foreach ($entryRelativePath in $EntryRelativePaths) {
    $normalizedEntry = $entryRelativePath.Replace('\', '/')
    Assert-AllowedRelativePath -RelativePath $normalizedEntry
    $pending.Enqueue($normalizedEntry)
  }

  while ($pending.Count -gt 0) {
    $relativePath = $pending.Dequeue()
    if (-not $visited.Add($relativePath)) {
      continue
    }

    $sourcePath = Assert-ChildPath -Root $Root -Candidate (Join-Path $Root $relativePath)
    [void](Assert-SafeSourceItem -Path $sourcePath -ExpectDirectory $false)
    $content = [System.IO.File]::ReadAllText($sourcePath)
    foreach ($match in [System.Text.RegularExpressions.Regex]::Matches($content, 'require\s*\(\s*["''](?<request>[^"'']+)["'']\s*\)')) {
      $dependency = Resolve-LocalRuntimeDependency `
        -Root $Root `
        -FromRelativePath $relativePath `
        -Request $match.Groups['request'].Value
      if ($null -ne $dependency) {
        $pending.Enqueue($dependency)
      }
    }
  }

  return @($visited | Sort-Object)
}

function Assert-CompiledMarkers {
  param(
    [Parameter(Mandatory)]
    [string]$Root,
    [switch]$FrozenPurchase
  )

  $checks = @(
    @{ RelativePath = 'dist/server/app.module.js'; Marker = 'WeatherWarningModule' }
    @{ RelativePath = 'dist/server/runtime-env.js'; Marker = 'NON_EMPTY_DOTENV_FALLBACK_KEYS' }
    @{ RelativePath = 'dist/server/common/feishu/bitable-direct-read.js'; Marker = 'Math.abs(field) < 100_000_000_000 ? field * 1000 : field' }
    @{ RelativePath = 'dist/server/common/feishu/bitable-direct-read.js'; Marker = 'automatic_fields' }
    @{ RelativePath = 'dist/server/common/feishu/bitable-direct-read.js'; Marker = 'automaticFields' }
    @{ RelativePath = 'dist/server/common/access/unified-access.module.js'; Marker = 'UnifiedAccessModule' }
    @{ RelativePath = 'dist/server/common/access/unified-access.controller.js'; Marker = 'UnifiedAccessController' }
    @{ RelativePath = 'dist/server/common/access/unified-access.service.js'; Marker = 'ACCESS_SESSION_TTL_MS' }
    @{ RelativePath = 'dist/server/common/access/unified-access.service.js'; Marker = 'principalFingerprint' }
    @{ RelativePath = 'dist/shared/change-request.js'; Marker = 'CHANGE_REQUEST_MAX_DOCUMENT_SIZE' }
    @{ RelativePath = 'dist/shared/change-request.js'; Marker = '单个变更文档不能超过 200 MiB' }
    @{ RelativePath = 'dist/shared/change-adjustment.js'; Marker = 'CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE' }
    @{ RelativePath = 'dist/shared/change-adjustment.js'; Marker = 'change-adjustment-UUID' }
    @{ RelativePath = 'dist/shared/change-drill-report.js'; Marker = 'change-drill-report-UUID' }
    @{ RelativePath = 'dist/shared/change-summary-report.js'; Marker = 'change-summary-report-UUID' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-request-document-validator.js'; Marker = 'validateOoxmlDocument' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-attachment-upload.js'; Marker = 'BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-attachment-storage.service.js'; Marker = '单个变更方案附件不能超过 200MB' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-attachment-storage.service.js'; Marker = 'deleteBoundForTrustedSelfTest' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-attachment-storage.service.js'; Marker = 'getDeletionStateForTrustedServer' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-attachment-temp-directory.js'; Marker = 'prepareChangeAttachmentTempDirectory' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-attachment-temp-directory.js'; Marker = 'removeExactChangeAttachmentTempFile' }
    @{ RelativePath = 'dist/shared/duty-staff-name.js'; Marker = 'normalizeDutyStaffDisplayName' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-adjustment.service.js'; Marker = 'CHANGE_ADJUSTMENT_MUTATION_LEDGER_DIR' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-drill-report.service.js'; Marker = 'CHANGE_DRILL_REPORT_MUTATION_LEDGER_DIR' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-summary-report.service.js'; Marker = 'CHANGE_SUMMARY_REPORT_MUTATION_LEDGER_DIR' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-summary-report.service.js'; Marker = 'self-test-cleaned' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.js'; Marker = 'finalizeFailedChangeSummarySelfTestLedgers' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.js'; Marker = 'vnet-change-summary-report-failed-self-test-cleanup-v1' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/change-adjustment-record.js'; Marker = 'mapChangeAdjustmentRecordSnapshot' }
    @{ RelativePath = 'scripts/ensure-change-adjustment-fields.mjs'; Marker = 'CHANGE_ADJUSTMENT_REQUIRED_FIELDS' }
    @{ RelativePath = 'scripts/ensure-change-drill-report-fields.mjs'; Marker = 'CHANGE_DRILL_REPORT_REQUIRED_FIELDS' }
    @{ RelativePath = 'scripts/ensure-change-summary-report-fields.mjs'; Marker = 'CHANGE_SUMMARY_REPORT_REQUIRED_FIELDS' }
    @{ RelativePath = 'scripts/self-test-change-adjustment.mjs'; Marker = 'CODEX-SELFTEST-CHANGE' }
    @{ RelativePath = 'scripts/self-test-change-adjustment.mjs'; Marker = 'MAX_SCHEME_BYTES' }
    @{ RelativePath = 'scripts/self-test-change-adjustment.mjs'; Marker = 'createChangeSelfTestCleanupProof' }
    @{ RelativePath = 'scripts/self-test-change-summary-report.mjs'; Marker = 'CODEX-SELFTEST-CHANGE-SUMMARY' }
    @{ RelativePath = 'dist/shared/overtime-request-impact.js'; Marker = 'calculateOvertimeRequestImpact' }
    @{ RelativePath = 'dist/shared/overtime-request-impact.js'; Marker = 'createOvertimeRequestImpactComparisonKey' }
    @{ RelativePath = 'dist/shared/overtime-request-impact.js'; Marker = 'long_white_workday_hours' }
    @{ RelativePath = 'dist/shared/overtime-request-impact.js'; Marker = 'continuous_duty_24_hours' }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'POST /api/duty-schedules/overtime-request' }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'accessPrincipalFingerprint' }
    @{ RelativePath = 'dist/server/common/filters/exception.filter.js'; Marker = 'createOvertimeRequestImpactComparisonKey' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'leave-request' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-attachments/stage' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-request' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-adjustment' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-drill-report' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-summary-report' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-summary-report/abandon' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-summary-report/self-test/cleanup-bound-attachment' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-summary-report/self-test/finalize-failed-cleanup' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-attachments/:id/self-test-deletion-state' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'ChangeAttachmentUploadAdmissionInterceptor' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'CHANGE_ATTACHMENT_ROUTE_UPLOAD_CONCURRENCY' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'CHANGE_ATTACHMENT_MAX_BYTES' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'parts: 3' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'parts: 6' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/change-adjustment/self-test/cleanup-bound-attachment' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'x-change-self-test-cleanup-proof' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'x-change-summary-self-test-cleanup-proof' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'x-change-summary-failed-self-test-cleanup-proof' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'duty-schedules/overtime-request' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.module.js'; Marker = 'ChangeAdjustmentService' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.module.js'; Marker = 'ChangeDrillReportService' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.module.js'; Marker = 'ChangeSummaryReportService' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.module.js'; Marker = 'EmergencyDutyController' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.module.js'; Marker = 'EmergencyDutyService' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/emergency-duty.controller.js'; Marker = 'EmergencyDutyController' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/emergency-duty.service.js'; Marker = 'EmergencyDutyService' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/emergency-duty.service.js'; Marker = 'unknown-result' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/emergency-duty.service.js'; Marker = 'definitely-not-written' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.controller.js'; Marker = 'overtimeRequestScreenshotFileFilter' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = 'createLeaveRequest' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = 'createOvertimeRequest' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = 'OVERTIME_REQUEST_MUTATION_LEDGER_DIR' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = 'deleteBoundForTrustedSelfTest' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = 'overtime-request-client-token:' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = '长白班工作日加班仅可选择 09:00 前或 18:00 后' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = '7×24 排班人员加班不得与本人排班连续值守达到 24 小时' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'; Marker = 'DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.rules.js'; Marker = 'requiresSupervisorSubstitute' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.card.js'; Marker = 'leave_substitute_person_record_id' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.callback.js'; Marker = 'leave_approve_submit:' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.service.js'; Marker = 'getCachedLeaveRequestImpactSchedules' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.service.js'; Marker = 'recoverApplicationsByLeaveCodes' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.scheduler.js'; Marker = 'recoverConfiguredApplications' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.gateway.js'; Marker = 'findLeaveRecordsByCodes' }
    @{ RelativePath = 'dist/server/modules/leave-workflow/leave-workflow.store.js'; Marker = 'substituteRequired' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/feishu-card-action.router.js'; Marker = 'leave_approve_submit:' }
    @{ RelativePath = 'dist/server/common/feishu/leave-approval-source.js'; Marker = 'SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD' }
    @{ RelativePath = 'dist/server/common/feishu/leave-approval-source.js'; Marker = '系统审批完成标记' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/approved-leave-visibility.js'; Marker = 'resolveApprovalAwareDutyStaffFromFields' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/today-operations-kpi.service.js'; Marker = 'APPROVAL_VISIBILITY_CACHE_VERSION' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/bitable-sync.module.js'; Marker = 'TodayOperationsScheduleConsistencyService' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/today-operations-anomaly.rules.js'; Marker = '已审批加班未更新排班' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/today-operations-anomaly.service.js'; Marker = 'scheduleConsistencyIssues' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/today-operations-anomaly.store.js'; Marker = 'knownIds' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/today-operations-schedule-consistency.js'; Marker = 'overtime_staff_missing' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/today-operations-schedule-consistency.service.js'; Marker = 'TodayOperationsScheduleConsistencyService' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/active-personnel-directory.js'; Marker = 'buildActivePersonnelDirectory' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/change-request-submitter-directory.js'; Marker = 'resolveChangeRequestSubmitterCandidate' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/change-request-submitter-directory.js'; Marker = 'listEligibleChangeRequestSubmitterNames' }
    @{ RelativePath = 'dist/server/modules/bitable-sync/bitable-sync.service.js'; Marker = 'getCachedActivePersonnelDirectory' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-screenshot.service.js'; Marker = 'captureAndSendDutyOverview' }
    @{ RelativePath = 'dist/server/modules/duty-schedule/duty-screenshot.service.js'; Marker = "source === 'manual'" }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'PURCHASE_APPLICANT_RECEIPT_TASK_PATH' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-inventory.module.js'; Marker = 'PurchaseWorkflowReceiptTaskService' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-application-task-ledger.store.js'; Marker = 'PurchaseApplicationTaskLedgerStore' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-application-task-ledger.store.js'; Marker = 'purchase-application-task-ledger.json' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-application.service.js'; Marker = 'revalidateSubmissionApplicant' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-application.service.js'; Marker = 'definitelyNotWritten' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-inventory.service.js'; Marker = 'ACTIVE_SOURCE_CACHE_TTL_MS' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-inventory.controller.js'; Marker = "Post)('workflows/:recordId/receive')" }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-inventory.controller.js'; Marker = "Get)('workflows/receipt-tasks/:taskId')" }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-inventory.controller.js'; Marker = 'HttpStatus.ACCEPTED' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js'; Marker = '到货签收已受理，正在后台同步飞书多维表' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js'; Marker = 'setImmediate(() => void this.executeTask(task.id))' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js'; Marker = 'canReadReceiptTask' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-workflow.rules.js'; Marker = '到货已签收（待入库）' }
    @{ RelativePath = 'dist/server/modules/purchase-inventory/purchase-workflow.rules.js'; Marker = 'isSameBuildingPurchaseApplicant' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js'; Marker = '请在确认入库时选择新增或已有' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js'; Marker = '请先生成新的物品类别号' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-storage-location.rules.js'; Marker = 'normalizeStorageLocationName' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-storage-location.service.js'; Marker = 'FEISHU_WAREHOUSE_STORAGE_LOCATION_TABLE_ID' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-storage-location.service.js'; Marker = 'clientMutationId' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = 'storage-locations' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.module.js'; Marker = 'InventoryStorageLocationService' }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'GET /api/inventory-management/storage-locations' }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'POST /api/inventory-management/storage-locations' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js'; Marker = 'resolveSelectedLocation' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js'; Marker = 'locationRecordId' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-category-task-ledger.store.js'; Marker = 'PurchaseInboundCategoryTaskLedgerStore' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-category-task-ledger.store.js'; Marker = 'purchase-inbound-category-task-ledger.json' }
    @{ RelativePath = 'dist/server/modules/inventory-management/purchase-inbound-category-task.service.js'; Marker = 'PurchaseInboundCategoryTaskService' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = 'purchase-inbounds/category-tasks' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-command.service.js'; Marker = 'locationRecordId' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js'; Marker = 'InventoryMovementDeletionTaskLedgerStore' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js'; Marker = 'inventory-movement-deletion-task-ledger.json' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js'; Marker = 'updateRecoveryState' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-deletion.service.js'; Marker = 'InventoryMovementDeletionService' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-deletion.service.js'; Marker = 'reconcileRunningTask' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-deletion.service.js'; Marker = 'recoveryCompensationWarning' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-operation-coordinator.js'; Marker = 'InventoryMovementOperationCoordinator' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = 'movements/deletions' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = "writeDisposition: 'definitely-not-written'" }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.module.js'; Marker = 'InventoryMovementDeletionService' }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'INVENTORY_ADMIN_MOVEMENT_DELETION_TASK_PATH' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-workflow.gateway.js'; Marker = 'data.items === undefined && data.total === 0 && data.has_more === false' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-canonical.js'; Marker = 'assertInventoryOutboundCanonicalRequest' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'; Marker = 'InventoryOutboundTaskLedgerStore' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'; Marker = 'inventory-outbound-task-ledger.json' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'; Marker = 'claimUncertain' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'; Marker = 'abandonUncertainClaim' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'; Marker = 'listUncertain' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js'; Marker = '出库不确定任务 owner 已变更' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-command.rules.js'; Marker = '出库数量: request.quantity' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = 'InventoryOutboundWorkflowService' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = '程序出库状态' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = '出库确认标识' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = 'assertPendingApplicationFingerprint' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = 'fieldPersonOpenId' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = '出库数量未持久化' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = 'repairMissingPendingFormalQuantity' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = 'reconcileClaimedUncertainTask' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = 'scheduleUncertainTask' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = 'outbounds/:recordId/confirm' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = "Post)('outbounds')" }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.controller.js'; Marker = '出库申请请使用异步出库接口 /api/inventory-management/outbounds' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-management.module.js'; Marker = 'InventoryOutboundWorkflowService' }
    @{ RelativePath = 'dist/server/common/access/unified-access.guard.js'; Marker = 'INVENTORY_ADMIN_OUTBOUND_CONFIRM_PATH' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.controller.js'; Marker = 'test-send' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.controller.js'; Marker = 'test-full-flow-send' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.controller.js'; Marker = 'test-full-flow-progress-send' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.controller.js'; Marker = 'registration/options' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.controller.js'; Marker = 'application/pdf' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.controller.js'; Marker = 'GuestSubmittable' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.module.js'; Marker = 'WeatherWarningModule' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.module.js'; Marker = 'WeatherWarningRegistrationService' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.rules.js'; Marker = 'validateWeatherGuardRegistration' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration-link.js'; Marker = 'weatherGuardRegistration' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.config.js'; Marker = 'loadWeatherWarningRegistrationRuntimeConfig' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'WeatherWarningRegistrationGateway' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'application/pdf' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'PDF_SIGNATURE' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'listManagerCandidateRecords' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'FEISHU_WEATHER_WARNING_MANAGER_TABLE_ID' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'FEISHU_PURCHASE_INVENTORY_SOURCE_URL' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'FEISHU_PURCHASE_ORGANIZATION_TABLE_ID' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'deleteRecordAndConfirmAbsent' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.service.js'; Marker = 'WeatherWarningRegistrationService' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.service.js'; Marker = 'buildCachedCandidateCatalog' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.service.js'; Marker = 'getCachedActivePersonnelDirectory' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.service.js'; Marker = 'deleteRecordAndConfirmAbsent' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.rules.js'; Marker = 'managerOpenIds' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = 'registrationUrl' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '提交戒备登记' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '执行进度 · 最近登记' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '楼栋进度' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = 'normalizeTemperatureMetric' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = 'normalizeHumidityMetric' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '${numeric}%' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '℃' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-check-scope.js'; Marker = 'resolveWeatherWarningCheckScope' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-notification.service.js'; Marker = 'sendFullFlowTest' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-notification.service.js'; Marker = 'sendFullFlowProgress' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-notification.service.js'; Marker = 'sendPersonalTestCard' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-test-simulation.js'; Marker = 'createWeatherWarningTestSimulationContext' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-test-simulation.js'; Marker = 'weather-e2e-' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-test-simulation.js'; Marker = 'WEATHER_WARNING_TEST_SIMULATION_SECRET' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.scheduler.js'; Marker = 'WeatherWarningScheduler' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning.scheduler.js'; Marker = 'config.pollIntervalMs' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.service.js'; Marker = 'WeatherWarningAutomationService' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.service.js'; Marker = 'forceRefresh: true' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.service.js'; Marker = 'buildWeatherWarningReminderCard' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.service.js'; Marker = 'config.reminderIntervalMs' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.service.js'; Marker = 'buildingProgress.incompleteItems' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.service.js'; Marker = '首次预警继续发送，本轮催办将跳过' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.config.js'; Marker = 'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.config.js'; Marker = 'FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation.config.js'; Marker = 'FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation-state-store.js'; Marker = 'weather-warning-automation-state.json' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-automation-state-store.js'; Marker = 'acquireWeatherWarningAutomationLease' }
  )

  if ($FrozenPurchase) {
    $checks = @(
      $checks |
        Where-Object {
          -not $_.RelativePath.StartsWith(
            'dist/server/modules/purchase-inventory/',
            [System.StringComparison]::OrdinalIgnoreCase
          )
        }
    )
  }

  foreach ($check in $checks) {
    $path = Assert-ChildPath -Root $Root -Candidate (Join-Path $Root $check.RelativePath)
    [void](Assert-SafeSourceItem -Path $path -ExpectDirectory $false)
    if (-not [System.IO.File]::ReadAllText($path).Contains($check.Marker)) {
      throw "Required compiled marker is missing: $($check.RelativePath) -> $($check.Marker)"
    }
  }

  $forbiddenChecks = @(
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '仅供关注' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '规则：重保类型对应表' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-card.js'; Marker = '状态：' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'FEISHU_ORG_APP_TOKEN' }
    @{ RelativePath = 'dist/server/modules/weather-warning/weather-warning-registration.gateway.js'; Marker = 'FEISHU_ORG_TABLE_ID' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-movement-command.rules.js'; Marker = '流程:' }
    @{ RelativePath = 'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'; Marker = '流程:' }
  )
  foreach ($check in $forbiddenChecks) {
    $path = Assert-ChildPath -Root $Root -Candidate (Join-Path $Root $check.RelativePath)
    [void](Assert-SafeSourceItem -Path $path -ExpectDirectory $false)
    if ([System.IO.File]::ReadAllText($path).Contains($check.Marker)) {
      throw "Forbidden compiled marker is present: $($check.RelativePath) -> $($check.Marker)"
    }
  }
}

function Get-StagedFileManifestEntries {
  param(
    [Parameter(Mandatory)]
    [string]$PackageRoot
  )

  $records = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Sort-Object FullName)) {
    $relativePath = Convert-ToArchivePath -Root $PackageRoot -Path $file.FullName
    Assert-AllowedRelativePath -RelativePath $relativePath
    $records += [ordered]@{
      path = $relativePath
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      bytes = [Int64]$file.Length
    }
  }
  return $records
}

function Assert-ArchiveMatchesStage {
  param(
    [Parameter(Mandatory)]
    [string]$ArchivePath,
    [Parameter(Mandatory)]
    [string]$PackageRoot
  )

  $expected = @(
    Get-ChildItem -LiteralPath $PackageRoot -Recurse -File |
      ForEach-Object { Convert-ToArchivePath -Root $PackageRoot -Path $_.FullName } |
      Sort-Object
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $actual = @(
      $archive.Entries |
        Where-Object {
          -not $_.FullName.EndsWith('/') -and
          -not $_.FullName.EndsWith('\')
        } |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Sort-Object -Unique
    )
    $difference = @(Compare-Object -ReferenceObject $expected -DifferenceObject $actual)
    if ($difference.Count -gt 0) {
      throw "Archive entries do not match staged files: $($difference | Out-String)"
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-FrozenPurchaseRequiredPackagePaths {
  return @(
    'dist/shared/change-request.js'
    'dist/shared/change-adjustment.js'
    'dist/shared/change-drill-report.js'
    'dist/shared/change-summary-report.js'
    'dist/server/common/access/unified-access.module.js'
    'dist/server/common/access/unified-access.controller.js'
    'dist/server/common/access/unified-access.service.js'
    'dist/server/common/access/unified-access.guard.js'
    'dist/server/modules/duty-schedule/change-drill-report.service.js'
    'dist/server/modules/duty-schedule/change-summary-report.service.js'
    'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.js'
    'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.js'
    'dist/server/modules/duty-schedule/duty-schedule.controller.js'
    'dist/server/modules/duty-schedule/duty-schedule.module.js'
    'scripts/ensure-change-drill-report-fields.mjs'
    'scripts/ensure-change-summary-report-fields.mjs'
    'scripts/self-test-change-summary-report.mjs'
  )
}

function Assert-FrozenPurchasePackageBoundary {
  param(
    [Parameter(Mandatory)]
    [string]$PackageRoot
  )

  foreach ($relativePath in @(Get-FrozenPurchaseRequiredPackagePaths)) {
    $path = Assert-ChildPath -Root $PackageRoot -Candidate (Join-Path $PackageRoot $relativePath)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Frozen-purchase package is missing required runtime: $relativePath"
    }
  }

  $purchaseServerRoot = Assert-ChildPath `
    -Root $PackageRoot `
    -Candidate (Join-Path $PackageRoot 'dist/server/modules/purchase-inventory')
  if (Test-Path -LiteralPath $purchaseServerRoot) {
    throw 'Frozen-purchase package contains excluded purchase-inventory server files'
  }

  $forbiddenClientMarkers = @('采购形式', '单一采购', '单一原因')
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'dist/client') -Recurse -File -Filter '*.js')) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    foreach ($marker in $forbiddenClientMarkers) {
      if ($content.Contains($marker)) {
        throw "Frozen-purchase package contains current purchase-page marker '$marker'"
      }
    }
  }

  $readmePath = Assert-ChildPath -Root $PackageRoot -Candidate (Join-Path $PackageRoot 'README.md')
  $readmeContent = [System.IO.File]::ReadAllText($readmePath)
  foreach ($marker in @('冻结采购页基线', '不包含当前工作区的采购页优化', 'change-drill-report', 'change-summary-report')) {
    if (-not $readmeContent.Contains($marker)) {
      throw "Frozen-purchase README is missing boundary marker '$marker'"
    }
  }

  $manifestPath = Assert-ChildPath -Root $PackageRoot -Candidate (Join-Path $PackageRoot 'hotfix-manifest.json')
  $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  if ($manifest.mode -ne 'frozen-purchase') {
    throw 'Frozen-purchase manifest mode is missing or invalid'
  }
  if (@($manifest.scope) -contains 'purchase-inventory') {
    throw 'Frozen-purchase manifest still declares purchase-inventory scope'
  }
  foreach ($excludedScope in @('purchase-page-current-workspace', 'purchase-inventory-server')) {
    if (-not (@($manifest.excludedScope) -contains $excludedScope)) {
      throw "Frozen-purchase manifest is missing excluded scope '$excludedScope'"
    }
  }
}

function Assert-FrozenPurchaseArchiveBoundary {
  param(
    [Parameter(Mandatory)]
    [string]$ArchivePath
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $entries = @(
      $archive.Entries |
        Where-Object {
          -not $_.FullName.EndsWith('/') -and
          -not $_.FullName.EndsWith('\')
        }
    )
    $entryNames = @($entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($relativePath in @(Get-FrozenPurchaseRequiredPackagePaths)) {
      if (-not ($entryNames -contains $relativePath)) {
        throw "Frozen-purchase archive is missing required runtime: $relativePath"
      }
    }
    if (@($entryNames | Where-Object { $_.StartsWith('dist/server/modules/purchase-inventory/') }).Count -gt 0) {
      throw 'Frozen-purchase archive contains excluded purchase-inventory server files'
    }

    $forbiddenClientMarkers = @('采购形式', '单一采购', '单一原因')
    foreach ($entry in @($entries | Where-Object { $_.FullName.Replace('\', '/').StartsWith('dist/client/') -and $_.FullName.EndsWith('.js') })) {
      $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8, $true)
      try {
        $content = $reader.ReadToEnd()
      } finally {
        $reader.Dispose()
      }
      foreach ($marker in $forbiddenClientMarkers) {
        if ($content.Contains($marker)) {
          throw "Frozen-purchase archive contains current purchase-page marker '$marker'"
        }
      }
    }

    foreach ($requiredDocument in @('README.md', 'hotfix-manifest.json')) {
      if (-not ($entryNames -contains $requiredDocument)) {
        throw "Frozen-purchase archive is missing $requiredDocument"
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$Content
  )

  [System.IO.File]::WriteAllText(
    $Path,
    $Content,
    [System.Text.UTF8Encoding]::new($false)
  )
}

$isolatedClientBuildStageRoot = $null
$clientRootPath = $null

try {
  Assert-NoReparsePointPath -Path $outputRootPath
  [void](New-Item -ItemType Directory -Path $outputRootPath -Force)

  if (-not $SkipBuild) {
    if (-not [string]::IsNullOrWhiteSpace($ClientRoot)) {
      throw '-ClientRoot cannot be combined with the default build mode'
    }
    Write-Host 'Building server production artifacts...'
    Push-Location $projectRoot
    try {
      & npm.cmd run build:server
      if ($LASTEXITCODE -ne 0) {
        throw "Server production build failed with exit code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }

    $isolatedClientBuildStageRoot = Assert-ChildPath `
      -Root $outputRootPath `
      -Candidate (Join-Path $outputRootPath ".client-$timestamp")
    $isolatedClientBuildRoot = Assert-ChildPath `
      -Root $isolatedClientBuildStageRoot `
      -Candidate (Join-Path $isolatedClientBuildStageRoot 'client')
    $isolatedClientBuildScriptName = if ($FrozenPurchase) {
      'scripts/build-hotfix-client-with-frozen-purchase.mjs'
    } else {
      'scripts/build-latest-hotfix-client.mjs'
    }
    $isolatedClientBuildScript = Assert-ChildPath `
      -Root $projectRoot `
      -Candidate (Join-Path $projectRoot $isolatedClientBuildScriptName)
    if ($FrozenPurchase) {
      Write-Host 'Building isolated client with the audited frozen purchase-page baseline...'
    } else {
      Write-Host 'Building isolated client from the current verified workspace source...'
    }
    & node $isolatedClientBuildScript --output $isolatedClientBuildRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Isolated client build failed with exit code $LASTEXITCODE"
    }
    $clientRootPath = $isolatedClientBuildRoot
  } else {
    if ([string]::IsNullOrWhiteSpace($ClientRoot)) {
      throw '-ClientRoot is required when -SkipBuild is used'
    }
    $clientRootPath = [System.IO.Path]::GetFullPath($ClientRoot)
  }

  [void](Assert-SafeSourceItem -Path $clientRootPath -ExpectDirectory $true)
  Assert-ClientHotfixBoundary -Root $clientRootPath -FrozenPurchase:$FrozenPurchase
  Assert-CompiledMarkers -Root $projectRoot -FrozenPurchase:$FrozenPurchase

  $nonRecursiveRuntimeRelativePaths = @('dist/server/app.module.js')
  $recursiveRuntimeEntryRelativePaths = @(
    $effectiveServerRelativePaths | Where-Object { $_ -notin $nonRecursiveRuntimeRelativePaths }
  )
  $recursiveRuntimeEntryRelativePaths += $sharedRelativePaths
  $dependencyClosure = @(Get-LocalRuntimeDependencyClosure `
    -Root $projectRoot `
    -EntryRelativePaths $recursiveRuntimeEntryRelativePaths)
  if ($FrozenPurchase) {
    $dependencyClosure = @(
      $dependencyClosure |
        Where-Object {
          -not $_.StartsWith(
            'dist/server/modules/purchase-inventory/',
            [System.StringComparison]::OrdinalIgnoreCase
          )
        }
    )
  }
  $runtimeRelativePaths = @($nonRecursiveRuntimeRelativePaths + $dependencyClosure)
  $runtimeRelativePaths = @($runtimeRelativePaths | Sort-Object -Unique)

  # Keep the private staging path short for Windows' legacy MAX_PATH boundary.
  # The public archive name and every path inside the archive remain unchanged.
  $stageRoot = Assert-ChildPath -Root $outputRootPath -Candidate (Join-Path $outputRootPath ".stage-$timestamp")
  $packageRoot = Assert-ChildPath -Root $stageRoot -Candidate (Join-Path $stageRoot 'pkg')
  $zipPath = Assert-ChildPath -Root $outputRootPath -Candidate (Join-Path $outputRootPath "$packageName.zip")
  $checksumPath = Assert-ChildPath -Root $outputRootPath -Candidate "$zipPath.sha256.txt"

  if (Test-Path -LiteralPath $stageRoot) {
    throw "Temporary package path already exists: $stageRoot"
  }
  if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $checksumPath)) {
    throw "Package output already exists: $packageName"
  }

  try {
    [void](New-Item -ItemType Directory -Path $packageRoot -Force)

    $stagedClientRoot = Assert-ChildPath -Root $packageRoot -Candidate (Join-Path $packageRoot $clientRelativePath)
    Copy-RequiredDirectory -Source $clientRootPath -Destination $stagedClientRoot -RelativeRoot $clientRelativePath

  foreach ($relativePath in $runtimeRelativePaths) {
    $sourcePath = Assert-ChildPath -Root $projectRoot -Candidate (Join-Path $projectRoot $relativePath)
    $destinationPath = Assert-ChildPath -Root $packageRoot -Candidate (Join-Path $packageRoot $relativePath)
    Copy-RequiredFile -Source $sourcePath -Destination $destinationPath -RelativePath $relativePath
  }

  foreach ($relativePath in $operationalScriptRelativePaths) {
    $sourcePath = Assert-ChildPath -Root $projectRoot -Candidate (Join-Path $projectRoot $relativePath)
    $destinationPath = Assert-ChildPath -Root $packageRoot -Candidate (Join-Path $packageRoot $relativePath)
    Copy-RequiredFile -Source $sourcePath -Destination $destinationPath -RelativePath $relativePath
  }

  $readmePath = Assert-ChildPath -Root $packageRoot -Candidate (Join-Path $packageRoot 'README.md')
  $readme = [string]::Join([Environment]::NewLine, @(
    '# 南通排班综合业务与采购签收热包'
    ''
    "包名：$packageName"
    ''
    '## 适用基线'
    ''
    '- 适用于已部署 nantong-business-optimization-hotfix-20260729-160651，或具备相同业务模块结构的环境。'
    '- 当前增量在该基线上注册天气预警模块，并为排班模块增加中国工作日历提供者。'
    ''
    '## 范围'
    ''
    '- 排班页面请休假：请休假单提交、人员信息、法定工作日历和幂等保护。'
    '- 请休假表单仅从服务端本地快照读取排班和人员资料，不在打开弹窗或选择人员时等待飞书。'
    '- 排班页面加班申请：使用已有的本地人员和排班快照，校验整点时间、加班工时与本人正常排班冲突。'
    '- 加班申请选择开始日期后自动将结束日期同步为同一天，结束日期不得早于开始日期，仍可调整。'
    '- 长白班在法定工作日仅可选择 09:00 前或 18:00 后加班，法定非工作日可自由选择时段。'
    '- 7×24 排班人员加班与本人排班的连续值守必须小于 24 小时；允许不形成 24 小时连班的 4 小时部分加班。'
    '- 加班举证截图为必选项，支持选择图片和 Ctrl+V 粘贴，不阻塞表单的本地交互。'
    '- 加班申请点击提交后立即关闭弹窗并显示“加班申请已受理，正在后台同步”；同步失败恢复原草稿，未知结果仅允许使用原请求 ID 和原内容安全重试。'
    '- 加班提交接口：POST /api/duty-schedules/overtime-request，按 multipart/form-data 上传申请 JSON 和一张加班举证截图。'
    '- 加班申请上线前必须使用真实人员和排班完成一次真实 Base 新增与回读；成功后按请求唯一 ID 和返回的 record ID 精确删除测试记录，并再次确认查询结果为 0。'
    '- 变更申请：提交人从本地人员快照精确选择，打开表单不实时请求飞书。'
    '- 变更方案支持 PDF、Word、Excel 和图片，最多 5 个，单个不超过 200 MB；前端优先从对象存储访问，后台同步为多维表附件。'
    '- 大于 20 MiB 的变更方案使用飞书分片附件上传；上传、外部存储和多维表同步不阻塞基础表单交互。'
    '- 对象存储启动修复：随包的 start.ps1 会自动读取 Windows 用户或机器环境、应用上一级的 nantong-schedule.private.env、应用根目录 .env/.env.local 中的腾讯云凭据；非空配置自动生效，启动日志仅显示 READY/NOT CONFIGURED，不输出密钥。'
    '- 服务器首次仅需在应用上一级创建一次 nantong-schedule.private.env；以后覆盖或整目录替换应用均可直接双击 start.cmd，热包不会包含或覆盖该文件。'
    '- 正常覆盖部署无需再次输入凭据；交互配置工具仅保留为服务器从未配置凭据或更换运行账户时的应急工具，密钥不会进入 README 或热包。'
    '- 变更申请接口：POST /api/duty-schedules/change-request；附件预存储接口：POST /api/duty-schedules/change-attachments/stage。'
    '- 变更调整：未开始变更可调整开始与结束时间，进行中变更仅可调整结束时间，已结束变更不可调整。'
    '- 变更调整支持删除旧方案、上传最新方案，并强制填写延期理由和上传延期举证；接口为 POST /api/duty-schedules/change-adjustment。'
    '- 变更调整点击提交后立即更新本地页面并后台同步；失败精确回滚并保留原草稿，未知结果仅使用原请求 ID 重试。'
        '- 中高风险变更演练报告：选择执行中或未执行变更、楼栋和演练报告后提交；接口为 POST /api/duty-schedules/change-drill-report。'
        '- 变更总结：按变更提交人选择 2026 年 6 月以来已结束、非超低且未退回的变更，上传 1-5 个总结材料后立即关闭弹窗并在后台同步；接口为 POST /api/duty-schedules/change-summary-report。'
        '- 变更总结材料使用 COS 暂存并同步为关单表附件；后台严格核对主变更、关单记录、请求唯一 ID、指纹和附件令牌。'
        '- 变更总结失败草稿仅能由原登录会话通过 POST /api/duty-schedules/change-summary-report/abandon 核验式清理；服务端完成关单记录、COS 对象和台账补偿后才允许重新填写。'
        '- 变更总结真实自测清理会将两类测试幂等台账精确脱敏为 self-test-cleaned 墓碑；墓碑不保留人员、附件、记录 ID 或令牌，并执行双轮零敏感残留确认。'
        '- 变更总结本地恢复按服务端 principalFingerprint 隔离；登录续期保持指纹，新登录或身份切换必然变化，游客不能继承上一身份草稿。'
    '- 统一权限重新登录：显式覆盖认证 module/controller/service/guard 与当前客户端，登录过期后可在原业务弹窗内恢复权限。'
    '- 排班与人员资料默认每 4 小时后台同步，审批状态默认每 15 分钟同步；同步失败保留最后一次成功快照。'
    '- 7×24 排班替班：必须选择替班人员，并排除重叠或相邻班次，避免连续值守 24 小时。'
    '- 今日截图：修复天气预警降级与人员字段回退导致的截图等待失败，保留管理员和排班编辑发送能力。'
    '- 应急值班：排班页显示前一天、当天、后一天值守，并提供独立 11 天调整；读取使用服务端本地快照。'
    '- 天气预警：每 1 分钟强制刷新一次天气预警，生成预警快照并执行飞书自动通知。'
    '- 首次识别新预警事件时自动首发：一级戒备：普通天气预警群、重要事件群和指定负责人；二级/三级戒备：普通天气预警群和指定负责人。'
    '- 预警戒备期内未完成时，每 2 小时按楼栋、按未完成检查项逐项催办，消息中明确楼栋和检查项。'
    '- 飞书卡片提供“下载重保检查单”和“提交戒备登记”两个按钮。'
    '- 下载重保检查单：https://vnet.feishu.cn/wiki/Hs4fwlplAijAgskmBnkcEDMvnKc'
    '- 提交戒备登记：服务端根据 PUBLIC_BASE_URL 与可选 CLIENT_BASE_PATH 生成带 weatherGuardRegistration=1 的站内弹窗深链；飞书卡片和排班页面共用同一入口。'
    '- 登记选项使用 GET /api/weather-warning/registration/options；提交使用 POST /api/weather-warning/registration，按 multipart/form-data 上传字段与检查附件，支持 PNG/JPEG/WebP 图片和 PDF 扫描件。'
    '- 机房经理从人员多维表按“设施运维经理/设施运维副经理”岗位实时生成，不沿用历史登记中的经理值。'
    '- 上线前必须在真实 Base 完成一次新增与回读验证，确认字段映射正确并删除测试记录后再启用自动化。'
    '- 服务端本地运行依赖：以本包入口递归收集并随包提供，避免覆盖新服务文件后缺少其本地依赖。'
    '- 采购申请支持采购形式、单一采购原因、经理审批卡片、流程签收与采购入库闭环。'
    '- 采购申请提交后立即更新阶段卡片和清单；申请中、审批中每 15 秒及窗口聚焦时刷新，服务端活跃数据缓存 10 秒，已完成数据维持 4 小时低频刷新。'
    '- 到货签收按钮的禁用态与提交态严格分离：必填项未齐时仅置灰，只有真实提交期间显示加载状态。'
    '- 采购入库的存放位置从库房位置底表选择；支持新增位置、失败保留草稿并沿原请求 ID 重试。'
    '- 出库申请提交后进入“待库房确认”，并立即把申请数量回填到多维表“出库数量”；平台仅写普通业务字段，不写只读的“流程（Stage）”字段。Stage 与库存累计由多维表原生流程及自动化维护；平台确认接口只更新可写的正式数量、时间、程序状态和幂等标识。网络中断或响应不确定时保留原出库编号，通过持久化异步任务后台续查并按需幂等补齐，避免重复创建。共享同一 .runtime 出库账本的多进程同时核对时，持久化租约确保正常租约有效期内只有一个进程回填；进程中断或租约过期后可由其他进程接管。'
    '- 出入库删除权限：管理员可删除全部楼栋记录；已配置楼栋的库房管理员仅可删除本楼记录，未配置楼栋时不显示删除入口。'
    '- 删除受理后立即从当前清单隐藏并标记后台同步；后端明确未写入时精准恢复原记录，响应不确定时保留原任务编号继续核对，避免重复删除。'
    '- 隔离前端构建直接使用当前工作区源码，并强制校验采购形式、单一原因、签收按钮及提交状态标记。'
    '- 完整前端生产静态文件：为保证内容哈希和按需加载一致，必须整体替换 dist/client。'
    ''
    '## 部署'
    ''
    '1. 停止应用服务。'
    '2. 备份当前 dist/client、本包内列出的 dist/server 和 dist/shared 文件，以及根目录 start.cmd、start.ps1 与 scripts/run-with-env.mjs。'
    '3. 删除当前 dist/client 目录后，将本压缩包解压到应用根目录并覆盖同名文件；必须同步覆盖 start.cmd、start.ps1 与 scripts/run-with-env.mjs，不能只替换 dist。'
    '4. 不要覆盖或删除环境配置、运行数据、日志、证书和依赖目录。'
    '5. 覆盖完成后直接双击 start.cmd；脚本会自动读取服务器现有私密配置并启动服务。'
    '6. 浏览器执行强制刷新。'
    ''
    '## 运行状态保护'
    ''
    '- 天气预警测试发送去重状态默认位于 data/weather-warning-delivery-state.json；若配置了 FEISHU_WEATHER_WARNING_DELIVERY_STATE_PATH 或 FEISHU_WEATHER_WARNING_DELIVERY_STATE_DIR，以配置位置为准。'
    '- 生产环境必须设置 FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH 或 FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR，并且必须指向发布目录外的固定持久目录（建议使用应用根目录上级的 nantong-schedule-state）；避免版本升级后丢失去重状态并重复首发。'
    '- 请休假未知写入账本默认位于 data/leave-request-mutations；若配置了 LEAVE_REQUEST_MUTATION_LEDGER_DIR，以配置位置为准。'
    '- 加班未知写入账本默认位于 data/overtime-request-mutations；若配置了 OVERTIME_REQUEST_MUTATION_LEDGER_DIR，以配置位置为准。'
    '- 变更申请未知写入账本默认位于 data/change-request-mutations；若配置了 CHANGE_REQUEST_MUTATION_LEDGER_DIR，以配置位置为准。'
    '- 变更调整未知写入账本默认位于 data/change-adjustment-mutations；若配置了 CHANGE_ADJUSTMENT_MUTATION_LEDGER_DIR，以配置位置为准。'
        '- 变更演练报告未知写入账本默认位于 data/change-drill-report-mutations；若配置了 CHANGE_DRILL_REPORT_MUTATION_LEDGER_DIR，以配置位置为准。'
    '- 变更总结未知写入账本默认位于 data/change-summary-report-mutations；若配置了 CHANGE_SUMMARY_REPORT_MUTATION_LEDGER_DIR，以配置位置为准。'
    '- 采购申请任务账本默认位于 .runtime/purchase-application-task-ledger.json；采购入库类别号任务账本默认位于 .runtime/purchase-inbound-category-task-ledger.json；出库任务账本默认位于 .runtime/inventory-outbound-task-ledger.json；出入库删除任务账本默认位于 .runtime/inventory-movement-deletion-task-ledger.json，覆盖部署时必须保留 .runtime。'
    '- 多进程部署必须让各进程共享同一个 .runtime 目录；多主机或容器使用独立本地磁盘时不具备出库任务互斥保证，不得并行启用出库恢复扫描。'
    '- 变更附件对象存储索引必须持久化；可通过 COS_CHANGE_INDEX_PATH 指定发布目录外的固定路径。'
    '- 生产环境的法定工作日历默认位于应用根目录上级的 nantong-schedule-state/china-work-calendar-state.json；若配置了 CHINA_WORK_CALENDAR_STATE_PATH 或 CHINA_WORK_CALENDAR_STATE_DIR，以配置位置为准。'
    '- 本包不包含上述状态文件，也不包含任何环境变量或密钥。'
    ''
    '## 变更申请与调整上线校验'
    ''
    '- 本包含 scripts/ensure-change-adjustment-fields.mjs；先运行 node scripts/ensure-change-adjustment-fields.mjs --dry-run 核对字段，再去掉 --dry-run 幂等补齐“申请提交人/延期理由/调整请求唯一ID/调整请求指纹”。'
        '- 本包含 scripts/ensure-change-drill-report-fields.mjs；先运行 node scripts/ensure-change-drill-report-fields.mjs --dry-run 核对字段，再去掉 --dry-run 幂等补齐演练报告相关字段。'
        '- 本包含 scripts/ensure-change-summary-report-fields.mjs；先运行 node scripts/ensure-change-summary-report-fields.mjs --dry-run 核对字段，再使用 --apply 幂等补齐“变更总结请求唯一ID/变更总结请求指纹”。'
    '- 启动服务后运行 node scripts/self-test-change-adjustment.mjs run --base-url https://127.0.0.1:3001，使用真实本地人员、大于 20 MiB 方案附件和真实 Base 完成新增、调整、回读与精确清理。'
        '- 如自测中断，使用 node scripts/self-test-change-adjustment.mjs cleanup-only --state <状态文件绝对路径> 恢复精确清理；不得模糊删除多维记录或对象。'
        '- 启动服务后运行 node scripts/self-test-change-summary-report.mjs run --base-url https://127.0.0.1:3001，使用唯一测试变更完成秒受理、COS/关单表回读、幂等冲突与精确清理。'
        '- 如变更总结自测中断，使用 node scripts/self-test-change-summary-report.mjs cleanup-only --state <状态文件绝对路径>；严格按对象、关单记录、主变更记录顺序清理并双轮确认残留为 0。'
    '- 真实自测成功标准：记录和方案/举证均可回读，幂等重试结果一致，测试记录、飞书附件关联和对象存储对象全部精确删除，残留查询为 0。'
    ''
    '## 天气预警接口预检'
    ''
    '- 覆盖前确认目标环境已通过受控环境变量提供所需 FEISHU_WEATHER_WARNING_* 配置；本包不会写入或替换这些值。'
    '- FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED：设为 true 后启用自动首发与催办。'
    '- FEISHU_WEATHER_WARNING_CHAT_IDS：普通天气预警群 chat_id，多个值以逗号分隔。'
    '- FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS：重要事件群 chat_id，多个值以逗号分隔；仅一级戒备首发与催办。'
    '- FEISHU_WEATHER_WARNING_OWNER_OPEN_ID：指定负责人的 open_id；FEISHU_WEATHER_WARNING_OWNER_NAME：对应接收人展示名。'
    '- FEISHU_WEATHER_WARNING_MANAGER_SOURCE_URL：机房经理人员多维表完整 URL（含 table 参数）；也可改用 FEISHU_WEATHER_WARNING_MANAGER_APP_TOKEN 与 FEISHU_WEATHER_WARNING_MANAGER_TABLE_ID。'
    '- 经理人员表须包含“职位”“主管”“主管（文本）”字段；仅“设施运维经理”和“设施运维副经理”进入机房经理候选。'
    '- PUBLIC_BASE_URL：必须是外部可访问的无凭据 HTTPS 地址；程序据此生成飞书卡片中的站内戒备登记深链。'
    '- FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS：轮询间隔，生产值 60000（1 分钟）。'
    '- FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS：预警戒备期内未完成催办间隔，生产值 7200000（2 小时）。'
    '- FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH / FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR：二选一指定发布目录外的自动通知持久状态位置。'
    '- 覆盖并重启后请求 GET /api/weather-warning/snapshot：403 表示全局访问守卫版本仍不一致；503 表示新降级逻辑尚未生效；200 表示快照接口契约可用，再按响应 status 区分 active、clear、degraded 或 stale。规则或检查表暂不可用时也应返回 200 降级快照，保留真实天气预警并禁用测试发送。'
    ''
    '## 校验'
    ''
    '- 解压后校验 hotfix-manifest.json 中每个文件的 SHA-256。'
    '- 校验压缩包旁的 SHA-256 文件与 ZIP 一致。'
    '- 本包不替换依赖清单，因此不需要为本包单独安装依赖。'
  ))
  if ($FrozenPurchase) {
    $readme = $readme.Replace(
      '# 南通排班综合业务与采购签收热包',
      '# 南通排班认证与变更演练热包（冻结采购）'
    )
    foreach ($line in @(
      '- 采购申请支持采购形式、单一采购原因、经理审批卡片、流程签收与采购入库闭环。'
      '- 到货签收按钮的禁用态与提交态严格分离：必填项未齐时仅置灰，只有真实提交期间显示加载状态。'
      '- 采购入库的存放位置从库房位置底表选择；支持新增位置、失败保留草稿并沿原请求 ID 重试。'
      '- 隔离前端构建直接使用当前工作区源码，并强制校验采购形式、单一原因、签收按钮及提交状态标记。'
    )) {
      $readme = $readme.Replace(($line + [Environment]::NewLine), '')
    }
    $readme += [Environment]::NewLine + [Environment]::NewLine + [string]::Join(
      [Environment]::NewLine,
      @(
        '## 冻结采购边界'
        ''
        '- dist/client 使用经 SHA-256 固定并校验的冻结采购页基线。'
        '- 本包不包含当前工作区的采购页优化，也不包含 dist/server/modules/purchase-inventory 服务文件。'
        '- 本包是覆盖式增量，目标基线原有的 purchase-inventory 服务文件必须保留，本包不会删除或替换。'
        '- 解包和归档校验都会拒绝采购形式、单一采购、单一原因三个当前采购页标记。'
      )
    )
  }
  Write-Utf8File -Path $readmePath -Content $readme
  Assert-NoSensitiveContent -Path $readmePath -RelativePath 'README.md'

  $manifestEntries = @(Get-StagedFileManifestEntries -PackageRoot $packageRoot)
  $manifest = [ordered]@{
    schemaVersion = 1
    name = $packageName
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    scope = @('leave-request', 'overtime-request', 'change-request', 'change-adjustment', 'change-summary-report', 'leave-substitute', 'duty-screenshot', 'emergency-duty', 'weather-warning', 'purchase-inventory', 'purchase-receipt', 'purchase-inbound', 'purchase-active-sync', 'inventory-storage-location', 'inventory-outbound-confirmation', 'inventory-outbound-durable-retry', 'inventory-movement-deletion') + @('change-drill-report', 'unified-access-reauthentication')
    files = $manifestEntries
  }
  if ($FrozenPurchase) {
    $manifest['scope'] = @(
      $manifest['scope'] |
        Where-Object { $_ -notin @('purchase-inventory', 'purchase-receipt', 'purchase-active-sync') }
    )
    $manifest['mode'] = 'frozen-purchase'
    $manifest['excludedScope'] = @('purchase-page-current-workspace', 'purchase-inventory-server')
  }
  $manifestPath = Assert-ChildPath -Root $packageRoot -Candidate (Join-Path $packageRoot 'hotfix-manifest.json')
  Write-Utf8File -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 6)
  if ($FrozenPurchase) {
    Assert-FrozenPurchasePackageBoundary -PackageRoot $packageRoot
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $packageRoot,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  Assert-ArchiveMatchesStage -ArchivePath $zipPath -PackageRoot $packageRoot
  if ($FrozenPurchase) {
    Assert-FrozenPurchaseArchiveBoundary -ArchivePath $zipPath
  }

  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content -LiteralPath $checksumPath -Value "$archiveHash  $([System.IO.Path]::GetFileName($zipPath))" -Encoding ascii -NoNewline

  Write-Host "Hot package created: $zipPath"
  Write-Host "SHA-256 sidecar: $checksumPath"
  } finally {
    if (Test-Path -LiteralPath $stageRoot) {
      $safeStageRoot = Assert-ChildPath -Root $outputRootPath -Candidate $stageRoot
      Remove-Item -LiteralPath $safeStageRoot -Recurse -Force
    }
  }
} finally {
  if ($null -ne $isolatedClientBuildStageRoot -and (Test-Path -LiteralPath $isolatedClientBuildStageRoot)) {
    $safeClientBuildStageRoot = Assert-ChildPath -Root $outputRootPath -Candidate $isolatedClientBuildStageRoot
    Remove-Item -LiteralPath $safeClientBuildStageRoot -Recurse -Force
  }
}
