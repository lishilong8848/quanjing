import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = []; let mockCursor = 0; const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useCallback: (callback: unknown, deps: unknown[]) => { const slot = mockCursor++, old = mockSlots[slot]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) mockSlots[slot] = { callback, deps }; return mockSlots[slot].callback; },
  useEffect: (effect: () => any, deps: unknown[]) => { const slot = mockCursor++, old = mockSlots[slot]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { const item = { deps, cleanup: old?.cleanup }; mockSlots[slot] = item; mockEffects.push(() => { item.cleanup?.(); item.cleanup = effect(); }); } },
}));
jest.mock('../../client/src/api/ali-monthly-report-email-settings', () => ({ ...jest.requireActual('../../client/src/api/ali-monthly-report-email-settings'), getAliMonthlyReportEmailSettings: jest.fn(), saveAliMonthlyReportEmailSettings: jest.fn() }));
import { isValidElement } from 'react';
import { getAliMonthlyReportEmailSettings, MonthlyEmailSettingsError, saveAliMonthlyReportEmailSettings } from '../../client/src/api/ali-monthly-report-email-settings';
import { useEmailSettings } from '../../client/src/pages/AliMonthlyReport/use-email-settings';
import { EmailSettingsDialog } from '../../client/src/pages/AliMonthlyReport/EmailSettingsDialog';
import { DialogDescription } from '../../client/src/components/ui/dialog';
import { canManageMonthlyEmailSettings, emailSettingsIssue, monthlyEmailSettingsIdentity } from '../../client/src/pages/AliMonthlyReport/email-settings.logic';
import type { AliMonthlyReportEmailSettings } from '../../shared/ali-monthly-report-email-settings';

const baseline: AliMonthlyReportEmailSettings = { senderEmail: '123456@qq.com', authCodeConfigured: true, source: 'server', revision: 'r1', updatedAt: null, canSave: true };
const config = { reportTypes: [], missingConfigKeys: [], emailReady: true } as any;
const onSaved = jest.fn();
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function effects() { while (mockEffects.length) mockEffects.shift()!(); }
function render(open = true, identity = 'admin-a') { mockCursor = 0; const state = useEmailSettings(open, identity, onSaved); effects(); return state; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function cleanup() { mockSlots.forEach(slot => slot?.cleanup?.()); mockSlots.length = 0; mockEffects.length = 0; mockCursor = 0; }
const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];

describe('monthly email configuration draft and identity safety', () => {
  beforeEach(() => { cleanup(); jest.clearAllMocks(); (getAliMonthlyReportEmailSettings as jest.Mock).mockReset().mockResolvedValue(baseline); (saveAliMonthlyReportEmailSettings as jest.Mock).mockReset(); });
  afterEach(cleanup);
  it('only allows a non-impersonating administrator', () => {
    expect(canManageMonthlyEmailSettings({ role: 'admin' })).toBe(true);
    expect(canManageMonthlyEmailSettings({ role: 'editor' })).toBe(false);
    expect(canManageMonthlyEmailSettings({ role: 'admin', impersonation: {} as any })).toBe(false);
    expect(canManageMonthlyEmailSettings({ role: 'admin', isChangingIdentity: true })).toBe(false);
    expect(canManageMonthlyEmailSettings({ role: 'admin', requiresPasswordChange: true })).toBe(false);
    expect(monthlyEmailSettingsIdentity({ role: 'admin', accountId: 'a', authorizationVersion: 1 } as any)).not.toBe(monthlyEmailSettingsIdentity({ role: 'admin', accountId: 'a', authorizationVersion: 2 } as any));
  });
  it('opens immediately, merges reads and never replaces fields edited while loading', async () => {
    const delayed = deferred<AliMonthlyReportEmailSettings>(); (getAliMonthlyReportEmailSettings as jest.Mock).mockReturnValueOnce(delayed.promise);
    let form = render(); form = render(); expect(form.loading).toBe(true);
    void form.load(); form.setSenderEmail('987654@qq.com'); form.setAuthCode('abcdefgh ijklmnop');
    delayed.resolve(baseline); await settle(); form = render();
    expect(getAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1); expect(form.senderEmail).toBe('987654@qq.com'); expect(form.authCode).toBe('abcdefgh ijklmnop');
  });
  it('requires code initially or when changing sender, with shared format validation', () => {
    expect(emailSettingsIssue({ ...baseline, authCodeConfigured: false }, baseline.senderEmail, '')).toContain('首次配置');
    expect(emailSettingsIssue(baseline, 'other@qq.com', '')).toContain('更换');
    expect(emailSettingsIssue(baseline, baseline.senderEmail, 'abcd efgh ijkl mnop')).toBeNull();
    expect(emailSettingsIssue(baseline, baseline.senderEmail, 'too-short')).toContain('16');
    expect(emailSettingsIssue(baseline, 'not-an-email', 'abcdefghijklmnop')).toContain('邮箱地址');
  });
  it('omits unchanged stored code, returns config directly and clears only the authorization-code draft', async () => {
    render(); await settle(); let form = render();
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValue({ success: true, settings: { ...baseline, revision: 'r2' }, config });
    expect(await form.save()).toBe(true); form = render();
    expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledWith(expect.not.objectContaining({ authCode: expect.anything() }), expect.anything());
    expect(onSaved).toHaveBeenCalledWith(config); expect(form.authCode).toBe(''); expect(form.settings?.revision).toBe('r2');
    expect(getAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
  });
  it('preserves timeout drafts and retries the exact mutation only when explicitly clicked', async () => {
    render(); await settle(); let form = render(); form.setAuthCode('abcd efgh ijkl mnop'); form = render();
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockRejectedValueOnce(new MonthlyEmailSettingsError('保存结果暂未确认', 408, true));
    await form.save(); form = render();
    expect(form.authCode).toBe('abcd efgh ijkl mnop'); expect(form.uncertain).toBe(true); expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
    const first = (saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[0][0]; expect(first.authCode).toBe('abcdefghijklmnop');
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValue({ success: true, settings: baseline, config });
    await form.save(); expect((saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[1][0]).toEqual(first);
    expect(render().authCode).toBe('');
  });
  it.each([503, 408])('preserves the original request through %s, temporary unavailability and recovery', async status => {
    render(); await settle(); let form = render(); form.setAuthCode('abcd efgh ijkl mnop'); form = render();
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockRejectedValueOnce(new MonthlyEmailSettingsError('保存结果暂未确认', status, true));
    await form.save(); form = render();
    const original = (saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[0][0];
    (getAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValueOnce({ ...baseline, senderEmail: '', authCodeConfigured: false, revision: 'unavailable', canSave: false });
    await form.load(); form = render();
    expect(form.canSave).toBe(false); expect(form.unavailable).toBe(true); expect(form.blocked).toBe(false);
    expect(form.senderEmail).toBe(baseline.senderEmail); expect(form.authCode).toBe('abcd efgh ijkl mnop');
    expect(form.settings?.revision).toBe('r1'); expect(form.uncertain).toBe(true);
    expect(await form.save()).toBe(false); expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
    // The original write may already have committed. Recovery must not force a new request/revision.
    (getAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValueOnce({ ...baseline, revision: 'r2' });
    await form.load(); form = render();
    expect(form.canSave).toBe(true); expect(form.conflict).toBe(false); expect(form.latest).toBeNull(); expect(form.settings?.revision).toBe('r1');
    expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValueOnce({ success: true, settings: { ...baseline, revision: 'r2' }, config });
    expect(await form.save()).toBe(true);
    expect((saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[1][0]).toEqual(original);
    expect((saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[1][0].expectedRevision).toBe('r1');
    form = render(); expect(form.authCode).toBe(''); expect(form.uncertain).toBe(false); expect(form.settings?.revision).toBe('r2');
  });
  it('preserves an unsent draft on unavailable reads and still requires review of a genuine revision change', async () => {
    render(); await settle(); let form = render(); form.setSenderEmail('draft@qq.com'); form.setAuthCode('abcdefghijklmnop'); form = render();
    (getAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValueOnce({ ...baseline, senderEmail: '', revision: 'unavailable', canSave: false });
    await form.load(); form = render();
    expect(form.senderEmail).toBe('draft@qq.com'); expect(form.authCode).toBe('abcdefghijklmnop'); expect(form.settings?.revision).toBe('r1'); expect(form.locked).toBe(false);
    (getAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValueOnce({ ...baseline, revision: 'r2' });
    await form.load(); form = render();
    expect(form.conflict).toBe(true); expect(form.latest?.revision).toBe('r2'); expect(await form.save()).toBe(false);
    expect(saveAliMonthlyReportEmailSettings).not.toHaveBeenCalled();
  });
  it.each([401, 403])('still clears a pending secret on a real identity/permission rejection %s', async status => {
    render(); await settle(); let form = render(); form.setAuthCode('abcdefghijklmnop'); form = render();
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockRejectedValueOnce(new MonthlyEmailSettingsError('结果暂未确认', 503, true));
    await form.save(); form = render();
    (getAliMonthlyReportEmailSettings as jest.Mock).mockRejectedValueOnce(new MonthlyEmailSettingsError('登录或管理权限已变化', status));
    await form.load(); form = render();
    expect(form.authCode).toBe(''); expect(form.uncertain).toBe(false); expect(form.blocked).toBe(true); expect(form.canSave).toBe(false);
    expect(await form.save()).toBe(false); expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
  });
  it('does not let double clicks start simultaneous saves', async () => {
    render(); await settle(); const form = render(), wait = deferred<any>(); (saveAliMonthlyReportEmailSettings as jest.Mock).mockReturnValue(wait.promise);
    const first = form.save(); expect(await form.save()).toBe(false); expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
    wait.resolve({ success: true, settings: baseline, config }); await first;
  });
  it('preserves a 409 draft and requires explicit adoption of the loaded latest revision', async () => {
    render(); await settle(); let form = render(); form.setAuthCode('abcdefghijklmnop'); form = render();
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockRejectedValueOnce(new MonthlyEmailSettingsError('配置已更新', 409));
    await form.save(); form = render();
    (getAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValue({ ...baseline, revision: 'r2', senderEmail: 'new@qq.com' });
    await form.load(); form = render();
    expect(form.authCode).toBe('abcdefghijklmnop'); expect(form.settings?.revision).toBe('r1'); expect(form.latest?.revision).toBe('r2');
    expect(await form.save()).toBe(false); expect(saveAliMonthlyReportEmailSettings).toHaveBeenCalledTimes(1);
    form.adoptLatest(); form = render(); (saveAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValue({ success: true, settings: baseline, config });
    await form.save(); expect((saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[1][0].expectedRevision).toBe('r2');
  });
  it('cancel retains the same-person draft and pending id; a late save response cannot update the page', async () => {
    render(); await settle(); let form = render(); form.setAuthCode('abcdefghijklmnop'); form = render();
    const wait = deferred<any>(); (saveAliMonthlyReportEmailSettings as jest.Mock).mockReturnValueOnce(wait.promise);
    const saving = form.save(); const first = (saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[0];
    render(false); expect(first[1].aborted).toBe(true);
    wait.resolve({ success: true, settings: baseline, config }); await saving; expect(onSaved).not.toHaveBeenCalled();
    render(true); await settle(); form = render(); expect(form.authCode).toBe('abcdefghijklmnop'); expect(form.uncertain).toBe(true);
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockResolvedValue({ success: true, settings: baseline, config }); await form.save();
    expect((saveAliMonthlyReportEmailSettings as jest.Mock).mock.calls[1][0].clientMutationId).toBe(first[0].clientMutationId);
  });
  it('identity or permission-version change aborts reads and clears the secret, rejecting late prior data', async () => {
    const wait = deferred<AliMonthlyReportEmailSettings>(); (getAliMonthlyReportEmailSettings as jest.Mock).mockReturnValueOnce(wait.promise);
    let form = render(); form.setAuthCode('abcdefghijklmnop');
    render(true, 'admin-b-new-version'); await settle(); form = render(true, 'admin-b-new-version');
    expect((getAliMonthlyReportEmailSettings as jest.Mock).mock.calls[0][0].aborted).toBe(true); expect(form.authCode).toBe('');
    wait.resolve({ ...baseline, senderEmail: 'old-person@qq.com' }); await settle();
    expect(render(true, 'admin-b-new-version').senderEmail).toBe(baseline.senderEmail);
  });
  it('clears the secret after server-side management permission denial', async () => {
    render(); await settle(); let form = render(); form.setAuthCode('abcdefghijklmnop'); form = render();
    (saveAliMonthlyReportEmailSettings as jest.Mock).mockRejectedValue(new MonthlyEmailSettingsError('权限已变化', 403));
    await form.save(); form = render(); expect(form.authCode).toBe(''); expect(form.blocked).toBe(true);
  });
  it('renders a masked code field with no stored-value echo and actionable read retry', async () => {
    mockCursor = 0; EmailSettingsDialog({ open: true, identity: 'admin-a', onOpenChange: jest.fn(), onSaved }); effects(); await settle();
    mockCursor = 0; const tree = EmailSettingsDialog({ open: true, identity: 'admin-a', onOpenChange: jest.fn(), onSaved });
    const field = nodes(tree).find(node => node.type === 'input' && node.props.type === 'password')!;
    expect(field.props.value).toBe(''); expect(field.props.placeholder).toContain('留空保持不变'); expect(field.props.autoComplete).toBe('new-password');
    expect(nodes(tree).find(node => node.type === DialogDescription)!.props.className).toBe('sr-only');
    expect(nodes(tree).find(node => node.type === 'form')!.props.noValidate).toBe(true);
  });
});
