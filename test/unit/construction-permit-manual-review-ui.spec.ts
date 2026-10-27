import { readFileSync } from 'fs';
import * as path from 'path';

describe('construction permit manual review UI wiring', () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );
  const onlineFormSource = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/online-work-form.tsx',
    ),
    'utf8',
  );
  const onlineFormModelSource = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/online-work-form-model.ts',
    ),
    'utf8',
  );
  const apiSource = readFileSync(
    path.resolve(__dirname, '../../client/src/api/index.ts'),
    'utf8',
  );
  const sharedApiSource = readFileSync(
    path.resolve(__dirname, '../../shared/api.interface.ts'),
    'utf8',
  );
  const dailyPermitSource = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/daily-permit-verification.ts',
    ),
    'utf8',
  );

  it('uses the global role capabilities and removes the page-local password gate', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function CrewRosterUploadDialog'),
    );

    expect(source).toContain(
      "import { getAccessRoleLabel, useAccess } from '@/access/AccessProvider';",
    );
    expect(pageSource).toContain('const { role, capabilities } = useAccess();');
    expect(pageSource).toContain(
      'const canEditConstruction = capabilities.canEdit;',
    );
    expect(pageSource).toContain(
      'const canDeleteConstruction = capabilities.canDelete;',
    );
    expect(pageSource).toContain(
      'const canForceRefreshConstruction = capabilities.canForceRefresh;',
    );

    for (const legacySymbol of [
      'ConstructionIdentitySwitch',
      'verifyConstructionManagementAccess',
      'ConstructionManagementAccessRole',
      'accessPassword',
      'projectDeletePassword',
      'projectTerminatePassword',
      'adminPassword:',
    ]) {
      expect(source).not.toContain(legacySymbol);
    }
  });

  it('removes legacy construction access DTOs and per-action passwords', () => {
    for (const legacySymbol of [
      'ConstructionManagementAccessRole',
      'ConstructionManagementAccessRequest',
      'ConstructionManagementAccessResponse',
    ]) {
      expect(sharedApiSource).not.toContain(legacySymbol);
      expect(apiSource).not.toContain(legacySymbol);
    }

    expect(apiSource).not.toContain('verifyConstructionManagementAccess');
    expect(sharedApiSource).not.toMatch(
      /ConstructionProject(?:Delete|Terminate)Request[\s\S]*?adminPassword/,
    );
  });

  it('lets guests inspect details, lets editors operate and terminate, and reserves deletion for admins', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function CrewRosterUploadDialog'),
    );
    const cardSource = source.slice(
      source.indexOf('function ConstructionCard'),
      source.indexOf('type ProjectCalendarDayStatus'),
    );
    const listSource = source.slice(
      source.indexOf('function ConstructionListDialog'),
      source.indexOf('function ConstructionDetailDialog'),
    );
    const openDetailSource = pageSource.slice(
      pageSource.indexOf('const openConstructionDetail'),
      pageSource.indexOf('const handleListItemSelect'),
    );
    const terminateSource = pageSource.slice(
      pageSource.indexOf('const handleConfirmTerminateProject'),
      pageSource.indexOf('const openCrewRosterUploadDialog'),
    );
    const deleteSource = pageSource.slice(
      pageSource.indexOf('const handleConfirmDeleteProject'),
      pageSource.indexOf('const handleConfirmTerminateProject'),
    );

    expect(openDetailSource).not.toContain('requireConstructionEdit');
    expect(pageSource).toContain('readOnly={!canEditConstruction}');
    expect(pageSource).toMatch(
      /onDeleteRequest=\{\s*canDeleteConstruction\s*\?\s*setProjectDeleteCandidate\s*:\s*undefined\s*\}/,
    );
    expect(pageSource).toContain(
      'onTerminateRequest={handleProjectTerminateRequest}',
    );
    expect(pageSource).toContain(
      'projectTerminateCandidateRef.current = candidate',
    );
    expect(pageSource).toContain('setProjectTerminateCandidate(candidate)');
    expect(pageSource).toContain(
      'allowAttachmentDelete={canDeleteConstruction}',
    );
    expect(terminateSource).toContain("requireConstructionEdit('终止项目')");
    expect(deleteSource).toContain("requireConstructionDelete('删除项目')");
    expect(pageSource).toContain(
      'disabled={refreshing || !canForceRefreshConstruction}',
    );
    expect(cardSource).toContain('readOnly');
    expect(cardSource).toContain('onDeleteRequest && (');
    expect(cardSource).toContain('onTerminateRequest(item)');
    expect(cardSource).toContain('onClick={() => onSelect(item)}');
    expect(cardSource).not.toContain("{readOnly ? '游客只读' : '查看详情'}");
    expect(listSource).toContain('readOnly');
    expect(listSource).not.toContain('disabled={readOnly}');
  });

  it('places the manual review control before the permit validity status', () => {
    const cardStart = source.indexOf('function DailyPermitVerificationCard');
    const badgeStart = source.indexOf('function DailyPermitManualReviewBadge');
    const cardSource = source.slice(cardStart, badgeStart);

    expect(cardSource).toContain('<DailyPermitManualReviewBadge');
    expect(cardSource.indexOf('<DailyPermitManualReviewBadge')).toBeLessThan(
      cardSource.indexOf('{canToggleDetails ? ('),
    );
  });

  it('uses page-based manual review copy instead of waiting for Bitable or AI backfill', () => {
    const blockingMessageSource = source.slice(
      source.indexOf('function getDailyPermitBlockingMessage'),
      source.indexOf('function CompletionChecklistEditor'),
    );

    expect(dailyPermitSource).not.toContain('等待审核回填');
    expect(dailyPermitSource).not.toContain('请在多维表回填审核结果');
    expect(dailyPermitSource).not.toContain('AI审核结果已保留可查看');
    expect(blockingMessageSource).not.toContain('审核回填');
    expect(blockingMessageSource).toContain('提交人工审核');
  });

  it('wires manual review controls to update Bitable decisions and refresh latest data', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const cardSource = source.slice(
      source.indexOf('function DailyPermitVerificationCard'),
      source.indexOf('function DailyPermitManualReviewBadge'),
    );
    const badgeSource = source.slice(
      source.indexOf('function DailyPermitManualReviewBadge'),
      source.indexOf('function DailyPermitAuditDetailPanel'),
    );

    expect(pageSource).toContain('handlePermitManualReviewRequest');
    expect(pageSource).toContain('updateConstructionPermitManualReview');
    expect(pageSource).toContain(
      'followupRecordId || verification.sourceFollowupRecordId',
    );
    expect(pageSource).toContain('permitFileTokens:');
    expect(pageSource).toContain('permitFingerprint:');
    expect(pageSource).toContain('sourceFeedback:');
    expect(pageSource).toContain('loadData(true)');
    expect(pageSource).toContain(
      'onRequestManualReview={handlePermitManualReviewRequest}',
    );
    expect(cardSource).toContain('followupRecordId=');
    expect(cardSource).toContain(
      'onRequestManualReview={onRequestManualReview}',
    );
    expect(badgeSource).toContain('<DropdownMenu');
    expect(badgeSource).toContain('<DropdownMenuTrigger');
    expect(badgeSource).toContain('<DropdownMenuItem');
    expect(badgeSource).toContain('标记通过');
    expect(badgeSource).toContain('标记驳回');
    expect(badgeSource).toContain("handleDecision('passed')");
    expect(badgeSource).toContain("handleDecision('rejected')");
    expect(badgeSource).toContain('Loader2');
  });

  it('requires a human validity date when passing a permit and retains a newly uploaded permit', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleGeneratedOnlineFormSubmit'),
    );
    const badgeSource = source.slice(
      source.indexOf('function DailyPermitManualReviewBadge'),
      source.indexOf('function DailyPermitAuditDetailPanel'),
    );

    expect(submitSource.replace(/\s+/g, ' ')).toContain(
      'options.keepDialogOpen ? filesToRetainAfterPermitUpload : {}',
    );
    expect(badgeSource).toContain('manualValidUntil');
    expect(badgeSource).toContain('作业票有效期开始');
    expect(badgeSource).toContain('作业票有效期结束');
    expect(badgeSource).toContain('type="date"');
  });

  it('queues manual review choices and submits them in one parallel sync', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const permitBadgeSource = source.slice(
      source.indexOf('function DailyPermitManualReviewBadge'),
      source.indexOf('function DailyPermitAuditDetailPanel'),
    );
    const isolationActionSource = source.slice(
      source.indexOf('function DailyIsolationPhotoAuditAction'),
      source.indexOf('function getDailyIsolationPhotoAuditStatus'),
    );

    expect(pageSource).toContain('pendingManualReviews');
    expect(pageSource).toContain('handleSubmitPendingManualReviews');
    expect(pageSource).toContain('Promise.allSettled(');
    expect(pageSource).toContain('manualReviewSyncingIdsRef');
    expect(pageSource).toContain('settleScopedManualReviewBatch(');
    expect(pageSource).toContain('updateConstructionPermitManualReview({');
    expect(pageSource).toContain(
      'updateConstructionIsolationPhotoManualReview({',
    );
    expect(dialogSource).toContain('ManualReviewBatchSubmitBar');
    expect(dialogSource).toContain('pendingManualReviewCount');
    expect(permitBadgeSource).toContain('pendingDecision');
    expect(permitBadgeSource).toContain('先暂存，点击提交人工审核后同步多维表');
    expect(isolationActionSource).toContain('pendingDecision');
    expect(isolationActionSource).toContain(
      '先暂存，点击提交人工审核后同步多维表',
    );
  });

  it('settles permit review submissions without a forced confirmation read', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(pageSource).toContain('followupSubmitInFlightRef');
    expect(pageSource).not.toContain('getManualReviewSyncConfirmationError');
    expect(submitSource).toContain('followupSubmitInFlightRef.current');
    expect(submitSource).toContain('setSubmitting(true)');
    expect(submitSource).toContain('setSubmitting(false)');
    expect(submitSource).toContain(
      'submitPendingManualReviewBatchInBackground(',
    );
    expect(source).toContain('人工审核结果未生效');
    expect(dialogSource).toContain(
      'const submitPending = submitting || manualReviewRefreshing',
    );
    expect(dialogSource).toContain('disabled={submitPending}');
    expect(dialogSource).toContain('正在提交作业票校核');
  });

  it('syncs queued manual reviews in the background after submitting daily prepare', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );

    expect(pageSource).toContain('submitPendingManualReviewBatchInBackground');
    expect(pageSource).toContain('confirmScopedManualReviewBatch');
    expect(submitSource).toContain('const reviewsToSync =');
    expect(submitSource).toContain(
      'submitPendingManualReviewBatchInBackground(reviewsToSync',
    );
    expect(submitSource).toContain('announce: false');
    expect(submitSource).not.toContain(
      'await submitPendingManualReviewBatchInBackground(',
    );
  });

  it('generates online form Word documents and backfills them to the latest today follow-up', () => {
    const submitSource = source.slice(
      source.indexOf('const handleGeneratedOnlineFormSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(submitSource).toContain('getTodayDailyFollowup(');
    expect(submitSource).toContain('new Date()');
    expect(submitSource).toContain('retainedAttachmentTokens');
    expect(submitSource).toContain(
      'buildGeneratedOnlineFormRetainedAttachmentTokenPayload(',
    );
    expect(submitSource).toContain('const generatedWorkApplication =');
    expect(submitSource).toContain(
      "generatedWorkApplication ? 'daily' : 'supplemental'",
    );
    expect(submitSource).toContain(
      "appendOptionalField(formData, 'dailyFollowupStage', 'prepare')",
    );
    expect(submitSource).toContain(
      "appendOptionalField(formData, 'permitOnlyUpload', 'true')",
    );
    expect(submitSource).not.toContain('已触发AI审核和有效期刷新');
    expect(submitSource).toContain(
      'loadData({ background: true, forceRefresh: false })',
    );
    expect(submitSource).not.toContain('loadData(true)');
    expect(submitSource).toContain('formData.append(fieldKey, file)');
    expect(submitSource).toContain('createConstructionFollowup(formData)');
    expect(source).toContain('function isGeneratedOnlineWorkApplicationField');
    expect(source).toContain("fieldKey === 'applicationFiles'");
    expect(source).toContain(
      'function getLatestGeneratedWorkApplicationFollowup',
    );
    expect(source).toContain('function hasGeneratedWorkApplicationAttachment');
    expect(dialogSource).toContain('latestGeneratedApplicationFollowup');
    expect(dialogSource).toContain(
      'applicationFiles: latestGeneratedApplicationFiles',
    );
    expect(source).toContain('getGeneratedOnlineFormAttachmentRemovalFiles(');
    expect(dialogSource).toContain('onGeneratedFileSubmit(fieldKey, file)');
    expect(onlineFormSource).toContain('function createWordDocumentHtml');
    expect(onlineFormSource).toContain("type: 'application/msword'");
    expect(onlineFormSource).toContain('${sanitizeFileName(target.label)}.doc');
    expect(onlineFormSource).not.toContain('-在线填表.doc');
    expect(onlineFormSource).toContain(
      'xmlns:w="urn:schemas-microsoft-com:office:word"',
    );
    expect(onlineFormSource).not.toContain("type: 'application/pdf'");
    expect(onlineFormSource).not.toContain('在线填表.pdf');
    expect(onlineFormSource).not.toContain('html2canvas');
    expect(onlineFormSource).not.toContain('jsPDF');
    expect(onlineFormSource).not.toContain("type: 'text/html");
  });

  it('adds an online form entry for the entry training sign-in sheet', () => {
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(dialogSource).toContain('openEntryTrainingSignInOnlineForm');
    expect(dialogSource).toContain("'entryTrainingSignInFiles'");
    expect(dialogSource).toContain("'入场培训签到表'");
    expect(dialogSource).toContain('createOnlineWorkFormPeopleFromCrewMembers');
    expect(dialogSource).toContain('施工作业安全管理相关内容');
    expect(onlineFormSource).toContain('function renderTrainingSignInHtml');
    expect(onlineFormSource).toContain('<h1>培训签到表</h1>');
    expect(onlineFormSource).toContain('<th>签到</th>');
    expect(dialogSource).not.toContain(
      'company: person.company || selectedConstruction?.contractorType',
    );
    expect(dialogSource).not.toContain(
      'company: person.company || construction?.contractorType',
    );
    expect(onlineFormSource).not.toContain(
      'left?.company || values.contractor',
    );
    expect(onlineFormSource).not.toContain(
      'right?.company || values.contractor',
    );
    expect(onlineFormSource).not.toContain(
      'company: existingPerson?.company || member.company',
    );
    expect(onlineFormModelSource).toContain("company: member.company || ''");
    expect(onlineFormSource).toContain('未关联台账单位');
  });

  it('keeps the work application Word layout close to the source template', () => {
    const workApplicationTemplateSource = onlineFormSource.slice(
      onlineFormSource.indexOf('function renderWorkApplicationHtml'),
      onlineFormSource.indexOf('function renderKindRows'),
    );
    const peopleBlockSource = onlineFormSource.slice(
      onlineFormSource.indexOf('function renderWorkApplicationPeopleBlock'),
      onlineFormSource.indexOf('function renderInlineBlank'),
    );

    expect(workApplicationTemplateSource).toContain(
      'renderWorkApplicationPeopleBlock(draft.people)',
    );
    expect(workApplicationTemplateSource).toContain(
      '作业人员身份证号及资质证书（可另贴附件）：',
    );
    expect(workApplicationTemplateSource).toContain(
      '作业地点：${renderInlineBlank(values.park',
    );
    expect(workApplicationTemplateSource).toContain(
      '园区${renderInlineBlank(values.building',
    );
    expect(workApplicationTemplateSource).toContain(
      '楼栋${renderInlineBlank(values.floor',
    );
    expect(workApplicationTemplateSource).toContain(
      '楼层${renderInlineBlank(values.roomArea',
    );
    expect(workApplicationTemplateSource).not.toContain(
      'border-bottom: 1px solid #000',
    );
    expect(workApplicationTemplateSource).toContain(
      '<td colspan="2" class="approval-cell" style="width:33.33%">作业现场负责人：${escapeHtml(values.siteOwner)}</td>',
    );
    expect(workApplicationTemplateSource).toContain(
      '<td colspan="2" class="approval-cell" style="width:33.34%">意见：${escapeHtml(values.siteOwnerOpinion)}</td>',
    );
    expect(workApplicationTemplateSource).toContain(
      '<td colspan="2" class="approval-cell" style="width:33.33%">审核人：${escapeHtml(values.ehsReviewer)}</td>',
    );
    expect(workApplicationTemplateSource).toContain(
      '<td colspan="2" class="approval-cell" style="width:33.33%">一级审批：${escapeHtml(values.levelOneApprover)}</td>',
    );
    expect(workApplicationTemplateSource).not.toContain(
      '<tr><td class="label">意见</td><td colspan="5" class="block">${escapeHtml(values.siteOwnerOpinion)}</td></tr>',
    );
    expect(workApplicationTemplateSource).not.toContain(
      '审核人：合作伙伴EHS工程师',
    );
    expect(workApplicationTemplateSource).not.toContain(
      '一级审批：FM/IM驻场主管',
    );
    expect(onlineFormModelSource).toContain("ehsReviewer: ''");
    expect(onlineFormModelSource).toContain("levelOneApprover: ''");
    expect(workApplicationTemplateSource).toContain('.people-field');
    expect(onlineFormSource).toContain('class="people-field people-id"');
    expect(onlineFormSource).toContain('class="people-field people-cert"');
    expect(peopleBlockSource).not.toContain(
      '身份证号：${escapeHtml(person.idCard)}',
    );
    expect(peopleBlockSource).not.toContain(
      '资质证书：${escapeHtml(person.role)}',
    );
    expect(peopleBlockSource).toContain(
      '<span class="people-field people-id">${escapeHtml(person.idCard)}</span>',
    );
    expect(peopleBlockSource).toContain(
      '<span class="people-field people-cert">${escapeHtml(person.role)}</span>',
    );
    expect(
      (workApplicationTemplateSource.match(/作业内容描述/g) || []).length,
    ).toBe(1);
    expect(
      (workApplicationTemplateSource.match(/材料堆放点/g) || []).length,
    ).toBe(1);
    expect(workApplicationTemplateSource).not.toContain(
      '<thead><tr><th style="width:52px">序号</th><th>姓名</th><th>身份证号</th><th>资质证书</th><th>签字</th></tr></thead>',
    );
  });

  it('opens a handwriting dialog for online form person signatures', () => {
    const peopleEditorSource = onlineFormSource.slice(
      onlineFormSource.indexOf('function PeopleEditor'),
      onlineFormSource.indexOf('function SignaturePad'),
    );

    expect(peopleEditorSource).toContain('setSignaturePerson(person)');
    expect(peopleEditorSource).toContain('<PersonSignatureDialog');
    expect(peopleEditorSource).toContain('保存签名');
    expect(peopleEditorSource).toContain('isSignatureImage(person.signature)');
    expect(onlineFormSource).toContain('function renderPersonSignatureHtml');
    expect(onlineFormSource).toContain('class="person-signature"');
  });

  it('retains a newly uploaded permit without waiting for background attachment sync', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );
    const normalizedSubmitSource = submitSource.replace(/\s+/g, ' ');
    const cleanupStart = normalizedSubmitSource.indexOf(
      'setFollowupFiles( options.keepDialogOpen ? filesToRetainAfterPermitUpload : {}, );',
    );
    const enqueueStart = normalizedSubmitSource.indexOf(
      'const mutationRequest = constructionMutationCoordinator.enqueue(',
      cleanupStart,
    );

    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(enqueueStart).toBeGreaterThan(cleanupStart);
    expect(submitSource).toContain('页面已更新，多维表同步中');
    expect(submitSource).toMatch(
      /result\.attachmentSyncPending\s*\|\|\s*hasSubmittedFollowupFiles/,
    );
    expect(normalizedSubmitSource).toContain(
      'void monitorAcceptedFollowupMutation({',
    );
    expect(submitSource).not.toContain('await loadData(true)');
  });

  it('uses locally submitted follow-up files to show background attachment sync feedback', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );
    expect(submitSource).toContain('const submittedFollowupFileBuckets =');
    expect(submitSource).toContain('const hasSubmittedFollowupFiles =');
    expect(submitSource).toMatch(
      /result\.attachmentSyncPending\s*\|\|\s*hasSubmittedFollowupFiles/,
    );
    expect(submitSource).toContain('多维表主记录已同步，附件后台处理中');
    expect(submitSource).not.toContain('const followupSuccessMessage =');
  });

  it('uses the generated daily personnel checklist attachment for daily progress status', () => {
    const projectChecklistSource = source.slice(
      source.indexOf('function getProjectDailyProgressChecklist'),
      source.indexOf('function getProjectLifecycleSteps'),
    );
    const stageProgressSource = source.slice(
      source.indexOf('function getDailyFollowupStageProgress'),
      source.indexOf('function isInitialApplicationFollowup'),
    );
    const normalizedChecklistSource = projectChecklistSource.replace(
      /\s+/g,
      '',
    );
    const normalizedStageProgressSource = stageProgressSource.replace(
      /\s+/g,
      '',
    );

    expect(normalizedChecklistSource).toContain(
      "hasDailyPersonnelChecklist:hasAttachment(followup.attachments,'每日人员核查清单',)",
    );
    expect(normalizedStageProgressSource).toContain(
      "hasDailyPersonnelChecklist:hasAttachment(followup.attachments,'每日人员核查清单',)",
    );
  });

  it('disables the completion checklist until the overall completion status is selected', () => {
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function CompletionChecklistEditor'),
    );
    const editorSource = source.slice(
      source.indexOf('function CompletionChecklistEditor'),
      source.indexOf('function CrewCheckList'),
    );

    expect(dialogSource).toMatch(
      /form\.completed\s*\?\s*getCompletionChecklistItemsForStatus\(form\.completed\)\s*:\s*\[\]/,
    );
    expect(dialogSource).toContain('disabled={!form.completed}');
    expect(dialogSource).toContain(
      "mode={form.completed === '是' ? 'full' : 'daily'}",
    );
    expect(editorSource).toContain('项目收尾检查清单');
    expect(editorSource).toContain('每日完工检查清单');
    expect(editorSource).toContain('请先选择项目是否整体全部完成');
    expect(editorSource).toContain('disabled={disabled}');
    expect(editorSource).toContain('disabled &&');
  });

  it('keeps follow-up and completion checklist headers free of explanatory copy', () => {
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function CompletionChecklistEditor'),
    );
    const dialogHeaderStart = dialogSource.indexOf('<DialogHeader');
    const dialogHeaderSource = dialogSource.slice(
      dialogHeaderStart,
      dialogSource.indexOf('</DialogHeader>', dialogHeaderStart),
    );
    const editorHeaderSource = source.slice(
      source.indexOf('function CompletionChecklistEditor'),
      source.indexOf('<div className="max-h-[360px]'),
    );

    expect(dialogHeaderSource).not.toContain('<DialogDescription>');
    expect(dialogHeaderSource).not.toContain('每日跟进按准备');
    expect(dialogHeaderSource).not.toContain('用于首次提交申请单');
    expect(editorHeaderSource).not.toContain('const description =');
    expect(editorHeaderSource).not.toContain('提交后生成');
  });

  it('adds a refresh icon control for syncing latest permit data from Bitable', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyPermitVerificationCard'),
    );
    const cardSource = source.slice(
      source.indexOf('function DailyPermitVerificationCard'),
      source.indexOf('function DailyPermitManualReviewBadge'),
    );

    expect(pageSource).toContain('handleRefreshConstructionBitableData');
    expect(pageSource).toContain('onRefreshPermitData=');
    expect(dialogSource).toContain('onRefreshPermitData={onRefreshPermitData}');
    expect(cardSource).toContain('RefreshCw');
    expect(cardSource).toContain('同步多维表最新作业票数据');
    expect(cardSource).toContain('onRefreshPermitData?.()');
  });

  it('adds a project daily progress refresh icon that syncs latest Bitable followups', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const cardUsageSource = source.slice(
      source.indexOf('<MemoizedConstructionCard'),
      source.indexOf('<ApplicationDialog'),
    );
    const constructionCardSource = source.slice(
      source.indexOf('function ConstructionCard'),
      source.indexOf('function ProjectKanbanDetail'),
    );
    const kanbanSource = source.slice(
      source.indexOf('function ProjectKanbanDetail'),
      source.indexOf('function DailyChecklistActionRow'),
    );

    expect(pageSource).toContain('handleRefreshDailyProgress');
    expect(cardUsageSource).toContain(
      'onRefreshDailyProgress={handleRefreshDailyProgress}',
    );
    expect(constructionCardSource).toContain('onRefreshDailyProgress');
    expect(kanbanSource).toContain('同步多维表今日跟进最新内容');
    expect(kanbanSource).toContain('onRefreshDailyProgress?.()');
    expect(kanbanSource).toContain('RefreshCw');
  });

  it('loads cached construction data first without an automatic forced refresh', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const initialLoadEffectSource = pageSource.slice(
      pageSource.indexOf('useEffect(() => {\n    void loadData(false).catch'),
      pageSource.indexOf('  const updateScopedPendingManualReviews'),
    );

    expect(initialLoadEffectSource).toContain(
      'void loadData(false).catch((err) =>',
    );
    expect(initialLoadEffectSource).not.toContain('loadData(true)');
    expect(initialLoadEffectSource).not.toContain('.then(');
  });

  it('applies daily follow-up changes immediately and reconciles them with the latest background read', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const loadSource = pageSource.slice(
      pageSource.indexOf('const loadData'),
      pageSource.indexOf('  useEffect(() => {\n    void loadData(false).catch'),
    );
    const submitSource = pageSource.slice(
      pageSource.indexOf('const handleFollowupSubmit'),
      pageSource.indexOf('const handleGeneratedOnlineFormSubmit'),
    );
    const optimisticApplyIndex = submitSource.indexOf(
      'applyOptimisticFollowupPatch',
    );
    const remoteCreateIndex = submitSource.indexOf(
      'createConstructionFollowup(formData)',
    );

    expect(source).toContain("from './optimistic-crud';");
    expect(source).toContain("from './mutation-coordinator';");
    expect(pageSource).toContain('const dataRef = useRef');
    expect(pageSource).toContain('const authoritativeConstructionDataRef =');
    expect(pageSource).toContain('const inFlightMutationKeysRef = useRef');
    expect(pageSource).toContain(
      'const optimisticConfirmationTimersRef = useRef',
    );
    expect(pageSource).toContain('const mountedRef = useRef');
    expect(pageSource).toContain('createConstructionMutationCoordinator');
    expect(pageSource).toContain('createLatestConstructionRequestCoordinator');
    expect(pageSource).toContain('const updateConstructionData = useCallback');
    expect(loadSource).toContain(
      'latestConstructionRequestCoordinatorRef.current.run',
    );
    expect(loadSource).toContain(
      'constructionMutationCoordinatorRef.current.reconcile(result)',
    );
    expect(loadSource).toContain(
      'authoritativeConstructionDataRef.current = result',
    );
    expect(optimisticApplyIndex).toBeGreaterThanOrEqual(0);
    expect(remoteCreateIndex).toBeGreaterThan(optimisticApplyIndex);
    expect(submitSource).toContain('captureFollowupFieldSnapshot');
    expect(pageSource).toContain(
      'rebaseConstructionDataAfterOptimisticFailure',
    );
    expect(submitSource).toContain(
      'rebaseVisibleConstructionData(optimisticSnapshot)',
    );
    expect(submitSource).toContain('let requestAccepted = false');
    expect(submitSource).toContain('if (!requestAccepted)');
    expect(submitSource).toContain(
      'inFlightMutationKeysRef.current.add(mutationKey)',
    );
    expect(submitSource).toContain(
      'inFlightMutationKeysRef.current.delete(mutationKey)',
    );
    expect(submitSource).toContain(
      'const overlayKey = `${mutationKey}:${clientMutationId}`',
    );
    expect(source).toContain(
      'const OPTIMISTIC_CONFIRMATION_TIMEOUT_MS = 120_000',
    );
    expect(submitSource).toContain('setFollowupOpen(false)');
    expect(submitSource).toContain('setDailyChecklistFocus(null)');
    expect(submitSource).toContain('页面已更新，多维表同步中');
    expect(submitSource).toContain('已恢复本次草稿');
    expect(submitSource).toContain('草稿已保留，未覆盖当前弹窗');
    expect(submitSource.replace(/\s+/g, ' ')).toContain(
      'constructionMutationCoordinator.enqueue( dailyMutationScopeKey,',
    );
    expect(submitSource).toContain("formData.append('clientMutationId'");
    expect(submitSource).toContain('const localDailyFollowupRecordId =');
    expect(submitSource).toContain(
      "optimisticDailySubmit ? '' : localDailyFollowupRecordId",
    );
    expect(submitSource).toContain(
      "formData.set('followupRecordId', serverFollowupRecordId)",
    );
    expect(submitSource).toContain("formData.delete('followupRecordId')");
    expect(submitSource).toContain('constructionRecordAliasRegistry.resolve(');
    expect(
      submitSource.indexOf('constructionRecordAliasRegistry.resolve('),
    ).toBeLessThan(remoteCreateIndex);
    const normalizedSubmitSource = submitSource.replace(/\s+/g, ' ');
    expect(normalizedSubmitSource).toContain(
      'followupRecordId: acceptedRecordId || optimisticPatch.followupRecordId,',
    );
    const aliasRememberIndex = normalizedSubmitSource.indexOf(
      'constructionRecordAliasRegistry.remember( dailyMutationScopeKey, result.recordId,',
    );
    const cacheWriteIndex = normalizedSubmitSource.indexOf(
      'writeDailyFollowupFormCache(',
      aliasRememberIndex,
    );
    expect(aliasRememberIndex).toBeGreaterThanOrEqual(0);
    expect(cacheWriteIndex).toBeGreaterThan(aliasRememberIndex);
    expect(normalizedSubmitSource).toContain(
      'void loadData({ background: true, forceRefresh: false, }).catch',
    );
    expect(submitSource).not.toContain('void loadData(true)');
  });

  it('does not let a background read cancel an in-flight forced refresh', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const loadSource = pageSource.slice(
      pageSource.indexOf('const loadData'),
      pageSource.indexOf('  useEffect(() => {\n    void loadData(false).catch'),
    );

    expect(pageSource).toContain(
      'const forceRefreshInFlightRef = useRef(false)',
    );
    expect(loadSource).toContain(
      'if (background && forceRefreshInFlightRef.current)',
    );
    expect(loadSource).toContain('forceRefreshInFlightRef.current = true');
    expect(loadSource).toContain('forceRefreshInFlightRef.current = false');
    expect(pageSource).toContain(
      'latestConstructionRequestCoordinatorRef.current.invalidate()',
    );
    expect(pageSource).toContain(
      'optimisticConfirmationTimersRef.current.forEach',
    );
  });

  it('opens project daily progress cards with a today-only detail view', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const constructionCardSource = source.slice(
      source.indexOf('function ConstructionCard'),
      source.indexOf('function ProjectKanbanDetail'),
    );
    const kanbanSource = source.slice(
      source.indexOf('function ProjectKanbanDetail'),
      source.indexOf('function DailyChecklistActionRow'),
    );
    const dialogSource = source.slice(
      source.indexOf('function ConstructionDetailDialog'),
      source.indexOf('function ProjectDetailSummaryCards'),
    );
    const traceSource = source.slice(
      source.indexOf('function ConstructionTraceDetailPanel'),
      source.indexOf('function StageDetailHeader'),
    );
    const helperSource = source.slice(
      source.indexOf('function getLatestRelatedFollowup'),
      source.indexOf('function getAttachmentLabelCandidates'),
    );

    expect(pageSource).toContain('setSelectedDetailDailyOnly');
    expect(pageSource).toContain(
      'openConstructionDetail(item, lifecycleStageKey, Boolean(dailyStageKey))',
    );
    expect(constructionCardSource).toContain('dailyOnly');
    expect(kanbanSource).toContain('onOpenStageDetail(stage.key, true)');
    expect(dialogSource).toContain('initialDailyOnly');
    expect(dialogSource).toContain('isDailyStageDetail');
    expect(traceSource).toContain('今日暂无该阶段跟进记录');
    expect(helperSource).toContain('getTodayConstructionFollowups');
    expect(helperSource).toContain('dailyOnly');
  });

  it('adds a daily work type audit module that drives permit verification', () => {
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyPermitVerificationCard'),
    );
    const pageSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );

    expect(dialogSource).toContain('DailyWorkTypeAuditPanel');
    expect(dialogSource).toContain('核对施工类型');
    expect(dialogSource).toContain('关联作业票核对');
    expect(dialogSource.replace(/\s+/g, '')).toMatch(
      /getDailyPermitVerifications\(selectedConstruction,dailyPermitReferenceDate,dailyPermitWorkTypes,constructionAiAuditEnabled,?\)/,
    );
    expect(pageSource.replace(/\s+/g, '')).toMatch(
      /getDailyPermitVerifications\(selectedConstruction,dailyPermitReferenceDate,dailyWorkTypes,constructionAiAuditEnabled,?\)/,
    );
    expect(pageSource).toContain('JSON.stringify(dailyWorkTypes)');
    expect(pageSource).not.toContain(
      'selectedConstruction?.workTypes || followupForm.workTypes',
    );
  });

  it('submits the current follow-up date with daily follow-up records', () => {
    const pageSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );

    expect(pageSource).toContain('appendOptionalField(');
    expect(pageSource).toContain("'followupDate'");
    expect(pageSource).toContain(
      'formatDateForBitableDate(dailyPermitReferenceDate)',
    );
  });

  it('adds isolation photo audit status and refresh control beside the upload field', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyPermitVerificationCard'),
    );
    const fileGridSource = source.slice(
      source.indexOf('function FileGrid'),
      source.indexOf('function FilePickerField'),
    );

    expect(dialogSource).toContain('onRefreshIsolationAuditData');
    expect(dialogSource).toContain('DailyIsolationPhotoAuditAction');
    expect(dialogSource).toContain('isolationPhotoFiles');
    expect(dialogSource).toContain('挂牌审核状态');
    expect(dialogSource).toContain('同步多维表挂牌审核状态');
    expect(dialogSource).toContain('onRequestIsolationManualReview');
    expect(pageSource).toContain('handleIsolationPhotoManualReviewRequest');
    expect(pageSource).toContain(
      'updateConstructionIsolationPhotoManualReview',
    );
    expect(pageSource).toContain('已同步多维表挂牌审核状态');
    expect(fileGridSource).toContain('fieldActions');
    expect(fileGridSource).toContain('onUploadedFileRemove');
  });

  it('lets isolation photo audit status choose pass or reject decisions', () => {
    const actionSource = source.slice(
      source.indexOf('function DailyIsolationPhotoAuditAction'),
      source.indexOf('function getDailyIsolationPhotoAuditStatus'),
    );

    expect(actionSource).toContain('<DropdownMenu');
    expect(actionSource).toContain('<DropdownMenuTrigger');
    expect(actionSource).toContain('<DropdownMenuItem');
    expect(actionSource).toContain('标记通过');
    expect(actionSource).toContain('标记驳回');
    expect(actionSource).toContain("handleDecision('passed')");
    expect(actionSource).toContain("handleDecision('rejected')");
  });

  it('shows isolation AI audit details before manual review decisions', () => {
    const actionSource = source.slice(
      source.indexOf('function DailyIsolationPhotoAuditAction'),
      source.indexOf('function getDailyIsolationPhotoAuditStatus'),
    );

    expect(actionSource).toContain('summary.details.map');
    expect(actionSource).toContain('summary.rawText');
    expect(actionSource).toContain('AI审核提炼');
    expect(actionSource).toContain('AI原始结论');
  });

  it('uses today work types and manual isolation review state in the daily checklist', () => {
    const checklistSource = source.slice(
      source.indexOf('function getProjectDailyProgressChecklist'),
      source.indexOf('function ApprovalFlowMiniTimeline'),
    );
    const manualStatusSource = source.slice(
      source.indexOf('function getDailyIsolationManualReviewStatus'),
      source.indexOf('function isIsolationManualReviewPassed'),
    );

    expect(checklistSource).toContain('getConfirmedTodayDailyWorkTypes');
    expect(checklistSource).toContain("label: '作业票校核'");
    expect(checklistSource).toContain("actionKind: 'permit'");
    expect(checklistSource).toContain("stage: 'prepare'");
    expect(checklistSource).toContain('getDailyIsolationManualReviewStatus');
    expect(checklistSource).toContain('isIsolationManualReviewPassed');
    expect(checklistSource).toContain('isolationManualReviewIssue');
    expect(manualStatusSource).toContain('true');
    expect(manualStatusSource).toContain('false');
  });

  it('orders daily work type confirmation before personnel', () => {
    const checklistSource = source.slice(
      source.indexOf('function getProjectDailyProgressChecklist'),
      source.indexOf('function ApprovalFlowMiniTimeline'),
    );
    const actionKinds = Array.from(
      checklistSource.matchAll(/actionKind:\s*'([^']+)'/g),
      (match) => match[1],
    );
    const workTypeActionIndex = checklistSource.indexOf(
      "actionKind: 'workType'",
    );
    const personnelActionIndex = checklistSource.indexOf(
      "actionKind: 'personnel'",
    );

    expect(actionKinds.slice(0, 2)).toEqual(['workType', 'personnel']);
    expect(workTypeActionIndex).toBeGreaterThan(-1);
    expect(workTypeActionIndex).toBeLessThan(personnelActionIndex);
    expect(checklistSource.slice(0, personnelActionIndex)).toMatch(
      /label:\s*'(?:当天)?作业类型校核'[\s\S]*actionKind:\s*'workType'/,
    );
  });

  it('disables personnel until todays work type is confirmed', () => {
    const checklistSource = source.slice(
      source.indexOf('function getProjectDailyProgressChecklist'),
      source.indexOf('function ApprovalFlowMiniTimeline'),
    );
    const personnelActionIndex = checklistSource.indexOf(
      "actionKind: 'personnel'",
    );
    const personnelItemStart = checklistSource.lastIndexOf(
      '{',
      personnelActionIndex,
    );
    const personnelItemEnd = checklistSource.indexOf(
      '    },',
      personnelActionIndex,
    );
    const personnelItemSource = checklistSource.slice(
      personnelItemStart,
      personnelItemEnd,
    );

    expect(personnelItemSource).toMatch(
      /disabled:\s*[^,\n]*(?:workType|WorkType)/,
    );
  });

  it('merges material submission and EHS confirmation into one approval material step', () => {
    const flowSource = source.slice(
      source.indexOf('function getApprovalFlowSteps'),
      source.indexOf('function getApprovalFlowProgress'),
    );
    const detailRowsSource = source.slice(
      source.indexOf("label: '审批进度'"),
      source.indexOf("label: '申请与许可材料'"),
    );

    expect(flowSource).toContain("title: '审批材料提交'");
    expect(flowSource).toContain('getApprovalMaterialSubmissionState');
    expect(flowSource).toContain('materialSubmission.passed && depositReady');
    expect(flowSource).not.toContain('approval.credential');
    expect(flowSource).not.toContain('approval.ehs');
    expect(flowSource).not.toContain("title: '材料提交确认'");
    expect(flowSource).not.toContain("title: 'EHS工程师确认'");
    expect(detailRowsSource).toContain("label: '审批材料提交'");
    expect(detailRowsSource).not.toContain("label: '材料提交确认'");
    expect(detailRowsSource).not.toContain("label: 'EHS工程师确认'");
  });

  it('refreshes bitable deposit status when clicking the deposit approval step', () => {
    const cardUsageSource = source.slice(
      source.indexOf('<MemoizedConstructionCard'),
      source.indexOf('<FollowupDialog'),
    );
    const refreshHandlerSource = source.slice(
      source.indexOf('const handleRefreshApprovalStatus'),
      source.indexOf('const handlePermitManualReviewRequest'),
    );
    const detailSource = source.slice(
      source.indexOf('function ProjectKanbanDetail'),
      source.indexOf('function ApprovalFlowMiniTimeline'),
    );
    const timelineSource = source.slice(
      source.indexOf('function ApprovalFlowMiniTimeline'),
      source.indexOf('function ProjectScheduleProgress'),
    );
    const flowSource = source.slice(
      source.indexOf('function getApprovalFlowSteps'),
      source.indexOf('function getApprovalFlowProgress'),
    );
    const syncStatusSource = source.slice(
      source.indexOf('function getParkSyncStatus'),
      source.indexOf('function isPassedStatusText'),
    );

    expect(cardUsageSource).toContain('onRefreshApprovalStatus');
    expect(cardUsageSource).toContain(
      'onRefreshApprovalStatus={handleRefreshApprovalStatus}',
    );
    expect(refreshHandlerSource).toContain('handleRefreshConstructionData');
    expect(refreshHandlerSource).toContain('已刷新质保金确认状态');
    expect(detailSource).toContain("step.title === '质保金确认'");
    expect(detailSource).toContain('onRefreshApprovalStatus?.()');
    expect(timelineSource).toContain('onStepClick?:');
    expect(timelineSource).toContain('onStepClick(step, index)');
    expect(flowSource).toContain("title: '同步机房经理'");
    expect(flowSource).not.toContain("title: '同步园区经理'");
    expect(syncStatusSource).not.toContain("return '已同步';");
    expect(syncStatusSource).toContain("return parkReady ? '待消息同步'");
  });

  it('does not show completed approval as the current card lifecycle stage', () => {
    const currentStageSource = source.slice(
      source.indexOf('function getCurrentStage'),
      source.indexOf('function getScheduleMeta'),
    );

    expect(currentStageSource).toContain('dailyStages');
    expect(currentStageSource).toContain("stage.key !== 'approval'");
  });

  it('renders preview links for uploaded follow-up files', () => {
    const filePickerSource = source.slice(
      source.indexOf('function FilePickerField'),
      source.indexOf('function getFilePickerFieldSummary'),
    );

    expect(filePickerSource).toContain('uploadedFiles.length > 0');
    expect(filePickerSource).toContain('getConstructionAttachmentPreviewUrl');
    expect(filePickerSource).toContain('预览');
    expect(filePickerSource).toContain('target="_blank"');
    expect(filePickerSource).toContain('<Eye');
  });

  it('does not append permit renewal upload fields to the daily follow-up form', () => {
    const stageFileFieldsSource = source.slice(
      source.indexOf('function getDailyFollowupStageFileFields'),
      source.indexOf('function getDailyFollowupStageRequiredFileKeys'),
    );

    expect(stageFileFieldsSource).not.toContain(
      'getDailyPermitRenewalFileFields',
    );
    expect(source).not.toContain('准备阶段必传续期材料');
  });

  it('stages selected permit files for one footer submission', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleRefreshConstructionBitableData'),
    );
    const permitSelectionSource = source.slice(
      source.indexOf('const handleDailyPermitUpload'),
      source.indexOf('const handleRefreshConstructionBitableData'),
    );
    const pickerSource = source.slice(
      source.indexOf('function pickDailyPermitFileBuckets'),
      source.indexOf('function pickSupplementalFileBuckets'),
    );

    expect(submitSource).toContain('permitUploadFileKey?: string;');
    expect(submitSource).toContain("dailyChecklistFocus === 'permit'");
    expect(submitSource).toContain('const partialDailySubmit =');
    expect(submitSource).toContain(
      'focusedDailySubmit && !permitFocusedSubmit',
    );
    expect(submitSource).toContain("'partialDailySubmit'");
    expect(submitSource).toContain("'dailyChecklistFocus'");
    expect(submitSource).toContain('activeDailyChecklistFocus');
    expect(submitSource).toContain(
      'options.permitOnlyUpload === true || permitFocusedSubmit',
    );
    expect(submitSource).toContain("activeDailyChecklistFocus === 'isolation'");
    expect(submitSource).toContain("item.kind === 'isolation'");
    expect(submitSource).toContain(
      'submitPendingManualReviewBatchInBackground(',
    );
    expect(submitSource).toContain("'isolation'");
    expect(submitSource).toContain(
      "pendingManualReviews.filter(\n          (item) => item.kind === 'permit'",
    );
    expect(submitSource).toContain(
      'buildRemovedAttachmentTokenPayloadForUploadedFields(',
    );
    expect(submitSource).toContain('mergeExistingFileTokenMaps(');
    expect(submitSource).toContain('retainedAttachmentRemovedTokens');
    expect(submitSource).toContain(
      'submittedFollowupFileBuckets,\n              retainedAttachmentRemovedTokens,',
    );
    expect(submitSource).toContain('options.permitUploadFileKey');
    expect(permitSelectionSource).toContain('setFollowupFiles(nextFiles)');
    expect(permitSelectionSource).toContain('已选择，请提交作业票校核');
    expect(permitSelectionSource).not.toContain('handleFollowupSubmit({');
    expect(source).toContain('function LocalSelectedPermitFilePreviewLink');
    expect(source).toContain('URL.createObjectURL(file)');
    expect(source).toContain('URL.revokeObjectURL(previewUrl)');
    expect(source).toContain(
      'const selectedPermitFiles = files[item.fileKey] || []',
    );
    expect(source).toContain('<LocalSelectedPermitFilePreviewLink');
    expect(pickerSource).toContain('selectedFileKey');
    expect(pickerSource).toContain('[selectedFileKey]');
  });

  it('treats unchanged focused daily follow-up content as a no-op instead of an error', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleRefreshConstructionBitableData'),
    );
    const focusedFormContentSource = source.slice(
      source.indexOf('function hasFocusedDailyFollowupFormContent'),
      source.indexOf('function hasFocusedDailyFollowupExistingContent'),
    );
    const focusedExistingContentSource = source.slice(
      source.indexOf('function hasFocusedDailyFollowupExistingContent'),
      source.indexOf('function getSupportedWorkTypes'),
    );

    expect(submitSource).toContain('hasFocusedDailyFollowupFormContent(');
    expect(submitSource).toContain('hasFocusedDailyFollowupExistingContent(');
    expect(submitSource).toContain(
      "toast.success('当前内容已是最新，无需重复提交')",
    );
    expect(submitSource).toContain(
      "toast.error('请填写或上传当前弹窗的跟进内容')",
    );
    expect(focusedFormContentSource).toContain("focus === 'isolation'");
    expect(focusedFormContentSource).toContain('return false;');
    expect(focusedExistingContentSource).toContain(
      'existingFiles.isolationPhotoFiles?.length',
    );
    expect(focusedExistingContentSource).toContain(
      'followup?.isolationFeedback',
    );
    expect(focusedExistingContentSource).toContain(
      'followup?.isolationCompliant',
    );
  });

  it('treats an already-valid permit check as a no-op without another upload', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleRefreshConstructionBitableData'),
    );

    expect(submitSource).toContain(
      "toast.success('当前作业票仍在有效期，无需重复提交')",
    );
    expect(submitSource).toContain(
      'permitVerifications.every((item) => !item.blocksProcess)',
    );
  });

  it('uses a stable semantic overlay key until background confirmation settles', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleGeneratedOnlineFormSubmit'),
    );
    const dailyOptimisticSource = submitSource.slice(
      submitSource.indexOf('if (optimisticDailySubmit)'),
      submitSource.indexOf("throw new Error('不支持的施工跟进提交模式')"),
    );

    expect(dailyOptimisticSource).toContain('const overlayKey = mutationKey;');
    expect(dailyOptimisticSource).not.toContain(
      'const overlayKey = `${mutationKey}:${clientMutationId}`;',
    );
  });

  it('allows a valid permit status pill to open AI audit details', () => {
    const cardSource = source.slice(
      source.indexOf('function DailyPermitVerificationCard'),
      source.indexOf('function DailyPermitManualReviewBadge'),
    );

    expect(cardSource).toContain('Boolean(auditDetails || invalidDetails)');
    expect(cardSource).not.toContain("itemTone !== 'valid' && Boolean");
  });

  it('uses the concise daily permit audit title', () => {
    const cardSource = source.slice(
      source.indexOf('function DailyPermitVerificationCard'),
      source.indexOf('function DailyPermitManualReviewBadge'),
    );

    expect(cardSource).toContain('<span>作业票审核</span>');
    expect(cardSource).not.toContain('作业票有效期核验');
  });

  it('opens daily follow-up from every daily checklist row', () => {
    const rowSource = source.slice(
      source.indexOf('function DailyChecklistActionRow'),
      source.indexOf('function IsolationAuditReviewDialog'),
    );

    expect(rowSource).toContain(
      'onOpenDailyFollowup(check.stage, check.actionKind)',
    );
    expect(rowSource).not.toContain(
      'return <div className={className}>{content}</div>',
    );
    expect(rowSource).not.toContain('onOpenAuditDetails();');
    expect(rowSource.replace(/\s+/g, ' ')).toMatch(
      /const actionable = (?:!disabled && isDailyChecklistActionable\(check\)|isDailyChecklistActionable\(check\) && !disabled);/,
    );
    expect(rowSource).toContain('disabled={!actionable}');
    expect(rowSource).toContain('if (!actionable) return;');
  });

  it('focuses daily checklist popups to the selected checklist content', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const helperSource = source.slice(
      source.indexOf('function getDailyFollowupFileFieldsForFocus'),
      source.indexOf('function getDailySpecialWorkTypeMaterialFileKeys'),
    );

    expect(pageSource).toContain(
      'const [dailyChecklistFocus, setDailyChecklistFocus]',
    );
    expect(pageSource).toContain('setDailyChecklistFocus(actionKind)');
    expect(dialogSource).toContain('dailyChecklistFocus');
    expect(dialogSource).toContain('showDailyPersonnelCheck');
    expect(dialogSource).toContain('showDailyFollowupStaff');
    expect(dialogSource).toContain('showDailyPermitVerification');
    expect(dialogSource).toContain('showDailyIsolationAuditNotice');
    expect(dialogSource).toContain("activeDailyChecklistFocus === 'personnel'");
    expect(dialogSource).toContain(
      "activeDailyChecklistFocus === 'closePhoto'",
    );
    expect(dialogSource).toContain('focusedDailyFileFields.length > 0');
    expect(helperSource).toContain("focus === 'personnel'");
    expect(helperSource).toContain("focus === 'permit'");
    expect(helperSource).toContain(
      "focus === 'closeChecklist' || focus === 'closePhoto'",
    );
    expect(source).toContain("return '收尾清单和照片'");
    expect(source).toContain('shouldSubmitDailyFollowupStaff');
    expect(source).toContain('getDailyChecklistFocusDialogTitle');
  });

  it('opens work type focus as a work type audit instead of a permit-only submission', () => {
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const workTypeVisibilitySource = dialogSource.slice(
      dialogSource.indexOf('const showDailyWorkTypeAudit'),
      dialogSource.indexOf('const showDailyPermitVerification'),
    );
    const permitVisibilitySource = dialogSource.slice(
      dialogSource.indexOf('const showDailyPermitVerification'),
      dialogSource.indexOf('const showDailyConstructionIssues'),
    );
    const submitFocusSource = source.slice(
      source.indexOf('const focusedDailySubmit'),
      source.indexOf('if (!followupForm.constructionRecordId)'),
    );
    const titleSource = source.slice(
      source.indexOf('function getDailyChecklistFocusDialogTitle'),
      source.indexOf('function getDailyChecklistFocusSubmitLabel'),
    );
    const focusedContentSource = source.slice(
      source.indexOf('function hasFocusedDailyFollowupFormContent'),
      source.indexOf('function hasFocusedDailyFollowupExistingContent'),
    );

    expect(workTypeVisibilitySource).toContain(
      "activeDailyChecklistFocus === 'workType'",
    );
    expect(permitVisibilitySource).not.toContain(
      "activeDailyChecklistFocus === 'workType'",
    );
    expect(submitFocusSource).toContain("dailyChecklistFocus === 'permit'");
    expect(submitFocusSource).not.toContain(
      "dailyChecklistFocus === 'workType'",
    );
    expect(titleSource).toContain(
      "if (focus === 'workType') return '作业类型校核';",
    );
    expect(focusedContentSource.replace(/\s+/g, ' ')).toMatch(
      /focus === 'workType'[\s\S]*form\.workTypes/,
    );
  });

  it('locks daily follow-up actions while project approval is not complete', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const cardUsageSource = source.slice(
      source.indexOf('<MemoizedConstructionCard'),
      source.indexOf('<ApplicationDialog'),
    );
    const kanbanSource = source.slice(
      source.indexOf('function ProjectKanbanDetail'),
      source.indexOf('function DailyChecklistActionRow'),
    );
    const rowSource = source.slice(
      source.indexOf('function DailyChecklistActionRow'),
      source.indexOf('function IsolationAuditReviewDialog'),
    );

    expect(pageSource).toContain(
      'isDailyFollowupOpenForProject(item, constructionAiAuditEnabled)',
    );
    expect(pageSource).toContain('项目施工申请未闭环');
    expect(cardUsageSource.replace(/\s+/g, '')).toContain(
      'onOpenApplicationFollowup={handleSupplementalFollowupQuickOpen}',
    );
    expect(kanbanSource.replace(/\s+/g, ' ')).toContain(
      'const dailyFollowupOpen = isDailyFollowupOpenForProject( item, constructionAiAuditEnabled, );',
    );
    expect(kanbanSource).toContain('disabled={!dailyFollowupOpen || readOnly}');
    expect(kanbanSource.replace(/\s+/g, '')).toContain(
      'onClick={dailyFollowupOpen&&!readOnly?()=>onOpenStageDetail(stage.key,true):undefined}',
    );
    expect(rowSource).toContain('disabled?: boolean;');
    expect(rowSource).toContain('disabled={!actionable}');
  });

  it('keeps finalized project approvals from regressing after prepare material supplements', () => {
    const lifecycleSource = source.slice(
      source.indexOf('function getLifecycleStages'),
      source.indexOf('function hasAttachment'),
    );
    const approvalMaterialSource = source.slice(
      source.indexOf('function isApprovalWorkflowClosed'),
      source.indexOf('function getApprovalTone'),
    );

    expect(lifecycleSource).toContain(
      'const approvalWorkflowClosed = isApprovalWorkflowClosed(item);',
    );
    expect(lifecycleSource).toContain(
      'const approvalStageMissingPrepare = approvalWorkflowClosed',
    );
    expect(lifecycleSource).toContain(
      'const approvalStagePrepareIssues = approvalWorkflowClosed ? 0 : prepareIssues;',
    );
    expect(lifecycleSource).toContain('approvalWorkflowClosed ||');
    expect(approvalMaterialSource).toContain(
      'function isApprovalWorkflowClosed',
    );
    expect(approvalMaterialSource).toContain(
      'workflowClosed: isApprovalWorkflowClosed(item),',
    );
  });

  it('opens application gaps through the supplemental follow-up form', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const constructionCardSource = source.slice(
      source.indexOf('function ConstructionCard'),
      source.indexOf('function ProjectKanbanDetail'),
    );

    expect(pageSource).toContain(
      'const handleSupplementalFollowupQuickOpen = useCallback',
    );
    expect(pageSource).toContain("followupMode: 'supplemental'");
    expect(pageSource).toContain('applyInitialApplicationFollowupForm(');
    expect(constructionCardSource).toContain('onOpenApplicationFollowup');
    expect(constructionCardSource).toContain('handleOpenApplicationGap');
    expect(constructionCardSource).toContain(
      'onOpenApplicationFollowup(item);',
    );
  });

  it('disables the daily follow-up tab for projects with unfinished approval', () => {
    const dialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(dialogSource).toContain('selectedAnyConstruction');
    expect(dialogSource).toContain('dailyFollowupLockedForSelected');
    expect(dialogSource).toContain(
      "mode === 'daily' && dailyFollowupLockedForSelected",
    );
    expect(dialogSource).toContain('disabled={modeDisabled}');
    expect(dialogSource).toContain('项目施工申请未闭环，暂不可每日跟进');
    expect(dialogSource).toContain('if (modeDisabled) {');
    expect(dialogSource).toContain("followupMode: 'supplemental'");
    expect(dialogSource).toContain('applyInitialApplicationFollowupForm(');
  });

  it('prefills close checklist and existing close attachments for second edits', () => {
    const formSource = source.slice(
      source.indexOf('function applyDailyFollowupStageForm'),
      source.indexOf('function applyInitialApplicationFollowupForm'),
    );
    const fileMapSource = source.slice(
      source.indexOf('function buildExistingDailyFollowupFileMap'),
      source.indexOf('function getExistingDailyFollowupFileKeys'),
    );

    expect(formSource).toContain('buildCompletionChecklistFormState');
    expect(formSource).toContain('followup?.completionChecklist');
    expect(formSource).not.toContain(
      'completionChecklist: createInitialCompletionChecklistState()',
    );
    expect(fileMapSource).toContain('getFollowupAttachmentKeyFromGroup');
    expect(source).toContain("每日收尾照片: ['施工收尾照片']");
    expect(source).toContain("施工检查表: ['每日收尾检查表']");
    expect(source).not.toContain("['inspectionFormFiles', '每日收尾检查表']");
  });

  it('keeps completed daily progress stages clickable for second edits', () => {
    const enabledSource = source.slice(
      source.indexOf('function isDailyFollowupStageEnabled'),
      source.indexOf('function isSameLocalDay'),
    );

    expect(enabledSource).toContain('progress[stage]');
    expect(enabledSource).not.toContain('progress.prepare && !progress.close');
  });

  it('keeps application optional fields out of the new construction dialog', () => {
    const applicationDialogSource = source.slice(
      source.indexOf('function ApplicationDialog'),
      source.indexOf('function FollowupDialog'),
    );
    const followupDialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const helperSource = source.slice(
      source.indexOf('function shouldShowDepositDetailFields'),
      source.indexOf('function mapFollowupStaffMembersToCandidates'),
    );
    const applicationFileConfigSource = source.slice(
      source.indexOf('const APPLICATION_FILE_FIELDS'),
      source.indexOf('const INITIAL_APPLICATION_PERMIT_FILE_KEYS'),
    );
    const applicationAttachmentLabelSource = source.slice(
      source.indexOf('function getApplicationAttachmentLabels'),
      source.indexOf('function getPrepareAttachmentLabels'),
    );

    expect(helperSource).toContain("depositPaid !== '否'");
    expect(applicationDialogSource).not.toContain('label="作业类型"');
    expect(applicationDialogSource).not.toContain('label="是否缴纳保证金"');
    expect(applicationDialogSource).not.toContain('label="缴纳保证金（元）"');
    expect(applicationDialogSource).not.toContain(
      'shouldShowDepositDetailFields(form.depositPaid)',
    );
    expect(applicationDialogSource).not.toContain(
      'clearDepositDetailFormFields',
    );
    expect(applicationFileConfigSource).not.toContain("'applicationFiles'");
    expect(applicationFileConfigSource).toContain("'crewRosterFiles'");
    expect(applicationAttachmentLabelSource).not.toContain(
      "'applicationFiles'",
    );
    expect(applicationAttachmentLabelSource).toContain("'crewRosterFiles'");
    expect(followupDialogSource).toMatch(
      /shouldShowDepositDetailFields\(\s*form\.depositPaid\s*,?\s*\)/,
    );
    expect(followupDialogSource).toContain('clearDepositDetailFileBuckets');
    expect(followupDialogSource).toContain('{showDepositDetailFields && (');
    expect(followupDialogSource).toContain('DEPOSIT_FILE_FIELDS');
  });

  it('requires crew roster authorization dates in the new construction dialog payload', () => {
    const applicationDialogSource = source.slice(
      source.indexOf('function ApplicationDialog'),
      source.indexOf('function FollowupDialog'),
    );
    const submitSource = source.slice(
      source.indexOf('const handleApplicationSubmit'),
      source.indexOf('const handleFollowupSubmit'),
    );
    const appendSource = source.slice(
      source.indexOf('function appendApplicationFields'),
      source.indexOf('function appendFollowupFields'),
    );

    expect(applicationDialogSource).toContain('label="授权开始日期"');
    expect(applicationDialogSource).toContain('label="施工结束日期"');
    expect(applicationDialogSource).toContain('authorizationStartDate');
    expect(applicationDialogSource).toContain('authorizationEndDate');
    expect(submitSource).toContain('form.authorizationStartDate');
    expect(submitSource).toContain('form.authorizationEndDate');
    expect(appendSource).toContain("'authorizationStartDate'");
    expect(appendSource).toContain("'authorizationEndDate'");
  });

  it('optimistically closes a new application before its background write and can restore its draft', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const submitSource = source.slice(
      source.indexOf('const handleApplicationSubmit'),
      source.indexOf('const handleFollowupSubmit'),
    );
    const dialogSource = source.slice(
      source.indexOf('function ApplicationDialog'),
      source.indexOf('function ConstructionChangeOrderSelect'),
    );

    expect(submitSource).toContain(
      'const mutationKey = `application:create:${applicationSessionId}`;',
    );
    expect(submitSource).toContain('createConstructionClientMutationId()');
    expect(submitSource).toContain(
      "formData.append('clientMutationId', clientMutationId);",
    );
    expect(submitSource).toContain('createTemporaryConstructionProject({');
    expect(submitSource).toContain(
      'appendTemporaryProject(value, temporaryProject)',
    );
    expect(submitSource).toContain('replaceTemporaryProjectRecordId(');
    expect(submitSource).toContain('constructionMutationCoordinator.begin({');
    expect(submitSource.indexOf('setApplicationOpen(false)')).toBeLessThan(
      submitSource.indexOf('await yieldToBrowserForConstructionResponse()'),
    );
    expect(
      submitSource.indexOf('await yieldToBrowserForConstructionResponse()'),
    ).toBeLessThan(submitSource.indexOf('const formData = new FormData()'));
    expect(submitSource.indexOf('setApplicationOpen(false)')).toBeLessThan(
      submitSource.indexOf('createConstructionApplication(formData)'),
    );
    expect(submitSource).not.toContain(
      'await createConstructionApplication(formData)',
    );
    expect(submitSource).not.toContain('loadData(true)');
    expect(submitSource).toContain('background: true');
    expect(submitSource).toContain('forceRefresh: false');
    expect(submitSource).toContain(
      'setApplicationRecoveryDraft(recovery.autoRestore)',
    );
    expect(pageSource).toContain('recoveryDraft={applicationRecoveryDraft}');
    expect(dialogSource).toContain('recoveryDraft');
    expect(dialogSource).toContain('recoveryDraft.revision');
    expect(dialogSource).toContain('setForm(recoveryDraft.form)');
    expect(dialogSource).toContain('setFiles(recoveryDraft.files)');
  });

  it('optimistically terminates a project before its background write and restores UI context on failure', () => {
    const terminateSource = source.slice(
      source.indexOf('const handleConfirmTerminateProject'),
      source.indexOf('const openCrewRosterUploadDialog'),
    );

    expect(terminateSource).toContain(
      'const mutationKey = `project:terminate:${candidate.recordId}`;',
    );
    expect(terminateSource).toContain('captureProjectFieldSnapshot(');
    expect(terminateSource).toContain('applyOptimisticProjectPatch(');
    expect(terminateSource).toContain('isProjectPatchConfirmed(');
    expect(terminateSource).toContain(
      'constructionMutationCoordinator.begin({',
    );
    expect(terminateSource.indexOf('updateConstructionData(')).toBeLessThan(
      terminateSource.indexOf('setProjectTerminateCandidate(null)'),
    );
    expect(
      terminateSource.indexOf('setProjectTerminateCandidate(null)'),
    ).toBeLessThan(terminateSource.indexOf('terminateConstructionProject({'));
    expect(terminateSource).not.toContain(
      'await terminateConstructionProject({',
    );
    expect(terminateSource).not.toContain('loadData(true)');
    expect(terminateSource).toContain('background: true');
    expect(terminateSource).toContain('forceRefresh: false');
    expect(terminateSource).toContain('restoreTerminationUiIfUntouched');
    expect(terminateSource).toContain('getTerminationUiRestoreDecisions({');
    expect(terminateSource).toContain('if (decisions.restoreExpanded)');
    expect(terminateSource).toContain('if (decisions.restoreFollowup)');
    expect(terminateSource).toContain('rebaseVisibleConstructionData()');
    expect(terminateSource).not.toContain('setTerminatingProject(true)');
  });

  it('scopes initial application material uploads by selected work types', () => {
    const fieldConfigSource = source.slice(
      source.indexOf('const FOLLOWUP_FILE_FIELDS'),
      source.indexOf('const DAILY_FOLLOWUP_FILE_FIELDS'),
    );
    const baseKeysSource = source.slice(
      source.indexOf('const INITIAL_APPLICATION_BASE_FILE_KEYS'),
      source.indexOf('const APPLICATION_FILE_FIELDS'),
    );
    const keyHelperSource = source.slice(
      source.indexOf('function getInitialApplicationFileKeys'),
      source.indexOf('function getInitialApplicationFileFields'),
    );
    const fieldHelperSource = source.slice(
      source.indexOf('function getInitialApplicationFileFields'),
      source.indexOf('function createInitialCompletionChecklistState'),
    );

    expect(fieldConfigSource).toContain('entryTrainingSignInFiles');
    expect(fieldConfigSource).toContain('entryTrainingAssessmentFiles');
    expect(fieldConfigSource).toContain('temporaryPowerRiskDisclosureFiles');
    expect(fieldConfigSource).toContain('hotWorkTrainingAssessmentFiles');
    expect(fieldConfigSource).toContain('heightWorkPermitFiles');
    expect(fieldConfigSource).toContain('confinedSpaceRiskDisclosureFiles');
    expect(fieldConfigSource).toContain('confinedSpaceTrainingSignInFiles');
    expect(fieldConfigSource).toContain('confinedSpaceTrainingAssessmentFiles');
    expect(fieldConfigSource).toContain('excavationRiskDisclosureFiles');
    expect(fieldConfigSource).toContain('excavationTrainingSignInFiles');
    expect(fieldConfigSource).toContain('excavationTrainingAssessmentFiles');
    expect(fieldConfigSource).toContain('excavationPermitFiles');
    expect(fieldConfigSource).toContain('liftingRiskDisclosureFiles');
    expect(fieldConfigSource).toContain('liftingTrainingSignInFiles');
    expect(fieldConfigSource).toContain('liftingTrainingAssessmentFiles');
    expect(fieldConfigSource).toContain('liftingPermitFiles');
    expect(fieldConfigSource).toContain(
      'fireSystemShutdownRiskDisclosureFiles',
    );
    expect(fieldConfigSource).toContain(
      'fireSystemShutdownTrainingSignInFiles',
    );
    expect(fieldConfigSource).toContain(
      'fireSystemShutdownTrainingAssessmentFiles',
    );
    expect(fieldConfigSource).toContain('fireSystemShutdownPermitFiles');
    expect(baseKeysSource).toContain('crewRosterFiles');
    expect(keyHelperSource).toContain('SPECIAL_WORK_TYPE_MATERIAL_GROUPS');
    expect(keyHelperSource).toContain('SPECIAL_WORK_TYPE_PERMIT_FILE_FIELDS');
    expect(keyHelperSource).toContain(
      'getSpecialWorkTypeMaterialGroup(workType)',
    );
    expect(fieldHelperSource).toContain('getInitialApplicationFileKeys');
    expect(fieldHelperSource).toContain('getInitialApplicationFileFieldLabel');
    expect(fieldHelperSource).toContain('施工人员增删名单');
    expect(fieldHelperSource).toContain(
      '!SPECIAL_WORK_TYPE_MODAL_FILE_KEYS.includes(key)',
    );
  });

  it('opens special work type material uploads in a dialog instead of the main file grid', () => {
    const followupDialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const specialDialogSource = source.slice(
      source.indexOf('function SpecialWorkTypeMaterialDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(followupDialogSource).toContain('setSpecialMaterialWorkType(type)');
    expect(followupDialogSource).toContain(
      'getSpecialWorkTypeMaterialGroup(type)',
    );
    expect(followupDialogSource).toContain('<SpecialWorkTypeMaterialDialog');
    expect(followupDialogSource).toContain('isSpecialWorkTypeMaterialComplete');
    expect(followupDialogSource).toContain(
      'onConfirmComplete={confirmSpecialMaterialWorkType}',
    );
    expect(followupDialogSource).toContain('cancelledSpecialMaterialWorkTypes');
    expect(followupDialogSource).toContain(
      'getVisibleSpecialWorkTypeExistingFiles',
    );
    expect(specialDialogSource).toContain('取消选择该作业');
    expect(specialDialogSource).toContain('onConfirmComplete(group.workType)');
    expect(specialDialogSource).not.toContain('提交');
    expect(source).toContain('getCompleteSubmittableWorkTypes(');
  });

  it('opens missing special work type material uploads from daily follow-up type selection', () => {
    const followupDialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const dailyWorkTypePanelSource = source.slice(
      source.indexOf('function DailyWorkTypeAuditPanel'),
      source.indexOf('function ManualReviewBatchSubmitBar'),
    );
    const dailySubmitPickerSource = source.slice(
      source.indexOf('function pickDailyStageFileBuckets'),
      source.indexOf('function omitFileBucketKeys'),
    );
    const dailyPermitCardSource = source.slice(
      source.indexOf('function DailyPermitVerificationCard'),
      source.indexOf('function DailyPermitManualReviewBadge'),
    );
    const dailyPermitUploadSource = source.slice(
      source.indexOf('function DailyPermitUploadButton'),
      source.indexOf('function DailyFollowupStageStepper'),
    );

    expect(followupDialogSource).toContain(
      'buildProjectSpecialWorkTypeMaterialFileMap(selectedConstruction)',
    );
    expect(followupDialogSource).toContain(
      'specialMaterialDialogExistingFiles',
    );
    expect(followupDialogSource).toContain(
      'onRequireMaterial={setSpecialMaterialWorkType}',
    );
    expect(dailyWorkTypePanelSource).toContain('const materialComplete =');
    expect(dailyWorkTypePanelSource).toContain(
      'if (materialGroup && !selected && !materialComplete)',
    );
    expect(dailyWorkTypePanelSource).toContain('onRequireMaterial(type)');
    expect(followupDialogSource).toContain("form.followupMode !== 'daily'");
    expect(followupDialogSource).toContain(
      'specialMaterialDialogExistingFiles',
    );
    expect(followupDialogSource).toContain('dailyPermitWorkTypes');
    expect(followupDialogSource).toContain(
      'isSpecialWorkTypeMaterialComplete(',
    );
    expect(followupDialogSource).toContain(
      'specialMaterialDialogExistingFiles',
    );
    expect(dailySubmitPickerSource).toContain(
      'getDailySpecialWorkTypeMaterialFileKeys(workTypes)',
    );
    expect(dailyPermitCardSource).toContain('onRequireMaterial');
    expect(dailyPermitCardSource).toContain(
      'getSpecialWorkTypeMaterialGroup(item.workType)',
    );
    expect(dailyPermitUploadSource).toContain(
      'onRequireMaterial?.(verification.workType)',
    );
  });

  it('treats every special work type as a four-file material group', () => {
    const fieldConfigSource = source.slice(
      source.indexOf('const FOLLOWUP_FILE_FIELDS'),
      source.indexOf('const DAILY_FOLLOWUP_FILE_FIELDS'),
    );

    [
      ['受限空间作业', 'confinedSpace'],
      ['临时用电作业', 'temporaryPower'],
      ['动火作业', 'hotWork'],
      ['高处作业', 'heightWork'],
      ['开挖动土作业', 'excavation'],
      ['吊装作业', 'lifting'],
      ['消防系统关闭作业', 'fireSystemShutdown'],
    ].forEach(([workType, keyPrefix]) => {
      expect(fieldConfigSource).toContain(`workType: '${workType}'`);
      expect(fieldConfigSource).toContain(`title: '${workType}资料'`);
      expect(fieldConfigSource).toContain(`${keyPrefix}RiskDisclosureFiles`);
      expect(fieldConfigSource).toContain(`${keyPrefix}TrainingSignInFiles`);
      expect(fieldConfigSource).toContain(
        `${keyPrefix}TrainingAssessmentFiles`,
      );
      expect(fieldConfigSource).toContain(`${keyPrefix}PermitFiles`);
    });
  });

  it('memoizes follow-up existing files to avoid repeated supplemental cleanup', () => {
    const followupDialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );

    expect(followupDialogSource).toContain('const existingFiles = useMemo');
    expect(followupDialogSource).toContain(
      'specialMaterialDialogExistingFiles',
    );
  });

  it('prefers initial application material follow-ups for supplemental edits', () => {
    const helperSource = source.slice(
      source.indexOf('function getInitialApplicationFollowup'),
      source.indexOf('function isInitialApplicationFollowup'),
    );

    expect(helperSource).toContain('.filter(isInitialApplicationFollowup)');
    expect(helperSource).toContain('getInitialApplicationFollowupScore');
    expect(helperSource).toContain('getFollowupTime(right)');
  });

  it('allows existing follow-up attachments to be previewed and removed', () => {
    const followupDialogSource = source.slice(
      source.indexOf('function FollowupDialog'),
      source.indexOf('function DailyWorkTypeAuditPanel'),
    );
    const fileGridSource = source.slice(
      source.indexOf('function FileGrid'),
      source.indexOf('function getFilePickerFieldSummary'),
    );
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleDailyPermitUpload'),
    );

    expect(followupDialogSource).toContain('removedExistingFileTokens');
    expect(followupDialogSource).toContain('onUploadedFileRemove');
    expect(fileGridSource).toContain(
      'appendSelectedFiles(Array.from(event.target.files || []))',
    );
    expect(fileGridSource).toContain('移除已上传');
    expect(fileGridSource).toContain('getConstructionAttachmentPreviewUrl');
    expect(source).toContain('deleteConstructionAttachment');
    expect(followupDialogSource).toContain('onAttachmentDeleted');
    expect(followupDialogSource).toContain(
      'getConstructionAttachmentDeleteTarget(',
    );
    expect(followupDialogSource).toMatch(
      /onUploadedFileRemove=\{\s*allowAttachmentDelete\s*\?\s*removeExistingFile\s*:\s*undefined\s*\}/,
    );
    expect(followupDialogSource).not.toContain(
      "form.followupMode === 'supplemental'\n                ? removeExistingFile\n                : undefined",
    );
    expect(submitSource).toContain('retainedAttachmentTokens');
    expect(source).toContain(
      'function buildGeneratedOnlineFormRetainedAttachmentTokenPayload',
    );
    expect(source).toContain("fileName.includes('在线填表')");
    expect(source).toContain('^20\\d{6}-.+-(?:施工作业申请单');
    expect(source).toContain('generatedOnlineFormFiles');
    expect(source).toContain(
      'replaceGeneratedOnlineFormFile(current, fieldKey, file)',
    );
    expect(source).toContain('mergeGeneratedOnlineFormFileMap(');
    expect(fileGridSource).toContain(
      'getConstructionAttachmentPreviewUrl(file, fileName)',
    );
    expect(fileGridSource).toContain('onUploadedFileRemove && file.fileToken');
  });

  it('restores same-day daily prepare staff and crew selections when reopening the dialog', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const dialogOpenSource = source.slice(
      source.indexOf('const handleFollowupDialogOpen'),
      source.indexOf('const handleApplicationSubmit'),
    );
    const formSource = source.slice(
      source.indexOf('function applyDailyFollowupStageForm'),
      source.indexOf('function applyInitialApplicationFollowupForm'),
    );

    expect(pageSource).toContain('writeDailyFollowupFormCache(');
    expect(dialogOpenSource).toContain('readDailyFollowupFormCache(');
    expect(formSource).toContain('cachedDraft');
    expect(formSource).toContain(
      'mapCachedFollowupStaffMembersToCandidates(cachedDraft)',
    );
    expect(formSource).toContain('getCheckedCrewRecordIdsFromFollowup(');
    expect(formSource).toContain('cachedDraft,');
  });
});
