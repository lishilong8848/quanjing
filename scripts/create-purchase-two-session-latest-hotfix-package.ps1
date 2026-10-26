param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runId = [Guid]::NewGuid().ToString('N')
$ownerTokenBytes = [byte[]]::new(32)
$ownerTokenGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $ownerTokenGenerator.GetBytes($ownerTokenBytes)
} finally {
  $ownerTokenGenerator.Dispose()
}
$ownerToken = ([BitConverter]::ToString($ownerTokenBytes)).Replace('-', '')
$runCode = $runId.Substring(0, 12)
$packageName = "purchase-two-session-latest-hotfix-$timestamp-$runCode"
$packageType = 'purchase-two-session-latest-combined-hotfix'
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$runRoot = Join-Path $outputRoot ".$packageName.run"
$ownerTokenPath = Join-Path $runRoot '.owner-token'
$baseSnapshotPath = Join-Path $runRoot 'base-archive.snapshot.zip'
$overlaySnapshotRoot = Join-Path $runRoot 'overlay-snapshot'
$overlayReadyPath = Join-Path $runRoot 'overlay-snapshot.ready.json'
$baseExtractDir = Join-Path $runRoot 'base-extract'
$stageDir = Join-Path $runRoot 'stage'
$verifyDir = Join-Path $runRoot 'verify'
$finalVerifyDir = Join-Path $runRoot 'verify-final'
$tempZipPath = Join-Path $runRoot "$packageName.zip"
$tempSidecarPath = "$tempZipPath.sha256.txt"
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"

$baseArchiveRelativePath = 'output/hotfix/purchase-manager-approval-card-hotfix-20260731-151710.zip'
$baseArchiveSha256 = '752B91D9D9046D208910DBDB069713181FDBA296BDF7555429B243929CA67F71'
$upstreamArchiveRelativePath = 'output/hotfix/purchase-single-procurement-order-hotfix-20260731-082059.zip'
$upstreamArchiveSha256 = '5F346ECDDF34BFD6E58824A17A40A221277F02F574B483715ABD94E51D6A8351'
$baseManifestRelativePath = 'hotfix-manifest.json'
$baseReadmeRelativePath = 'README_PURCHASE_MANAGER_APPROVAL_CARD_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$readmeRelativePath = 'README_PURCHASE_TWO_SESSION_LATEST_HOTFIX.md'
$preservedBaseClientPrefix = 'dist/client/'

$baseServerRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js',
  'dist/server/scripts/reconcile-purchase-manager-approval-delivery.js'
)
$preservedBaseServerRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js',
  'dist/server/scripts/reconcile-purchase-manager-approval-delivery.js'
)
$overlayRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js'
)
$workflowServiceMarkers = @(
  'expectedResultFingerprint',
  'commandResultFingerprintFromPatch',
  'doesCommandResultMatchExpected',
  'claimCommand',
  'releaseCommandClaim'
)
$workflowRulesMarkers = @(
  'buildOrderPatch'
)
$workflowRulesMarkerBase64 = @(
  '5LiL5Y2V5a6M5oiQ77yI5b6F562+5pS277yJ'
)
$workflowRulesForbiddenMarkerBase64 = @(
  '5LiL5Y2V5pe26Ze0'
)
$inboundRulesMarkers = @(
  'workflowStatus',
  'receiptCompleted',
  'inboundCompleted'
)
$inboundRulesMarkerBase64 = @(
  '5Yiw6LSn5bey562+5pS277yI5b6F5YWl5bqT77yJ',
  '6YeH6LSt5a6M5oiQ77yI5bey5YWl5bqT77yJ'
)
$inboundServiceMarkers = @(
  'hasCompletedExecutionSignal'
)
$inboundServiceMarkerBase64 = @(
  '6YeH6LSt5rWB56iL',
  '56iL5bqP6YeH6LSt54q25oCB',
  '5piv5ZCm5bey5YWl5bqT'
)
$baseGatewayMarkers = @(
  '1254607'
)
$baseGatewayMarkerBase64 = @(
  '6YeN6K+V'
)
$baseStoreMarkers = @(
  'expectedResultFingerprint',
  'claimCommand',
  'releaseCommandClaim'
)
$readmeIntroductionBase64 = @(
  'IyDkuKTph4fotK3kvJror53mnIDmlrDlkIjljIU=',
  '6L+Z5piv5Lik5Lu75Yqh5ZCI5YyF77ya5YyF5ZCr5bey6aqM6K+B55qE55Sz6K+3L+e7j+eQhuWuoeaJueiDveWKm++8jOS7peWPiuS4i+WNlee7k+aenOaMgeS5heWMluS4jumAkOaJp+ihjOmhueWFpeW6k+i1hOagvOS/ruWkjeOAgg=='
)
$readmeDeploymentBase64 = @(
  'IyMg5a6M5pW05a6J5YWo5LiK57q/6aG65bqP',
  'MS4g5Lik5Liq56iL5bqP5byA5YWz5Yid5aeL5L+d5oyBIGBQVVJDSEFTRV9NQU5BR0VSX0FQUFJPVkFMX0NBUkRfRU5BQkxFRD1mYWxzZWAg5ZKMIGBQVVJDSEFTRV9XT1JLRkxPV19QUk9HUkFNX0VOQUJMRUQ9ZmFsc2Vg44CC',
  'Mi4g5YGc5q2i5bqU55So77yM5aSH5Lu9546w572R5a6M5pW0IGBkaXN0L2NsaWVudGDjgIHlhajpg6ggcmVwbGFjZUZpbGVzIOWSjOmHh+i0reWuoeaJuSBsZWRnZXLjgII=',
  'My4g6Kej5Y6L5pysIFpJUCDliLDlupTnlKjmoLnnm67lvZXvvIzlrozmlbTmm7/mjaIgYGRpc3QvY2xpZW50YCDlubbmm7/mjaIgbWFuaWZlc3Qg5YiX5Ye655qEIHNlcnZlci9DTEkg5paH5Lu244CC',
  'NC4g5L+d5oyB5Lik5Liq56iL5bqP5byA5YWz5Li6IGZhbHNlIOWQr+WKqOW6lOeUqO+8jOmqjOivgemjnuS5puWbnuiwg+OAgeWUr+S4gOe7j+eQhumFjee9ruWSjOWfuuehgOafpeivouOAgg==',
  'NS4g5pqC5YGc6YeH6LSt5o+Q5Lqk5bm25YaN5qyh5YGc5q2i5bqU55So77yM6K6w5b2V5YiH5o2i5byA5aeL5pe26Ze044CC',
  'Ni4g5bqU55So5YGc5py65pyf6Ze05YiH5o2iIEJhc2Ug6YeN5aSN5a6h5om55omA5pyJ5p2D77ya5Y+q5YGc55SoIEJhc2Ug5Lit6YeN5aSN55qE57uP55CG5a6h5om55Yqo5L2c77yM54S25ZCO6K6+572uIGBQVVJDSEFTRV9NQU5BR0VSX0FQUFJPVkFMX0NBUkRfRU5BQkxFRD10cnVlYO+8m+W3peS9nOa1geeoi+W6j+W8gOWFs+S7jeS/neaMgSBmYWxzZeOAgg==',
  'Ny4g5ZCv5Yqo5bqU55So77yM5Lul5LiA5byg5Y+X5o6n55Sz6K+36aqM6K+B5paw57uP55CG5a6h5om56ZO+6Lev77yM5YaN5oyJ5Y+Y5pu05pa55qGI5byA5ZCv5bel5L2c5rWB56iL5bqP5byA5YWz44CC',
  'OC4g5a+56L+H5rih56qX5Y+j6YCQ5Y2V5qC45a+55omA5pyJ5b6F5a6h5om544CB5b6F5LiL5Y2V44CB5b6F562+5pS25ZKM5b6F5YWl5bqT6K6w5b2V77yM6KGl6b2Q5b2S5bGe5ZCO5omN5oGi5aSN6YeH6LSt5o+Q5Lqk44CC'
)
$readmeAcceptanceRollbackBase64 = @(
  'IyMg6aqM5pS25riF5Y2V',
  'LSDnlLPor7fkuInmlrnot6/lvoTlnYflj6/nlKjvvIzlubbpqozor4HljZXkuIDmnaXmupDpgInmi6nml7blv4XpobvloavlhpnljZXkuIDljp/lm6DjgII=',
  'LSDnu4/nkIYgMyDpgIkgMSDmk43kvZzlnYflj6/nlKjvvIzpqbPlm57ml7blv4XpobvloavlhpnpqbPlm57ljp/lm6DjgII=',
  'LSDlrqHmibnpgJrov4flkI7nmoTlvoXkuIvljZXkuI3ovazlnIjvvIzlj6/mraPluLjov5vlhaXkuIvljZXmk43kvZzjgII=',
  'LSDkuIvljZXliLfmlrDkuI3lm57pgIDvvIzlubbnoa7orqTkuIvljZXnu5Pmnpzlt7LlrozmiJDlpJrnu7TooajlhpnlhaXjgII=',
  'LSDlr7kgYENHMjYwNzIzLTYwMWAg6aqM6K+B5LuF5bey562+5pS25omn6KGM6aG55Y+v5YWl5bqT77yb5pyq562+5pS25oiW5bey5YWl5bqT5omn6KGM6aG55LiN5b6X6YeN5aSN5YWl5bqT44CC',
  'IyMg5Zue5rua',
  '5Zue5rua5pyf6Ze05L+d5oyB5pqC5YGc5o+Q5Lqk77yM5YWI5YGc5q2i5bqU55So5bm25aSH5Lu95b2T5YmNIGxlZGdlcuOAgg==',
  '5bqU55So5YGc5py65pyf6Ze05YWz6Zet5Lik5Liq56iL5bqP5byA5YWz77yM5Y+N5ZCR5oGi5aSN5aSH5Lu955qEIGNsaWVudC9zZXJ2ZXIg5paH5Lu277yM5bm25oGi5aSNIEJhc2Ug6YeN5aSN5a6h5om55Yqo5L2c55qE5Y6f5omA5pyJ5p2D44CC',
  '6L+H5rih56qX5Y+j6YCQ5Y2V5qC45a+55ZCO5YaN5oGi5aSN6YeH6LSt5o+Q5Lqk77yb5LiN5b6X6KaG55uW5bey5Y+R55Sf5a6h5om5IGxlZGdlcu+8jOS5n+S4jeW+l+eUqOaXpyBsZWRnZXIg5oq55o6J5LiK57q/5ZCO5bey5Y+R55Sf55qE5a6h5om55LqL5a6e44CC',
  'IyMg5o6S6Zmk5YaF5a65',
  '5pys5YyF5LiN5ZCr5rqQ56CB44CB5rWL6K+V44CBc2VjcmV044CBc291cmNlIG1hcOOAgeS+nei1luebruW9lS/muIXljZXjgIHnjq/looPmlofku7bjgIHkuJrliqHmlbDmja7jgIHml6Xlv5fjgIHor4HkuabmiJbov5DooYzml7bnirbmgIHjgII='
)

function ConvertFrom-Utf8Base64Array {
  param([string[]]$Values)

  return @(
    $Values | ForEach-Object {
      [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))
    }
  )
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentFullPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childFullPath = [IO.Path]::GetFullPath($Child)
  $parentPrefix = $parentFullPath + [IO.Path]::DirectorySeparatorChar
  if (
    $childFullPath.Equals(
      $parentFullPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    !$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Assert-SafePayloadPaths {
  param([string[]]$Paths)

  $forbiddenPathFragments = @(
    '/node_modules/',
    '/data/',
    '/logs/',
    '/certs/',
    '/secrets/',
    '/.runtime/',
    '/sourcemaps/',
    '/src/',
    '/source/',
    '/test/',
    '/tests/'
  )
  $forbiddenFileNames = @(
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock'
  )
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.spec',
    '.log',
    '.pem',
    '.cer',
    '.crt',
    '.cert',
    '.key',
    '.pfx',
    '.p12'
  )
  $regexOptions =
    [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
    [Text.RegularExpressions.RegexOptions]::CultureInvariant

  foreach ($path in $Paths) {
    $rawNormalized = ([string]$path).Replace('\', '/')
    $normalized = $rawNormalized.TrimStart('/')
    $guardPath = "/$normalized/"
    $leafName = [IO.Path]::GetFileName($normalized)
    $extension = [IO.Path]::GetExtension($normalized)
    $isUnsafeRoot = [IO.Path]::IsPathRooted([string]$path) -or
      $rawNormalized.StartsWith('/')
    $hasForbiddenPathFragment = @(
      $forbiddenPathFragments |
        Where-Object {
          $guardPath.IndexOf(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          ) -ge 0
        }
    ).Count -gt 0
    $hasForbiddenFileName = @(
      $forbiddenFileNames |
        Where-Object {
          $leafName.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasForbiddenExtension = @(
      $forbiddenExtensions |
        Where-Object {
          $extension.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasEnvironmentSegment = [Text.RegularExpressions.Regex]::IsMatch(
      $normalized,
      '(^|/)\.env[^/]*(/|$)',
      $regexOptions
    )
    $hasSpecFileName = [Text.RegularExpressions.Regex]::IsMatch(
      $leafName,
      '(^|[.])spec([.]|$)',
      $regexOptions
    )
    if (
      [string]::IsNullOrWhiteSpace([string]$path) -or
      $isUnsafeRoot -or
      $normalized -match '(^|/)\.\.?(/|$)' -or
      $hasEnvironmentSegment -or
      $hasForbiddenPathFragment -or
      $hasForbiddenFileName -or
      $hasSpecFileName -or
      $hasForbiddenExtension
    ) {
      throw "Refusing to package forbidden path: $path"
    }
  }
}

function Assert-NoReparsePoints {
  param([string]$Root)

  if (!(Test-Path -LiteralPath $Root)) {
    throw "Required payload path was not found: $Root"
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  $items = @($rootItem)
  if ($rootItem.PSIsContainer) {
    $items += @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  }
  $reparsePoint = @(
    $items |
      Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
      }
  ) | Select-Object -First 1
  if ($reparsePoint) {
    throw "Refusing to package a reparse point: $($reparsePoint.FullName)"
  }
}

function Assert-NoReparsePointsInPathChain {
  param([string]$Path)

  $currentPath = [IO.Path]::GetFullPath($Path)
  while (![string]::IsNullOrWhiteSpace($currentPath)) {
    if (Test-Path -LiteralPath $currentPath) {
      $item = Get-Item -LiteralPath $currentPath -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to use a reparse point in an output path: $currentPath"
      }
    }
    $parent = [IO.Directory]::GetParent($currentPath)
    if (!$parent) {
      break
    }
    $currentPath = $parent.FullName
  }
}

function Assert-NoReparsePointsWithinRoot {
  param(
    [string]$Root,
    [string]$Path
  )

  $rootFullPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $pathFullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  if (
    !$pathFullPath.Equals(
      $rootFullPath,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    Assert-ChildPath -Parent $rootFullPath -Child $pathFullPath
  }

  $pathsToCheck = [Collections.Generic.List[string]]::new()
  $pathsToCheck.Add($rootFullPath)
  if (
    !$pathFullPath.Equals(
      $rootFullPath,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    $relativePath = $pathFullPath.Substring(
      $rootFullPath.Length
    ).TrimStart('\', '/')
    $currentPath = $rootFullPath
    foreach ($segment in $relativePath.Replace('\', '/').Split([char]'/')) {
      $currentPath = Join-Path $currentPath $segment
      $pathsToCheck.Add($currentPath)
    }
  }

  foreach ($candidatePath in $pathsToCheck) {
    try {
      $item = Get-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
    } catch {
      throw "Required directory segment was not found: $candidatePath"
    }
    if (!$item.PSIsContainer) {
      throw "Required directory segment is not a directory: $candidatePath"
    }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to use a reparse point in an output path: $candidatePath"
    }
  }
}

function Get-OwnedRunRootAllowedSids {
  $allowedSids = [Collections.Generic.List[Security.Principal.SecurityIdentifier]]::new()
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $allowedSids.Add($currentIdentity.User)
  $allowedSids.Add(
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  )
  $allowedSids.Add(
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
  return @(
    $allowedSids |
      Sort-Object -Property Value -Unique
  )
}

function Protect-OwnedRunRootAcl {
  param([string]$RunRoot)

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    return
  }
  $directorySecurity = [Security.AccessControl.DirectorySecurity]::new()
  $directorySecurity.SetAccessRuleProtection($true, $false)
  $inheritanceFlags =
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @(Get-OwnedRunRootAllowedSids)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritanceFlags,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$directorySecurity.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($RunRoot, $directorySecurity)
}

function Assert-OwnedRunRootAcl {
  param([string]$RunRoot)

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    return
  }
  $directorySecurity = [IO.Directory]::GetAccessControl(
    $RunRoot,
    [Security.AccessControl.AccessControlSections]::Access
  )
  if (!$directorySecurity.AreAccessRulesProtected) {
    throw "Owned run root ACL inheritance is not protected: $RunRoot"
  }
  $expectedSids = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($sid in @(Get-OwnedRunRootAllowedSids)) {
    [void]$expectedSids.Add($sid.Value)
  }
  $observedSids = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  $rules = @(
    $directorySecurity.GetAccessRules(
      $true,
      $false,
      [Security.Principal.SecurityIdentifier]
    )
  )
  foreach ($rule in $rules) {
    $sidValue = $rule.IdentityReference.Value
    if (
      !$expectedSids.Contains($sidValue) -or
      $rule.IsInherited -or
      $rule.AccessControlType -ne
        [Security.AccessControl.AccessControlType]::Allow -or
      (
        $rule.FileSystemRights -band
          [Security.AccessControl.FileSystemRights]::FullControl
      ) -ne [Security.AccessControl.FileSystemRights]::FullControl
    ) {
      throw "Owned run root ACL contains an unexpected rule: $RunRoot"
    }
    [void]$observedSids.Add($sidValue)
  }
  if (!$observedSids.SetEquals($expectedSids)) {
    throw "Owned run root ACL principals are incomplete: $RunRoot"
  }
}

function Initialize-OwnedRunRoot {
  param(
    [string]$RunRoot,
    [string]$OwnerTokenPath,
    [string]$OwnerToken
  )

  Assert-ChildPath -Parent $RunRoot -Child $OwnerTokenPath
  $runRootCreated = $false
  $tokenCreated = $false
  $identityCreated = $false
  try {
    New-Item -ItemType Directory -Path $RunRoot -ErrorAction Stop | Out-Null
    $runRootCreated = $true
    $runRootItem = Get-Item -LiteralPath $RunRoot -Force
    if ($runRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to own a reparse-point run root: $RunRoot"
    }
    Protect-OwnedRunRootAcl -RunRoot $RunRoot
    Assert-OwnedRunRootAcl -RunRoot $RunRoot

    $tokenBytes = [Text.Encoding]::ASCII.GetBytes($OwnerToken)
    $tokenStream = [IO.FileStream]::new(
      $OwnerTokenPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $tokenCreated = $true
    try {
      $tokenStream.Write($tokenBytes, 0, $tokenBytes.Length)
      $tokenStream.Flush()
    } finally {
      $tokenStream.Dispose()
    }

    $rootIdentityPath = Join-Path $RunRoot '.root-identity.json'
    $rootIdentity = [ordered]@{
      schemaVersion = 1
      ownerToken = $OwnerToken
      fullPath = [IO.Path]::GetFullPath($RunRoot)
      aclProtected = (
        [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
      )
      creationTimeUtcTicks = $runRootItem.CreationTimeUtc.Ticks.ToString(
        [Globalization.CultureInfo]::InvariantCulture
      )
    }
    $identityJson = $rootIdentity | ConvertTo-Json -Depth 3
    $identityBytes = [Text.UTF8Encoding]::new($false).GetBytes(
      $identityJson + [Environment]::NewLine
    )
    $identityStream = [IO.FileStream]::new(
      $rootIdentityPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $identityCreated = $true
    try {
      $identityStream.Write($identityBytes, 0, $identityBytes.Length)
      $identityStream.Flush()
    } finally {
      $identityStream.Dispose()
    }
  } catch {
    if ($runRootCreated) {
      $createdLeaves = @()
      if ($identityCreated) {
        $createdLeaves += (Join-Path $RunRoot '.root-identity.json')
      }
      if ($tokenCreated) {
        $createdLeaves += $OwnerTokenPath
      }
      foreach ($initializationLeaf in $createdLeaves) {
        if (Test-Path -LiteralPath $initializationLeaf -PathType Leaf) {
          $initializationItem = Get-Item -LiteralPath $initializationLeaf -Force
          if (
            !(
              $initializationItem.Attributes -band
                [IO.FileAttributes]::ReparsePoint
            )
          ) {
            [IO.File]::Delete($initializationLeaf)
          }
        }
      }
      if (Test-Path -LiteralPath $RunRoot) {
        try {
          [IO.Directory]::Delete($RunRoot, $false)
        } catch {
          # Fail closed if anything appeared in the new root during initialization.
        }
      }
    }
    throw
  }
}

function Assert-OwnedRunRoot {
  param(
    [string]$RunRoot,
    [string]$OwnerTokenPath,
    [string]$ExpectedToken
  )

  if (!(Test-Path -LiteralPath $RunRoot -PathType Container)) {
    throw "Owned run root was not found: $RunRoot"
  }
  $runRootItem = Get-Item -LiteralPath $RunRoot -Force
  if ($runRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to clean a reparse-point run root: $RunRoot"
  }
  if (!(Test-Path -LiteralPath $OwnerTokenPath -PathType Leaf)) {
    throw "Owned run root token was not found: $OwnerTokenPath"
  }
  $tokenItem = Get-Item -LiteralPath $OwnerTokenPath -Force
  if ($tokenItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to trust a reparse-point owner token: $OwnerTokenPath"
  }
  $actualToken = [IO.File]::ReadAllText(
    $OwnerTokenPath,
    [Text.Encoding]::ASCII
  )
  if (
    !$actualToken.Equals(
      $ExpectedToken,
      [StringComparison]::Ordinal
    )
  ) {
    throw "Owned run root token mismatch: $RunRoot"
  }

  $rootIdentityPath = Join-Path $RunRoot '.root-identity.json'
  if (!(Test-Path -LiteralPath $rootIdentityPath -PathType Leaf)) {
    throw "Owned run root identity was not found: $rootIdentityPath"
  }
  $identityItem = Get-Item -LiteralPath $rootIdentityPath -Force
  if ($identityItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to trust a reparse-point root identity: $rootIdentityPath"
  }
  $rootIdentity = [IO.File]::ReadAllText(
    $rootIdentityPath,
    [Text.Encoding]::UTF8
  ) | ConvertFrom-Json
  $expectedFullPath = [IO.Path]::GetFullPath($RunRoot)
  $expectedCreationTicks = $runRootItem.CreationTimeUtc.Ticks.ToString(
    [Globalization.CultureInfo]::InvariantCulture
  )
  if (
    [int]$rootIdentity.schemaVersion -ne 1 -or
    [string]$rootIdentity.ownerToken -cne $ExpectedToken -or
    [bool]$rootIdentity.aclProtected -ne (
      [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    ) -or
    !([string]$rootIdentity.fullPath).Equals(
      $expectedFullPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$rootIdentity.creationTimeUtcTicks -cne $expectedCreationTicks
  ) {
    throw "Owned run root identity mismatch: $RunRoot"
  }
  Assert-OwnedRunRootAcl -RunRoot $RunRoot
}

function Remove-OwnedRunRoot {
  param(
    [string]$RunRoot,
    [string]$OwnerTokenPath,
    [string]$ExpectedToken
  )

  Assert-OwnedRunRoot `
    -RunRoot $RunRoot `
    -OwnerTokenPath $OwnerTokenPath `
    -ExpectedToken $ExpectedToken
  Assert-NoReparsePoints -Root $RunRoot
  Assert-OwnedRunRoot `
    -RunRoot $RunRoot `
    -OwnerTokenPath $OwnerTokenPath `
    -ExpectedToken $ExpectedToken
  Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction Stop
}

function Copy-FileSnapshot {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$DestinationRoot = '',
    [string]$MissingMessage = ''
  )

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    if ($MissingMessage) {
      throw $MissingMessage
    }
    throw "Required snapshot source was not found: $Source"
  }
  $sourceItem = Get-Item -LiteralPath $Source -Force
  if ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to snapshot a reparse point: $Source"
  }
  if (!$DestinationRoot) {
    $DestinationRoot = Split-Path -Parent $Destination
  }
  $destinationRootFullPath = [IO.Path]::GetFullPath(
    $DestinationRoot
  ).TrimEnd('\', '/')
  $destinationFullPath = [IO.Path]::GetFullPath($Destination)
  Assert-ChildPath `
    -Parent $destinationRootFullPath `
    -Child $destinationFullPath
  $relativeDestination = $destinationFullPath.Substring(
    $destinationRootFullPath.Length
  ).TrimStart('\', '/')
  $relativeParent = [IO.Path]::GetDirectoryName($relativeDestination)
  $destinationParent = Ensure-SafeRelativeDirectory `
    -Root $destinationRootFullPath `
    -RelativeDirectory $relativeParent
  $safeDestination = Join-Path `
    $destinationParent `
    ([IO.Path]::GetFileName($destinationFullPath))
  if (
    !$safeDestination.Equals(
      $destinationFullPath,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Snapshot destination identity is invalid: $Destination"
  }

  $sourceStream = [IO.FileStream]::new(
    $Source,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  try {
    Assert-NoReparsePointsWithinRoot `
      -Root $destinationRootFullPath `
      -Path $destinationParent
    $destinationStream = [IO.FileStream]::new(
      $destinationFullPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try {
      $sourceStream.CopyTo($destinationStream)
      $destinationStream.Flush()
    } finally {
      $destinationStream.Dispose()
    }
  } finally {
    $sourceStream.Dispose()
  }
}

function Get-StreamSha256 {
  param([IO.Stream]$stream)

  $stream.Position = 0
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($stream)
  } finally {
    $sha256.Dispose()
  }
  return ([BitConverter]::ToString($hashBytes)).Replace('-', '')
}

function Get-LockedFileSha256 {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required hash source was not found: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to hash a reparse point: $Path"
  }
  $stream = [IO.FileStream]::new(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  try {
    return Get-StreamSha256 -stream $stream
  } finally {
    $stream.Dispose()
  }
}

function Get-RelativeFileHashMap {
  param(
    [string]$Root,
    [string[]]$RelativePaths
  )

  Assert-SafePayloadPaths -Paths $RelativePaths
  $hashes = @{}
  foreach ($relativePath in $RelativePaths) {
    $hashes[$relativePath] = Get-LockedFileSha256 `
      -Path (Join-Path $Root $relativePath)
  }
  return $hashes
}

function Complete-OverlaySnapshotReady {
  param(
    [string]$SourceRoot,
    [string]$SnapshotRoot,
    [string[]]$RelativePaths,
    [Collections.IDictionary]$FirstHashes,
    [string]$ReadyPath
  )

  if (Test-Path -LiteralPath $ReadyPath) {
    throw "Overlay snapshot ready file already exists: $ReadyPath"
  }
  $snapshotHashes = Get-RelativeFileHashMap `
    -Root $SnapshotRoot `
    -RelativePaths $RelativePaths
  $secondHashes = Get-RelativeFileHashMap `
    -Root $SourceRoot `
    -RelativePaths $RelativePaths
  foreach ($relativePath in $RelativePaths) {
    if (
      !$FirstHashes.Contains($relativePath) -or
      !$snapshotHashes.Contains($relativePath) -or
      !$secondHashes.Contains($relativePath) -or
      [string]$FirstHashes[$relativePath] -ne
        [string]$snapshotHashes[$relativePath] -or
      [string]$snapshotHashes[$relativePath] -ne
        [string]$secondHashes[$relativePath]
    ) {
      throw "Overlay source changed while snapshotting: $relativePath"
    }
  }

  $ready = [ordered]@{
    schemaVersion = 1
    files = @(
      $RelativePaths | ForEach-Object {
        [ordered]@{
          path = $_
          sha256 = ([string]$snapshotHashes[$_]).ToUpperInvariant()
        }
      }
    )
  }
  $readyJson = $ready | ConvertTo-Json -Depth 4
  $readyBytes = [Text.UTF8Encoding]::new($false).GetBytes(
    $readyJson + [Environment]::NewLine
  )
  $readyStream = [IO.FileStream]::new(
    $ReadyPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $readyStream.Write($readyBytes, 0, $readyBytes.Length)
    $readyStream.Flush()
  } finally {
    $readyStream.Dispose()
  }
}

function Read-OverlaySnapshotReady {
  param(
    [string]$ReadyPath,
    [string[]]$ExpectedPaths
  )

  if (!(Test-Path -LiteralPath $ReadyPath -PathType Leaf)) {
    throw "Overlay snapshot ready file was not found: $ReadyPath"
  }
  $readyItem = Get-Item -LiteralPath $ReadyPath -Force
  if ($readyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to trust a reparse-point ready file: $ReadyPath"
  }
  $ready = [IO.File]::ReadAllText(
    $ReadyPath,
    [Text.Encoding]::UTF8
  ) | ConvertFrom-Json
  if ([int]$ready.schemaVersion -ne 1) {
    throw 'Overlay snapshot ready identity is invalid.'
  }
  $readyFiles = @($ready.files)
  $readyPaths = @($readyFiles | ForEach-Object { [string]$_.path })
  Assert-ExactPathSet `
    -Actual $readyPaths `
    -Expected $ExpectedPaths `
    -FailureMessage 'Overlay snapshot ready paths are invalid.'
  foreach ($entry in $readyFiles) {
    if ([string]$entry.sha256 -notmatch '^[A-F0-9]{64}$') {
      throw "Overlay snapshot ready hash is invalid: $($entry.path)"
    }
  }
  return $ready
}

function Assert-OverlayFilesMatchReady {
  param(
    [string]$Root,
    [string]$ReadyPath,
    [string[]]$ExpectedPaths,
    [string]$FailurePrefix
  )

  $ready = Read-OverlaySnapshotReady `
    -ReadyPath $ReadyPath `
    -ExpectedPaths $ExpectedPaths
  $actualHashes = Get-RelativeFileHashMap `
    -Root $Root `
    -RelativePaths $ExpectedPaths
  foreach ($entry in @($ready.files)) {
    $relativePath = [string]$entry.path
    if (
      [string]$actualHashes[$relativePath] -ne
        [string]$entry.sha256
    ) {
      throw "$FailurePrefix $relativePath"
    }
  }
}

function Assert-UniquePaths {
  param(
    [string[]]$Paths,
    [string]$FailureMessage
  )

  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in $Paths) {
    if (!$seen.Add(([string]$path).Replace('\', '/'))) {
      throw $FailureMessage
    }
  }
}

function Assert-ExactPathSet {
  param(
    [string[]]$Actual,
    [string[]]$Expected,
    [string]$FailureMessage
  )

  Assert-UniquePaths -Paths $Actual -FailureMessage $FailureMessage
  Assert-UniquePaths -Paths $Expected -FailureMessage $FailureMessage
  $actualPaths = @($Actual | Sort-Object -CaseSensitive)
  $expectedPaths = @($Expected | Sort-Object -CaseSensitive)
  $difference = @(
    Compare-Object `
      -ReferenceObject $expectedPaths `
      -DifferenceObject $actualPaths `
      -CaseSensitive
  )
  if ($difference.Count -gt 0) {
    throw $FailureMessage
  }
}

function Get-StageRelativePaths {
  param([string]$Stage)

  $stageFullPath = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $relative = $_.FullName.Substring($stageFullPath.Length)
        $relative = $relative.TrimStart('\', '/')
        $relative.Replace('\', '/')
      } |
      Sort-Object -CaseSensitive
  )
}

function Get-UniqueSortedPaths {
  param([string[]]$Paths)

  return @(
    $Paths |
      ForEach-Object { ([string]$_).Replace('\', '/') } |
      Sort-Object -Unique -CaseSensitive
  )
}

function Assert-SafeArchiveEntries {
  param([System.IO.Compression.ZipArchive]$Archive)

  $allPaths = @(
    $Archive.Entries |
      Where-Object { $_.FullName } |
      ForEach-Object { $_.FullName.Replace('\', '/') }
  )
  try {
    Assert-SafePayloadPaths -Paths $allPaths
  } catch {
    throw 'ZIP contains an unsafe entry path.'
  }
  Assert-UniquePaths `
    -Paths $allPaths `
    -FailureMessage 'ZIP contains duplicate entry paths.'
  return @(
    $Archive.Entries |
      Where-Object { $_.Name } |
      ForEach-Object { $_.FullName.Replace('\', '/') } |
      Sort-Object -CaseSensitive
  )
}

function Ensure-SafeRelativeDirectory {
  param(
    [string]$Root,
    [string]$RelativeDirectory
  )

  $rootFullPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  Assert-NoReparsePointsWithinRoot `
    -Root $rootFullPath `
    -Path $rootFullPath

  $normalized = ([string]$RelativeDirectory).Replace('\', '/').Trim('/')
  if (!$normalized) {
    return $rootFullPath
  }
  if (
    [IO.Path]::IsPathRooted($RelativeDirectory) -or
    $normalized -match '(^|/)\.\.?(/|$)' -or
    $normalized.Contains('//')
  ) {
    throw "Refusing to create an unsafe relative directory: $RelativeDirectory"
  }

  $currentPath = $rootFullPath
  foreach ($segment in $normalized.Split([char]'/')) {
    Assert-NoReparsePointsWithinRoot `
      -Root $rootFullPath `
      -Path $currentPath
    $nextPath = Join-Path $currentPath $segment
    Assert-ChildPath -Parent $rootFullPath -Child $nextPath
    if (![IO.Directory]::Exists($nextPath)) {
      New-Item -ItemType Directory -Path $nextPath | Out-Null
    }
    Assert-NoReparsePointsWithinRoot `
      -Root $rootFullPath `
      -Path $nextPath
    $currentPath = $nextPath
  }
  return $currentPath
}

function Write-OpenArchiveEntry {
  param(
    [System.IO.Compression.ZipArchiveEntry]$Entry,
    [string]$DestinationRoot
  )

  $relativePath = $entry.FullName.Replace('\', '/')
  Assert-SafePayloadPaths -Paths @($relativePath)
  $platformRelativePath = $relativePath.Replace(
    '/',
    [IO.Path]::DirectorySeparatorChar
  )
  $relativeParent = [IO.Path]::GetDirectoryName($platformRelativePath)
  $destinationParent = Ensure-SafeRelativeDirectory `
    -Root $DestinationRoot `
    -RelativeDirectory $relativeParent
  $destinationPath = Join-Path `
    $destinationParent `
    ([IO.Path]::GetFileName($platformRelativePath))
  Assert-ChildPath -Parent $DestinationRoot -Child $destinationPath
  Assert-NoReparsePointsWithinRoot `
    -Root $DestinationRoot `
    -Path $destinationParent

  $destinationStream = [IO.FileStream]::new(
    $destinationPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $entryStream = $entry.Open()
    try {
      $entryStream.CopyTo($destinationStream)
      $destinationStream.Flush()
    } finally {
      $entryStream.Dispose()
    }
  } finally {
    $destinationStream.Dispose()
  }
}

function Expand-OpenArchiveEntries {
  param(
    [System.IO.Compression.ZipArchive]$Archive,
    [string]$Destination
  )

  if (Test-Path -LiteralPath $Destination) {
    throw "Archive extraction destination already exists: $Destination"
  }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  foreach ($entry in @($Archive.Entries | Where-Object { $_.Name })) {
    Write-OpenArchiveEntry `
      -Entry $entry `
      -DestinationRoot $Destination
  }
  Assert-NoReparsePoints -Root $Destination
}

function Expand-VerifiedBaseArchiveSnapshot {
  param(
    [string]$SnapshotPath,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $SnapshotPath -PathType Leaf)) {
    throw "Frozen base archive snapshot was not found: $SnapshotPath"
  }
  Add-Type -AssemblyName System.IO.Compression
  $stream = [IO.FileStream]::new(
    $SnapshotPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  try {
    $actualHash = Get-StreamSha256 -stream $stream
    if ($actualHash -ne $baseArchiveSha256) {
      throw 'Base archive SHA256 mismatch.'
    }
    $stream.Position = 0
    $archive = [System.IO.Compression.ZipArchive]::new(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $true
    )
    try {
      $filePaths = Assert-SafeArchiveEntries -Archive $archive
      Expand-OpenArchiveEntries `
        -Archive $archive `
        -Destination $Destination
    } finally {
      $archive.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  Assert-NoReparsePoints -Root $Destination
  return @($filePaths)
}

function Assert-ManifestFileHashes {
  param(
    [string]$Root,
    [object[]]$ManifestFiles,
    [string]$HashMismatchPrefix
  )

  $manifestPaths = @(
    $ManifestFiles | ForEach-Object { [string]$_.path }
  )
  Assert-SafePayloadPaths -Paths $manifestPaths
  Assert-UniquePaths `
    -Paths $manifestPaths `
    -FailureMessage 'Manifest contains duplicate file paths.'
  foreach ($entry in $ManifestFiles) {
    $relativePath = [string]$entry.path
    $expectedHash = ([string]$entry.sha256).ToUpperInvariant()
    if ($expectedHash -notmatch '^[A-F0-9]{64}$') {
      throw "Manifest contains an invalid SHA256: $relativePath"
    }
    $fullPath = Join-Path $Root $relativePath.Replace(
      '/',
      [IO.Path]::DirectorySeparatorChar
    )
    if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Manifest payload is missing: $relativePath"
    }
    $actualHash = (
      Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
    ).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "$HashMismatchPrefix $relativePath"
    }
  }
}

function Assert-BaseManifest {
  param(
    [string]$ExtractedRoot,
    [string[]]$ArchiveFilePaths
  )

  $manifestPath = Join-Path $ExtractedRoot $baseManifestRelativePath
  if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Frozen base archive does not contain hotfix-manifest.json.'
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [int]$manifest.schemaVersion -ne 1 -or
    [string]$manifest.package -ne
      'purchase-manager-approval-card-hotfix-20260731-151710' -or
    [string]$manifest.packageType -ne
      'purchase-manager-approval-card-combined-hotfix'
  ) {
    throw 'Frozen base manifest identity is invalid.'
  }
  if (
    [string]$manifest.baseArchive -cne $upstreamArchiveRelativePath -or
    [string]$manifest.baseArchiveSha256 -ne $upstreamArchiveSha256
  ) {
    throw 'Frozen base manifest provenance is invalid.'
  }
  Assert-ExactPathSet `
    -Actual @($manifest.replaceDirectories | ForEach-Object { [string]$_ }) `
    -Expected @('dist/client') `
    -FailureMessage 'Frozen base replaceDirectories is invalid.'
  Assert-ExactPathSet `
    -Actual @($manifest.replaceFiles | ForEach-Object { [string]$_ }) `
    -Expected $baseServerRelativePaths `
    -FailureMessage 'Frozen base replaceFiles is invalid.'

  $manifestFiles = @($manifest.files)
  $manifestPaths = @(
    $manifestFiles | ForEach-Object { [string]$_.path }
  )
  $expectedArchivePaths = @($manifestPaths) + @($baseManifestRelativePath)
  Assert-ExactPathSet `
    -Actual $ArchiveFilePaths `
    -Expected $expectedArchivePaths `
    -FailureMessage 'Base manifest entries do not exactly match the frozen archive.'
  Assert-ManifestFileHashes `
    -Root $ExtractedRoot `
    -ManifestFiles $manifestFiles `
    -HashMismatchPrefix 'Base manifest hash mismatch:'

  if (
    $baseReadmeRelativePath -notin $manifestPaths -or
    @(
      $manifestPaths |
        Where-Object { $_.StartsWith($preservedBaseClientPrefix) }
    ).Count -eq 0
  ) {
    throw 'Frozen base manifest is missing its README or complete client tree.'
  }
  return $manifest
}

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$DestinationRoot
  )

  Copy-FileSnapshot `
    -Source $Source `
    -Destination $Destination `
    -DestinationRoot $DestinationRoot `
    -MissingMessage "Required hotfix payload is missing: $Source"
}

function Copy-VerifiedBaseManifestPayload {
  param(
    [string]$ExtractedRoot,
    [string]$Stage,
    [object]$BaseManifest
  )

  foreach ($entry in @($BaseManifest.files)) {
    $relativePath = [string]$entry.path
    if ($relativePath -eq $baseReadmeRelativePath) {
      continue
    }
    Copy-RequiredFile `
      -Source (Join-Path $ExtractedRoot $relativePath) `
      -Destination (Join-Path $Stage $relativePath) `
      -DestinationRoot $Stage
  }
}

function Assert-PreservedBaseManifestEntries {
  param(
    [string]$Stage,
    [object]$BaseManifest
  )

  $preservedEntries = @(
    @($BaseManifest.files) |
      Where-Object {
        $path = [string]$_.path
        $path.StartsWith($preservedBaseClientPrefix) -or
          $path -in $preservedBaseServerRelativePaths
      }
  )
  if ($preservedEntries.Count -eq 0) {
    throw 'No frozen base client entries were selected for preservation.'
  }
  Assert-ManifestFileHashes `
    -Root $Stage `
    -ManifestFiles $preservedEntries `
    -HashMismatchPrefix 'Frozen base payload changed after overlay:'
}

function Assert-CompiledFileContains {
  param(
    [string]$Root,
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $Root $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled server runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled server runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledFileOmits {
  param(
    [string]$Root,
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $Root $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled server runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content.Contains($marker)) {
      throw "Compiled server runtime contains forbidden marker '$marker': $RelativePath"
    }
  }
}

function Copy-OverlaySnapshots {
  param(
    [string]$SnapshotRoot,
    [string]$ReadyPath,
    [string[]]$WorkflowRulesRequiredMarkers,
    [string[]]$WorkflowRulesForbiddenMarkers,
    [string[]]$InboundRulesRequiredMarkers,
    [string[]]$InboundServiceRequiredMarkers
  )

  foreach ($relativePath in $overlayRelativePaths) {
    $sourcePath = Join-Path $repoRoot $relativePath
    if (!(Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Compiled server runtime file was not found: $sourcePath"
    }
  }
  $firstHashes = Get-RelativeFileHashMap `
    -Root $repoRoot `
    -RelativePaths $overlayRelativePaths
  New-Item -ItemType Directory -Path $SnapshotRoot | Out-Null
  foreach ($relativePath in $overlayRelativePaths) {
    $sourcePath = Join-Path $repoRoot $relativePath
    Copy-FileSnapshot `
      -Source $sourcePath `
      -Destination (Join-Path $SnapshotRoot $relativePath) `
      -DestinationRoot $SnapshotRoot `
      -MissingMessage "Compiled server runtime file was not found: $sourcePath"
  }
  Complete-OverlaySnapshotReady `
    -SourceRoot $repoRoot `
    -SnapshotRoot $SnapshotRoot `
    -RelativePaths $overlayRelativePaths `
    -FirstHashes $firstHashes `
    -ReadyPath $ReadyPath
  Assert-NoReparsePoints -Root $SnapshotRoot
  Assert-OverlayFilesMatchReady `
    -Root $SnapshotRoot `
    -ReadyPath $ReadyPath `
    -ExpectedPaths $overlayRelativePaths `
    -FailurePrefix 'Overlay snapshot changed after ready:'
  Assert-CompiledFileContains `
    -Root $SnapshotRoot `
    -RelativePath $overlayRelativePaths[0] `
    -Markers $workflowServiceMarkers
  Assert-CompiledFileContains `
    -Root $SnapshotRoot `
    -RelativePath $overlayRelativePaths[1] `
    -Markers $WorkflowRulesRequiredMarkers
  Assert-CompiledFileOmits `
    -Root $SnapshotRoot `
    -RelativePath $overlayRelativePaths[1] `
    -Markers $WorkflowRulesForbiddenMarkers
  Assert-CompiledFileContains `
    -Root $SnapshotRoot `
    -RelativePath $overlayRelativePaths[2] `
    -Markers $InboundRulesRequiredMarkers
  Assert-CompiledFileContains `
    -Root $SnapshotRoot `
    -RelativePath $overlayRelativePaths[3] `
    -Markers $InboundServiceRequiredMarkers
}

function Assert-FrozenBaseFileContains {
  param(
    [string]$ExtractedRoot,
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $ExtractedRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Frozen base runtime file was not found: $RelativePath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Frozen base runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles
  )

  $files = @(
    $PayloadPaths | Sort-Object -CaseSensitive | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      $fileHash = Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
      [ordered]@{
        path = $_
        sha256 = $fileHash.Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    package = $packageName
    packageType = $packageType
    baseArchive = $baseArchiveRelativePath
    baseArchiveSha256 = $baseArchiveSha256
    replaceDirectories = @('dist/client')
    replaceFiles = @($ReplaceFiles)
    files = $files
  } | ConvertTo-Json -Depth 6 |
    Set-Content `
      -LiteralPath (Join-Path $Stage $manifestRelativePath) `
      -Encoding UTF8
}

function Assert-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles,
    [string]$HashMismatchPrefix = 'Hotfix manifest hash mismatch:'
  )

  $manifestPath = Join-Path $Stage $manifestRelativePath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [int]$manifest.schemaVersion -ne 1 -or
    [string]$manifest.package -cne $packageName -or
    [string]$manifest.packageType -ne $packageType -or
    [string]$manifest.baseArchive -cne $baseArchiveRelativePath -or
    [string]$manifest.baseArchiveSha256 -ne $baseArchiveSha256
  ) {
    throw 'Combined hotfix manifest identity is invalid.'
  }
  Assert-ExactPathSet `
    -Actual @($manifest.replaceDirectories | ForEach-Object { [string]$_ }) `
    -Expected @('dist/client') `
    -FailureMessage 'Combined manifest replaceDirectories is invalid.'
  Assert-ExactPathSet `
    -Actual @($manifest.replaceFiles | ForEach-Object { [string]$_ }) `
    -Expected $ReplaceFiles `
    -FailureMessage 'Combined manifest replaceFiles is invalid.'
  $manifestFiles = @($manifest.files)
  Assert-ExactPathSet `
    -Actual @($manifestFiles | ForEach-Object { [string]$_.path }) `
    -Expected $PayloadPaths `
    -FailureMessage 'Combined manifest entries do not match the payload files.'
  Assert-ManifestFileHashes `
    -Root $Stage `
    -ManifestFiles $manifestFiles `
    -HashMismatchPrefix $HashMismatchPrefix
}

function Assert-ZipSidecar {
  param(
    [string]$ArchivePath,
    [string]$SidecarPath,
    [string]$ExpectedHash = ''
  )

  if (
    !(Test-Path -LiteralPath $ArchivePath -PathType Leaf) -or
    !(Test-Path -LiteralPath $SidecarPath -PathType Leaf)
  ) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
  $rawSidecar = [IO.File]::ReadAllText(
    $SidecarPath,
    [Text.Encoding]::ASCII
  )
  $sidecarMatch = [Text.RegularExpressions.Regex]::Match(
    $rawSidecar,
    '\A(?<hash>[A-Fa-f0-9]{64})  (?<file>[^/\\\r\n]+)(?:\r\n|\n)?\z',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  $expectedFileName = [IO.Path]::GetFileName($ArchivePath)
  if (
    !$sidecarMatch.Success -or
    !$sidecarMatch.Groups['file'].Value.Equals(
      $expectedFileName,
      [StringComparison]::Ordinal
    )
  ) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
  $declaredHash = $sidecarMatch.Groups['hash'].Value.ToUpperInvariant()
  if ($ExpectedHash) {
    $actualHash = $ExpectedHash.ToUpperInvariant()
  } else {
    $stream = [IO.FileStream]::new(
      $ArchivePath,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::Read
    )
    try {
      $sha256 = [Security.Cryptography.SHA256]::Create()
      try {
        $hashBytes = $sha256.ComputeHash($stream)
      } finally {
        $sha256.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    $actualHash = ([BitConverter]::ToString($hashBytes)).Replace('-', '')
  }
  if ($actualHash -ne $declaredHash) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
}

function Verify-FinalArchive {
  param(
    [string]$zipPath,
    [string]$VerificationRoot,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles
  )

  $lease = Open-VerifiedFinalArchive `
    -zipPath $zipPath `
    -VerificationRoot $VerificationRoot `
    -PayloadPaths $PayloadPaths `
    -ReplaceFiles $ReplaceFiles
  try {
    $archiveHash = [string]$lease.Hash
  } finally {
    $lease.Stream.Dispose()
  }
  return $archiveHash
}

function Open-VerifiedFinalArchive {
  param(
    [string]$zipPath,
    [string]$VerificationRoot,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles,
    [string]$ExpectedHash = ''
  )

  Add-Type -AssemblyName System.IO.Compression
  $stream = [IO.FileStream]::new(
    $zipPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  try {
    $archiveHash = Get-StreamSha256 -stream $stream
    if (
      $ExpectedHash -and
      $archiveHash -ne $ExpectedHash.ToUpperInvariant()
    ) {
      throw 'Published ZIP hash does not match the verified temporary ZIP.'
    }
    $stream.Position = 0
    $archive = [System.IO.Compression.ZipArchive]::new(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $true
    )
    try {
      $archivePaths = Assert-SafeArchiveEntries -Archive $archive
      Assert-ExactPathSet `
        -Actual $archivePaths `
        -Expected (@($PayloadPaths) + @($manifestRelativePath)) `
        -FailureMessage 'Final ZIP entries do not exactly match the manifest and metadata files.'
      Expand-OpenArchiveEntries `
        -Archive $archive `
        -Destination $VerificationRoot
      Assert-NoReparsePoints -Root $VerificationRoot
      Assert-HotfixManifest `
        -Stage $VerificationRoot `
        -PayloadPaths $PayloadPaths `
        -ReplaceFiles $ReplaceFiles `
        -HashMismatchPrefix 'Final archive manifest hash mismatch:'
      $verifiedPaths = Get-StageRelativePaths -Stage $VerificationRoot
      Assert-ExactPathSet `
        -Actual $verifiedPaths `
        -Expected (@($PayloadPaths) + @($manifestRelativePath)) `
        -FailureMessage 'Final ZIP extraction contains an unexpected or missing file.'
    } finally {
      $archive.Dispose()
    }
    return [PSCustomObject]@{
      Stream = $stream
      Hash = $archiveHash
    }
  } catch {
    $stream.Dispose()
    throw
  }
}

function Write-ArchiveSidecarCandidate {
  param(
    [string]$ArchivePath,
    [string]$CandidatePath,
    [string]$ArchiveHash
  )

  if ($ArchiveHash -notmatch '^[A-F0-9]{64}$') {
    throw 'Cannot write a sidecar for an invalid archive hash.'
  }
  $sidecarContent = "$ArchiveHash  $([IO.Path]::GetFileName($ArchivePath))" +
    [Environment]::NewLine
  $sidecarBytes = [Text.Encoding]::ASCII.GetBytes($sidecarContent)
  $sidecarStream = [IO.FileStream]::new(
    $CandidatePath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $sidecarStream.Write($sidecarBytes, 0, $sidecarBytes.Length)
    $sidecarStream.Flush()
  } finally {
    $sidecarStream.Dispose()
  }
  return $sidecarContent
}

function Assert-OwnedPublishedArchiveLeaf {
  param(
    [string]$ArchivePath,
    [string]$ExpectedHash
  )

  if (!(Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
    throw "Owned published ZIP was not found: $ArchivePath"
  }
  $archiveItem = Get-Item -LiteralPath $ArchivePath -Force
  if ($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to delete a reparse-point published ZIP: $ArchivePath"
  }
  $actualHash = Get-LockedFileSha256 -Path $ArchivePath
  if ($actualHash -ne $ExpectedHash.ToUpperInvariant()) {
    throw "Refusing to delete a published ZIP with changed content: $ArchivePath"
  }
}

function Assert-OwnedPublishedSidecarLeaf {
  param(
    [string]$SidecarPath,
    [string]$ExpectedContent
  )

  if (!(Test-Path -LiteralPath $SidecarPath -PathType Leaf)) {
    throw "Owned published sidecar was not found: $SidecarPath"
  }
  $sidecarItem = Get-Item -LiteralPath $SidecarPath -Force
  if ($sidecarItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to delete a reparse-point published sidecar: $SidecarPath"
  }
  $actualContent = [IO.File]::ReadAllText(
    $SidecarPath,
    [Text.Encoding]::ASCII
  )
  if ($actualContent -cne $ExpectedContent) {
    throw "Refusing to delete a published sidecar with changed content: $SidecarPath"
  }
}

function Remove-OwnedPublishedArchiveLeaf {
  param(
    [string]$ArchivePath,
    [string]$ExpectedHash
  )

  Assert-OwnedPublishedArchiveLeaf `
    -ArchivePath $ArchivePath `
    -ExpectedHash $ExpectedHash
  [IO.File]::Delete($ArchivePath)
}

function Remove-OwnedPublishedSidecarLeaf {
  param(
    [string]$SidecarPath,
    [string]$ExpectedContent
  )

  Assert-OwnedPublishedSidecarLeaf `
    -SidecarPath $SidecarPath `
    -ExpectedContent $ExpectedContent
  [IO.File]::Delete($SidecarPath)
}

function Rollback-OwnedPublishedLeaves {
  param(
    [bool]$ArchivePublished,
    [bool]$SidecarPublished,
    [string]$ArchivePath,
    [string]$SidecarPath,
    [string]$ExpectedArchiveHash,
    [string]$ExpectedSidecarContent
  )

  $ownedSidecarExists = $SidecarPublished -and (Test-Path -LiteralPath $SidecarPath)
  $ownedArchiveExists = $ArchivePublished -and (Test-Path -LiteralPath $ArchivePath)

  if ($ownedSidecarExists) {
    Assert-OwnedPublishedSidecarLeaf `
      -SidecarPath $SidecarPath `
      -ExpectedContent $ExpectedSidecarContent
  }
  if ($ownedArchiveExists) {
    Assert-OwnedPublishedArchiveLeaf `
      -ArchivePath $ArchivePath `
      -ExpectedHash $ExpectedArchiveHash
  }

  if ($ownedSidecarExists) {
    Remove-OwnedPublishedSidecarLeaf `
      -SidecarPath $SidecarPath `
      -ExpectedContent $ExpectedSidecarContent
  }
  if ($ownedArchiveExists) {
    Remove-OwnedPublishedArchiveLeaf `
      -ArchivePath $ArchivePath `
      -ExpectedHash $ExpectedArchiveHash
  }
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Production server build failed; hotfix package was not created.'
  }
}

$decodedWorkflowRulesMarkers = @($workflowRulesMarkers) + @(
  ConvertFrom-Utf8Base64Array -Values $workflowRulesMarkerBase64
)
$decodedWorkflowRulesForbiddenMarkers = ConvertFrom-Utf8Base64Array `
  -Values $workflowRulesForbiddenMarkerBase64
$decodedInboundRulesMarkers = @($inboundRulesMarkers) + @(
  ConvertFrom-Utf8Base64Array -Values $inboundRulesMarkerBase64
)
$decodedInboundServiceMarkers = @($inboundServiceMarkers) + @(
  ConvertFrom-Utf8Base64Array -Values $inboundServiceMarkerBase64
)
$decodedBaseGatewayMarkers = @($baseGatewayMarkers) + @(
  ConvertFrom-Utf8Base64Array -Values $baseGatewayMarkerBase64
)

Assert-NoReparsePointsInPathChain -Path $outputRoot
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
foreach ($privatePath in @(
  $runRoot,
  $ownerTokenPath,
  $baseSnapshotPath,
  $overlaySnapshotRoot,
  $overlayReadyPath,
  $baseExtractDir,
  $stageDir,
  $verifyDir,
  $finalVerifyDir,
  $tempZipPath,
  $tempSidecarPath
)) {
  Assert-ChildPath -Parent $outputRoot -Child $privatePath
}
foreach ($publishedPath in @($zipPath, $sidecarPath)) {
  Assert-ChildPath -Parent $outputRoot -Child $publishedPath
  if (Test-Path -LiteralPath $publishedPath) {
    throw "Hotfix output already exists: $publishedPath"
  }
}

$baseArchivePath = Join-Path $repoRoot $baseArchiveRelativePath
$runRootCreated = $false
$ownerTokenWritten = $false
$zipPublished = $false
$sidecarPublished = $false
$tempArchiveHash = ''
$archiveHash = ''
$expectedSidecarContent = ''
$finalArchiveLease = $null
try {
  Initialize-OwnedRunRoot `
    -RunRoot $runRoot `
    -OwnerTokenPath $ownerTokenPath `
    -OwnerToken $ownerToken
  $runRootCreated = $true
  $ownerTokenWritten = $true
  Assert-OwnedRunRoot `
    -RunRoot $runRoot `
    -OwnerTokenPath $ownerTokenPath `
    -ExpectedToken $ownerToken

  Copy-OverlaySnapshots -SnapshotRoot $overlaySnapshotRoot `
    -ReadyPath $overlayReadyPath `
    -WorkflowRulesRequiredMarkers $decodedWorkflowRulesMarkers `
    -WorkflowRulesForbiddenMarkers $decodedWorkflowRulesForbiddenMarkers `
    -InboundRulesRequiredMarkers $decodedInboundRulesMarkers `
    -InboundServiceRequiredMarkers $decodedInboundServiceMarkers
  Copy-FileSnapshot `
    -Source $baseArchivePath `
    -Destination $baseSnapshotPath `
    -DestinationRoot $runRoot `
    -MissingMessage "Frozen base archive was not found: $baseArchivePath"

  $baseArchiveFilePaths = Expand-VerifiedBaseArchiveSnapshot -SnapshotPath $baseSnapshotPath `
    -Destination $baseExtractDir
  $baseManifest = Assert-BaseManifest -ExtractedRoot $baseExtractDir `
    -ArchiveFilePaths $baseArchiveFilePaths
  Assert-FrozenBaseFileContains `
    -ExtractedRoot $baseExtractDir `
    -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js' `
    -Markers $decodedBaseGatewayMarkers
  Assert-FrozenBaseFileContains `
    -ExtractedRoot $baseExtractDir `
    -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.store.js' `
    -Markers $baseStoreMarkers

  New-Item -ItemType Directory -Path $stageDir | Out-Null
  Copy-VerifiedBaseManifestPayload -ExtractedRoot $baseExtractDir `
    -Stage $stageDir `
    -BaseManifest $baseManifest

  foreach ($relativePath in $overlayRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $overlaySnapshotRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath) `
      -DestinationRoot $stageDir
  }
  Assert-OverlayFilesMatchReady `
    -Root $stageDir `
    -ReadyPath $overlayReadyPath `
    -ExpectedPaths $overlayRelativePaths `
    -FailurePrefix 'Staged overlay does not match ready snapshot:'
  Assert-PreservedBaseManifestEntries -Stage $stageDir `
    -BaseManifest $baseManifest

  $finalServerRelativePaths = Get-UniqueSortedPaths `
    -Paths (@($baseServerRelativePaths) + @($overlayRelativePaths))
  $readmeLines = @(
    ConvertFrom-Utf8Base64Array -Values $readmeIntroductionBase64
  ) + @(
    '',
    '## Provenance',
    '',
    "- Frozen base: ``$baseArchiveRelativePath``",
    "- Frozen base SHA256: ``$baseArchiveSha256``",
    '- Complete dist/client and all frozen manager server/CLI files come only from the verified base archive.',
    '- The current workspace dist/client is never copied or rebuilt.',
    '- The current workspace overlays only the four server runtime files listed in the manifest.',
    ''
  ) + @(
    ConvertFrom-Utf8Base64Array -Values $readmeDeploymentBase64
  ) + @(
    '',
    '## Server runtime files'
  ) + @(
    $finalServerRelativePaths | ForEach-Object { '- `' + $_ + '`' }
  ) + @(
    ''
  ) + @(
    ConvertFrom-Utf8Base64Array -Values $readmeAcceptanceRollbackBase64
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $basePayloadPaths = @(
    @($baseManifest.files) |
      ForEach-Object { [string]$_.path } |
      Where-Object { $_ -ne $baseReadmeRelativePath }
  )
  $expectedPayloadPaths = Get-UniqueSortedPaths `
    -Paths (
      @($basePayloadPaths) +
      @($overlayRelativePaths) +
      @($readmeRelativePath)
    )
  $stagedPayloadPaths = Get-StageRelativePaths -Stage $stageDir
  Assert-ExactPathSet `
    -Actual $stagedPayloadPaths `
    -Expected $expectedPayloadPaths `
    -FailureMessage 'Hotfix staging contains an unexpected or missing file.'
  Assert-SafePayloadPaths -Paths $stagedPayloadPaths
  Assert-NoReparsePoints -Root $stageDir

  Write-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths
  Assert-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths

  $actualStagePaths = Get-StageRelativePaths -Stage $stageDir
  Assert-ExactPathSet `
    -Actual $actualStagePaths `
    -Expected (@($stagedPayloadPaths) + @($manifestRelativePath)) `
    -FailureMessage 'Hotfix staging contains an unexpected or missing metadata file.'
  Assert-SafePayloadPaths -Paths $actualStagePaths

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $tempZipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $tempArchiveHash = Verify-FinalArchive `
    -zipPath $tempZipPath `
    -VerificationRoot $verifyDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths

  Assert-OwnedRunRoot `
    -RunRoot $runRoot `
    -OwnerTokenPath $ownerTokenPath `
    -ExpectedToken $ownerToken
  foreach ($publishedPath in @($zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $publishedPath) {
      throw "Hotfix output already exists: $publishedPath"
    }
  }
  Move-Item -LiteralPath $tempZipPath -Destination $zipPath
  $zipPublished = $true
  $finalArchiveLease = Open-VerifiedFinalArchive `
    -zipPath $zipPath `
    -VerificationRoot $finalVerifyDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths `
    -ExpectedHash $tempArchiveHash
  try {
    $archiveHash = [string]$finalArchiveLease.Hash
    $expectedSidecarContent = Write-ArchiveSidecarCandidate `
      -ArchivePath $zipPath `
      -CandidatePath $tempSidecarPath `
      -ArchiveHash $archiveHash
    Assert-ZipSidecar `
      -ArchivePath $zipPath `
      -SidecarPath $tempSidecarPath `
      -ExpectedHash $archiveHash
    Move-Item -LiteralPath $tempSidecarPath -Destination $sidecarPath
    $sidecarPublished = $true
    Assert-ZipSidecar `
      -ArchivePath $zipPath `
      -SidecarPath $sidecarPath `
      -ExpectedHash $archiveHash
    Assert-OwnedPublishedSidecarLeaf `
      -SidecarPath $sidecarPath `
      -ExpectedContent $expectedSidecarContent
  } finally {
    $finalArchiveLease.Stream.Dispose()
    $finalArchiveLease = $null
  }
} catch {
  if ($finalArchiveLease) {
    $finalArchiveLease.Stream.Dispose()
    $finalArchiveLease = $null
  }
  if ($runRootCreated -and $ownerTokenWritten) {
    Assert-OwnedRunRoot `
      -RunRoot $runRoot `
      -OwnerTokenPath $ownerTokenPath `
      -ExpectedToken $ownerToken
    Rollback-OwnedPublishedLeaves `
      -ArchivePublished $zipPublished `
      -SidecarPublished $sidecarPublished `
      -ArchivePath $zipPath `
      -SidecarPath $sidecarPath `
      -ExpectedArchiveHash $tempArchiveHash `
      -ExpectedSidecarContent $expectedSidecarContent
  }
  throw
} finally {
  if (
    $runRootCreated -and
    $ownerTokenWritten -and
    (Test-Path -LiteralPath $runRoot)
  ) {
    Remove-OwnedRunRoot `
      -RunRoot $runRoot `
      -OwnerTokenPath $ownerTokenPath `
      -ExpectedToken $ownerToken
  }
}

Write-Host '[OK] Purchase two-session latest combined hotfix created.' -ForegroundColor Green
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
