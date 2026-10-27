import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dialogPath = resolve(
  process.cwd(),
  'client/src/pages/MonthlySchedule/NewEmployeeOnboardingDialog.tsx',
);
const hostPath = resolve(
  process.cwd(),
  'client/src/pages/MonthlySchedule/NewEmployeeOnboardingDialogHost.tsx',
);

describe('monthly schedule employee onboarding dialog', () => {
  it('provides the approved dialog implementation', () => {
    expect(existsSync(dialogPath)).toBe(true);

    const source = readFileSync(dialogPath, 'utf8');
    expect(source).toContain('新员工入职');
  });

  it('uses the approved sections and includes every visible business field', () => {
    const source = readFileSync(dialogPath, 'utf8');

    for (const section of [
      '任职信息',
      '身份与入职',
      '教育与兴趣',
      '证件照',
    ]) {
      expect(source).toContain(`title="${section}"`);
    }

    for (const label of [
      '姓名',
      '公司名称',
      '岗位',
      '联系方式',
      '入职日期',
      '学历',
      '毕业院校',
      '所学专业',
      '毕业日期',
      '车牌号',
    ]) {
      expect(source).toContain(`label="${label}"`);
    }
    expect(source).toContain(
      '<Label htmlFor="employee-onboarding-identity-number">',
    );
    expect(source).toContain('身份证号 <RequiredMark />');
    expect(source).toContain('兴趣爱好 <RequiredMark />');
    expect(source).toContain('证件照 <RequiredMark />');
    expect(source).toContain('蓝底半身照');
    expect(source).toContain(
      '/assets/employee-onboarding-blue-id-photo-example.jpg',
    );
    expect(source).not.toContain('用工性质');
    expect(source).not.toContain('证书附件');
  });

  it('reuses shared enumerations and keeps only the approved defaults', () => {
    const source = readFileSync(dialogPath, 'utf8');

    for (const symbol of [
      'EMPLOYEE_ONBOARDING_COMPANIES',
      'EMPLOYEE_ONBOARDING_POSITIONS',
      'EMPLOYEE_ONBOARDING_EDUCATIONS',
      'EMPLOYEE_ONBOARDING_HOBBIES',
    ]) {
      expect(source).toContain(symbol);
    }
    expect(source).toContain("companyName: '南通承宏云计算有限公司'");
    expect(source).toContain("position: ''");
    expect(source).toContain("education: ''");
    expect(source).toContain('<SelectValue placeholder={placeholder} />');
    expect(source).not.toContain('<SelectItem value="">');
  });

  it('implements the approved responsive shell without horizontal scrolling', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain('max-h-[90dvh]');
    expect(source).toContain('max-w-4xl');
    expect(source).toContain('flex-col');
    expect(source).toContain('overflow-hidden p-0');
    expect(source).toContain(
      'min-h-0 flex-1 overflow-x-hidden overflow-y-auto',
    );
    expect(source).toContain('grid grid-cols-1 gap-4 md:grid-cols-2');
    expect(source).toMatch(/DialogHeader className="[^"]*shrink-0/);
    expect(source).toMatch(/DialogFooter className="[^"]*shrink-0/);
  });

  it('uses real labels, inline errors and required accessibility metadata', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain('<DialogTitle>新员工入职</DialogTitle>');
    expect(source).toContain('<DialogDescription>');
    expect(source).toContain('<Label htmlFor={id}>');
    expect(source).toContain('htmlFor="employee-onboarding-photo"');
    expect(source).toContain('htmlFor="employee-onboarding-hobby-0"');
    expect(source).toContain('aria-invalid={Boolean(error)}');
    expect(source).toContain('aria-describedby={error ? errorId : undefined}');
    expect(source).toContain('aria-required={required}');
    expect(source).toContain('aria-required="true"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('onOpenAutoFocus');
    expect(source).toContain("'employee-onboarding-name'");
    expect(source).toContain('className="h-11"');
  });

  it('masks the identity number by default and provides an accessible visibility toggle', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain(
      'const [identityNumberVisible, setIdentityNumberVisible]',
    );
    expect(source).toContain(
      "type={identityNumberVisible ? 'text' : 'password'}",
    );
    expect(source).toContain(
      "identityNumberVisible ? '隐藏身份证号' : '显示身份证号'",
    );
    expect(source).toContain('aria-pressed={identityNumberVisible}');
    expect(source).toContain('setIdentityNumberVisible((visible) => !visible)');
    expect(source).toContain('<Eye aria-hidden="true" />');
    expect(source).toContain('<EyeOff aria-hidden="true" />');
    expect(
      sourceBlock(
        source,
        'const handleDialogOpenChange = useCallback(',
        'const focusFirstInvalid = useCallback(',
      ),
    ).toContain('setIdentityNumberVisible(false);');
    expect(source).toMatch(
      /setDraftStatus\('syncing'\);\s*setIdentityNumberVisible\(false\);\s*onOpenChange\(false\);/,
    );
  });

  it('uses keyboard-accessible searchable single-choice fields for company and position', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain("from '@/components/ui/command'");
    expect(source).toContain("from '@/components/ui/popover'");
    expect(source.match(/<SearchableSelectField\b/g)).toHaveLength(2);
    expect(sourceBlock(source, 'label="公司名称"', '/>')).toContain(
      'options={EMPLOYEE_ONBOARDING_COMPANIES}',
    );
    expect(sourceBlock(source, 'label="岗位"', '/>')).toContain(
      'options={EMPLOYEE_ONBOARDING_POSITIONS}',
    );
    expect(source).toContain('role="combobox"');
    expect(source).toContain('aria-haspopup="listbox"');
    expect(source).toContain('aria-expanded={open}');
    expect(source).toContain('aria-controls={listboxId}');
    expect(source).toContain('<CommandInput');
    expect(source).toContain('<CommandEmpty>未找到匹配项</CommandEmpty>');
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain('aria-selected={option === value}');
    expect(source).toContain('onSelect={() =>');
  });

  it('keeps the required blue-background ID photo local and shows an example', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const photoInput = sourceBlock(
      source,
      'ref={photoInputRef}',
      'onClick={(event)',
    );
    expect(photoInput).toContain(
      'className="sr-only !h-px !w-px !border-0 !p-0"',
    );
    expect(photoInput).toContain('type="file"');
    expect(photoInput).toContain('required');
    expect(photoInput).toContain('accept={PHOTO_ACCEPT}');
    expect(source).toContain("'.png', '.jpg', '.jpeg', '.webp'");
    expect(source).toContain("photo ? '替换证件照' : '选择证件照'");
    expect(source).toContain('file.name');
    expect(source).toContain('formatFileSize(file.size)');
    expect(source).toContain('aria-label={`移除 ${file.name}`}');
    expect(source).toContain("file.type || '未知类型'");
    expect(source).toContain('URL.createObjectURL(file)');
    expect(source).toContain('URL.revokeObjectURL(objectUrl)');
    expect(source).toContain('alt={`${file.name} 本地预览`}');
    expect(source).toContain('label="证件照"');
    expect(source).toContain('蓝底半身照示例');
    expect(source).toContain("local: '本地待提交'");
    expect(source).toContain("syncing: '同步中'");
    expect(source).toContain("retry: '待重试'");

    expect(photoInput).not.toContain('createEmployeeOnboarding(');
    expect(source.match(/\bcreateEmployeeOnboarding\(/g)).toHaveLength(1);
    expect(source).not.toContain('certificates');
    expect(source).not.toContain('CERTIFICATE');
  });

  it('performs begin, optimistic close, stable toast and exactly one API call in order', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const begin = source.indexOf('const begin = coordinator.begin(');
    const close = source.indexOf('onOpenChange(false);', begin);
    const acceptedToast = source.indexOf(
      "toast.info('新员工入职信息已受理，正在后台同步');",
      close,
    );
    const api = source.indexOf('void createEmployeeOnboarding(', acceptedToast);

    expect(begin).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(begin);
    expect(acceptedToast).toBeGreaterThan(close);
    expect(api).toBeGreaterThan(acceptedToast);
    expect(source).toContain("begin.status === 'storage-error'");
    expect(source).toContain('未发送请求');
    expect(source).toContain("begin.status === 'duplicate'");
    expect(source).toContain('正在同步，请勿重复提交');
    expect(source).toContain("begin.status === 'blocked-unknown-change'");
    expect(source).not.toContain('必须使用恢复内容直接重试');
    expect(source).toContain(
      '结果待确认，字段/附件未保存，请重新填写同一内容和重新选附件后安全重试',
    );
  });

  it('detects a refreshed unresolved ledger without claiming private fields or files were restored', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain('coordinator.getLedger()');
    expect(source).toMatch(
      /ledger\.stage === 'in-flight'[\s\S]*?ledger\.stage === 'unknown-result'/,
    );
    expect(source).toContain('pendingLedgerWithoutSnapshot');
    expect(source).toContain("setDraftStatus('retry')");
    expect(source).toContain('role="alert"');
    expect(source).toContain(
      '结果待确认，字段/附件未保存，请重新填写同一内容和重新选附件后安全重试',
    );
  });

  it('clears only a current confirmation and ignores stale results', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const confirmedBlock = sourceBlock(
      source,
      "if (resolution.status === 'confirmed')",
      "if (\n            resolution.status === 'storage-error'",
    );

    expect(source).toContain(
      'coordinator.resolveSuccess(begin.token, response)',
    );
    expect(confirmedBlock).toContain('resetForm();');
    expect(confirmedBlock).toContain(
      "toast.success('新员工入职信息及 MBTI 结果已同步至员工信息池')",
    );
    expect(
      source.match(/if \(resolution\.status === 'stale'\) return;/g),
    ).toHaveLength(2);
  });

  it('restores the exact recovery files and reopens on recoverable failures', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const recoveryBlock = sourceBlock(
      source,
      'const restoreRecovery = useCallback(',
      'const resetForm = useCallback(',
    );
    const reopenBlock = sourceBlock(
      source,
      'const recoverAndReopen = useCallback(',
      'const handleSubmit = useCallback(',
    );

    expect(source).toContain('coordinator.resolveFailure(begin.token, reason)');
    expect(recoveryBlock).toContain('setPhoto(recovery.photo);');
    expect(reopenBlock).toContain('restoreRecovery(resolution.recovery);');
    expect(reopenBlock).toContain('onOpenChange(true);');
  });

  it('does not reopen or unlock resubmission after confirmed storage cleanup failure', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const start = source.indexOf('resolution.confirmedResponse');
    const end = source.indexOf('recoverAndReopen(', start);
    const storageConfirmedBlock = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(storageConfirmedBlock).toContain('setConfirmedCleanupError(true);');
    expect(storageConfirmedBlock).toContain('clearFormMemory();');
    expect(storageConfirmedBlock).toContain(
      'coordinatorRef.current = createEmployeeOnboardingCoordinator({',
    );
    expect(storageConfirmedBlock).toContain('storage: null');
    expect(storageConfirmedBlock).toContain("setDraftStatus('confirmed');");
    expect(storageConfirmedBlock).toContain('onOpenChange(false);');
    expect(storageConfirmedBlock).toContain(
      '记录已写入，但本地状态未清理，请勿重复提交',
    );
    expect(storageConfirmedBlock).not.toContain('onOpenChange(true)');
    expect(source).toContain(
      'const formDisabled = submitting || confirmedCleanupError;',
    );
  });

  it('shows title-level draft status synchronized with edit, retain, submit and recovery', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain("unsaved: '未保存'");
    expect(source).toContain("retained: '已保留'");
    expect(source).toContain("syncing: '同步中'");
    expect(source).toContain("retry: '待重试'");
    expect(source).toContain('<DraftStatusBadge status={draftStatus} />');
    expect(source).toContain("setDraftStatus('unsaved')");
    expect(source).toContain("setDraftStatus('retained')");
    expect(source).toContain("setDraftStatus('syncing')");
    expect(source).toContain("setDraftStatus('retry')");
    expect(source).toContain('const handleDialogOpenChange = useCallback(');
    expect(source).toContain("draftStatus !== 'retry'");
  });

  it('requires explicit acknowledgement before abandoning a 409 conflict', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain("begin.status === 'blocked-conflict'");
    expect(source).toContain("resolution.status === 'conflict'");
    expect(source).toContain('coordinator.abandonConflict()');
    expect(source).toContain('已阻止重复提交');
    expect(source).toContain('核对后解除阻断');
    expect(source).toContain('确认员工尚未创建？');
    expect(source).toContain('确认未创建，解除阻断');
    expect(source).toContain('status === 409');
  });

  it('uses fixed safe messages for rate limits, validation, timeout, network and unknown results', () => {
    const source = readFileSync(dialogPath, 'utf8');

    expect(source).toContain('status === 429');
    expect(source).toContain('提交过于频繁，请稍后使用已恢复内容重试');
    expect(source).toContain('status === 413');
    expect(source).toContain('status === 400 || status === 422');
    expect(source).toContain('请求超时，结果暂未确认，请保持原内容直接重试');
    expect(source).toContain('网络异常，结果暂未确认，请保持原内容直接重试');
    expect(source).toContain('结果暂未确认，请保持原内容直接重试');
    expect(source).toContain('status === 401');
    expect(source).toContain('提交凭证已失效，请稍后使用已恢复内容重试');
    expect(source).toContain('status === 403');
    expect(source).toContain('当前提交未获授权，请保留已恢复内容并联系管理员');
    expect(source).not.toMatch(/requestLogin|logger\.|console\./);
  });

  it('provides a lazy imperative host', () => {
    expect(existsSync(hostPath)).toBe(true);

    const source = readFileSync(hostPath, 'utf8');
    expect(source).toContain('useImperativeHandle');
    expect(source).toContain('lazy(');
  });

  it('shows an accessible fallback immediately and keeps one loaded dialog mounted', () => {
    const source = readFileSync(hostPath, 'utf8');

    expect(source).toContain('forwardRef<NewEmployeeOnboardingDialogHandle>');
    expect(source).toContain(
      'export interface NewEmployeeOnboardingDialogHandle',
    );
    expect(source).toContain('open(opener?: HTMLElement | null): void;');
    expect(source).toContain(
      'openerRef.current = opener?.isConnected ? opener : fallbackOpener;',
    );
    expect(source).toContain('window.requestAnimationFrame');
    expect(source).toContain('<Suspense');
    expect(source).toContain(
      '<DialogTitle className="flex items-center gap-2">',
    );
    expect(source).toContain('新员工入职');
    expect(source).toContain('正在加载入职表单，请稍候');
    expect(source).toContain('<Spinner aria-label="正在加载新员工入职表单" />');
    expect(source).toContain('关闭');
    expect(source).toContain('setShouldMount(true);');
    expect(source).not.toContain('setShouldMount(false)');
    expect(source.match(/<LazyNewEmployeeOnboardingDialog\b/g)).toHaveLength(1);
    expect(source).toContain('if (!shouldMount) return null;');
    expect(source).toContain('opener?.isConnected');
    expect(source).toContain('opener.focus()');
  });
});

function sourceBlock(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
