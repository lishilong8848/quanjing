import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

describe('monthly schedule change adjustment UI', () => {
  const page = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );
  const dialog = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/ChangeAdjustmentDialog.tsx',
    ),
    'utf8',
  );

  it('nests change adjustment below change request and guards its page action', () => {
    const tools = page.slice(
      page.indexOf('运维相关'),
      page.indexOf('<ClipboardPlus', page.indexOf('运维相关')),
    );
    expect(tools).toContain('变更相关');
    expect(tools.indexOf('变更申请')).toBeGreaterThan(-1);
    expect(tools.indexOf('变更调整')).toBeGreaterThan(
      tools.indexOf('变更申请'),
    );
    expect(tools).toContain('{canUpdateChange && (');
    expect(page).toContain("canUsePageAction(access, 'change_management', 'update', capabilities.canEdit)");
    expect(tools).toContain('openChangeAdjustmentRequest()');
  });

  it.each([true, false])('opens the actual adjustment dialog only when update permission is %s', allowed => {
    const start = page.indexOf('(recordId: string | null = null) => {', page.indexOf('const openChangeAdjustmentRequest'));
    const end = page.indexOf('\n    },', start) + '\n    }'.length;
    const setters = { setChangeAdjustmentRequestInitialRecordId: jest.fn(), setChangeAdjustmentRequestServerError: jest.fn(), setChangeAdjustmentRequestOpen: jest.fn() };
    const env = { canUpdateChange: allowed, changeAdjustmentRequestRetryBinding: null, toast: { info: jest.fn() }, ...setters };
    const code = ts.transpileModule(`const open = ${page.slice(start, end)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function(...Object.keys(env), `${code}; open('synthetic-record');`)(...Object.values(env));
    if (allowed) expect(setters.setChangeAdjustmentRequestOpen).toHaveBeenCalledWith(true);
    else { expect(setters.setChangeAdjustmentRequestOpen).not.toHaveBeenCalled(); expect(env.toast.info).toHaveBeenCalledWith('当前为只读模式，不能调整变更'); }
  });

  it('uses cached change records and enforces lifecycle-specific date editing', () => {
    expect(dialog).toContain('listAdjustableChanges(changes)');
    expect(dialog).not.toContain('getYearlyChangeInfo');
    expect(dialog).toContain("prepared.lifecycleStatus === 'in-progress'");
    expect(dialog).toContain('进行中的变更仅可调整结束时间');
    expect(dialog).toContain('type="datetime-local"');
    expect(dialog).toContain('min={');
  });

  it('supports deleting old schemes, adding 200 MB schemes and required evidence', () => {
    expect(dialog).toContain('删除此方案');
    expect(dialog).toContain('retainedDocumentTokens');
    expect(dialog).toContain('removedDocumentTokens');
    expect(dialog).toContain('上传最新方案');
    expect(dialog).toContain('单个不超过 200 MB');
    expect(dialog).toContain('延期举证');
    expect(dialog).toContain('单个不超过 20 MB');
    expect(dialog).toContain('CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE');
    expect(dialog).toContain('isChangeAttachmentFileAllowedByExtension');
    expect(dialog).toContain('调整理由');
    expect(dialog).not.toContain('同步至园区变更多维表');
  });

  it('opens an existing scheme by its server-issued URL without a mutation owner query', () => {
    expect(dialog).toContain('href={document.url}');
    expect(dialog).not.toMatch(/document\.url[\s\S]{0,120}ownerMutationId/);
  });

  it('closes before network I/O and rolls back known failures precisely', () => {
    const start = page.indexOf('const handleSubmitChangeAdjustmentRequest');
    const end = page.indexOf('const handleSubmitChangeDrillReport', start);
    const handler = page.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(handler.indexOf('flushSync')).toBeLessThan(
      handler.indexOf('await createChangeAdjustment(request)'),
    );
    expect(handler).toContain('applyPendingChangeAdjustment');
    expect(handler).toContain("progress: '调整结果待确认'");
    expect(handler).toContain(': original');
    expect(handler).toContain('setChangeAdjustmentRequestOpen(true)');
    expect(handler).not.toContain('getYearlyChangeInfo');
  });

  it('mounts the adjustment dialog with a mutation-keyed recoverable draft', () => {
    expect(page).toContain('<ChangeAdjustmentDialog');
    expect(page).toContain('key={changeAdjustmentRequestOwnerMutationId}');
    expect(page).toContain('onSubmit={handleSubmitChangeAdjustmentRequest}');
    expect(dialog).toContain('same-ID reopen preserves a failed draft');
  });

  it('freezes an unknown-result draft and retries the exact immutable request', () => {
    expect(page).toContain('changeAdjustmentRequestRetryBinding');
    expect(page).toContain('setChangeAdjustmentRequestRetryBinding({');
    expect(page).toContain(
      'retryBinding={changeAdjustmentRequestRetryBinding}',
    );
    expect(page).toMatch(/if\s*\(\s*!changeAdjustmentRequestRetryBinding\s*&&/);
    expect(dialog).toContain(
      'const draftLocked = submitting || Boolean(retryBinding)',
    );
    expect(dialog).toContain(
      'onSubmit(retryBinding.request, retryBinding.original)',
    );
    expect(dialog).toContain('disabled={draftLocked}');
    expect(dialog).toContain('仅可使用原内容重试');
  });
});
