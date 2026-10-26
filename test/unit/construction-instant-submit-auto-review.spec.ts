import { readFileSync } from 'fs';
import * as path from 'path';

import { isConstructionManualReviewAutoApprovalRole } from '../../shared/construction-manual-review-policy';
import {
  buildConstructionPermitManualReviewAutoApprovalFields,
  CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
  CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS,
} from '../../server/modules/duty-schedule/construction-management';

describe('construction instant submit and automatic manual review', () => {
  const pageSource = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );
  const serviceSource = readFileSync(
    path.resolve(
      __dirname,
      '../../server/modules/duty-schedule/duty-schedule.service.ts',
    ),
    'utf8',
  );
  const hotfixInstallerSource = readFileSync(
    path.resolve(
      __dirname,
      '../../deploy/apply-construction-instant-submit-auto-review-hotfix.ps1',
    ),
    'utf8',
  );
  const hotfixPackageSource = readFileSync(
    path.resolve(
      __dirname,
      '../../scripts/create-construction-instant-submit-auto-review-hotfix-package.ps1',
    ),
    'utf8',
  );
  const hotfixReadmeSource = readFileSync(
    path.resolve(
      __dirname,
      '../../deploy/README_CONSTRUCTION_INSTANT_SUBMIT_AUTO_REVIEW.md',
    ),
    'utf8',
  );

  it.each(['admin', 'construction_admin', 'editor'] as const)(
    'automatically approves manual review for %s',
    (role) => {
      expect(isConstructionManualReviewAutoApprovalRole(role)).toBe(true);
    },
  );

  it.each([
    'guest',
    'inventory_admin',
    'purchase_admin',
    'purchase_applicant',
    'duty_editor',
    'supply_chain_admin',
  ] as const)('does not broaden automatic approval to %s', (role) => {
    expect(isConstructionManualReviewAutoApprovalRole(role)).toBe(false);
  });

  it('auto-approves uploaded permits only with their manually selected validity dates', () => {
    const permitFiles = Object.fromEntries(
      Object.keys(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).map(
        (fileKey, index) => [
          CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey],
          [{ file_token: `permit-${index + 1}` }],
        ],
      ),
    );
    const permitValidUntilByFileKey = Object.fromEntries(
      Object.keys(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).map(
        (fileKey, index) => [fileKey, `2026-08-0${index + 1}`],
      ),
    );
    const buildWithValidityDates =
      buildConstructionPermitManualReviewAutoApprovalFields as unknown as (
        fields: Record<string, unknown>,
        role: 'construction_admin' | 'guest',
        validUntilByFileKey: Record<string, string>,
        changedFileKeys?: readonly string[],
      ) => Record<string, unknown>;

    const fields = buildWithValidityDates(
      permitFiles,
      'construction_admin',
      permitValidUntilByFileKey,
    );

    Object.entries(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).forEach(
      ([fileKey, config]) => {
        expect(fields[config.reviewField]).toBe('通过');
        expect(fields[config.fingerprintField]).toMatch(
          new RegExp(`^v2:${permitValidUntilByFileKey[fileKey]}:`),
        );
      },
    );
    expect(buildWithValidityDates(permitFiles, 'construction_admin', {})).toEqual(
      {},
    );
    expect(
      buildWithValidityDates(
        permitFiles,
        'guest',
        permitValidUntilByFileKey,
      ),
    ).toEqual({});
  });

  it('does not overwrite the manual validity of permits that were not replaced', () => {
    const permitFiles = Object.fromEntries(
      Object.keys(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).map(
        (fileKey, index) => [
          CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey],
          [{ file_token: `permit-${index + 1}` }],
        ],
      ),
    );
    const buildWithValidityDates =
      buildConstructionPermitManualReviewAutoApprovalFields as unknown as (
        fields: Record<string, unknown>,
        role: 'construction_admin',
        validUntilByFileKey: Record<string, string>,
        changedFileKeys: readonly string[],
      ) => Record<string, unknown>;
    const fields = buildWithValidityDates(
      permitFiles,
      'construction_admin',
      { heightWorkPermitFiles: '2026-08-02' },
      ['heightWorkPermitFiles'],
    );
    const heightConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.heightWorkPermitFiles;

    expect(fields).toEqual(
      expect.objectContaining({
        [heightConfig.reviewField]: '通过',
        [heightConfig.fingerprintField]: expect.stringMatching(
          /^v2:2026-08-02:/,
        ),
      }),
    );
    Object.entries(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS)
      .filter(([fileKey]) => fileKey !== 'heightWorkPermitFiles')
      .forEach(([, config]) => {
        expect(fields).not.toHaveProperty(config.reviewField);
        expect(fields).not.toHaveProperty(config.fingerprintField);
      });
  });

  it('collects permit validity ranges before one submit and applies them to the optimistic passed state', () => {
    const permitSelectionSource = pageSource.slice(
      pageSource.indexOf('const handleDailyPermitUpload'),
      pageSource.indexOf('const handleRefreshConstructionBitableData'),
    );
    const permitCardSource = pageSource.slice(
      pageSource.indexOf('function DailyPermitVerificationCard'),
      pageSource.indexOf('function DailyPermitManualReviewBadge'),
    );
    const permitUploadButtonSource = pageSource.slice(
      pageSource.indexOf('function DailyPermitUploadButton'),
      pageSource.indexOf('function DailyFollowupStageStepper'),
    );
    const permitPickerSource = pageSource.slice(
      pageSource.indexOf('function pickDailyPermitFileBuckets'),
      pageSource.indexOf('function pickSupplementalFileBuckets'),
    );

    expect(pageSource).toContain('permitValidFromByFileKey');
    expect(pageSource).toContain('permitValidUntilByFileKey');
    expect(pageSource).toContain('作业票有效期开始');
    expect(pageSource).toContain('作业票有效期至');
    expect(pageSource).toContain(
      "appendOptionalField(formData, 'permitValidFromByFileKey'",
    );
    expect(pageSource).toContain(
      "appendOptionalField(formData, 'permitValidUntilByFileKey'",
    );
    expect(pageSource).toContain(
      'validFrom: permitValidFromByFileKey[fieldKey] || null',
    );
    expect(pageSource).toContain(
      'validUntil: permitValidUntilByFileKey[fieldKey] || null',
    );
    expect(pageSource).toContain(
      'if (permitOnlyUpload && manualReviewAutoApproved)',
    );
    expect(permitCardSource).toContain(
      'manualReviewAutoApproved && (',
    );
    expect(permitUploadButtonSource).toContain('requireValidityRange');
    expect(permitUploadButtonSource).toContain('!validFrom || !validUntil');
    expect(permitSelectionSource).toContain('if (manualReviewAutoApproved)');
    expect(permitSelectionSource).toContain('已选择，请提交作业票校核');
    expect(permitSelectionSource).not.toContain('handleFollowupSubmit({');
    expect(permitPickerSource).toContain(
      'permitVerifications.map((item) => item.fileKey)',
    );
    expect(permitPickerSource).not.toContain(
      'getDailyPermitRenewalFileFields(permitVerifications)',
    );
  });

  it('never reuses a boolean value for permit manual-review single-option fields', () => {
    expect(serviceSource).not.toContain(
      'autoFields[reviewConfig.reviewField] = true;',
    );
    expect(serviceSource).toContain(
      "autoFields[reviewConfig.reviewField] = '通过';",
    );
  });

  it('closes accepted dialogs before yielding to expensive payload work', () => {
    const followupSubmitSource = pageSource.slice(
      pageSource.indexOf('const handleFollowupSubmit'),
      pageSource.indexOf('const handleGeneratedOnlineFormSubmit'),
    );
    const instantCloseIndex = followupSubmitSource.indexOf(
      'closeFollowupDialogForOptimisticSubmit();',
    );
    const yieldIndex = followupSubmitSource.indexOf(
      'await yieldToBrowserForConstructionResponse();',
    );
    const formDataIndex = followupSubmitSource.indexOf(
      'const formData = new FormData();',
    );

    expect(instantCloseIndex).toBeGreaterThan(-1);
    expect(yieldIndex).toBeGreaterThan(instantCloseIndex);
    expect(formDataIndex).toBeGreaterThan(yieldIndex);
    expect(pageSource).toMatch(
      /const manualReviewAutoApproved\s*=\s*isConstructionManualReviewAutoApprovalRole\(role\);/,
    );
  });

  it('explicitly declares the compact follow-up dialog has no description', () => {
    const followupDialogSource = pageSource.slice(
      pageSource.indexOf('function FollowupDialog'),
      pageSource.indexOf('function DailyWorkTypeAuditPanel'),
    );
    expect(followupDialogSource).toContain('aria-describedby={undefined}');
  });

  it('uses file pickers only and removes construction drag-and-drop upload', () => {
    const uploadSource = pageSource.slice(
      pageSource.indexOf('function FilePickerField'),
      pageSource.indexOf('function getFilePickerFieldSummary'),
    );

    expect(uploadSource).toContain('type="file"');
    expect(uploadSource).toContain('选择文件');
    expect(uploadSource).not.toContain('onDrop');
    expect(uploadSource).not.toContain('onDrag');
    expect(uploadSource).not.toContain('dragActive');
    expect(uploadSource).not.toContain('拖拽');
    expect(pageSource).not.toContain('function FileDropField');
  });

  it('allows the hotfix installer to compare empty runtime file sets', () => {
    expect(hotfixInstallerSource).toContain(
      '$leftCount = ($Left | Measure-Object).Count',
    );
    expect(hotfixInstallerSource).toContain(
      '$rightCount = ($Right | Measure-Object).Count',
    );
    expect(hotfixInstallerSource).toContain(
      '$leftCount -ne $rightCount',
    );
  });

  it('packages and atomically installs the shared runtime required by the compiled server', () => {
    expect(hotfixPackageSource).toContain(
      "$sharedSource = Join-Path $repoRoot 'dist/shared'",
    );
    expect(hotfixPackageSource).toContain(
      "(Join-Path $sharedSource 'construction-manual-review-policy.js')",
    );
    expect(hotfixPackageSource).toContain(
      "replaceDirectories = @('dist/client', 'dist/server', 'dist/shared')",
    );
    expect(hotfixInstallerSource).toContain(
      "$allowedDirectories = @('dist/client', 'dist/server', 'dist/shared')",
    );
    expect(hotfixInstallerSource).toContain(
      "$packageSharedPath = Join-Path $packageRoot 'dist/shared'",
    );
    expect(hotfixInstallerSource).toContain(
      "$targetSharedPath = Join-Path $targetPath 'dist/shared'",
    );
    expect(hotfixInstallerSource).toContain(
      "$backupSharedPath = Join-Path $backupRoot 'dist/shared'",
    );
    expect(hotfixInstallerSource).toContain(
      "$replacementSharedPath = Join-Path $replacementRoot 'shared'",
    );
    expect(hotfixInstallerSource).toContain(
      "'^dist/(client|server|shared)/'",
    );
    expect(hotfixReadmeSource).toContain('`dist/shared`');
  });

  it('cleans only the three verified build output directories before compiling', () => {
    expect(hotfixPackageSource).toContain(
      "$buildOutputRoot = Join-Path $repoRoot 'dist'",
    );
    expect(hotfixPackageSource).toContain(
      "$cleanBuildDirectories = @('client', 'server', 'shared')",
    );
    expect(hotfixPackageSource).toMatch(
      /Assert-ChildPath\s+`?\s*-Parent \$buildOutputRoot\s+`?\s*-Child \$cleanBuildPath/,
    );
    expect(hotfixPackageSource).toMatch(
      /Remove-Item -LiteralPath \$cleanBuildPath -Recurse -Force/,
    );
    expect(hotfixPackageSource).toContain(
      "$serverBuildInfoPath = Join-Path $buildOutputRoot 'tsconfig.node.tsbuildinfo'",
    );
    expect(hotfixPackageSource).toMatch(
      /Remove-Item -LiteralPath \$serverBuildInfoPath -Force/,
    );
  });

  it('repairs a target where the previous hot package omitted dist/shared', () => {
    expect(hotfixInstallerSource).toContain(
      '$targetSharedOriginallyExists = Test-Path -LiteralPath $targetSharedPath -PathType Container',
    );
    expect(hotfixInstallerSource).toMatch(
      /if \(\$targetSharedOriginallyExists\) \{\s+Assert-NoReparsePoints/,
    );
    expect(hotfixInstallerSource).toMatch(
      /if \(\$targetSharedOriginallyExists\) \{\s+Copy-Item -LiteralPath \$targetSharedPath -Destination \$backupDistPath -Recurse/,
    );
    expect(hotfixInstallerSource).toMatch(
      /if \(\$targetSharedOriginallyExists\) \{\s+Copy-Item\s+`?\s+-LiteralPath \$backupSharedPath/,
    );
  });

  it('uses a short staging path and retries transient Windows moves', () => {
    expect(hotfixInstallerSource).toContain(
      '$replacementRoot = Join-Path $targetPath ".hf-$PID"',
    );
    expect(hotfixInstallerSource).toContain('function Move-PathWithRetry');
    expect(hotfixInstallerSource).toContain(
      'Start-Sleep -Milliseconds (200 * $attempt)',
    );
    expect(hotfixInstallerSource.match(/Move-PathWithRetry\s+`/g)).toHaveLength(4);
  });

  it('backs up, replaces, verifies, and rolls back the root launcher', () => {
    expect(hotfixPackageSource).toContain(
      "$startScriptSource = Join-Path $repoRoot 'deploy/start.ps1'",
    );
    expect(hotfixPackageSource).toContain(
      "-Destination (Join-Path $stageRoot 'start.ps1')",
    );
    expect(hotfixPackageSource).toContain(
      "replaceFiles = @('start.ps1')",
    );
    expect(hotfixPackageSource).toContain(
      "$runtimeFiles.path -contains 'start.ps1'",
    );
    expect(hotfixInstallerSource).toContain(
      "$allowedFiles = @('start.ps1')",
    );
    expect(hotfixInstallerSource).toContain(
      '$manifest.replaceFiles',
    );
    expect(hotfixInstallerSource).toContain(
      "$packageStartScriptPath = Join-Path $packageRoot 'start.ps1'",
    );
    expect(hotfixInstallerSource).toContain(
      "$targetStartScriptPath = Join-Path $targetPath 'start.ps1'",
    );
    expect(hotfixInstallerSource).toContain(
      "$backupStartScriptPath = Join-Path $backupRoot 'start.ps1'",
    );
    expect(hotfixInstallerSource).toContain(
      "$replacementStartScriptPath = Join-Path $replacementRoot 'start.ps1'",
    );
    expect(hotfixInstallerSource).toMatch(
      /Copy-Item\s+`?\s*-LiteralPath \$targetStartScriptPath\s+`?\s*-Destination \$backupStartScriptPath/,
    );
    expect(hotfixInstallerSource).toMatch(
      /Move-PathWithRetry\s+`?\s*-Source \$replacementStartScriptPath\s+`?\s*-Destination \$targetStartScriptPath/,
    );
    expect(hotfixInstallerSource).toMatch(
      /catch \{[\s\S]*?Copy-Item\s+`?\s*-LiteralPath \$backupStartScriptPath\s+`?\s*-Destination \$targetStartScriptPath/,
    );
    expect(hotfixInstallerSource).toContain(
      "($relativePath -ne 'start.ps1')",
    );
  });

  it('auto-approves isolation review in the background for privileged submitters', () => {
    expect(serviceSource).toContain(
      'buildConstructionIsolationManualReviewAutoApprovalFields',
    );
    expect(serviceSource).toContain(
      'isConstructionManualReviewAutoApprovalRole(input.accessRole)',
    );
    expect(serviceSource).toMatch(
      /buildConstructionIsolationManualReviewAutoApprovalFields[\s\S]*?buildConstructionIsolationManualReviewUpdateFields\([\s\S]*?'passed'/,
    );
  });

  it.each([
    ['crew roster update', 'private async syncConstructionCrewRosterFilesToLedger'],
    ['project termination', 'async terminateConstructionProject'],
    ['project deletion', 'private async deleteConstructionProjectNow'],
    ['application creation', 'private async createConstructionApplicationNow'],
    ['attachment deletion', 'async deleteConstructionAttachment'],
    ['follow-up main write', 'private async createConstructionFollowupNow'],
    [
      'follow-up attachment write',
      'private async runConstructionFollowupPostSaveSync(',
    ],
  ])(
    'invalidates persisted Feishu snapshots after %s',
    (_label, functionSignature) => {
      const start = serviceSource.indexOf(functionSignature);
      const nextMethod = serviceSource
        .slice(start + functionSignature.length)
        .search(/\n  (?:async |private |protected |public )/);
      const end =
        nextMethod < 0
          ? serviceSource.length
          : start + functionSignature.length + nextMethod;
      expect(start).toBeGreaterThan(-1);
      expect(serviceSource.slice(start, end)).toContain(
        'deletePersisted: true',
      );
    },
  );
});
