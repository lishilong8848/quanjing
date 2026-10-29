import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purchase application dashboard entry', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    ),
    'utf8',
  );
  const dialog = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/PurchaseInventoryManagement/PurchaseApplicationDialog.tsx',
    ),
    'utf8',
  );

  it('opens the batch application dialog from the guarded header action and apply query', () => {
    expect(source).toContain(
      'const [applicationDialogOpen, setApplicationDialogOpen] = useState(false)',
    );
    expect(source).toContain('canCreatePurchaseApplication');
    expect(source).toContain('canCreateApplication ? (');
    expect(source).toContain('onClick={() => setApplicationDialogOpen(true)}');
    expect(source).toContain("params.get('apply') === '1'");
    expect(source).toContain('const location = useLocation()');
    expect(source).toContain(
      'isPurchaseApplicationDirectPath(location.pathname)',
    );
    expect(source).toContain(
      'const handleApplicationDialogOpenChange = useCallback(',
    );
    expect(source).toContain(
      'navigate(PURCHASE_INVENTORY_MANAGEMENT_PATH, { replace: true })',
    );
    expect(source).toContain('<PurchaseApplicationDialog');
    expect(source).toContain(
      'open={principalMatchesRenderedData && applicationDialogOpen}',
    );
    expect(source).toContain(
      'onOpenChange={handleApplicationDialogOpenChange}',
    );
    expect(source).toContain(
      'onSubmissionStarted={handleApplicationSubmissionStarted}',
    );
    expect(source).toContain(
      'onSubmissionSettled={handleApplicationSubmissionSettled}',
    );
  });

  it('keeps the approval filter in the application activity lane', () => {
    expect(source).toContain("{ key: 'approval', label: '审批中' }");
  });

  it('inserts pending applications immediately and refreshes active rows every 15 seconds', () => {
    expect(source).toContain('const ACTIVE_AUTO_REFRESH_MS = 15 * 1000');
    expect(source).toContain("void loadDashboard('active')");
    expect(source).toContain(
      "window.addEventListener('focus', refreshActiveDashboard)",
    );
    expect(source).toContain('dashboardRequestSequenceRef');
    expect(source).toContain('dashboardRequestInFlightRef');
    expect(source).toContain('createEmptyPurchaseInventoryDashboard');
    expect(source).toContain("response.refreshState === 'stale'");
    expect(source).toContain(
      'onSubmissionStarted={handleApplicationSubmissionStarted}',
    );
    expect(source).toContain(
      'onSubmissionSettled={handleApplicationSubmissionSettled}',
    );
    expect(dialog).toContain(
      'onSubmissionStarted(mutationId, submissionDraft)',
    );
    expect(
      dialog.indexOf('onSubmissionStarted(mutationId, submissionDraft)'),
    ).toBeLessThan(dialog.indexOf('await submitPurchaseApplications'));
    expect(dialog).toContain('retryMutationIdRef');
    expect(dialog).toMatch(
      /submitPurchaseApplications\(\s*submissionDraft,\s*selectedFiles,\s*mutationId,\s*fingerprint,\s*\)/,
    );
    expect(dialog).toContain('isUncertainPurchaseSubmissionError(error)');
    expect(dialog).toContain('SUBMISSION_TASK_SLOW_POLL_INTERVAL_MS');
    expect(dialog).not.toContain(
      "await onFailed('采购申请仍在后台同步，请稍后刷新页面确认结果')",
    );
  });

  it('persists and restores the original application identity across refreshes', () => {
    expect(dialog).toContain('principalFingerprint');
    expect(dialog).toContain('loadPurchaseApplicationSubmissionJournal');
    expect(dialog).toContain('savePurchaseApplicationSubmissionJournal');
    expect(dialog).toContain('clearPurchaseApplicationSubmissionJournal');
    expect(dialog).toContain('buildPurchaseApplicationSubmissionFingerprint');
    expect(dialog).toContain('matchesPurchaseApplicationAttachmentManifest');
    expect(dialog).toContain(
      'onSubmissionStartedRef.current(journal.mutationId, journal.request)',
    );
    expect(
      dialog.indexOf('savePurchaseApplicationSubmissionJournal('),
    ).toBeLessThan(dialog.indexOf('await submitPurchaseApplications'));
    expect(
      dialog.indexOf('matchesPurchaseApplicationAttachmentManifest('),
    ).toBeLessThan(dialog.indexOf('requestDispatched = true'));
  });

  it('offers only original-identity recovery actions for uncertain submissions', () => {
    expect(dialog).toContain('使用原编号安全重试');
    expect(dialog).toContain('继续确认');
    expect(dialog).toContain('再次查询原任务');
    expect(dialog).toContain("task.status === 'uncertain'");
    expect(dialog).toContain('系统不会生成新编号');
    expect(dialog).toMatch(
      /task\.status === 'uncertain'[\s\S]*?await onTerminalUncertain\([\s\S]*?\);\s*return;/,
    );
    expect(dialog).toMatch(
      /!response\.success \|\| !task[\s\S]*?await onTerminalUncertain\([\s\S]*?\);\s*return;/,
    );
    expect(dialog).toMatch(
      /task\.status === 'completed'[\s\S]*?if \(task\.result\)[\s\S]*?await onTerminalUncertain\([\s\S]*?\);\s*return;/,
    );
  });

  it('requires inline risk confirmation before manually resolving an uncertain submission', () => {
    expect(dialog).toMatch(
      /useState<\s*'found' \| 'missing' \| null\s*>\(null\)/,
    );
    expect(dialog).toContain("recoveryJournal.status === 'uncertain'");
    expect(dialog).toContain('已在采购清单找到，结束恢复');
    expect(dialog).toContain('已确认清单无记录，恢复为可提交草稿');
    expect(dialog).toContain('可能造成采购遗漏');
    expect(dialog).toContain('可能造成重复采购');
    expect(dialog).toContain("setUncertainResolution('found')");
    expect(dialog).toContain("setUncertainResolution('missing')");
    expect(dialog).toMatch(
      /journal\.status !== 'uncertain' \|\|\s*uncertainResolution !== resolution/,
    );
    expect(dialog).toContain(
      'await onSubmissionSettledRef.current(journal.mutationId, null)',
    );
    expect(dialog).toContain(
      'clearPurchaseApplicationSubmissionJournal(principal)',
    );
    expect(dialog).toContain('clearDraft(principal)');
    expect(dialog).toContain('saveDraft(journal.request, principal)');
    expect(dialog).not.toContain('window.confirm');
  });

  it('submits directly without showing or invoking Feishu login', () => {
    expect(dialog).not.toContain('beginFeishuLogin');
    expect(dialog).not.toContain('飞书登录并提交');
    expect(dialog).not.toContain('提交时需飞书登录');
    expect(dialog).not.toContain('getPurchaseApplicationAuthStatus');
    expect(dialog).not.toContain('getPurchaseApplicationLoginUrl');
    expect(dialog).toContain('应用身份安全提交');
    expect(dialog).toContain('提交采购申请');
  });

  it('keeps online link and new item inputs in the native form', () => {
    expect(dialog).toContain("draft.shared.purchaseChannel === '线上'");
    expect(dialog).toContain('采购链接');
    expect(dialog).toContain('PurchaseLinkInputs');
    expect(dialog).toContain("props.onChange('onlineUrls'");
    expect(dialog).toContain('每个物品最多 3 个');
    expect(dialog).toContain("item.mode === 'new'");
    expect(dialog).toContain('填写新增物品名称');
  });

  it('keeps the application form usable as a full-height mobile dialog', () => {
    expect(dialog).toContain('max-sm:h-dvh');
    expect(dialog).toContain('max-sm:w-screen');
    expect(dialog).toContain('min-h-0 overflow-y-auto');
    expect(dialog).toContain('max-sm:overscroll-contain');
    expect(dialog).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]');
    expect(dialog).toContain('grid grid-cols-2 gap-2 sm:flex sm:justify-end');
    expect(dialog).toContain('className="w-full max-sm:min-h-11 sm:w-auto"');
    expect(dialog).toContain(
      'className="w-full bg-blue-600 text-white hover:bg-blue-700 max-sm:min-h-11 sm:w-auto"',
    );
    expect(dialog).toContain(
      'className="w-full bg-amber-600 text-white hover:bg-amber-700 max-sm:min-h-11 sm:w-auto"',
    );
  });

  it('keeps the desktop brand and purchase-link controls under their matching headers', () => {
    const desktopRow = dialog.slice(
      dialog.indexOf('function DesktopItemRow'),
      dialog.indexOf('function MobileItemEditor'),
    );
    const brandControlIndex = desktopRow.indexOf('value={item.brand}');
    const purchaseLinkControlIndex = desktopRow.indexOf('<PurchaseLinkInputs');

    expect(brandControlIndex).toBeGreaterThan(-1);
    expect(purchaseLinkControlIndex).toBeGreaterThan(-1);
    expect(brandControlIndex).toBeLessThan(purchaseLinkControlIndex);
  });

  it('uses the procurement form selector and clears stale dependent state immediately', () => {
    const selectorStart = dialog.indexOf('label="采购形式"');
    const selectorEnd = dialog.indexOf(
      "{draft.shared.procurementForm === '单一采购' && (",
      selectorStart,
    );
    const selector = dialog.slice(selectorStart, selectorEnd);

    expect(selectorStart).toBeGreaterThan(-1);
    expect(selectorEnd).toBeGreaterThan(selectorStart);
    expect(selector).toContain('value={draft.shared.procurementForm}');
    expect(selector).toContain('options={options?.procurementForms || []}');
    expect(selector).toContain('error={errors.shared.procurementForm}');
    expect(selector).toMatch(
      /const selection = applyProcurementFormSelection\(\s*draft\.shared,\s*files,\s*procurementForm,\s*\)/,
    );
    expect(selector).toMatch(
      /setDraft\(\(current\) => \(\{\s*\.\.\.current,\s*shared: selection\.nextShared,\s*\}\)\)/,
    );
    expect(selector).toContain('setFiles(selection.nextFiles)');
    expect(selector).toContain(
      'selection.clearedErrorFields.forEach(clearSharedError)',
    );
    expect(selector).not.toContain('setFiles([])');
    expect(dialog).not.toContain('label="满足三方比价"');
  });

  it('shows an accessible required reason textarea only for single procurement', () => {
    expect(dialog).toContain(
      "draft.shared.procurementForm === '单一采购' && (",
    );
    expect(dialog).toContain('htmlFor={singleReasonFieldId}');
    expect(dialog).toContain('单一原因');
    expect(dialog).toContain('id={singleReasonFieldId}');
    expect(dialog).toContain('value={draft.shared.singleReason}');
    expect(dialog).toMatch(
      /id=\{singleReasonFieldId\}[\s\S]*?required[\s\S]*?aria-required="true"[\s\S]*?aria-invalid=\{Boolean\(errors\.shared\.singleReason\)\}/,
    );
    expect(dialog).toContain(
      'aria-invalid={Boolean(errors.shared.singleReason)}',
    );
    expect(dialog).toMatch(
      /errors\.shared\.singleReason\s*\?\s*singleReasonErrorId\s*:\s*undefined/,
    );
    expect(dialog).toContain(
      "updateShared('singleReason', event.target.value)",
    );
    expect(dialog).toContain('id={singleReasonErrorId}');
    expect(dialog).toContain('message={errors.shared.singleReason}');
    expect(dialog).toContain('请说明采用单一采购的原因');
  });

  it('shows the three-image requirement for comparison procurement on both channels', () => {
    const attachmentStart = dialog.indexOf(
      "{draft.shared.procurementForm === '三方比价' && (",
    );
    const attachmentEnd = dialog.indexOf('<FieldError', attachmentStart);
    const attachment = dialog.slice(attachmentStart, attachmentEnd);
    expect(attachmentStart).toBeGreaterThan(-1);
    expect(attachmentEnd).toBeGreaterThan(attachmentStart);
    expect(attachment).not.toContain('draft.shared.purchaseChannel');
    expect(attachment).toContain('必传 ${MIN_COMPARISON_IMAGE_COUNT} 张比价图片');
    expect(attachment).toContain('另可选 ${MAX_COMPARISON_ATTACHMENT_COUNT - MIN_COMPARISON_IMAGE_COUNT} 项');
    expect(attachment).toContain('已选 {comparisonImageCount} 张图片');
    expect(attachment).toContain('附件 {files.length}/{MAX_COMPARISON_ATTACHMENT_COUNT}');
    expect(attachment).toContain('恢复原申请，请按原顺序选择全部原附件');
    expect(attachment).toMatch(
      /<input\s+id=\{comparisonAttachmentFieldId\}\s+data-purchase-field\s+type="file"/,
    );
    expect(attachment).toContain(
      'aria-invalid={Boolean(errors.shared.comparisonAttachment)}',
    );
    expect(attachment).toContain('`${comparisonAttachmentHintId}${errors.shared.comparisonAttachment ? ` ${comparisonAttachmentErrorId}` : \'\'}`');
    expect(attachment).toContain(
      'required={!recoveryJournal && comparisonImageCount < MIN_COMPARISON_IMAGE_COUNT}',
    );
    expect(attachment).toContain(
      'aria-required="true"',
    );
    expect(attachment).toContain('focus-within:ring-2');
    expect(attachment).not.toContain('tabIndex={-1}');
    expect(attachment).not.toContain('outline-none');
  });

  it('unlocks only attachment replacement for a recoverable submission without a task id', () => {
    const attachmentStart = dialog.indexOf(
      "{draft.shared.procurementForm === '三方比价' && (",
    );
    const attachmentEnd = dialog.indexOf('</section>', attachmentStart);
    const attachment = dialog.slice(attachmentStart, attachmentEnd);
    const desktopItemStart = dialog.indexOf('<DesktopItemRow');
    const desktopItemEnd = dialog.indexOf('/>', desktopItemStart);
    const desktopItem = dialog.slice(desktopItemStart, desktopItemEnd);
    const mobileItemStart = dialog.indexOf('<MobileItemEditor');
    const mobileItemEnd = dialog.indexOf('/>', mobileItemStart);
    const mobileItem = dialog.slice(mobileItemStart, mobileItemEnd);
    const handleFilesStart = dialog.indexOf(
      'function handleFiles(selected: FileList | null)',
    );
    const handleFilesEnd = dialog.indexOf(
      'async function handleSubmit()',
      handleFilesStart,
    );
    const handleFiles = dialog.slice(handleFilesStart, handleFilesEnd);

    expect(dialog).toMatch(
      /const recoveryAttachmentSelectionEnabled = Boolean\(\s*recoveryJournal &&\s*!recoveryJournal\.taskId &&\s*recoveryJournal\.attachments\.length > 0 &&\s*!submitting,?\s*\)/,
    );
    expect(dialog).toMatch(
      /const attachmentControlsLocked =\s*formLocked && !recoveryAttachmentSelectionEnabled/,
    );
    expect(desktopItem).toContain('disabled={formLocked}');
    expect(desktopItem).not.toContain('attachmentControlsLocked');
    expect(mobileItem).toContain('disabled={formLocked}');
    expect(mobileItem).not.toContain('attachmentControlsLocked');
    expect(attachment).toMatch(
      /<input[\s\S]*?type="file"[\s\S]*?disabled=\{attachmentControlsLocked\}[\s\S]*?onChange=/,
    );
    expect(attachment).toMatch(
      /<button[\s\S]*?title="移除附件"[\s\S]*?disabled=\{attachmentControlsLocked\}/,
    );
    expect(handleFiles).toMatch(
      /const next = recoveryAttachmentSelectionEnabled\s*\? Array\.from\(selected\)\s*:\s*\[\.\.\.files, \.\.\.Array\.from\(selected\)\]/,
    );
    expect(dialog).toContain('disabled={formLocked}');
  });

  it('validates and submits only the files selected for the procurement form', () => {
    const submitStart = dialog.indexOf('async function handleSubmit()');
    const submitEnd = dialog.indexOf('function handleOpenChange', submitStart);
    const submitHandler = dialog.slice(submitStart, submitEnd);

    expect(submitStart).toBeGreaterThan(-1);
    expect(submitEnd).toBeGreaterThan(submitStart);
    expect(submitHandler.match(/const selectedFiles =/g)).toHaveLength(1);
    expect(submitHandler).toMatch(
      /selectPurchaseComparisonFiles\(\s*submissionDraft\.shared\.procurementForm,\s*files,\s*\)/,
    );
    expect(submitHandler).toMatch(
      /validatePurchaseApplicationForUi\(\s*submissionDraft,\s*selectedFiles,\s*\{ recoveringSubmission: Boolean\(retryState\) \},\s*\)/,
    );
    expect(submitHandler.indexOf('matchesPurchaseApplicationAttachmentManifest(')).toBeLessThan(
      submitHandler.indexOf('validatePurchaseApplicationForUi('),
    );
    expect(submitHandler.indexOf('computed.fingerprint !== retryState.fingerprint')).toBeLessThan(
      submitHandler.indexOf('await submitPurchaseApplications('),
    );
    expect(submitHandler).toMatch(
      /submitPurchaseApplications\(\s*submissionDraft,\s*selectedFiles,\s*mutationId,\s*fingerprint,\s*\)/,
    );
    expect(submitHandler).not.toContain('function validateForUi');
    expect(submitHandler).not.toContain('validateForUi(');
  });

  it('builds a safe retry draft through the executable retry helper', () => {
    const failureStart = dialog.indexOf(
      '} else {',
      dialog.indexOf('result.success'),
    );
    const failureEnd = dialog.indexOf('setSubmitting(false)', failureStart);
    const failureHandler = dialog.slice(failureStart, failureEnd);

    expect(failureStart).toBeGreaterThan(-1);
    expect(failureEnd).toBeGreaterThan(failureStart);
    expect(failureHandler).toMatch(
      /buildPurchaseApplicationRetryDraft\(\s*journal\.request,\s*result\.failed\.map\(\(item\) => item\.lineId\),\s*\)/,
    );
    expect(failureHandler).not.toContain('items: submissionDraft.items.filter');
  });

  it('scopes applicant drafts, searches, validation, and submission to the session building', () => {
    expect(dialog).toContain('useAccess');
    expect(dialog).toContain('scopePurchaseApplicationDraft');
    expect(dialog).toContain('fixedBuilding');
    expect(dialog).toContain('building: effectiveBuilding');
    expect(dialog).toContain('loadDraft(principal)');
    expect(dialog).toContain('saveDraft(draft, principal)');
    expect(dialog).toContain('clearDraft(principal)');
  });

  it('closes sensitive purchase dialogs whenever the signed-in principal changes', () => {
    expect(source).toContain('previousPrincipalKeyRef');
    expect(source).toContain('activePrincipalKeyRef');
    expect(source).toContain('setApplicationDialogOpen(false)');
    expect(source).toContain('setCompletionDialogOpen(false)');
    expect(source).toContain('setEditingRecord(null)');
    expect(source).toContain('setDeleteItems([])');
    expect(source).not.toContain('setWorkflowRecordId');
    expect(source).toContain('setDashboard(null)');
    expect(source).toContain('void loadDashboard(false)');
    expect(source).toContain(
      'activePrincipalKeyRef.current !== requestPrincipalKey',
    );
    expect(source).toContain('principalMatchesRenderedData');
    expect(source).toContain(
      'const dashboard = principalMatchesRenderedData ? dashboardState : null',
    );
    expect(source).toContain(
      'principalMatchesRenderedData && deleteItems.length > 0',
    );
    expect(source).not.toContain('canManageWorkflow');
  });

  it('drops every stale application-dialog response by principal generation', () => {
    expect(dialog).toContain('PurchasePrincipalRequestGate');
    expect(dialog).toContain('principalGeneration');
    expect(dialog).toContain('requestGeneration');
    expect(dialog).toContain('principalRequestGate.isCurrent(requestToken)');
    expect(dialog).toContain('loadReferenceData(principalGeneration)');
  });

  it('focuses the first invalid control and exposes labels and errors to assistive technology', () => {
    expect(dialog).toContain(
      'firstInvalidField?.focus({ preventScroll: true })',
    );
    expect(dialog).toContain('htmlFor={fieldId}');
    expect(dialog).toContain('aria-describedby={error ? errorId : undefined}');
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain('aria-live="polite"');
  });

  it('accepts immediately and reconciles after the tracked Feishu synchronization finishes', () => {
    expect(dialog).toContain('monitorPurchaseApplicationTask');
    expect(dialog).toContain('getPurchaseApplicationSubmissionTaskStatus');
    expect(dialog).toContain('toast.success(accepted.message)');
    expect(dialog).toMatch(
      /toast\.success\(accepted\.message\);\s*onOpenChange\(false\);\s*startTaskMonitoring\(acceptedJournal, requestToken\)/,
    );
    expect(dialog).toContain("task.status === 'completed'");
    expect(dialog).toContain("task.status === 'failed'");
    expect(dialog).toContain('task.definitelyNotWritten === true');
    expect(dialog).toContain('reconnectPurchaseApplicationAcceptance');
    expect(dialog).toContain(
      'submitPurchaseApplications(\n              journal.request,\n              [],\n              journal.mutationId,\n              journal.fingerprint',
    );
    expect(dialog).toContain('SUBMISSION_TASK_MAX_QUERY_FAILURES');
    expect(dialog).toContain(
      'await onSubmissionSettledRef.current(journal.mutationId, result)',
    );
    expect(dialog).toContain(
      'await onSubmissionSettledRef.current(journal.mutationId, null)',
    );
    expect(dialog).not.toContain('refreshPurchaseDashboard');
  });
});
