import { readFileSync } from 'fs';
import { join } from 'path';

import type { ChangeInfo } from '../../shared/api.interface';
import type { ChangeRequestCreateRequest } from '../../shared/change-request';
import {
  createPendingChangeInfo,
  getChangeRequestAttachmentPartialFailure,
  getChangeInfoScheduleYear,
  mergeChangeInfoOverlay,
  reconcileChangeRequestEndAfterStart,
  reconcileChangeRequestRangeAfterStartChange,
  resolveChangeInfoOverlayResponse,
  reconcilePendingChange,
  rollbackPendingChange,
  shouldRetainChangeRequestMutationIdAfterError,
} from '../../client/src/pages/MonthlySchedule/change-request-state';

const request = (): ChangeRequestCreateRequest => ({
  clientMutationId: 'change-request-123e4567-e89b-42d3-a456-426614174000',
  nature: '标准变更',
  summary: 'UPS 年度维护',
  changeType: '计划性变更',
  workType: '维护',
  buildings: ['A楼'],
  plannedStartAt: '2026-08-03T09:00',
  plannedEndAt: '2026-08-03T12:00',
  discipline: '电气',
  level: '低',
  riskSummary: '切换前确认旁路供电正常',
});

const changeInfo = (id: string, title = id): ChangeInfo => ({
  id,
  bitableRecordId: id,
  title,
  startDate: '2026-08-03T09:00',
  endDate: '2026-08-03T12:00',
  actualStartDate: null,
  actualEndDate: null,
  plannedDelayStartDate: null,
  plannedDelayEndDate: null,
  level: '低',
  type: '计划性变更',
  progress: null,
  executor: null,
  buildings: ['A楼'],
  riskSummary: '风险',
  isKey: false,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
});

describe('monthly schedule change request optimistic state', () => {
  it('moves the end time with the changed start while preserving a valid duration', () => {
    expect(
      reconcileChangeRequestRangeAfterStartChange(
        '2026-08-10T09:00',
        '2026-08-10T18:00',
        '2026-08-12T09:00',
      ),
    ).toBe('2026-08-12T18:00');
    expect(
      reconcileChangeRequestRangeAfterStartChange(
        '2026-08-10T09:00',
        '2026-08-10T18:00',
        '2026-08-10T19:00',
      ),
    ).toBe('2026-08-11T04:00');
    expect(
      reconcileChangeRequestRangeAfterStartChange(
        '2026-08-10T22:00',
        '2026-08-11T01:00',
        '2026-08-10T23:00',
      ),
    ).toBe('2026-08-11T02:00');
  });

  it('leaves incomplete date-time input untouched and never creates an invalid range', () => {
    expect(
      reconcileChangeRequestRangeAfterStartChange(
        '2026-08-10T09:00',
        '2026-08-10T18:00',
        '',
      ),
    ).toBe('2026-08-10T18:00');
    expect(
      reconcileChangeRequestRangeAfterStartChange('', '', '2026-08-10T23:30'),
    ).toBe('2026-08-11T00:30');
  });

  it('clamps a typed end time to one hour after the start', () => {
    expect(
      reconcileChangeRequestEndAfterStart(
        '2026-08-11T11:00',
        '2026-08-11T10:00',
      ),
    ).toBe('2026-08-11T12:00');
    expect(
      reconcileChangeRequestEndAfterStart(
        '2026-08-11T11:00',
        '2026-08-11T11:00',
      ),
    ).toBe('2026-08-11T12:00');
    expect(
      reconcileChangeRequestEndAfterStart(
        '2026-08-11T11:00',
        '2026-08-11T12:00',
      ),
    ).toBe('2026-08-11T12:00');
    expect(reconcileChangeRequestEndAfterStart('', '')).toBe('');
  });

  it('assigns UTC API dates to the Asia/Shanghai schedule year', () => {
    expect(getChangeInfoScheduleYear('2025-12-31T16:00:00.000Z')).toBe(2026);
    expect(getChangeInfoScheduleYear('2026-01-01T00:00')).toBe(2026);
    expect(getChangeInfoScheduleYear('invalid')).toBeNull();
  });

  it('creates a stable pending record from an immutable request snapshot', () => {
    const input = request();
    const pending = createPendingChangeInfo(
      input,
      'change-request-temp-1',
      '2026-08-02T00:00:00.000Z',
    );

    input.buildings.push('B楼');

    expect(pending).toMatchObject({
      id: 'change-request-temp-1',
      bitableRecordId: 'change-request-temp-1',
      title: 'UPS 年度维护',
      startDate: '2026-08-03T09:00',
      endDate: '2026-08-03T12:00',
      level: '低',
      type: '计划性变更',
      progress: '同步中',
      buildings: ['A楼'],
      riskSummary: '切换前确认旁路供电正常',
    });
  });

  it('reconciles only the exact temporary record', () => {
    const existing = changeInfo('existing');
    const pending = createPendingChangeInfo(request(), 'temp-1');
    const otherPending = createPendingChangeInfo(request(), 'temp-2');
    const saved = changeInfo('saved', '飞书已保存');

    const result = reconcilePendingChange(
      [existing, pending, otherPending],
      'temp-1',
      saved,
    );

    expect(result).toEqual([existing, saved, otherPending]);
    expect(result[0]).toBe(existing);
    expect(result[2]).toBe(otherPending);
  });

  it('upserts a saved record when an older yearly response removed the temporary row', () => {
    const existing = changeInfo('existing');
    const saved = changeInfo('saved', '飞书已保存');

    expect(reconcilePendingChange([existing], 'missing-temp', saved)).toEqual([
      saved,
      existing,
    ]);
  });

  it('deduplicates an existing partial record when attachment retry succeeds', () => {
    const partial = changeInfo('saved', '附件待重试');
    const pending = createPendingChangeInfo(request(), 'temp-retry');
    const saved = changeInfo('saved', '飞书已保存');

    expect(
      reconcilePendingChange([partial, pending], 'temp-retry', saved),
    ).toEqual([saved]);
  });

  it('parses structured attachment partial failures from the API envelope', () => {
    const partial = {
      code: 'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE',
      clientMutationId: request().clientMutationId,
      recordState: 'not-created',
      recordCreated: false,
      retryAction: 'retry-same-mutation',
      recordId: 'rec-partial',
      record: changeInfo('rec-partial', '附件待重试'),
      documents: [
        {
          name: '成功.pdf',
          size: 10,
          status: 'attached',
          stage: 'record-link',
          retryable: false,
        },
        {
          name: '失败.pdf',
          size: 20,
          status: 'upload_failed',
          stage: 'upload',
          retryable: true,
          message: '飞书上传超时',
        },
      ],
      message: '变更记录已创建，1 个附件待重试',
    };
    const error = {
      response: {
        data: {
          success: false,
          error: {
            code: 'BAD_GATEWAY',
            details: JSON.stringify(partial),
          },
        },
      },
    };

    expect(getChangeRequestAttachmentPartialFailure(error)).toEqual(partial);
    expect(
      getChangeRequestAttachmentPartialFailure({
        response: {
          data: {
            ...partial,
            recordState: 'unknown',
            recordCreated: null,
          },
        },
      }),
    ).toMatchObject({ recordState: 'unknown', recordCreated: null });
    expect(
      getChangeRequestAttachmentPartialFailure({
        response: {
          data: {
            ...partial,
            recordCreated: undefined,
          },
        },
      }),
    ).toBeNull();
    expect(
      getChangeRequestAttachmentPartialFailure({
        response: { data: { error: { details: '{broken' } } },
      }),
    ).toBeNull();
  });

  it('retains the original mutation id only for ambiguous transport failures', () => {
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        code: 'ECONNABORTED',
        message: 'timeout of 420000ms exceeded',
      }),
    ).toBe(true);
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        message: 'Failed to fetch',
      }),
    ).toBe(true);
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        code: 'ERR_NETWORK',
        request: {},
      }),
    ).toBe(true);
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        request: {},
      }),
    ).toBe(true);
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        response: { status: 503 },
      }),
    ).toBe(true);
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        response: { status: 400 },
        message: '字段校验失败',
      }),
    ).toBe(false);
    expect(
      shouldRetainChangeRequestMutationIdAfterError({
        response: { status: 400 },
        message: 'network timeout wording in a rejected request',
      }),
    ).toBe(false);
  });

  it('merges pending and recently saved overlays into stale yearly data', () => {
    const authoritative = changeInfo('existing');
    const pending = createPendingChangeInfo(request(), 'temp-1');
    const saved = changeInfo('saved', '刚保存的记录');

    expect(mergeChangeInfoOverlay([authoritative], [pending, saved])).toEqual([
      pending,
      saved,
      authoritative,
    ]);
    expect(mergeChangeInfoOverlay([saved], [saved])).toEqual([saved]);
  });

  it('keeps overlays written after a yearly request started and attachment recovery states', () => {
    const serverSaved = changeInfo('saved', '服务端旧快照');
    const locallySaved = {
      ...changeInfo('saved', '刚完成的本地变更'),
      progress: '已完成',
    };
    const attachmentPending = {
      ...changeInfo('partial', '附件待补传'),
      progress: '附件待补传',
    };
    const attachmentSyncing = {
      ...changeInfo('retrying', '附件同步中'),
      progress: '附件同步中',
    };
    const oldConfirmed = {
      ...changeInfo('old-confirmed', '已被新请求确认'),
      progress: '已完成',
    };

    const result = resolveChangeInfoOverlayResponse(
      [
        serverSaved,
        changeInfo('partial', '服务端无附件状态'),
        changeInfo('retrying', '服务端无重试状态'),
        oldConfirmed,
      ],
      [
        { key: 'saved', change: locallySaved, generation: 11 },
        { key: 'partial', change: attachmentPending, generation: 3 },
        { key: 'retrying', change: attachmentSyncing, generation: 4 },
        { key: 'old-confirmed', change: oldConfirmed, generation: 8 },
      ],
      10,
    );

    expect(result.confirmedOverlayKeys).toEqual(['old-confirmed']);
    expect(result.changes).toEqual([
      locallySaved,
      attachmentPending,
      attachmentSyncing,
      oldConfirmed,
    ]);
  });

  it('rolls back only the exact temporary record', () => {
    const existing = changeInfo('existing');
    const pending = createPendingChangeInfo(request(), 'temp-1');
    const otherPending = createPendingChangeInfo(request(), 'temp-2');

    const result = rollbackPendingChange(
      [existing, pending, otherPending],
      'temp-1',
    );

    expect(result).toEqual([existing, otherPending]);
    expect(result[0]).toBe(existing);
    expect(result[1]).toBe(otherPending);
  });
});

describe('monthly schedule change request dialogs', () => {
  const dialogSource = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/ChangeRequestDialog.tsx',
    ),
    'utf8',
  );
  const thresholdSource = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/ThresholdAdjustmentDialog.tsx',
    ),
    'utf8',
  );
  const attachmentFieldSource = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/ChangeAttachmentField.tsx',
    ),
    'utf8',
  );

  it('renders four sections without preselecting a classification', () => {
    expect(dialogSource).toContain('基础分类');
    expect(dialogSource).toContain('时间安排');
    expect(dialogSource).toContain('内容与风险');
    expect(dialogSource).toContain('变更文档');
    expect(dialogSource).toContain("draft.nature === '非标准变更'");
    expect(dialogSource).toContain('createEmptyChangeRequestDraft');
    expect(dialogSource).not.toContain("nature: '标准变更'");
    expect(dialogSource).not.toContain("changeType: '计划性变更'");
    expect(dialogSource).not.toContain("level: '低'");
  });

  it('validates locally and gives immediate attachment feedback', () => {
    expect(dialogSource).toContain('validateChangeRequest');
    expect(dialogSource).toContain('<ChangeAttachmentField');
    expect(attachmentFieldSource).toContain('removeChangeAttachmentUploadItem');
    expect(attachmentFieldSource).toContain('onProgress');
    expect(attachmentFieldSource).toContain(
      'const [selectionError, setSelectionError]',
    );
    expect(attachmentFieldSource).toContain('setSelectionError(result.error)');
    expect(attachmentFieldSource).toContain("role={visibleError ? 'alert'");
    expect(attachmentFieldSource).toContain('uploadingLocalIdsRef');
    expect(attachmentFieldSource).toContain(
      'if (uploadingLocalIdsRef.current.has(item.localId)) return;',
    );
    expect(attachmentFieldSource).toContain(
      'uploadingLocalIdsRef.current.delete(item.localId)',
    );
    expect(dialogSource).toContain('CHANGE_REQUEST_MAX_DOCUMENT_COUNT');
    expect(dialogSource).toContain('CHANGE_REQUEST_MAX_DOCUMENT_SIZE');
    expect(dialogSource).toContain('isAllowedChangeRequestDocument');
    expect(dialogSource).toContain(
      'isAllowed={isAllowedChangeRequestDocument}',
    );
    expect(dialogSource).toContain('PDF、Word、Excel 或图片');
    expect(dialogSource).toContain(
      'accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"',
    );
    expect(dialogSource).toContain('[...draft.buildings]');
    expect(dialogSource).toContain('getReadyChangeAttachmentDocuments');
    expect(dialogSource).toContain('单个不超过 200 MB');
    expect(dialogSource).not.toContain('单个不超过 20 MiB');
  });

  it('selects the submitter through the cached search picker and stable identity', () => {
    const picker = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/ChangeRequestPersonPicker.tsx',
      ),
      'utf8',
    );
    expect(dialogSource).toContain('ChangeRequestPersonPicker');
    expect(dialogSource).toContain('value={draft.submitterId}');
    expect(dialogSource).not.toContain('<datalist');
    expect(picker).toContain('id="change-request-submitter"');
    expect(picker).toContain('输入姓名快速匹配');
    expect(dialogSource).toContain('请从人员名单中选择提交人');
    expect(dialogSource).not.toContain(
      '提交后同步至园区变更多维表；分类选项与原飞书表单保持一致。',
    );
  });

  it('synchronizes controlled drafts and exposes keyboard/error/submitting states', () => {
    expect(dialogSource).toContain('resetKey');
    expect(dialogSource).toContain('onOpenAutoFocus');
    expect(dialogSource).toContain('focusFirstError');
    expect(dialogSource).toContain('serverError');
    expect(dialogSource).toContain('role="alert"');
    expect(dialogSource).toContain('正在提交');
    expect(dialogSource).toContain('disabled={submitting}');
    expect(dialogSource).toContain(
      "clearFieldErrors('plannedStartAt', 'plannedEndAt')",
    );
    expect(dialogSource).toContain(
      "clearFieldErrors('meetingStartAt', 'meetingEndAt')",
    );
    expect(dialogSource).toContain("ref={setFieldRef('documents')}");
    expect(dialogSource).toContain('attachmentRetryLocked');
    expect(dialogSource).toContain('retryAction');
    expect(dialogSource).toContain('使用原申请标识重试');
    expect(dialogSource).toContain('提交结果待确认');
    expect(dialogSource).toContain("retryAction === 'manual-reconcile'");
    expect(dialogSource).toContain('window.requestAnimationFrame');
    expect(dialogSource).toContain('if (errors.length > 0) setErrors([])');
    expect(attachmentFieldSource).toContain("return '上传完成'");
    expect(attachmentFieldSource).toContain("return '上传失败'");
    expect(attachmentFieldSource).toContain(
      'return `上传中 ${item.progress}%`',
    );
  });

  it('mounts cached form fields without a second opening gate', () => {
    expect(dialogSource).toContain('id="change-request-nature"');
    expect(dialogSource).not.toContain('contentReady');
    expect(dialogSource).not.toContain('正在准备表单…');
    expect(dialogSource).not.toContain('CONTENT_DEFER_AFTER_FIRST_FRAME_MS');
    expect(dialogSource).not.toContain('window.setTimeout');
  });

  it('mounts the first control before progressively rendering secondary fields', () => {
    const natureFieldIndex = dialogSource.indexOf('id="change-request-nature"');
    const secondaryFieldsIndex = dialogSource.indexOf(
      '{secondaryFieldsReady && (',
      natureFieldIndex,
    );

    expect(natureFieldIndex).toBeGreaterThan(-1);
    expect(secondaryFieldsIndex).toBeGreaterThan(natureFieldIndex);
    expect(dialogSource).toMatch(
      /disabled=\{[\s\S]{0,120}!secondaryFieldsReady/,
    );
    expect(dialogSource).toMatch(
      /const firstFrame = window\.requestAnimationFrame\([\s\S]{0,240}secondFrame = window\.requestAnimationFrame\(/,
    );
  });

  it('keeps threshold adjustment information-only with no request path', () => {
    expect(thresholdSource).toContain('阈值数据源和字段协议尚未配置');
    expect(thresholdSource).toContain('仅供说明');
    expect(thresholdSource).not.toMatch(/\/api\//);
    expect(thresholdSource).not.toMatch(/\bfetch\s*\(/);
    expect(thresholdSource).not.toMatch(/\baxios\b/);
    expect(thresholdSource).not.toContain('onSubmit');
  });
});

describe('monthly schedule change request API', () => {
  it('stages large documents first and submits only their JSON references', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(source).toContain('export async function createChangeRequest');
    expect(source).toContain('export async function stageChangeAttachment');
    expect(source).toContain(
      "url: '/api/duty-schedules/change-attachments/stage'",
    );
    expect(source).toContain('onUploadProgress');
    expect(source).toContain('export async function deleteChangeAttachment');
    expect(source).toContain("url: '/api/duty-schedules/change-request'");
    expect(source).toContain('timeout: 420000');
  });

  it('does not render an empty Radix select option', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/ChangeRequestDialog.tsx',
      ),
      'utf8',
    );

    expect(source).not.toContain('<SelectItem value="">');
  });
});

describe('monthly schedule change request page integration', () => {
  const source = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );

  it('exposes leave, change request and threshold adjustment to guests only', () => {
    const commonToolsLabelIndex = source.indexOf('常用工具');
    const commonToolsStart = source.lastIndexOf(
      '{canUseSelfServiceTools && (',
      commonToolsLabelIndex,
    );
    const commonToolsEnd = source.indexOf(
      '</DropdownMenu>',
      commonToolsLabelIndex,
    );
    const commonTools = source.slice(commonToolsStart, commonToolsEnd);

    expect(source).toContain("canManageMonthlySchedule || role === 'guest'");
    expect(commonToolsStart).toBeGreaterThan(-1);
    expect(commonTools).toContain('<DropdownMenu modal={false}>');
    expect(commonTools).toContain('请休假');
    expect(commonTools).toContain('setLeaveRequestDialogOpen(true)');
    expect(commonTools).toContain('变更申请');
    expect(commonTools).toContain(
      'changeRequestDialogRef.current?.setOpen(true)',
    );
    expect(commonTools).toContain('disabled={changeRequestSubmitting}');
    expect(commonTools).toContain('阈值调整');
    expect(commonTools).toContain('setThresholdAdjustmentDialogOpen(true)');
    expect(commonTools).toContain('{canManageMonthlySchedule && (');
    expect(commonTools).not.toContain('（待开放）');
  });

  it('prepares an empty draft outside the change-request menu click path', () => {
    const commonToolsLabelIndex = source.indexOf('常用工具');
    const changeRequestLabelIndex = source.indexOf(
      '变更申请',
      commonToolsLabelIndex,
    );
    const changeRequestMenuHandlerStart = source.lastIndexOf(
      'onSelect={() => {',
      changeRequestLabelIndex,
    );
    const changeRequestMenuHandler = source.slice(
      changeRequestMenuHandlerStart,
      changeRequestLabelIndex,
    );

    expect(source).toContain(
      'createChangeRequestDraftForDate(selectedDateKey)',
    );
    expect(source).toContain('const resetChangeRequestDraft = useCallback');
    expect(changeRequestMenuHandler).toContain(
      'changeRequestDialogRef.current?.setOpen(true)',
    );
    expect(changeRequestMenuHandler).not.toContain('setChangeRequestDraft');
    expect(changeRequestMenuHandler).not.toContain('setChangeRequestDocuments');
    expect(changeRequestMenuHandler).not.toContain('setChangeRequestResetKey');
  });

  it('optimistically closes, reconciles and precisely restores failed requests', () => {
    const start = source.indexOf('const handleSubmitChangeRequest');
    const end = source.indexOf('const handleSubmitAdditionalMatter', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('changeRequestSubmittingRef.current');
    expect(handler).toContain('validateChangeRequest');
    expect(handler.indexOf('validateChangeRequest')).toBeLessThan(
      handler.indexOf('createPendingChangeInfo'),
    );
    expect(handler).not.toContain('showSyncFeedback: true');
    expect(source).not.toContain('变更申请正在同步飞书多维表');
    expect(handler).toContain('正在提交变更申请，草稿已保留');
    expect(handler).toContain('monitorChangeRequestSyncTask');
    expect(handler).toContain('createPendingChangeInfo');
    expect(handler).toContain(': [pendingChange, ...current]');
    expect(handler).toContain(
      'reconcilePendingChange(current, temporaryId, pendingChange)',
    );
    expect(
      handler.indexOf('changeRequestDialogRef.current?.setOpen(false)'),
    ).toBeLessThan(handler.indexOf('await createChangeRequest(request)'));
    expect(handler).toContain('reconcilePendingChange');
    expect(handler).toContain('rollbackPendingChange');
    expect(handler).toContain('changeRequestDialogRef.current?.setOpen(true)');
    expect(handler).toContain(
      'changeRequestSubmitSeqRef.current === submitSeq',
    );
    expect(
      handler.match(/selectedYearRef\.current === changeYear/g)?.length || 0,
    ).toBeGreaterThanOrEqual(3);
    expect(handler).toContain('getChangeRequestAttachmentPartialFailure');
    expect(handler).toContain('setChangeRequestPartialRecord(partialRecord)');
    expect(handler).toContain(
      'shouldRetainChangeRequestMutationIdAfterError(error)',
    );
    expect(handler).toContain("progress: '提交结果待确认'");
    expect(handler).toContain(
      'setChangeRequestRetryAction(partialFailure.retryAction)',
    );
    expect(handler).toContain('setChangeRequestStagedDocuments');
    expect(handler).toContain(
      "!partialRecordAtSubmit.id.startsWith('change-request-pending-')",
    );
    expect(handler).toContain(
      'setChangeRequestOwnerMutationId(nextMutationId)',
    );
    expect(handler).toContain('setChangeRequestPartialRecord(null)');
    expect(handler).not.toContain('getYearlyChangeInfo');
  });

  it('merges the local overlay whenever yearly change data lands', () => {
    const start = source.indexOf('const loadChangeInfo');
    const end = source.indexOf('const loadPersonProfiles', start);
    const loader = source.slice(start, end);

    expect(source).toContain('changeRequestOverlayRef');
    expect(loader).toContain('resolveChangeInfoOverlayResponse');
    expect(loader).toContain('requestStartedAtOverlayGeneration');
    expect(loader).toContain('changeRequestOverlayRef.current.entries()');
    expect(loader).toContain('mergeLocalOverlay(cached.changes, false)');
    expect(loader).toContain('mergeLocalOverlay(validChanges, true)');
    expect(loader).not.toContain('setChanges(validChanges)');
    expect(loader).not.toContain('changes: validChanges');
  });

  it('mounts both dialogs and keeps threshold adjustment network-free', () => {
    expect(source).toContain('<ChangeRequestDialogHost');
    expect(source).toContain('key={dialogProps.resetKey}');
    expect(source).toContain('onSubmit={handleSubmitChangeRequest}');
    expect(source).toContain('retryAction={changeRequestRetryAction}');
    expect(source).toContain('提交结果待确认');
    expect(source).toContain("changeRequestRetryAction === 'manual-reconcile'");
    expect(source).toContain('<ThresholdAdjustmentDialog');
  });
});
