import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Children, createElement, isValidElement } from 'react';
import type { FunctionComponent, ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LeaveRequestScheduleTimeFields,
  selectDefaultScheduleTimeForGroup,
} from '../../client/src/pages/MonthlySchedule/LeaveRequestScheduleTimeFields';
import {
  getLeaveRequestClipboardImage,
  normalizeLeaveRequestClipboardImage,
} from '../../client/src/pages/MonthlySchedule/leave-request-screenshot';
import * as leaveRequestScheduleCoverage from '../../client/src/pages/MonthlySchedule/leave-request-schedule-coverage';
import type { LeaveRequestCreateResponse } from '../../shared/api.interface';
import type { LeaveRequestImpact } from '../../shared/leave-request-impact';

const { deduplicateScheduleDateKeysByMonth, getLeaveScheduleCoverageDateKeys } =
  leaveRequestScheduleCoverage;

type LeaveScheduleCoverageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface LeaveRequestHoursSummaryProps {
  coverageStatus: LeaveScheduleCoverageStatus;
  isCoverageReady: boolean;
  hasTimeRange: boolean;
  impact: LeaveRequestImpact;
  submitting: boolean;
  onRetry: () => void;
}

interface LeaveRequestSubmitOptions<TDraft, TResult> {
  draft: TDraft;
  onStart: (draft: TDraft) => void;
  request: (draft: TDraft) => Promise<TResult>;
  onSuccess: (result: TResult, draft: TDraft) => void | Promise<void>;
  onRollback: (error: unknown, draft: TDraft) => void;
  onReopen: (draft: TDraft) => void;
  onFailure: (error: unknown, draft: TDraft) => void | Promise<void>;
  onSettled: (draft: TDraft) => void;
}

type CoordinateLeaveRequestSubmit = <TDraft, TResult>(
  options: LeaveRequestSubmitOptions<TDraft, TResult>,
) => Promise<TResult | undefined>;

interface LeaveRequestDraftIdentity {
  clientMutationId: string;
  startAt: string;
  endAt: string;
}

type ResolveLeaveRequestSuccessResponse = (
  result: unknown,
  draft: LeaveRequestDraftIdentity,
) => LeaveRequestCreateResponse;

type LeaveRequestFailureDisposition =
  | 'definitely-not-written'
  | 'unknown-result';

interface LeaveRequestSubmissionSnapshot {
  staffName: string;
  startAt: string;
  endAt: string;
  expectedImpact: LeaveRequestImpact;
  leaveType: string;
  reason: string;
  screenshot: object;
  needSubstitute: boolean;
  substituteName: string;
}

interface LeaveRequestMutationBinding {
  clientMutationId: string;
  snapshot: LeaveRequestSubmissionSnapshot;
  state: 'in-flight' | 'editable-error' | 'unknown-result';
}

type LeaveRequestMutationResolution =
  | {
      status: 'ready';
      binding: LeaveRequestMutationBinding;
      reused: boolean;
    }
  | {
      status: 'blocked';
      binding: LeaveRequestMutationBinding;
    };

interface LeaveRequestSubmissionStateHelpers {
  classifyLeaveRequestSubmissionError: (
    error: unknown,
  ) => LeaveRequestFailureDisposition;
  markLeaveRequestMutationFailure: (
    binding: LeaveRequestMutationBinding,
    error: unknown,
  ) => LeaveRequestMutationBinding;
  resolveLeaveRequestMutationBinding: (
    binding: LeaveRequestMutationBinding | null,
    snapshot: LeaveRequestSubmissionSnapshot,
    createMutationId: () => string,
  ) => LeaveRequestMutationResolution;
  readLeaveRequestUnknownMutationId: (
    storage: Pick<Storage, 'getItem'> | null,
  ) => string | null;
  persistLeaveRequestUnknownMutationId: (
    storage: Pick<Storage, 'setItem'> | null,
    clientMutationId: string,
  ) => boolean;
  clearLeaveRequestUnknownMutationId: (
    storage: Pick<Storage, 'removeItem'> | null,
  ) => boolean;
}

const hoursSummaryPath = join(
  process.cwd(),
  'client/src/pages/MonthlySchedule/LeaveRequestHoursSummary.tsx',
);
const submitCoordinatorPath = join(
  process.cwd(),
  'client/src/pages/MonthlySchedule/leave-request-submit.ts',
);

function requireHoursSummary(): FunctionComponent<LeaveRequestHoursSummaryProps> {
  expect(existsSync(hoursSummaryPath)).toBe(true);
  if (!existsSync(hoursSummaryPath)) {
    throw new Error('LeaveRequestHoursSummary.tsx is required');
  }
  const loaded = require(hoursSummaryPath) as {
    LeaveRequestHoursSummary?: FunctionComponent<LeaveRequestHoursSummaryProps>;
  };
  expect(typeof loaded.LeaveRequestHoursSummary).toBe('function');
  return loaded.LeaveRequestHoursSummary as FunctionComponent<LeaveRequestHoursSummaryProps>;
}

function requireSubmitCoordinator(): CoordinateLeaveRequestSubmit {
  expect(existsSync(submitCoordinatorPath)).toBe(true);
  if (!existsSync(submitCoordinatorPath)) {
    throw new Error('leave-request-submit.ts is required');
  }
  const loaded = require(submitCoordinatorPath) as {
    coordinateLeaveRequestSubmit?: CoordinateLeaveRequestSubmit;
  };
  expect(typeof loaded.coordinateLeaveRequestSubmit).toBe('function');
  return loaded.coordinateLeaveRequestSubmit as CoordinateLeaveRequestSubmit;
}

function requireSuccessResponseResolver(): ResolveLeaveRequestSuccessResponse {
  expect(existsSync(submitCoordinatorPath)).toBe(true);
  if (!existsSync(submitCoordinatorPath)) {
    throw new Error('leave-request-submit.ts is required');
  }
  const loaded = require(submitCoordinatorPath) as {
    resolveLeaveRequestSuccessResponse?: ResolveLeaveRequestSuccessResponse;
  };
  expect(typeof loaded.resolveLeaveRequestSuccessResponse).toBe('function');
  return loaded.resolveLeaveRequestSuccessResponse as ResolveLeaveRequestSuccessResponse;
}

function requireSubmissionStateHelpers(): LeaveRequestSubmissionStateHelpers {
  expect(existsSync(submitCoordinatorPath)).toBe(true);
  if (!existsSync(submitCoordinatorPath)) {
    throw new Error('leave-request-submit.ts is required');
  }
  const loaded = require(
    submitCoordinatorPath,
  ) as Partial<LeaveRequestSubmissionStateHelpers>;
  expect(typeof loaded.classifyLeaveRequestSubmissionError).toBe('function');
  expect(typeof loaded.markLeaveRequestMutationFailure).toBe('function');
  expect(typeof loaded.resolveLeaveRequestMutationBinding).toBe('function');
  expect(typeof loaded.readLeaveRequestUnknownMutationId).toBe('function');
  expect(typeof loaded.persistLeaveRequestUnknownMutationId).toBe('function');
  expect(typeof loaded.clearLeaveRequestUnknownMutationId).toBe('function');
  return loaded as LeaveRequestSubmissionStateHelpers;
}

function createImpact(
  overrides: Partial<LeaveRequestImpact> = {},
): LeaveRequestImpact {
  return {
    affectedSchedules: [
      {
        recordId: 'hidden-affected-record',
        date: '2099-12-31',
        building: '测试隐藏楼栋',
        team: '测试隐藏班组',
        shift: '测试隐藏班次',
        scheduledHours: 8,
        leaveHours: 8,
        countedHours: 8,
      },
    ],
    excludedSchedules: [
      {
        recordId: 'hidden-excluded-record',
        date: '2099-12-30',
        reason: 'holiday',
      },
    ],
    rawHours: 8,
    minimumHours: 4,
    unrecognizedShifts: [],
    missingCalendarYears: [],
    invalidRange: false,
    invalidRangeReason: null,
    ...overrides,
  };
}

function createHoursSummaryProps(
  overrides: Partial<LeaveRequestHoursSummaryProps> = {},
): LeaveRequestHoursSummaryProps {
  return {
    coverageStatus: 'ready',
    isCoverageReady: true,
    hasTimeRange: true,
    impact: createImpact(),
    submitting: false,
    onRetry: () => undefined,
    ...overrides,
  };
}

function renderHoursSummary(
  overrides: Partial<LeaveRequestHoursSummaryProps> = {},
): string {
  const LeaveRequestHoursSummary = requireHoursSummary();
  return renderToStaticMarkup(
    createElement(LeaveRequestHoursSummary, createHoursSummaryProps(overrides)),
  );
}

function renderHoursSummaryElement(
  overrides: Partial<LeaveRequestHoursSummaryProps> = {},
): ReactElement<Record<string, unknown>> {
  const LeaveRequestHoursSummary = requireHoursSummary();
  const rendered = LeaveRequestHoursSummary(createHoursSummaryProps(overrides));
  expect(isValidElement(rendered)).toBe(true);
  if (!isValidElement(rendered)) {
    throw new Error('LeaveRequestHoursSummary must render synchronously');
  }
  return rendered as ReactElement<Record<string, unknown>>;
}

function findReactElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) {
    return null;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) {
    return element;
  }
  for (const child of Children.toArray(element.props.children as ReactNode)) {
    const found = findReactElement(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function visibleText(markup: string): string {
  return markup
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Monthly schedule leave request tool', () => {
  it('renders leave request entry and dialog from common tools', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).toContain('setLeaveRequestDialogOpen(true)');
    expect(source).toContain('请休假');
    expect(source).toContain('handleSubmitLeaveRequest');
    expect(source).toContain('createLeaveRequest');
  });

  it('groups common tools into level-one categories while preserving existing actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const commonToolsLabelIndex = source.indexOf('常用工具');
    const commonToolsStart = source.lastIndexOf(
      '<DropdownMenu modal={false}>',
      commonToolsLabelIndex,
    );
    const commonToolsEnd = source.indexOf(
      '</DropdownMenu>',
      commonToolsLabelIndex,
    );
    const commonTools = source.slice(commonToolsStart, commonToolsEnd);

    expect(commonTools).toContain('DropdownMenuSub');
    expect(commonTools).toContain('人员相关');
    expect(commonTools).toContain('运维相关');
    expect(commonTools).toContain('其他事宜');
    expect(commonTools).toContain('同步相关');
    expect(commonTools).toContain('请休假');
    expect(commonTools).toContain('排班人员调整');
    expect(commonTools).toContain('人员异动');
    expect(commonTools).toContain('封网登记');
    expect(commonTools).toContain('阿里月报生成');
    expect(commonTools).toContain('同步本地库');
    expect(commonTools).toContain('发送今日截图');

    const changeApplicationIndex = commonTools.indexOf('变更申请');
    const thresholdAdjustmentIndex = commonTools.indexOf('阈值调整');
    expect(changeApplicationIndex).toBeGreaterThan(-1);
    expect(thresholdAdjustmentIndex).toBeGreaterThan(-1);
    expect(commonTools).toContain(
      'changeRequestDialogRef.current?.setOpen(true)',
    );
    expect(commonTools).toContain('setThresholdAdjustmentDialogOpen(true)');
    expect(commonTools).not.toContain('（待开放）');
  });

  it('uses personnel data and the shared impact engine instead of manual leave scope', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).toContain('calculateLeaveRequestImpact');
    expect(source).toContain('selectedLeaveStaffProfile');
    expect(source).toContain('leaveImpact');
    expect(source).toContain('休假类型');
    expect(source).toContain('请假原因');
    expect(source).toContain('maxLength={LEAVE_REQUEST_REASON_MAX_LENGTH}');
    expect(source).toContain('leaveImpact');
    expect(source).toContain('至少 4 小时');
    expect(source).not.toContain('id="leave-building"');
    expect(source).not.toContain('id="leave-team"');
    expect(source).not.toContain('id="leave-shift"');
  });

  it('keeps substitute assignment out of the applicant form', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const fieldsSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/LeaveRequestScheduleTimeFields.tsx',
      ),
      'utf8',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    expect(source).not.toContain('calculateLeaveRequestSubstituteRule');
    expect(source).not.toContain('isLeaveSubstituteStaffBlocked');
    expect(source).not.toContain('leaveNeedSubstitute');
    expect(source).not.toContain('setLeaveNeedSubstitute');
    expect(dialog).not.toContain('id="leave-need-substitute"');
    expect(dialog).not.toContain('id="leave-substitute-staff"');
    expect(handler).toContain('needSubstitute: false');
    expect(handler).toContain("substituteName: ''");
    expect(dialog).not.toContain(
      '选择人员后，可按实际排班选择请假时段，工时自动计算。',
    );
    expect(fieldsSource).not.toContain(
      '仅可选择该人员实际排班的工作日期和整点时刻。',
    );
  });

  it('submits a fixed empty applicant substitute binding', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    const snapshotStart = handler.indexOf(
      'const submissionSnapshot = Object.freeze({',
    );
    const snapshotSource = handler.slice(snapshotStart, snapshotStart + 700);

    expect(source).not.toContain('leaveSubstituteInvalidationWarningRef');
    expect(source).not.toContain('selectedLeaveSubstituteIsEligible');
    expect(handler).not.toContain('hasValidLeaveSubstituteSelection');
    expect(snapshotSource).toContain('needSubstitute: false');
    expect(snapshotSource).toContain("substituteName: ''");
    expect(handler).toContain('needSubstitute: draft.needSubstitute');
    expect(dialog).not.toContain('hasValidLeaveSubstituteSelection');
    expect(dialog).toContain('!isLeaveScheduleCoverageReady');
  });

  it('locks the full leave draft while it is synchronizing or awaiting reconciliation', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const fieldsSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/LeaveRequestScheduleTimeFields.tsx',
      ),
      'utf8',
    );
    const start = source.indexOf('open={leaveRequestDialogOpen}');
    const end = source.indexOf('</Dialog>', start);
    const dialog = source.slice(start, end);

    expect(dialog).toMatch(
      /<LeaveRequestPersonPicker[\s\S]{0,400}disabled=\{leaveRequestDraftLocked\}/,
    );
    expect(dialog).toMatch(
      /<LeaveRequestScheduleTimeFields[\s\S]{0,800}leaveRequestDraftLocked/,
    );
    expect(fieldsSource.match(/disabled=\{disabled\}/g)).toHaveLength(4);
    expect(dialog).toMatch(
      /id="leave-type"[\s\S]{0,800}disabled=\{leaveRequestDraftLocked\}/,
    );
    expect(dialog).not.toContain('id="leave-substitute-staff"');
    expect(dialog).toMatch(
      /id="leave-reason"[\s\S]{0,800}disabled=\{leaveRequestDraftLocked\}/,
    );
  });

  it('requires one PNG, JPEG, or WebP screenshot and shows immediate file feedback', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const screenshotFieldPath = join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/LeaveRequestScreenshotField.tsx',
    );
    const screenshotFieldSource = existsSync(screenshotFieldPath)
      ? readFileSync(screenshotFieldPath, 'utf8')
      : '';
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const attachmentSource = `${dialog}\n${screenshotFieldSource}`;
    const validationSource = `${source}\n${screenshotFieldSource}`;
    const inputIndex = attachmentSource.indexOf('id={inputId}');
    const inputSource = attachmentSource.slice(
      Math.max(0, inputIndex - 300),
      inputIndex + 1_200,
    );

    expect(source).toMatch(
      /useState<File\s*\|\s*null>\(null\)[\s\S]{0,200}leaveRequestScreenshot|leaveRequestScreenshot[\s\S]{0,200}useState<File\s*\|\s*null>\(null\)/,
    );
    expect(screenshotFieldSource).toContain("inputId = 'leave-screenshot'");
    expect(inputIndex).toBeGreaterThan(-1);
    expect(inputSource).toContain('type="file"');
    expect(inputSource).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(inputSource).not.toMatch(/\bmultiple(?:=|\s|>)/);
    expect(attachmentSource.match(/type="file"/g)).toHaveLength(1);
    expect(validationSource).toContain('image/png');
    expect(validationSource).toContain('image/jpeg');
    expect(validationSource).toContain('image/webp');
    expect(validationSource).toMatch(/10\s*\*\s*1024\s*\*\s*1024|10_?485_?760/);
    expect(validationSource).toMatch(/\.type\b/);
    expect(validationSource).toMatch(/\.size\b/);
    expect(validationSource).toContain('URL.createObjectURL');
    expect(validationSource).toContain('URL.revokeObjectURL');
    expect(validationSource).toMatch(
      /(?:leaveRequestScreenshot|screenshot|file)\.name/,
    );
    expect(validationSource).toMatch(
      /(?:leaveRequestScreenshotPreviewUrl|previewUrl)/,
    );
    expect(validationSource).toMatch(
      /(?:onRemove|handleRemoveLeaveRequestScreenshot)[\s\S]{0,300}setLeaveRequestScreenshot\(null\)|setLeaveRequestScreenshot\(null\)[\s\S]{0,300}(?:onRemove|handleRemoveLeaveRequestScreenshot)/,
    );
  });

  it('accepts the first pasted clipboard image and ignores text or non-image files', () => {
    const imageFile = {
      name: 'clipboard.png',
      size: 128,
      type: 'image/png',
    } as File;
    const pdfFile = {
      name: 'document.pdf',
      size: 256,
      type: 'application/pdf',
    } as File;

    expect(
      getLeaveRequestClipboardImage([
        {
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null,
        },
        {
          kind: 'file',
          type: 'application/pdf',
          getAsFile: () => pdfFile,
        },
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => imageFile,
        },
      ]),
    ).toBe(imageFile);
    expect(getLeaveRequestClipboardImage([], [pdfFile, imageFile])).toBe(
      imageFile,
    );
    expect(getLeaveRequestClipboardImage([], [pdfFile])).toBeNull();
  });

  it('gives unnamed pasted images a backend-safe extension without changing their bytes', async () => {
    const pastedImage = new File([new Uint8Array([137, 80, 78, 71])], '', {
      type: 'image/png',
    });

    const normalized = normalizeLeaveRequestClipboardImage(
      pastedImage,
      1_786_147_200_000,
    );

    expect(normalized.name).toBe('leave-screenshot-1786147200000.png');
    expect(normalized.type).toBe('image/png');
    expect(normalized.size).toBe(pastedImage.size);
    expect(new Uint8Array(await normalized.arrayBuffer())).toEqual(
      new Uint8Array(await pastedImage.arrayBuffer()),
    );
  });

  it('listens for image paste only while the screenshot field is mounted', () => {
    const screenshotFieldSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/LeaveRequestScreenshotField.tsx',
      ),
      'utf8',
    );

    expect(screenshotFieldSource).toContain("window.addEventListener('paste'");
    expect(screenshotFieldSource).toContain(
      "window.removeEventListener('paste'",
    );
    expect(screenshotFieldSource).toContain('event.preventDefault()');
    expect(screenshotFieldSource).toContain('getLeaveRequestClipboardImage');
    expect(screenshotFieldSource).toContain('Ctrl+V 粘贴截图');
  });

  it('blocks a missing screenshot and preserves it until submission succeeds', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    const screenshotGuardIndex = handler.indexOf(
      'if (!leaveRequestScreenshot)',
    );
    const mutationPersistenceIndex = handler.indexOf(
      'persistLeaveRequestUnknownMutationId',
    );
    const guardSource = handler.slice(
      screenshotGuardIndex,
      screenshotGuardIndex + 500,
    );
    const submittedDraftIndex = handler.indexOf(
      'const submittedDraft = Object.freeze({',
    );
    const submissionSnapshotIndex = handler.indexOf(
      'const submissionSnapshot = Object.freeze({',
    );
    const submittedDraftSource = handler.slice(
      submissionSnapshotIndex,
      submittedDraftIndex + 800,
    );
    const coordinatorIndex = handler.indexOf(
      'void coordinateLeaveRequestSubmit',
    );
    const requestIndex = handler.indexOf('request:', coordinatorIndex);
    const onSuccessIndex = handler.indexOf('onSuccess:', requestIndex);
    const onRollbackIndex = handler.indexOf('onRollback:', onSuccessIndex);
    const onFailureIndex = handler.indexOf('onFailure:', onRollbackIndex);
    const onSettledIndex = handler.indexOf('onSettled:', onFailureIndex);
    const requestSource = handler.slice(requestIndex, onSuccessIndex);
    const onSuccessSource = handler.slice(onSuccessIndex, onRollbackIndex);
    const failureSource = handler.slice(onRollbackIndex, onSettledIndex);
    const submitClickIndex = dialog.indexOf('void handleSubmitLeaveRequest()');
    const submitButtonSource = dialog.slice(
      Math.max(0, submitClickIndex - 1_800),
      submitClickIndex + 300,
    );

    expect(screenshotGuardIndex).toBeGreaterThan(-1);
    expect(screenshotGuardIndex).toBeLessThan(mutationPersistenceIndex);
    expect(guardSource).toContain('toast.warning');
    expect(guardSource).toContain('return;');
    expect(submitClickIndex).toBeGreaterThan(-1);
    expect(submitButtonSource).toContain('!leaveRequestScreenshot');
    expect(submissionSnapshotIndex).toBeGreaterThan(-1);
    expect(submittedDraftIndex).toBeGreaterThan(-1);
    expect(submittedDraftSource).toContain(
      'screenshot: leaveRequestScreenshot',
    );
    expect(requestSource).toMatch(
      /createLeaveRequest\(\s*\{[\s\S]*?\}\s*,\s*draft\.screenshot\s*,?\s*\)/,
    );
    expect(onSuccessSource).toContain('setLeaveRequestScreenshot(null)');
    expect(failureSource).not.toContain('setLeaveRequestScreenshot(null)');
  });

  it('loads every month spanned by a leave range before allowing submit', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    const coverageHelperSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/leave-request-schedule-coverage.ts',
      ),
      'utf8',
    );
    expect(source).toContain('getLeaveScheduleCoverageDateKeys');
    expect(coverageHelperSource).toContain(
      'addDaysToDateKey(start.dateKey, -1)',
    );
    expect(source).toContain('ensureSchedulesForLeaveDateRange');
    expect(source).toContain('leaveScheduleCoverageStatus');
    expect(source).toContain('leaveScheduleCoverageReadyKey');
    expect(source).toContain('isLeaveScheduleCoverageReady');
    expect(source).toContain(
      'leaveScheduleCoverageReadyKey === leaveScheduleCoverageKey',
    );
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitAdditionalMatter',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handler).toContain('!isLeaveScheduleCoverageReady');
    expect(source).toContain('scheduleMonthRequestGenerationRef');
    expect(source).toContain('scheduleMonthForceRefreshGenerationRef');
    expect(source).toContain('return authoritativeSchedules');
    expect(source).toContain('replaceScheduleMonthsFromAuthoritative');
  });

  it('drives selected-date loading from a Shanghai business-day clock without forcing today month', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const initialDateStart = source.indexOf('function getInitialSelectedDate');
    const initialDateEnd = source.indexOf(
      'function formatSealingDateTime',
      initialDateStart,
    );
    const initialDateSource = source.slice(initialDateStart, initialDateEnd);
    const businessClockStart = source.indexOf('const [businessDateKey');
    const businessClockSource = source.slice(
      businessClockStart,
      businessClockStart + 1_200,
    );
    const pageLoaderStart = source.indexOf('const loadSchedules = useCallback');
    const pageLoaderEnd = source.indexOf(
      'const loadSchedulesForDate = useCallback',
      pageLoaderStart,
    );
    const pageLoader = source.slice(pageLoaderStart, pageLoaderEnd);
    const monthMapStart = pageLoader.indexOf('const monthMap = new Map');
    const monthMapEnd = pageLoader.indexOf(
      'const monthsForWindow =',
      monthMapStart,
    );
    const monthMapSource = pageLoader.slice(monthMapStart, monthMapEnd);

    expect(source).toContain("from './business-date'");
    expect(initialDateSource).toContain(
      'const fallbackDateKey = getShanghaiBusinessDateKey()',
    );
    expect(initialDateSource).toContain("dateKey.split('-').map(Number)");
    expect(initialDateSource).not.toContain('return new Date();');
    expect(businessClockStart).toBeGreaterThan(-1);
    expect(businessClockSource).toMatch(
      /useState\(\(\) =>\s*getShanghaiBusinessDateKey\(\),?\s*\)/,
    );
    expect(businessClockSource).toContain(
      'current === nextBusinessDateKey ? current : nextBusinessDateKey',
    );
    expect(businessClockSource).toContain(
      'window.setInterval(refreshBusinessClock, 60_000)',
    );
    expect(businessClockSource).toContain(
      "window.addEventListener('focus', refreshBusinessClock)",
    );
    expect(businessClockSource).toContain(
      "document.addEventListener('visibilitychange', refreshBusinessClock)",
    );
    expect(businessClockSource).toContain('window.clearInterval(intervalId)');
    expect(
      source.match(
        /refreshBusinessClock\(\);\s*setLeaveRequestDialogOpen\(true\)/g,
      ),
    ).toHaveLength(3);
    expect(
      source.match(
        /refreshBusinessClock\(\);\s*overtimeRequestDialogRef\.current\?\.open\(\)/g,
      ),
    ).toHaveLength(2);

    expect(monthMapSource).toMatch(
      /const \[businessYear,\s*businessMonth\]\s*=\s*businessDateKey\s*\.split\('-'\)\s*\.map\(Number\)/,
    );
    expect(monthMapSource).toContain('monthMap.set(businessMonthKey');
    expect(monthMapSource).not.toContain('forceRefresh');
    expect(monthMapSource).not.toContain('setSelectedDate');
    expect(pageLoader).toMatch(
      /getMonthlySchedulesWithInFlightDeduplication\(\s*item\.year,\s*item\.month,?\s*\)/,
    );
    expect(pageLoader).not.toMatch(
      /getMonthlySchedulesWithInFlightDeduplication\(\s*item\.year,\s*item\.month,\s*true/,
    );
    expect(pageLoader).not.toContain('businessClockMs');
    expect(pageLoader).toMatch(
      /\},\s*\[[^\]]*businessDateKey,[^\]]*selectedDate,\s*setScreenshotSectionState\],\s*\);/,
    );
  });

  it('uses only necessary leave coverage months and preserves an explicit historical shift', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const coverageStart = source.indexOf(
      'const leaveScheduleMonthDateKeys = useMemo',
    );
    const coverageEnd = source.indexOf(
      'const leaveScheduleCoverageKey',
      coverageStart,
    );
    const coverageSource = source.slice(coverageStart, coverageEnd);
    const defaultStart = source.indexOf(
      'const defaultLeaveTimeRange = useMemo',
    );
    const defaultEnd = source.indexOf(
      'const calculatedLeaveImpact = useMemo',
      defaultStart,
    );
    const defaultSource = source.slice(defaultStart, defaultEnd);
    const effectStart = source.indexOf('const nextLeaveTimeRangeStaffKey =');
    const effectSource = source.slice(effectStart, effectStart + 2_000);

    expect(coverageSource).toContain('getLeaveScheduleCoverageDateKeys(');
    expect(coverageSource).toMatch(
      /\}, \[businessDateKey, leaveEndAt, leaveStartAt\]\);/,
    );
    expect(coverageSource).not.toContain('selectedDateKey');
    expect(defaultSource).toContain(
      'leaveTimeCandidates.fullShiftRanges,\n      businessDateKey',
    );
    expect(defaultSource).toContain(
      '[businessDateKey, leaveTimeCandidates.fullShiftRanges]',
    );
    expect(effectSource).not.toContain(
      'leaveStartAt < `${businessDateKey}T00:00`',
    );
  });

  it('resets the time range to the new staff full shift after switching personnel', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const effectStart = source.indexOf('const nextLeaveTimeRangeStaffKey =');
    const effectSource = source.slice(effectStart, effectStart + 1_600);

    expect(source).toContain('leaveTimeRangeStaffKeyRef');
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectSource).toContain('const staffChanged =');
    expect(effectSource).toMatch(
      /staffChanged\s*\|\|\s*!leaveTimeCandidates\.startOptions\.includes\(leaveStartAt\)/,
    );
    expect(effectSource).toContain(
      "setLeaveStartAt(defaultLeaveTimeRange?.startAt || '')",
    );
    expect(effectSource).toContain(
      "setLeaveEndAt(defaultLeaveTimeRange?.endAt || '')",
    );
  });

  it('deduplicates leave schedule coverage by month before refreshing', () => {
    expect(
      deduplicateScheduleDateKeysByMonth([
        '2026-08-02',
        '2026-08-01',
        '2026-07-31',
        'invalid',
        '2026-09-01',
      ]),
    ).toEqual(['2026-08-02', '2026-07-31', '2026-09-01']);
  });

  it('loads only the business-day boundary on open and adds the actual range on demand', () => {
    expect(getLeaveScheduleCoverageDateKeys('2026-09-01', '', '')).toEqual([
      '2026-09-01',
      '2026-08-31',
    ]);
    expect(
      getLeaveScheduleCoverageDateKeys(
        '2026-09-01',
        '2026-08-31T09:00',
        '2026-08-31T18:00',
      ),
    ).toEqual(['2026-09-01', '2026-08-31']);
  });

  it('does not preload leave coverage before staff selection', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const effectMarker = source.indexOf(
      'void ensureSchedulesForLeaveDateRange(monthDateKeys, forceRefresh)',
    );
    const effectStart = source.lastIndexOf('useEffect(() => {', effectMarker);
    const effectEnd = source.indexOf('\n  useEffect(() => {', effectMarker);
    const effectSource = source.slice(effectStart, effectEnd);

    expect(effectMarker).toBeGreaterThan(-1);
    expect(effectSource).toContain('!selectedLeaveStaffProfile');
    expect(effectSource).not.toContain(
      "toast.error('加载请休假日期范围内的排班失败，请稍后重试')",
    );
  });

  it('fills the shift end whenever the leave start time changes', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialogStart = source.indexOf('<LeaveRequestScheduleTimeFields');
    const dialog = source.slice(dialogStart, dialogStart + 800);

    expect(source).toContain('const handleLeaveStartAtChange = useCallback');
    expect(source).toContain('selectDefaultLeaveEndAt(');
    expect(dialog).toContain('onStartAtChange={handleLeaveStartAtChange}');
    expect(dialog).not.toContain('onStartAtChange={setLeaveStartAt}');
  });

  it('opens leave requests from cache and force-refreshes only for explicit retry or submit', () => {
    const resolveLeaveScheduleForceRefresh = (
      leaveRequestScheduleCoverage as typeof leaveRequestScheduleCoverage & {
        resolveLeaveScheduleForceRefresh?: (
          requested: boolean,
          canForceRefresh: boolean,
        ) => boolean;
      }
    ).resolveLeaveScheduleForceRefresh;
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const commonToolsLabelIndex = source.indexOf('常用工具');
    const commonToolsStart = source.lastIndexOf(
      '<DropdownMenu modal={false}>',
      commonToolsLabelIndex,
    );
    const commonToolsEnd = source.indexOf(
      '</DropdownMenu>',
      commonToolsLabelIndex,
    );
    const commonTools = source.slice(commonToolsStart, commonToolsEnd);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    expect(typeof resolveLeaveScheduleForceRefresh).toBe('function');
    expect(resolveLeaveScheduleForceRefresh?.(true, false)).toBe(false);
    expect(resolveLeaveScheduleForceRefresh?.(true, true)).toBe(true);
    expect(resolveLeaveScheduleForceRefresh?.(false, true)).toBe(false);
    expect(source).toContain('deduplicateScheduleDateKeysByMonth');
    expect(source).toContain('leaveScheduleForceRefreshPendingRef');
    expect(commonTools).not.toMatch(
      /leaveScheduleForceRefreshPendingRef\.current\s*=\s*capabilities\.canForceRefresh/,
    );
    expect(commonTools).toContain('setLeaveRequestDialogOpen(true)');
    expect(source).toMatch(
      /ensureSchedulesForLeaveDateRange\(monthDateKeys, forceRefresh\)/,
    );
    expect(handler).toMatch(
      /resolveLeaveScheduleForceRefresh\(\s*true,\s*capabilities\.canForceRefresh,?\s*\)/,
    );
    expect(handler).not.toContain('loadPersonProfiles(');
    expect(handler).not.toContain('loadSchedules(');
    expect(source).toContain('handleRetryLeaveScheduleCoverage');
    expect(source).toContain('重新加载排班');
  });

  it('keeps the last successful schedule snapshot when mutations invalidate network cache', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.service.ts',
      ),
      'utf8',
    );

    expect(source).toMatch(
      /invalidateBitableRecordCache\(\{\s*appToken: this\.scheduleAppToken,\s*tableId: this\.scheduleTableId,\s*\}\)/,
    );
    expect(source).not.toMatch(
      /appToken: this\.scheduleAppToken,\s*tableId: this\.scheduleTableId,\s*deletePersisted: true/,
    );
  });

  it('filters the local schedule snapshot before approval enrichment', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.service.ts',
      ),
      'utf8',
    );
    const methodStart = source.indexOf(
      'private async getMonthlySchedulesFromLocalCache',
    );
    const methodEnd = source.indexOf(
      'private async getYearlySealingInfoFromFeishu',
      methodStart,
    );
    const method = source.slice(methodStart, methodEnd);
    const rangeFilterIndex = method.indexOf('const monthlyRecords =');
    const enrichmentIndex = method.indexOf(
      'enrichScheduleRecordsWithLeaveApproval(',
    );

    expect(methodStart).toBeGreaterThan(-1);
    expect(rangeFilterIndex).toBeGreaterThan(-1);
    expect(method).toContain('this.extractScheduleDateFromFields');
    expect(rangeFilterIndex).toBeLessThan(enrichmentIndex);
  });

  it('shares ordinary monthly schedule reads without reusing them for force refreshes', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const cacheSource = readFileSync(join(process.cwd(), 'client/src/pages/MonthlySchedule/schedule-read-cache.ts'), 'utf8');
    const helperStart = cacheSource.indexOf(
      'function getMonthlySchedulesWithInFlightDeduplication',
    );
    const helper = cacheSource.slice(helperStart);
    const pageLoaderStart = source.indexOf('const loadSchedules = useCallback');
    const dateLoaderStart = source.indexOf(
      'const loadSchedulesForDate = useCallback',
      pageLoaderStart,
    );
    const pageLoader = source.slice(pageLoaderStart, dateLoaderStart);
    const dateLoader = source.slice(
      dateLoaderStart,
      source.indexOf('const ensureSchedulesForRepairDate', dateLoaderStart),
    );

    expect(cacheSource).toContain('const monthlyScheduleReadInFlight = new Map');
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('if (forceRefresh)');
    expect(helper).toMatch(/return getMonthlySchedules\(year, month, true\)/);
    expect(helper).toContain('monthlyScheduleReadInFlight.get(monthKey)');
    expect(helper).toContain(
      'monthlyScheduleReadInFlight.set(monthKey, request)',
    );
    expect(helper).toContain('monthlyScheduleReadInFlight.delete(monthKey)');
    expect(pageLoader).toContain(
      'getMonthlySchedulesWithInFlightDeduplication(',
    );
    expect(dateLoader).toContain(
      'getMonthlySchedulesWithInFlightDeduplication(',
    );
  });

  it('loads leave personnel independently from selected-date page data', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const pageDataEffectStart = source.indexOf(
      'useEffect(() => {\n    if (access.isLoading) return;\n    const controller = new AbortController();\n    void loadSchedules(',
    );
    const pageDataEffectEnd = source.indexOf(
      '\n\n  useEffect(() => {',
      pageDataEffectStart,
    );
    const pageDataEffect = source.slice(pageDataEffectStart, pageDataEffectEnd);

    expect(pageDataEffectStart).toBeGreaterThan(-1);
    expect(pageDataEffect).not.toContain('loadPersonProfiles()');
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*loadPersonProfiles\(\);\s*return \(\) => personProfileLoadAbortRef\.current\?\.abort\(\);\s*\}, \[loadPersonProfiles\]\);/,
    );
  });

  it('renders complete schedule-bound dates in a full-width form row', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const fieldsPath = join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/LeaveRequestScheduleTimeFields.tsx',
    );
    const fieldsSource = existsSync(fieldsPath)
      ? readFileSync(fieldsPath, 'utf8')
      : '';
    const start = source.indexOf('open={leaveRequestDialogOpen}');
    const end = source.indexOf('</Dialog>', start);
    const dialog = source.slice(start, end);
    const markup = renderToStaticMarkup(
      createElement(LeaveRequestScheduleTimeFields, {
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
        startOptions: ['2026-08-03T09:00', '2026-08-04T09:00'],
        endOptions: ['2026-08-03T18:00', '2026-08-04T18:00'],
        disabled: false,
        loading: false,
        onStartAtChange: () => undefined,
        onEndAtChange: () => undefined,
      }),
    );
    const renderedRootOpenTag = markup.match(/^<div[^>]*>/)?.[0] ?? '';

    expect(source).toContain('leaveStartAt');
    expect(source).toContain('leaveEndAt');
    expect(source).toContain('createLeaveRequestTimeCandidates');
    expect(dialog).toContain('<LeaveRequestScheduleTimeFields');
    expect(dialog).not.toContain('type="datetime-local"');
    expect(fieldsSource).toContain('idPrefix="leave-start"');
    expect(fieldsSource).toContain('idPrefix="leave-end"');
    expect(fieldsSource).toContain('startOptions');
    expect(fieldsSource).toContain('endOptions');
    expect(fieldsSource).toContain('disabled={disabled}');
    expect(fieldsSource).toContain('id={`${idPrefix}-date`}');
    expect(fieldsSource).toContain('id={`${idPrefix}-time`}');
    expect(renderedRootOpenTag).toContain('sm:col-span-2');
    expect(markup.match(/<select/g)).toHaveLength(4);
    expect(markup).toContain('>2026-08-03</option>');
    expect(markup).toContain('>09:00</option>');
    expect(markup).toContain('>18:00</option>');
    expect(dialog).toMatch(
      /<div className="[^"]*\bsm:grid-cols-2\b[^"]*">\s*<LeaveRequestScheduleTimeFields/,
    );
  });

  it('defaults a newly selected end shift to its final boundary', () => {
    const options = [
      {
        value: '2026-09-15T10:00',
        groupKey: '2026-09-15|long-white',
        groupLabel: '2026-09-15 · 长白 · 09:00–18:00',
        timeLabel: '10:00',
      },
      {
        value: '2026-09-15T18:00',
        groupKey: '2026-09-15|long-white',
        groupLabel: '2026-09-15 · 长白 · 09:00–18:00',
        timeLabel: '18:00',
      },
    ];

    expect(
      selectDefaultScheduleTimeForGroup(
        options,
        '2026-09-15|long-white',
        'end',
      ),
    ).toBe('2026-09-15T18:00');
    expect(
      selectDefaultScheduleTimeForGroup(
        options,
        '2026-09-15|long-white',
        'start',
      ),
    ).toBe('2026-09-15T10:00');
  });

  it('isolates leave person typing and presents neutral leave or travel labels', () => {
    const pageSource = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const pickerSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/LeaveRequestPersonPicker.tsx',
      ),
      'utf8',
    );
    const dialogStart = pageSource.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = pageSource.indexOf('</Dialog>', dialogStart);
    const dialog = pageSource.slice(dialogStart, dialogEnd);

    expect(pageSource).not.toContain('const [leaveStaffSearch');
    expect(pageSource).not.toContain('const [leaveStaffPickerOpen');
    expect(dialog).toContain('<LeaveRequestPersonPicker');
    expect(pickerSource).toContain('const [search, setSearch] = useState');
    expect(pickerSource).toContain('startTransition');
    expect(dialog).toContain('请休假&差旅申请');
    expect(dialog).toMatch(/>\s*申请人员\s*</);
    expect(dialog).toMatch(/>\s*类型\s*</);
    expect(dialog).toContain("'差旅'");
    expect(dialog).toMatch(/>\s*原因\s*</);
    expect(dialog).toContain('placeholder="填写原因"');
  });

  it('keeps empty or invalid controlled values on explicit schedule placeholders', () => {
    const fieldsSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/LeaveRequestScheduleTimeFields.tsx',
      ),
      'utf8',
    );
    const emptyMarkup = renderToStaticMarkup(
      createElement(LeaveRequestScheduleTimeFields, {
        startAt: '',
        endAt: '',
        startOptions: ['2026-07-01T09:00'],
        endOptions: ['2026-07-01T18:00'],
        disabled: false,
        loading: false,
        onStartAtChange: () => undefined,
        onEndAtChange: () => undefined,
      }),
    );
    const invalidMarkup = renderToStaticMarkup(
      createElement(LeaveRequestScheduleTimeFields, {
        startAt: '2026-07-01T08:00',
        endAt: '2026-07-01T08:30',
        startOptions: ['2026-07-01T09:00'],
        endOptions: ['2026-07-01T18:00'],
        shiftRanges: [
          {
            scheduleDate: '2026-07-01',
            kind: 'white',
            startAt: '2026-07-01T09:00',
            endAt: '2026-07-01T18:00',
          },
        ],
        disabled: false,
        loading: false,
        onStartAtChange: () => undefined,
        onEndAtChange: () => undefined,
      }),
    );

    expect(fieldsSource).not.toContain('groups[0]?.key');
    expect(fieldsSource).not.toContain('timeOptions[0]?.value');
    expect(
      emptyMarkup.match(/selected="">\u8bf7选择日期<\/option>/g),
    ).toHaveLength(2);
    expect(
      emptyMarkup.match(/selected="">\u8bf7选择时刻<\/option>/g),
    ).toHaveLength(2);
    expect(emptyMarkup).toContain('>2026-07-01</option>');
    expect(
      invalidMarkup.match(/selected="">\u8bf7选择班次<\/option>/g),
    ).toHaveLength(2);
    expect(
      invalidMarkup.match(/selected="">\u8bf7选择时刻<\/option>/g),
    ).toHaveLength(2);
    expect(invalidMarkup).toContain('2026-07-01 · 白班 · 09:00–18:00');
  });

  it('never offers an end timestamp at or before the selected start', () => {
    const markup = renderToStaticMarkup(
      createElement(LeaveRequestScheduleTimeFields, {
        startAt: '2026-08-04T09:00',
        endAt: '2026-08-04T13:00',
        startOptions: ['2026-08-04T09:00'],
        endOptions: [
          '2026-08-03T18:00',
          '2026-08-04T09:00',
          '2026-08-04T13:00',
        ],
        disabled: false,
        loading: false,
        onStartAtChange: () => undefined,
        onEndAtChange: () => undefined,
      }),
    );

    expect(markup).not.toContain('>2026-08-03</option>');
    expect(markup.match(/>09:00<\/option>/g)).toHaveLength(1);
    expect(markup).toContain('>13:00</option>');
  });

  it('groups an overnight partial leave under its real scheduled shift', () => {
    const ShiftAwareFields =
      LeaveRequestScheduleTimeFields as FunctionComponent<
        Record<string, unknown>
      >;
    const markup = renderToStaticMarkup(
      createElement(ShiftAwareFields, {
        startAt: '2026-08-17T00:00',
        endAt: '2026-08-17T05:00',
        startOptions: ['2026-08-16T18:00', '2026-08-17T00:00'],
        endOptions: [
          '2026-08-16T22:00',
          '2026-08-17T05:00',
          '2026-08-17T09:00',
        ],
        shiftRanges: [
          {
            scheduleDate: '2026-08-16',
            kind: 'night',
            startAt: '2026-08-16T18:00',
            endAt: '2026-08-17T09:00',
          },
        ],
        disabled: false,
        loading: false,
        onStartAtChange: () => undefined,
        onEndAtChange: () => undefined,
      }),
    );

    expect(markup).toContain('2026-08-16 · 夜班 · 18:00–次日09:00');
    expect(markup).toContain('>次日00:00</option>');
    expect(markup).not.toContain('>2026-08-17</option>');
  });

  it('wires the shared leave-hours summary into the dialog', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);

    expect(source).toContain("from './LeaveRequestHoursSummary'");
    expect(dialog).toContain('<LeaveRequestHoursSummary');
    expect(dialog).toMatch(
      /<LeaveRequestHoursSummary[\s\S]{0,1000}onRetry=\{handleRetryLeaveScheduleCoverage\}/,
    );
    expect(dialog).not.toContain('leaveImpact.affectedSchedules.map');
    expect(dialog).not.toContain('leaveImpact.excludedSchedules.map');
    expect(dialog).not.toContain('getLeaveScheduleWindowLabel');
  });

  it('renders a prominent eight-hour summary without schedule details', () => {
    const markup = renderHoursSummary();
    const text = visibleText(markup);
    const hoursTextIndex = markup.indexOf('休假工时');
    const hoursOpenTagStart = markup.lastIndexOf('<', hoursTextIndex);
    const hoursOpenTagEnd = markup.indexOf('>', hoursOpenTagStart);
    const hoursOpenTag = markup.slice(hoursOpenTagStart, hoursOpenTagEnd + 1);

    expect(text).toBe('休假工时：8 小时');
    expect(hoursTextIndex).toBeGreaterThan(-1);
    expect(hoursOpenTag).toMatch(/^<(?!\/)/);
    expect(hoursOpenTag).toMatch(/text-(?:xl|2xl)/);
    expect(hoursOpenTag).toMatch(/font-(?:bold|semibold)/);
    expect(text).not.toContain('受影响排班');
    expect(text).not.toContain('去重');
    expect(text).not.toContain('未计入排班');
    for (const hiddenDetail of [
      '2099-12-31',
      '测试隐藏楼栋',
      '测试隐藏班组',
      '测试隐藏班次',
      '2099-12-30',
      'holiday',
      '法定节假日',
    ]) {
      expect(text).not.toContain(hiddenDetail);
    }
    expect(markup).not.toContain('scheduledHours');
    expect(markup).not.toContain('countedHours');
  });

  it('renders loading, retry, and all blocking leave-hours states', () => {
    const loadingText = visibleText(
      renderHoursSummary({
        coverageStatus: 'loading',
        isCoverageReady: false,
      }),
    );
    expect(loadingText).toContain('正在加载休假时段内的排班，请稍候。');

    const retryMock = jest.fn();
    const errorProps = {
      coverageStatus: 'error',
      isCoverageReady: false,
      onRetry: retryMock,
    } as const;
    const errorMarkup = renderHoursSummary(errorProps);
    expect(visibleText(errorMarkup)).toContain(
      '时间范围内排班加载失败，暂不能提交。',
    );
    expect(errorMarkup).toContain('<button');
    expect(visibleText(errorMarkup)).toContain('重新加载排班');
    const errorElement = renderHoursSummaryElement(errorProps);
    const retryControl = findReactElement(
      errorElement,
      (element) => element.props.onClick === retryMock,
    );
    expect(retryControl).not.toBeNull();
    const retryOnClick = retryControl?.props.onClick;
    expect(typeof retryOnClick).toBe('function');
    if (typeof retryOnClick === 'function') {
      retryOnClick();
    }
    expect(retryMock).toHaveBeenCalledTimes(1);

    const stateCases: Array<{
      label: string;
      props: Partial<LeaveRequestHoursSummaryProps>;
      expected: string;
    }> = [
      {
        label: 'no time range',
        props: { hasTimeRange: false },
        expected: '当前加载范围内没有该人员可申请的排班时段。',
      },
      {
        label: 'invalid range',
        props: {
          impact: createImpact({
            invalidRange: true,
            invalidRangeReason: 'end_not_after_start',
          }),
        },
        expected: '开始和结束时间必须为有效整点，且结束时间必须晚于开始时间。',
      },
      {
        label: 'under four hours',
        props: { impact: createImpact({ rawHours: 3, minimumHours: 3 }) },
        expected: '当前实际休假工时不足 4 小时',
      },
      {
        label: 'unknown shift',
        props: {
          impact: createImpact({ unrecognizedShifts: ['测试未知班次'] }),
        },
        expected: '未识别班次 测试未知班次',
      },
      {
        label: 'missing calendar',
        props: {
          impact: createImpact({ missingCalendarYears: ['2027'] }),
        },
        expected: '缺少 2027 年法定节假日数据',
      },
    ];

    for (const stateCase of stateCases) {
      const text = visibleText(renderHoursSummary(stateCase.props));
      expect(text).toContain(stateCase.expected);
      expect(text).not.toContain('去重');
      expect(text).not.toContain('受影响排班');
    }
  });

  it('wires the submit coordinator while preserving duplicate and stale-response guards', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    const coordinatorCallIndex = handler.indexOf(
      'void coordinateLeaveRequestSubmit',
    );
    const requestIndex = handler.indexOf('request:', coordinatorCallIndex);
    const beforeRequest = handler.slice(0, requestIndex);
    const draftSetterPattern =
      /setLeave(?:StaffName|StaffSearch|Type|Reason|NeedSubstitute|SubstituteStaffName|StartAt|EndAt)\s*\(/;
    const readOptionSource = (name: string, nextName: string): string => {
      const optionStart = handler.indexOf(`${name}:`, coordinatorCallIndex);
      const optionEnd = handler.indexOf(`${nextName}:`, optionStart);
      return optionStart >= 0 && optionEnd > optionStart
        ? handler.slice(optionStart, optionEnd)
        : '';
    };
    const onStartSource = readOptionSource('onStart', 'request');
    const requestSource = readOptionSource('request', 'onSuccess');
    const onSuccessSource = readOptionSource('onSuccess', 'onRollback');
    const onRollbackSource = readOptionSource('onRollback', 'onReopen');
    const onReopenSource = readOptionSource('onReopen', 'onFailure');
    const onFailureSource = readOptionSource('onFailure', 'onSettled');
    const onSettledIndex = handler.indexOf('onSettled:', coordinatorCallIndex);
    const onSettledSource = handler.slice(onSettledIndex, onSettledIndex + 800);
    const failureLifecycle = [
      onRollbackSource,
      onReopenSource,
      onFailureSource,
      onSettledSource,
    ].join('\n');
    const leaveDraftResetHelperPattern =
      /\b(?:reset|clear|discard|reinitialize)(?:LeaveRequest|Leave)(?:Draft|Form|Fields|State)[A-Za-z0-9_]*\s*\(/i;

    expect(source).toContain("from './leave-request-submit'");
    expect(handler).toContain('coordinateLeaveRequestSubmit');
    expect(dialog).not.toContain('确认登记');
    expect(dialog).toContain("? '提交中'");
    expect(dialog).toContain(": '提交'");
    expect(coordinatorCallIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(-1);
    expect(handler).not.toContain('beginOptimisticScheduleMutation');
    expect(handler).not.toContain('applyOptimisticLeaveToRecords');
    expect(beforeRequest).not.toMatch(draftSetterPattern);
    expect(onStartSource).toContain("setLeaveRequestSyncStatus('syncing')");
    expect(onStartSource).toContain('setLeaveRequestDialogOpen(false)');
    expect(requestSource).toContain('createLeaveRequest');
    expect(requestSource).toContain('clientMutationId');
    expect(requestSource).toContain('expectedImpact');
    expect(onSuccessSource).toContain(
      'resolveLeaveRequestSuccessResponse(result, draft)',
    );
    expect(onSuccessSource).not.toContain('affectedSchedules.map');
    expect(onSuccessSource).not.toMatch(
      /result\.(?:startAt|endAt)\s*!==\s*leave(?:StartAt|EndAt)/,
    );
    expect(onRollbackSource).not.toContain('optimisticMutation');
    expect(onReopenSource).toContain('setLeaveRequestDialogOpen(true)');
    expect(onFailureSource).toContain('isBackendStatus(error, 409)');
    expect(onFailureSource).toContain('getBackendErrorMessage');
    expect(onFailureSource).toContain('ensureSchedulesForLeaveDateRange');
    expect(onFailureSource).toContain('toast.error');
    expect(onSettledIndex).toBeGreaterThan(-1);
    expect(onSettledSource).toContain(
      'leaveRequestSubmittingRef.current = false',
    );
    expect(onSettledSource).toContain('setLeaveRequestSubmitting(false)');
    expect(failureLifecycle).not.toMatch(draftSetterPattern);
    expect(failureLifecycle).not.toMatch(leaveDraftResetHelperPattern);
    expect(handler).toContain(
      'leaveRequestSubmittingRef.current || leaveRequestSubmitting',
    );
    expect(handler).toContain('leaveRequestSubmitSeqRef.current !== submitSeq');
    expect(handler).toContain(
      'leaveRequestMutationBindingRef.current?.clientMutationId !==',
    );
  });

  it('acknowledges submission without showing unapproved leave or substitute data', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler).toContain('void coordinateLeaveRequestSubmit');
    expect(handler).toContain('请休假申请已受理，正在后台同步');
    expect(handler).toContain('待审批通过后生效');
    expect(handler).not.toContain("toast.loading('正在提交请休假...')");
    expect(handler).not.toContain('applyOptimisticLeaveToRecords');
    expect(handler).not.toContain('beginOptimisticScheduleMutation');
    expect(handler).not.toContain('optimisticMutation.reconcile');
  });

  it('binds retry identity to the frozen leave draft and locks ambiguous outcomes', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);

    expect(source).toContain('leaveRequestMutationBindingRef');
    expect(source).toContain("'editable-error' | 'unknown-result' | null");
    expect(source).toContain("leaveRequestRecoveryState === 'unknown-result'");
    expect(handler).toContain('resolveLeaveRequestMutationBinding');
    expect(handler).toContain("mutationResolution.status === 'blocked'");
    expect(handler).toContain('markLeaveRequestMutationFailure');
    expect(handler).toContain('leaveRequestMutationBindingRef.current =');
    expect(handler).toContain('setLeaveRequestRecoveryState(');
    expect(handler).not.toContain('leaveRequestMutationIdRef.current = null');
    expect(dialog).toContain('disabled={leaveRequestDraftLocked}');
    expect(dialog).toContain('提交结果待确认，当前草稿已锁定');
    expect(dialog).toContain("? '安全重试'");
    expect(dialog).toContain("leaveRequestRecoveryState === 'unknown-result'");
  });

  it('restores only the unknown leave mutation id across a page refresh', () => {
    const {
      readLeaveRequestUnknownMutationId,
      persistLeaveRequestUnknownMutationId,
      clearLeaveRequestUnknownMutationId,
    } = requireSubmissionStateHelpers();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const clientMutationId =
      'leave-request-33333333-3333-4333-8333-333333333333';

    expect(readLeaveRequestUnknownMutationId(storage)).toBeNull();
    expect(
      persistLeaveRequestUnknownMutationId(storage, clientMutationId),
    ).toBe(true);
    expect(readLeaveRequestUnknownMutationId(storage)).toBe(clientMutationId);
    expect([...values.values()]).toEqual([clientMutationId]);
    expect([...values.values()].join('')).not.toContain('示例人员020');
    expect(clearLeaveRequestUnknownMutationId(storage)).toBe(true);
    expect(readLeaveRequestUnknownMutationId(storage)).toBeNull();
  });

  it('wires refresh-safe leave idempotency into the page without persisting form data', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const handler = source.slice(
      source.indexOf('const handleSubmitLeaveRequest'),
      source.indexOf('const handleSubmitChangeRequest'),
    );
    const persistIndex = handler.indexOf(
      'persistLeaveRequestUnknownMutationId(',
    );
    const requestIndex = handler.indexOf('request: async');

    expect(source).toContain('readLeaveRequestUnknownMutationId');
    expect(source).toContain('persistLeaveRequestUnknownMutationId');
    expect(source).toContain('clearLeaveRequestUnknownMutationId');
    expect(source).toContain('recoveredLeaveRequestMutationId');
    expect(persistIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(persistIndex);
    expect(handler).toContain('if (!mutationIdPersisted)');
    expect(handler).not.toContain('optimisticMutation');
    expect(source).not.toMatch(
      /sessionStorage\.(?:setItem|getItem)\([^\n]*(?:leaveReason|leaveStaffName|leaveRequestScreenshot)/,
    );
  });

  it('reconciles direct and wrapped success payloads against the frozen draft', () => {
    const resolveLeaveRequestSuccessResponse = requireSuccessResponseResolver();
    const draft = Object.freeze({
      clientMutationId: 'leave-request-11111111-1111-4111-8111-111111111111',
      startAt: '2026-08-04T09:00',
      endAt: '2026-08-04T18:00',
    });
    const response: LeaveRequestCreateResponse = {
      success: true,
      total: 1,
      created: 1,
      recordIds: ['leave-record-1'],
      startAt: draft.startAt,
      endAt: draft.endAt,
      leaveStaffName: '示例人员020',
      clientMutationId: draft.clientMutationId,
      affectedSchedules: [],
      excludedSchedules: [],
      rawHours: 8,
      minimumHours: 4,
      unrecognizedShifts: [],
      missingCalendarYears: [],
      message: '提交成功',
    };

    expect(resolveLeaveRequestSuccessResponse(response, draft)).toBe(response);
    expect(resolveLeaveRequestSuccessResponse({ data: response }, draft)).toBe(
      response,
    );
    expect(
      resolveLeaveRequestSuccessResponse({ data: { data: response } }, draft),
    ).toBe(response);
  });

  it('rejects malformed, failed, and genuinely mismatched success payloads', () => {
    const resolveLeaveRequestSuccessResponse = requireSuccessResponseResolver();
    const draft = Object.freeze({
      clientMutationId: 'leave-request-22222222-2222-4222-8222-222222222222',
      startAt: '2026-08-04T09:00',
      endAt: '2026-08-04T18:00',
    });
    const response: LeaveRequestCreateResponse = {
      success: true,
      total: 1,
      created: 1,
      recordIds: ['leave-record-2'],
      startAt: draft.startAt,
      endAt: draft.endAt,
      leaveStaffName: '示例人员020',
      clientMutationId: draft.clientMutationId,
      affectedSchedules: [],
      excludedSchedules: [],
      rawHours: 8,
      minimumHours: 4,
      unrecognizedShifts: [],
      missingCalendarYears: [],
      message: '提交成功',
    };

    expect(() =>
      resolveLeaveRequestSuccessResponse({ success: false }, draft),
    ).toThrow('请休假响应格式异常');
    expect(() =>
      resolveLeaveRequestSuccessResponse(
        { ...response, clientMutationId: `${draft.clientMutationId}-stale` },
        draft,
      ),
    ).toThrow('请休假响应与当前请求不一致');
    expect(() =>
      resolveLeaveRequestSuccessResponse(
        { ...response, startAt: '2026-08-05T09:00' },
        draft,
      ),
    ).toThrow('请休假响应与当前请求不一致');
    expect(() =>
      resolveLeaveRequestSuccessResponse(
        { ...response, endAt: '2026-08-05T18:00' },
        draft,
      ),
    ).toThrow('请休假响应与当前请求不一致');
  });

  it('reuses one mutation ID only for the same immutable submission snapshot', () => {
    const {
      markLeaveRequestMutationFailure,
      resolveLeaveRequestMutationBinding,
    } = requireSubmissionStateHelpers();
    const screenshot = Object.freeze({ name: 'leave-proof.png' });
    const snapshot = Object.freeze({
      staffName: '示例人员020',
      startAt: '2026-08-04T09:00',
      endAt: '2026-08-04T18:00',
      expectedImpact: createImpact(),
      leaveType: '年假',
      reason: '原始原因',
      screenshot,
      needSubstitute: false,
      substituteName: '',
    });
    const createMutationId = jest
      .fn<() => string>()
      .mockReturnValueOnce('leave-request-first')
      .mockReturnValueOnce('leave-request-second');

    const initial = resolveLeaveRequestMutationBinding(
      null,
      snapshot,
      createMutationId,
    );
    expect(initial).toMatchObject({
      status: 'ready',
      reused: false,
      binding: {
        clientMutationId: 'leave-request-first',
        state: 'in-flight',
      },
    });
    if (initial.status !== 'ready') throw new Error('expected ready binding');

    const editableFailure = markLeaveRequestMutationFailure(initial.binding, {
      response: { status: 422 },
    });
    expect(editableFailure.state).toBe('editable-error');

    const unchangedRetry = resolveLeaveRequestMutationBinding(
      editableFailure,
      snapshot,
      createMutationId,
    );
    expect(unchangedRetry).toMatchObject({
      status: 'ready',
      reused: true,
      binding: {
        clientMutationId: 'leave-request-first',
        state: 'in-flight',
      },
    });
    expect(createMutationId).toHaveBeenCalledTimes(1);

    const editedRetry = resolveLeaveRequestMutationBinding(
      editableFailure,
      { ...snapshot, reason: '修改后的原因' },
      createMutationId,
    );
    expect(editedRetry).toMatchObject({
      status: 'ready',
      reused: false,
      binding: {
        clientMutationId: 'leave-request-second',
        state: 'in-flight',
      },
    });
    expect(createMutationId).toHaveBeenCalledTimes(2);
  });

  it('locks an unknown-result snapshot and only permits an explicit same-ID retry', () => {
    const {
      markLeaveRequestMutationFailure,
      resolveLeaveRequestMutationBinding,
    } = requireSubmissionStateHelpers();
    const snapshot = Object.freeze({
      staffName: '示例人员020',
      startAt: '2026-08-04T09:00',
      endAt: '2026-08-04T18:00',
      expectedImpact: createImpact(),
      leaveType: '年假',
      reason: '结果不明测试',
      screenshot: Object.freeze({ name: 'leave-proof.webp' }),
      needSubstitute: false,
      substituteName: '',
    });
    const initial = resolveLeaveRequestMutationBinding(
      null,
      snapshot,
      () => 'leave-request-unknown',
    );
    if (initial.status !== 'ready') throw new Error('expected ready binding');
    const unknownFailure = markLeaveRequestMutationFailure(initial.binding, {
      code: 'ETIMEDOUT',
      request: {},
    });

    expect(unknownFailure.state).toBe('unknown-result');
    expect(
      resolveLeaveRequestMutationBinding(
        unknownFailure,
        snapshot,
        () => 'must-not-create',
      ),
    ).toMatchObject({
      status: 'ready',
      reused: true,
      binding: {
        clientMutationId: 'leave-request-unknown',
        state: 'unknown-result',
      },
    });
    expect(
      resolveLeaveRequestMutationBinding(
        unknownFailure,
        { ...snapshot, endAt: '2026-08-04T17:00' },
        () => 'must-not-create',
      ),
    ).toEqual({ status: 'blocked', binding: unknownFailure });
  });

  it('treats only authoritative non-ambiguous 4xx responses as definitely not written', () => {
    const { classifyLeaveRequestSubmissionError } =
      requireSubmissionStateHelpers();
    const resolveLeaveRequestSuccessResponse = requireSuccessResponseResolver();
    const draft = {
      clientMutationId: 'leave-request-classify',
      startAt: '2026-08-04T09:00',
      endAt: '2026-08-04T18:00',
    };
    let malformedResponseError: unknown;
    try {
      resolveLeaveRequestSuccessResponse({ success: false }, draft);
    } catch (error) {
      malformedResponseError = error;
    }

    for (const error of [
      { response: { status: 400 } },
      { response: { status: 403 } },
      { response: { status: 422 } },
      {
        response: {
          status: 409,
          data: { writeDisposition: 'definitely-not-written' },
        },
      },
      {
        response: {
          status: 502,
          data: { writeDisposition: 'definitely-not-written' },
        },
      },
      {
        response: {
          status: 502,
          data: {
            data: { writeDisposition: 'definitely-not-written' },
          },
        },
      },
    ]) {
      expect(classifyLeaveRequestSubmissionError(error)).toBe(
        'definitely-not-written',
      );
    }
    for (const error of [
      malformedResponseError,
      { response: { status: 408 } },
      { response: { status: 409 } },
      { response: { status: 425 } },
      { response: { status: 429 } },
      { response: { status: 500 } },
      { response: { status: 503 } },
      { code: 'ERR_NETWORK', request: {} },
      new Error('Network Error'),
    ]) {
      expect(classifyLeaveRequestSubmissionError(error)).toBe('unknown-result');
    }
  });

  it('keeps an already ambiguous mutation locked when a same-id retry gets a definite pre-write failure', () => {
    const {
      markLeaveRequestMutationFailure,
      resolveLeaveRequestMutationBinding,
    } = requireSubmissionStateHelpers();
    const snapshot = Object.freeze({
      staffName: '示例人员020',
      startAt: '2026-08-04T09:00',
      endAt: '2026-08-04T18:00',
      expectedImpact: createImpact(),
      leaveType: '年假',
      reason: '结果不明后重试',
      screenshot: Object.freeze({ name: 'leave-proof.png' }),
      needSubstitute: false,
      substituteName: '',
    });
    const initial = resolveLeaveRequestMutationBinding(
      null,
      snapshot,
      () => 'leave-request-ambiguous-retry',
    );
    if (initial.status !== 'ready') throw new Error('expected ready binding');
    const ambiguous = markLeaveRequestMutationFailure(initial.binding, {
      code: 'ETIMEDOUT',
      request: {},
    });
    const retry = resolveLeaveRequestMutationBinding(
      ambiguous,
      snapshot,
      () => 'must-not-create',
    );
    if (retry.status !== 'ready') throw new Error('expected same-id retry');
    expect(retry.binding.state).toBe('unknown-result');
    expect(
      markLeaveRequestMutationFailure(retry.binding, {
        response: {
          status: 502,
          data: { writeDisposition: 'definitely-not-written' },
        },
      }).state,
    ).toBe('unknown-result');
  });

  it('starts submission synchronously and reconciles before settling on success', async () => {
    const coordinateLeaveRequestSubmit = requireSubmitCoordinator();
    const requestDeferred = createDeferred<{ recordId: string }>();
    const screenshot = Object.freeze({
      name: 'leave-proof.png',
      type: 'image/png',
      size: 1_024,
    });
    const draft = Object.freeze({
      staffName: '示例人员020',
      startAt: '2026-08-03T09:00',
      endAt: '2026-08-03T18:00',
      screenshot,
      reason: '测试原因',
    });
    const originalDraft = { ...draft };
    const receivedDrafts: unknown[] = [];
    const events: string[] = [];
    const onFailure = jest.fn();

    const execution = coordinateLeaveRequestSubmit({
      draft,
      onStart: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('start', 'close', 'sync');
      },
      request: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('request');
        return requestDeferred.promise;
      },
      onSuccess: (_result, receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('reconcile');
      },
      onRollback: () => events.push('unexpected-rollback'),
      onReopen: () => events.push('unexpected-reopen'),
      onFailure,
      onSettled: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('settle');
      },
    });

    expect(events).toEqual(['start', 'close', 'sync', 'request']);
    expect(onFailure).not.toHaveBeenCalled();
    requestDeferred.resolve({ recordId: 'leave-record-1' });
    await execution;

    expect(events).toEqual([
      'start',
      'close',
      'sync',
      'request',
      'reconcile',
      'settle',
    ]);
    expect(receivedDrafts.every((item) => item === draft)).toBe(true);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(draft.screenshot).toBe(screenshot);
    expect(draft).toEqual(originalDraft);
  });

  it('rolls back, reopens, and settles before slow failure handling completes', async () => {
    const coordinateLeaveRequestSubmit = requireSubmitCoordinator();
    const requestDeferred = createDeferred<{ recordId: string }>();
    const slowFailure = createDeferred<void>();
    const expectedError = new Error('network failed');
    const screenshot = Object.freeze({
      name: 'leave-proof.webp',
      type: 'image/webp',
      size: 2_048,
    });
    const draft = Object.freeze({
      staffName: '示例人员020',
      staffSearch: '示例人员020',
      leaveType: '年假',
      reason: '原始草稿',
      needSubstitute: false,
      substituteStaffName: '',
      startAt: '2026-08-03T09:00',
      endAt: '2026-08-03T18:00',
      screenshot,
    });
    const originalDraft = { ...draft };
    const receivedDrafts: unknown[] = [];
    const events: string[] = [];

    const execution = coordinateLeaveRequestSubmit({
      draft,
      onStart: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('start', 'close', 'sync');
      },
      request: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('request');
        return requestDeferred.promise;
      },
      onSuccess: () => events.push('unexpected-reconcile'),
      onRollback: (error, receivedDraft) => {
        expect(error).toBe(expectedError);
        receivedDrafts.push(receivedDraft);
        events.push('rollback');
      },
      onReopen: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('reopen');
      },
      onFailure: async (error, receivedDraft) => {
        expect(error).toBe(expectedError);
        receivedDrafts.push(receivedDraft);
        events.push('failure:start');
        await slowFailure.promise;
        events.push('failure:done');
      },
      onSettled: (receivedDraft) => {
        receivedDrafts.push(receivedDraft);
        events.push('settle');
      },
    });
    let executionSettled = false;
    void execution.then(
      () => {
        executionSettled = true;
      },
      () => {
        executionSettled = true;
      },
    );

    expect(events).toEqual(['start', 'close', 'sync', 'request']);
    requestDeferred.reject(expectedError);
    await flushMicrotasks();

    expect(events).toEqual(
      expect.arrayContaining(['rollback', 'reopen', 'settle', 'failure:start']),
    );
    expect(events).not.toContain('failure:done');
    expect(executionSettled).toBe(false);
    expect(receivedDrafts.every((item) => item === draft)).toBe(true);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(draft.screenshot).toBe(screenshot);
    expect(draft).toEqual(originalDraft);

    slowFailure.resolve();
    await execution;

    for (const event of ['rollback', 'reopen', 'settle']) {
      expect(events.indexOf(event)).toBeLessThan(
        events.indexOf('failure:done'),
      );
    }
    expect(executionSettled).toBe(true);
    expect(draft.screenshot).toBe(screenshot);
    expect(draft).toEqual(originalDraft);
  });

  it('retries an in-memory unknown result from its frozen binding without live form gates', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const bindingStart = source.indexOf(
      'const lockedLeaveRequestRetryBinding =',
    );
    const bindingSource = source.slice(bindingStart, bindingStart + 800);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    const retryBranchStart = handler.indexOf(
      'if (lockedLeaveRequestRetryBinding)',
    );
    const normalBranchStart = handler.indexOf('} else {', retryBranchStart);
    const retryBranch = handler.slice(retryBranchStart, normalBranchStart);
    const liveValidationStart = handler.indexOf('const staffName =');
    const snapshotStart = handler.indexOf(
      'const submissionSnapshot = Object.freeze({',
    );
    const mutationBindingStart = handler.indexOf(
      'const mutationBinding = mutationResolution.binding',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const submitClickIndex = dialog.indexOf('void handleSubmitLeaveRequest()');
    const submitButtonSource = dialog.slice(
      Math.max(0, submitClickIndex - 2_400),
      submitClickIndex + 200,
    );

    expect(bindingStart).toBeGreaterThan(-1);
    expect(bindingSource).toContain(
      "leaveRequestRecoveryState === 'unknown-result'",
    );
    expect(bindingSource).toContain('!recoveredLeaveRequestMutationId');
    expect(bindingSource).toContain(
      "leaveRequestMutationBindingRef.current?.state === 'unknown-result'",
    );
    expect(bindingSource).toContain('const hasLockedLeaveRequestRetry =');
    expect(retryBranchStart).toBeGreaterThan(-1);
    expect(normalBranchStart).toBeGreaterThan(retryBranchStart);
    expect(retryBranch).toContain("status: 'ready'");
    expect(retryBranch).toContain('binding: lockedLeaveRequestRetryBinding');
    expect(retryBranch).toContain('reused: true');
    expect(retryBranch).not.toContain('resolveLeaveRequestMutationBinding');
    expect(retryBranch).not.toContain('createLeaveRequestMutationId');
    expect(retryBranch).not.toContain('submissionSnapshot');
    expect(normalBranchStart).toBeLessThan(liveValidationStart);
    expect(liveValidationStart).toBeLessThan(snapshotStart);
    expect(snapshotStart).toBeLessThan(mutationBindingStart);
    expect(handler.slice(normalBranchStart, mutationBindingStart)).toContain(
      'const recoveredMutationBinding = recoveredLeaveRequestMutationId',
    );
    expect(handler.slice(mutationBindingStart)).toContain(
      'const boundSnapshot = mutationBinding.snapshot',
    );
    expect(submitButtonSource).toMatch(
      /disabled=\{\s*hasLockedLeaveRequestRetry\s*\?\s*leaveRequestSubmitting\s*\|\|\s*!canUseSelfServiceTools\s*:/,
    );
    expect(submitButtonSource).toContain('!isLeaveScheduleCoverageReady');
    expect(submitButtonSource).not.toContain(
      'hasValidLeaveSubstituteSelection',
    );
  });

  it('keeps personnel auto-fill but hides persistence implementation copy', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitChangeRequest',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    expect(dialog).toContain('人员信息');
    expect(dialog).toContain('selectedLeaveStaffProfile.buildingsSpecialties');
    expect(dialog).toContain('selectedLeaveStaffProfile.position');
    expect(dialog).toContain('selectedLeaveStaffProfile.shift');
    expect(dialog).not.toMatch(
      /多维表|写入飞书|同步飞书|人员表自动带出|本地已标记/,
    );
    expect(handler).not.toMatch(/多维表|写入飞书|同步飞书|本地已标记/);
  });

  it('loads server-scoped personnel sources without exposing arbitrary views', () => {
    const pageSource = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const apiSource = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );
    const controllerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.controller.ts',
      ),
      'utf8',
    );
    const serviceSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.service.ts',
      ),
      'utf8',
    );
    const leaveLoaderStart = pageSource.indexOf(
      'const loadPersonProfiles = useCallback',
    );
    const travelLoaderStart = pageSource.indexOf(
      'const loadTravelPersonProfiles = useCallback',
      leaveLoaderStart,
    );
    const leaveLoader = pageSource.slice(leaveLoaderStart, travelLoaderStart);
    const travelLoader = pageSource.slice(
      travelLoaderStart,
      pageSource.indexOf('const personProfileMap', travelLoaderStart),
    );
    const personnelMovementHandlerStart = pageSource.indexOf(
      'const handleSubmitPersonnelMovement',
    );
    const personnelMovementHandler = pageSource.slice(
      personnelMovementHandlerStart,
      pageSource.indexOf(
        'const startTravelDetailEdit',
        personnelMovementHandlerStart,
      ),
    );

    expect(leaveLoader).toContain(
      "getPersonProfiles(forceRefresh, 'leave', controller.signal)",
    );
    expect(leaveLoader).toMatch(
      /catch[\s\S]*setPersonProfileDetails\(\[\]\)[\s\S]*setScreenshotSectionState\('personProfiles', 'error'\)/,
    );
    expect(leaveLoader).not.toContain('setPersonProfiles([])');
    expect(travelLoader).toContain("getPersonProfiles(forceRefresh, 'travel')");
    expect(travelLoader).toContain('travelProfileLoadSeqRef.current');
    expect(travelLoader).toContain("setTravelProfilesStatus('ready')");
    expect(travelLoader).toMatch(
      /catch[\s\S]*setTravelPersonProfiles\(\[\]\)[\s\S]*setTravelProfilesStatus\('error'\)/,
    );
    expect(personnelMovementHandler).toContain(
      'void loadTravelPersonProfiles(true)',
    );
    expect(apiSource).toContain("scope: PersonProfileScope = 'leave'");
    expect(apiSource).toContain('params: {');
    expect(apiSource).toContain('scope,');
    expect(apiSource).not.toContain("allRecords: '1'");
    expect(controllerSource).toContain("@Query('scope') scope?: string");
    expect(controllerSource).not.toContain("@Query('allRecords')");
    expect(controllerSource).not.toContain("@Query('viewId') viewId?: string");
    expect(serviceSource).toContain('resolvePersonProfileReadPlan');
    expect(serviceSource).toContain('resolveBitableAppToken');
    expect(serviceSource).toContain('fieldNames: plan.fieldNames');
    expect(serviceSource).toContain('strict: plan.strict');
    expect(serviceSource).toContain(
      'private mapFeishuEmployeeRecordToPersonProfile',
    );
    expect(serviceSource).toContain('supervisorText: name');
    expect(serviceSource).toContain(
      'buildingsSpecialties: this.extractEmployeeBuildingProfessional(fields)',
    );
    expect(serviceSource).not.toContain('resolvePersonProfileViewIds');

    const travelOptionsStart = pageSource.indexOf(
      'const travelStaffOptions = useMemo',
      travelLoaderStart,
    );
    const travelOptions = pageSource.slice(
      travelOptionsStart,
      pageSource.indexOf(
        'const filteredTravelStaffOptions',
        travelOptionsStart,
      ),
    );
    expect(travelOptions).not.toContain('personProfiles');
    expect(pageSource).not.toContain(
      'travelPersonProfiles.length === 0 && !travelProfilesLoading',
    );
  });

  it('passes raw and display schedule fields into the shared impact engine', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).toContain('building: schedule.building');
    expect(source).toContain('buildingText: schedule.buildingText');
    expect(source).toContain('team: schedule.team');
    expect(source).toContain('teamText: schedule.teamText');
    expect(source).toContain('shift: schedule.shift');
    expect(source).toContain('shiftText: schedule.shiftText');
  });

  it('blocks invalid or unsafe impacts and uses the hourly API contract', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const handlerStart = source.indexOf('const handleSubmitLeaveRequest');
    const handlerEnd = source.indexOf(
      'const handleSubmitAdditionalMatter',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);
    const dialogStart = source.indexOf('open={leaveRequestDialogOpen}');
    const dialogEnd = source.indexOf('</Dialog>', dialogStart);
    const dialog = source.slice(dialogStart, dialogEnd);

    expect(handler).toContain('parseShanghaiLocalDateTime(leaveStartAt)');
    expect(handler).toContain('parseShanghaiLocalDateTime(leaveEndAt)');
    expect(handler).toContain('leaveImpact.invalidRange');
    expect(handler).toContain('leaveImpact.unrecognizedShifts.length > 0');
    expect(handler).toContain('leaveImpact.missingCalendarYears.length > 0');
    expect(handler).toContain('leaveImpact.rawHours < 4');
    expect(handler).toContain('startAt: leaveStartAt');
    expect(handler).toContain('endAt: leaveEndAt');
    expect(handler).toContain('expectedImpact: leaveImpact');
    expect(handler).toContain('isBackendStatus(error, 409)');
    expect(handler).toContain('latestImpact');
    expect(handler).toContain('setLeaveAuthoritativeImpact');
    expect(handler).toContain('ensureSchedulesForLeaveDateRange(');
    expect(handler).toContain(
      'resolveLeaveRequestSuccessResponse(result, draft)',
    );
    expect(handler).not.toMatch(
      /result\.(?:startAt|endAt)\s*!==\s*leave(?:StartAt|EndAt)/,
    );
    expect(handler).not.toContain('startDate: leaveStartDate');
    expect(handler).not.toContain('endDate: leaveEndDate');
    expect(dialog).toContain('leaveImpact.invalidRange ||');
    expect(dialog).toContain('leaveImpact.unrecognizedShifts.length > 0 ||');
    expect(dialog).toContain('leaveImpact.missingCalendarYears.length > 0 ||');
    expect(dialog).toContain('leaveImpact.rawHours < 4 ||');
  });

  it('renders sealing registration entry and dialog from common tools', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).toContain('setSealingRegistrationDialogOpen(true)');
    expect(source).toContain('封网登记');
    expect(source).toContain('handleSubmitSealingRegistration');
    expect(source).toContain('createSealingRegistration');
  });

  it('supports adding multiple sealing registration rows before submit', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).toContain('sealingRegistrationRows');
    expect(source).toContain('handleAddSealingRegistrationRow');
    expect(source).toContain('handleRemoveSealingRegistrationRow');
    expect(source).toContain('Promise.all(');
    expect(source).toContain('新增一条');
  });

  it('uses backend leave request endpoint from client api', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(source).toContain('createLeaveRequest');
    expect(source).toContain("url: '/api/duty-schedules/leave-request'");
  });

  it('sends the leave payload and screenshot as multipart FormData', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function createLeaveRequest');
    const end = source.indexOf(
      'export async function createOvertimeRequest',
      start,
    );
    const createLeaveRequestSource = source.slice(start, end);
    const formVariableMatch = createLeaveRequestSource.match(
      /const\s+(formData|form)\s*=\s*new FormData\(\)/,
    );

    expect(start).toBeGreaterThan(-1);
    expect(createLeaveRequestSource).toMatch(
      /payload:\s*LeaveRequestCreateRequest\s*,\s*screenshot:\s*File/,
    );
    expect(formVariableMatch).not.toBeNull();
    const formVariable = formVariableMatch?.[1] ?? 'formData';
    expect(createLeaveRequestSource).toContain(
      `${formVariable}.append('payload', JSON.stringify(payload))`,
    );
    expect(createLeaveRequestSource).toContain(
      `${formVariable}.append('screenshot', screenshot)`,
    );
    expect(createLeaveRequestSource).toContain(`data: ${formVariable}`);
    expect(createLeaveRequestSource).not.toMatch(/data:\s*payload\b/);
  });

  it('uses backend sealing registration endpoint from client api', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(source).toContain('createSealingRegistration');
    expect(source).toContain("url: '/api/duty-schedules/sealing-registration'");
  });
});
