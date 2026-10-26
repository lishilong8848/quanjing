import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

jest.mock(
  '@server/database/schema',
  () => ({
    appRoomScheduleEnhanced: {},
    appSyncConfig: {},
    appSealingInfo: {},
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({})),
    maskSecret: jest.fn((value?: string | null) => (value ? '***' : '')),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn((name: string, aliases: string[] = []) => {
      for (const key of [name, ...aliases]) {
        const value = process.env[key]?.trim();
        if (value) return value;
      }
      return '';
    }),
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/database/unavailable-database',
  () => ({
    isDatabaseDisabled: jest.fn(() => true),
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/feishu/bitable-direct-read',
  () => ({
    extractDateTimeIso: jest.fn(() => null),
    extractDateValue: jest.fn(() => null),
    extractDisplayText: jest.fn(() => ''),
    extractDisplayValues: jest.fn(() => []),
    extractNumberValue: jest.fn(() => null),
    fetchBitableRecords: jest.fn(),
    getRecordId: jest.fn(() => ''),
    invalidateBitableRecordCache: jest.fn(),
    normalizeBuildingForFrontend: jest.fn((value: string) => value),
    normalizeBuildingLabel: jest.fn((value: string) => value),
    normalizeShiftForFrontend: jest.fn((value: string) => value),
    normalizeTeamForFrontend: jest.fn((value: string) => value),
    pickField: jest.fn(() => undefined),
    resolveBitableAppToken: jest.fn(async () => ''),
  }),
  { virtual: true },
);

jest.mock(
  '@shared/exception-follow-up-match',
  () => ({
    normalizeExceptionFollowUpComparable: jest.fn((value: string) => value),
  }),
  { virtual: true },
);

import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import {
  getDailyPermitDisplayMessage,
  type DailyPermitVerification,
} from '../../client/src/pages/ConstructionManagement/daily-permit-verification';

type ConstructionAiAuditSwitchProbe = {
  isConstructionAiAuditEnabled(): boolean;
  readConstructionImageAuditExternalEnv(): Record<string, string>;
};

const SWITCH_ENV_NAME = 'CONSTRUCTION_AI_AUDIT_ENABLED';
const EXTERNAL_ENV_PATH_NAME = 'CONSTRUCTION_IMAGE_AUDIT_ENV_PATH';

describe('construction AI audit master switch', () => {
  const previousSwitchValue = process.env[SWITCH_ENV_NAME];
  const previousExternalEnvPath = process.env[EXTERNAL_ENV_PATH_NAME];
  const previousNodeEnv = process.env.NODE_ENV;
  let temporaryDirectory: string;
  let externalEnvPath: string;
  let service: ConstructionAiAuditSwitchProbe;

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'construction-ai-switch-'));
    externalEnvPath = join(temporaryDirectory, '.env');
    writeFileSync(externalEnvPath, '', 'utf8');
    process.env.NODE_ENV = 'test';
    process.env[EXTERNAL_ENV_PATH_NAME] = externalEnvPath;
    service = new DutyScheduleService(
      {} as never,
      { axiosRef: {} } as never,
    ) as unknown as ConstructionAiAuditSwitchProbe;
  });

  beforeEach(() => {
    delete process.env[SWITCH_ENV_NAME];
    process.env[EXTERNAL_ENV_PATH_NAME] = externalEnvPath;
    writeFileSync(externalEnvPath, '', 'utf8');
  });

  afterAll(() => {
    restoreEnv(SWITCH_ENV_NAME, previousSwitchValue);
    restoreEnv(EXTERNAL_ENV_PATH_NAME, previousExternalEnvPath);
    restoreEnv('NODE_ENV', previousNodeEnv);
    unlinkSync(externalEnvPath);
    rmdirSync(temporaryDirectory);
  });

  it('exposes an optional enabled flag on ConstructionImageAuditStatus', () => {
    const source = readFileSync(resolve('shared/api.interface.ts'), 'utf8');
    const body = source.match(
      /export interface ConstructionImageAuditStatus\s*{([\s\S]*?)\n}/,
    )?.[1];

    expect(body).toMatch(/^\s*enabled\?: boolean;\s*$/m);
  });

  it('keeps the example configuration disabled by default', () => {
    const source = readFileSync(resolve('.env.example'), 'utf8');
    const lines = source.split(/\r?\n/);
    const declarationIndexes = lines
      .map((line, index) =>
        line.trim().startsWith(`${SWITCH_ENV_NAME}=`) ? index : -1,
      )
      .filter((index) => index >= 0);

    expect(declarationIndexes).toHaveLength(1);
    const declarationIndex = declarationIndexes[0];
    expect(lines[declarationIndex].trim()).toBe(`${SWITCH_ENV_NAME}=false`);

    const adjacentComments = lines.slice(
      declarationIndex - 2,
      declarationIndex,
    );
    expect(adjacentComments).toHaveLength(2);
    expect(adjacentComments.every((line) => line.trim().startsWith('#'))).toBe(
      true,
    );

    const commentText = adjacentComments.join(' ');
    expect(commentText).toMatch(
      /\bdefaults?\s+(?:to\s+)?false\b|默认(?:值为\s*false|关闭)/i,
    );
    expect(commentText).toMatch(
      /personnel certificate(?: checks?)?.*(?:not affected|unaffected|does not control)|人员持证.*不受影响/i,
    );
  });

  it('only enables process configuration for the explicit true allowlist', () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ['', false],
      ['false', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['enabled', false],
      ['2', false],
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['  YeS  ', true],
      ['ON', true],
    ];

    for (const [value, expected] of cases) {
      restoreEnv(SWITCH_ENV_NAME, value);
      expect(service.isConstructionAiAuditEnabled()).toBe(expected);
    }
  });

  it('prefers process configuration when external configuration conflicts', () => {
    const cases: Array<[string, string, boolean]> = [
      ['false', 'on', false],
      ['yes', 'off', true],
      ['', 'on', false],
      ['   ', 'on', false],
    ];

    for (const [processValue, externalValue, expected] of cases) {
      process.env[SWITCH_ENV_NAME] = processValue;
      writeFileSync(
        externalEnvPath,
        `${SWITCH_ENV_NAME}=${externalValue}\n`,
        'utf8',
      );
      expect(service.isConstructionAiAuditEnabled()).toBe(expected);
    }
  });

  it('applies the same strict allowlist to external configuration', () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ['false', false],
      ['unknown', false],
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['  On  ', true],
    ];

    for (const [value, expected] of cases) {
      writeFileSync(
        externalEnvPath,
        value === undefined ? '' : `${SWITCH_ENV_NAME}=${value}\n`,
        'utf8',
      );
      expect(service.isConstructionAiAuditEnabled()).toBe(expected);
    }
  });

  it('fails closed when the external configuration path cannot be read', () => {
    process.env[EXTERNAL_ENV_PATH_NAME] = temporaryDirectory;
    let externalEnv: Record<string, string> | undefined;

    expect(() => {
      externalEnv = service.readConstructionImageAuditExternalEnv();
    }).not.toThrow();
    expect(externalEnv).toEqual({});
    expect(service.isConstructionAiAuditEnabled()).toBe(false);
  });

  it('allows only the master switch key from unrelated external values', () => {
    writeFileSync(
      externalEnvPath,
      `${SWITCH_ENV_NAME}=on\nUNRELATED_SWITCH=true\n`,
      'utf8',
    );

    expect(service.readConstructionImageAuditExternalEnv()).toEqual({
      [SWITCH_ENV_NAME]: 'on',
    });
  });
});

describe('construction AI audit frontend master switch', () => {
  const pageSource = readFileSync(
    resolve('client/src/pages/ConstructionManagement/index.tsx'),
    'utf8',
  );

  it('defaults the construction UI to manual-only unless enabled is strictly true', () => {
    const compactPageSource = pageSource.replace(/\s+/g, ' ');

    expect(compactPageSource).toContain(
      'const constructionAiAuditEnabled = data?.imageAuditStatus?.enabled === true;',
    );
    expect(compactPageSource).toContain(
      'constructionAiAuditEnabled={constructionAiAuditEnabled}',
    );
  });

  it('hides the construction header provider badge and visual refresh action in manual-only mode', () => {
    const headerSource = pageSource.slice(
      pageSource.indexOf('南通全景平台 · 施工管理'),
      pageSource.indexOf('更新 {latestUpdatedLabel}'),
    );
    const compactHeaderSource = headerSource.replace(/\s+/g, ' ');

    expect(compactHeaderSource).toMatch(
      /\{constructionAiAuditEnabled && \( <span[\s\S]*?视觉审核 \{data\?\.imageAuditStatus\?\.provider \|\| 'Qwen'\}[\s\S]*?<\/span> \)\}/,
    );
    expect(compactHeaderSource).toMatch(
      /\{constructionAiAuditEnabled && \( <button[\s\S]*?补缺\/刷新视觉审核[\s\S]*?<\/button> \)\}/,
    );
  });

  it('does not open the isolation model configuration notice in manual-only mode', () => {
    const followupDialogSource = pageSource.slice(
      pageSource.indexOf('function FollowupDialog'),
      pageSource.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(followupDialogSource.replace(/\s+/g, ' ')).toContain(
      '{constructionAiAuditEnabled && showDailyIsolationAuditNotice && (',
    );
  });

  it('keeps isolation manual review controls but suppresses AI summaries in manual-only mode', () => {
    const followupDialogSource = pageSource.slice(
      pageSource.indexOf('function FollowupDialog'),
      pageSource.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const isolationActionSource = pageSource.slice(
      pageSource.indexOf('function DailyIsolationPhotoAuditAction'),
      pageSource.indexOf('function getDailyIsolationPhotoAuditStatus'),
    );
    const compactFollowupSource = followupDialogSource.replace(/\s+/g, ' ');
    const compactActionSource = isolationActionSource.replace(/\s+/g, ' ');

    expect(compactFollowupSource).toContain(
      'const isolationPhotoAuditSummary = constructionAiAuditEnabled &&',
    );
    expect(compactFollowupSource).toContain(
      'constructionAiAuditEnabled={constructionAiAuditEnabled}',
    );
    expect(compactActionSource).toContain('<DropdownMenu>');
    expect(compactActionSource).toContain(
      '{constructionAiAuditEnabled && summary && (',
    );
    expect(pageSource).toContain('constructionAiAuditEnabled = false');
  });

  it('suppresses permit AI details and audit metadata in manual-only mode', () => {
    const permitCardSource = pageSource.slice(
      pageSource.indexOf('function DailyPermitVerificationCard'),
      pageSource.indexOf('function DailyPermitManualReviewBadge'),
    );
    const compactPermitCardSource = permitCardSource.replace(/\s+/g, ' ');

    expect(compactPermitCardSource).toContain(
      'const auditDetails = constructionAiAuditEnabled ? getDailyPermitAuditDetails(item) : null;',
    );
    expect(compactPermitCardSource).toContain(
      'const invalidDetails = constructionAiAuditEnabled ? getDailyPermitInvalidDetails(item) : null;',
    );
    expect(compactPermitCardSource).toContain(
      "const metaText = constructionAiAuditEnabled ? getDailyPermitCardMeta(item, auditDetails) : '';",
    );
  });

  it('hides audit feedback refresh controls while manual review remains available', () => {
    const isolationActionSource = pageSource.slice(
      pageSource.indexOf('function DailyIsolationPhotoAuditAction'),
      pageSource.indexOf('function getDailyIsolationPhotoAuditStatus'),
    );
    const permitCardSource = pageSource.slice(
      pageSource.indexOf('function DailyPermitVerificationCard'),
      pageSource.indexOf('function DailyPermitManualReviewBadge'),
    );
    const compactIsolationSource = isolationActionSource.replace(/\s+/g, ' ');
    const compactPermitSource = permitCardSource.replace(/\s+/g, ' ');

    expect(compactIsolationSource).toContain('<DropdownMenu>');
    expect(compactIsolationSource).toMatch(
      /\{constructionAiAuditEnabled && \( <button[\s\S]*?title="同步多维表挂牌审核状态"[\s\S]*?<\/button> \)\}/,
    );
    expect(compactPermitSource).toContain('<DailyPermitManualReviewBadge');
    expect(compactPermitSource).toMatch(
      /\{constructionAiAuditEnabled && \( <button[\s\S]*?title="同步多维表最新作业票数据"[\s\S]*?<\/button> \)\}/,
    );
  });

  it('uses neutral manual-review copy while preserving enabled AI copy', () => {
    const aiMessage = '动火作业票人工审核通过，AI审核结果已保留可查看。';
    const verification = {
      label: '动火作业票',
      message: aiMessage,
      status: 'valid',
      files: [{}],
      manualReview: { status: 'passed' },
    } as unknown as DailyPermitVerification;

    expect(getDailyPermitDisplayMessage(verification, true)).toBe(aiMessage);
    expect(getDailyPermitDisplayMessage(verification, false)).toBe(
      '动火作业票人工审核通过。',
    );
  });

  it('uses a neutral permit staging acknowledgement before bottom submit', () => {
    const uploadSource = pageSource.slice(
      pageSource.indexOf('const handleDailyPermitUpload'),
      pageSource.indexOf('const handleRefreshConstructionBitableData'),
    );
    const compactUploadSource = uploadSource.replace(/\s+/g, ' ');

    expect(compactUploadSource).toContain(
      'toast.success(`${verification.label}已选择，请提交作业票校核`)',
    );
    expect(compactUploadSource).not.toContain('handleFollowupSubmit');
  });

  it('threads the fail-closed switch into permit and lifecycle decisions', () => {
    const compactPageSource = pageSource.replace(/\s+/g, ' ');

    expect(compactPageSource).toContain(
      'function getLifecycleStages( item: ConstructionOverviewItem, dailyPermitReferenceDate: Date = new Date(), constructionAiAuditEnabled = false, )',
    );
    expect(compactPageSource).toContain(
      'getDailyPermitVerifications( item, referenceDate, confirmedWorkTypes, constructionAiAuditEnabled, )',
    );
    expect(compactPageSource).toContain(
      'constructionAiAuditEnabled={constructionAiAuditEnabled}',
    );
  });

  it('threads the switch through stage materials and calendar problem aggregation', () => {
    const stagePanelSource = pageSource.slice(
      pageSource.indexOf('function StageMaterialSidePanel'),
      pageSource.indexOf('function AttachmentPreviewList'),
    );
    const calendarSource = pageSource.slice(
      pageSource.indexOf('function buildProjectCalendarDay'),
      pageSource.indexOf('function getProjectPlanDateRange'),
    );

    expect(stagePanelSource.replace(/\s+/g, ' ')).toContain(
      'getLifecycleStageAttachmentGroups( item, stage, dailyPermitReferenceDate, dailyOnly, constructionAiAuditEnabled, )',
    );
    expect(calendarSource.replace(/\s+/g, ' ')).toContain(
      'buildProjectDayProblems(checklist, followups, constructionAiAuditEnabled)',
    );
  });

  it('ignores attachment and followup AI findings in manual-only lifecycle decisions', () => {
    const attachmentSource = pageSource.slice(
      pageSource.indexOf('function getLifecycleStageAttachmentGroups'),
      pageSource.indexOf('function getAttachmentLabelCandidates'),
    );
    const checklistSource = pageSource.slice(
      pageSource.indexOf('function buildProjectDayChecklist'),
      pageSource.indexOf('function formatProjectCalendarDayLabel'),
    );
    const lifecycleSource = pageSource.slice(
      pageSource.indexOf('function getLifecycleStages'),
      pageSource.indexOf('function hasAttachment'),
    );
    const approvalSource = pageSource.slice(
      pageSource.indexOf('function getApprovalFlowSteps'),
      pageSource.indexOf('function getApprovalTone'),
    );
    const compactAttachmentSource = attachmentSource.replace(/\s+/g, ' ');
    const compactChecklistSource = checklistSource.replace(/\s+/g, ' ');
    const compactLifecycleSource = lifecycleSource.replace(/\s+/g, ' ');
    const compactApprovalSource = approvalSource.replace(/\s+/g, ' ');

    expect(compactAttachmentSource).toContain(
      'resolveConstructionAttachmentAuditPresentation({ enabled: constructionAiAuditEnabled,',
    );
    expect(compactAttachmentSource).toContain(
      "hasAiIssue: matchedGroups.some((group) => group.status === 'issue'),",
    );
    expect(compactChecklistSource).toMatch(
      /const hasIsolation = .*constructionAiAuditEnabled && .*followup\.isolationFeedback/,
    );
    expect(compactChecklistSource).toContain(
      'const closeTraceIssue = constructionAiAuditEnabled &&',
    );
    expect(compactChecklistSource).toContain(
      'buildConstructionAiAuditProblemEntries({ enabled: constructionAiAuditEnabled, isolationFeedback: followup.isolationFeedback, closingFeedback: followup.closingFeedback,',
    );
    expect(compactLifecycleSource).toContain(
      'resolveConstructionLifecycleAuditPolicy({ enabled: constructionAiAuditEnabled, applicationAiIssueCount, prepareAiIssueCount,',
    );
    expect(compactLifecycleSource).toContain(
      'processManualIssue, closingAiIssue: isIssueFeedback(',
    );
    expect(compactLifecycleSource).toContain(
      'closingApprovalRejected: isRejectedStatusText(latest?.closingApproval),',
    );
    expect(compactLifecycleSource).toContain(
      'getApprovalFlowProgress( item, constructionAiAuditEnabled, )',
    );
    expect(compactApprovalSource).toContain(
      'getApprovalFlowSteps(item, constructionAiAuditEnabled)',
    );
    expect(compactApprovalSource).toContain(
      'getApprovalMaterialSubmissionState( item, ehsNotifiedPassed, constructionAiAuditEnabled, )',
    );
    expect(compactApprovalSource).toContain(
      'resolveConstructionMaterialSubmissionState({ enabled: constructionAiAuditEnabled,',
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
