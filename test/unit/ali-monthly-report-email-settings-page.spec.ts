import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = []; let mockCursor = 0;
let mockAccess: any = { role: 'admin', accountId: 'synthetic-admin', authorizationVersion: 1 };
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useMemo: (factory: () => unknown) => factory(), useEffect: () => undefined,
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => mockAccess }));
jest.mock('../../client/src/pages/business-action-access', () => ({ canUsePageAction: () => true }));
jest.mock('../../client/src/api', () => ({ getAliMonthlyReportConfig: jest.fn(), generateAliMonthlyReport: jest.fn(), bundleAliMonthlyReportFiles: jest.fn(), openAliMonthlyReportFile: jest.fn(), revealAliMonthlyReportFile: jest.fn(), sendAliMonthlyReportEmail: jest.fn() }));
jest.mock('@lark-apaas/client-toolkit/logger', () => ({ logger: { error: jest.fn() } }), { virtual: true });
jest.mock('sonner', () => ({ toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() } }));
import { isValidElement } from 'react';
import AliMonthlyReportPage from '../../client/src/pages/AliMonthlyReport';
import { EmailSettingsDialog } from '../../client/src/pages/AliMonthlyReport/EmailSettingsDialog';
import { getAliMonthlyReportConfig, generateAliMonthlyReport, sendAliMonthlyReportEmail } from '../../client/src/api';

const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
const words = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : '';
const render = () => { mockCursor = 0; return AliMonthlyReportPage(); };
const button = (tree: ReactNode, label: string) => nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children).includes(label))!;
const field = (tree: ReactNode, label: string) => nodes(nodes(tree).find(node => node.type === 'label' && words(node).includes(label))!).find(node => node.type === 'input')!;
const config: any = { reportTypes: [{ key: 'alarm_analysis', name: '合成月报' }], defaultYear: 2026, defaultMonth: 10, outputDir: '', defaultEmailRecipient: 'default@example.invalid', emailReady: true, toolReady: true, missingConfigKeys: [], missingAttachmentConfigKeys: [], missingEmailConfigKeys: [] };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

describe('monthly report page email settings integration', () => {
  beforeEach(() => { mockSlots.length = 0; mockCursor = 0; jest.clearAllMocks(); mockAccess = { role: 'admin', accountId: 'synthetic-admin', authorizationVersion: 1 }; (getAliMonthlyReportConfig as jest.Mock).mockResolvedValue(config); Object.defineProperty(globalThis, 'window', { configurable: true, value: {} }); });
  afterEach(() => { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); expect(sendAliMonthlyReportEmail).not.toHaveBeenCalled(); });
  it.each([{ role: 'editor' }, { role: 'admin', impersonation: { actorAccountId: 'real-admin' } }])('keeps refresh and administrator guidance without a settings entry for %o', access => {
    mockAccess = access; const tree = render();
    expect(nodes(tree).some(node => node.type === EmailSettingsDialog)).toBe(false);
    expect(words(tree)).not.toContain('邮箱配置'); expect(words(tree)).toContain('刷新状态'); expect(words(tree)).toContain('联系管理员');
  });
  it('opens the single dialog immediately without waiting for a page configuration fetch', () => {
    let tree = render(); button(tree, '邮箱配置').props.onClick(); tree = render();
    expect(nodes(tree).find(node => node.type === EmailSettingsDialog)!.props.open).toBe(true);
    expect(getAliMonthlyReportConfig).not.toHaveBeenCalled();
  });
  it('applying saved configuration preserves recipient, subject and generated report', async () => {
    let tree = render(); await button(tree, '刷新状态').props.onClick(); tree = render();
    field(tree, '邮件主题').props.onChange({ target: { value: '保留的主题' } });
    field(tree, '收件人邮箱').props.onChange({ target: { value: 'draft@example.invalid' } });
    (generateAliMonthlyReport as jest.Mock).mockResolvedValue({ year: 2026, month: 10, files: [], logs: ['保留的合成报告结果'], message: '合成完成' });
    tree = render(); await button(tree, '生成月报').props.onClick(); tree = render();
    nodes(tree).find(node => node.type === EmailSettingsDialog)!.props.onSaved({ ...config, defaultEmailRecipient: 'replacement@example.invalid', defaultYear: 2030 });
    tree = render(); expect(field(tree, '邮件主题').props.value).toBe('保留的主题'); expect(field(tree, '收件人邮箱').props.value).toBe('draft@example.invalid');
    expect(words(tree)).toContain('保留的合成报告结果');
  });
  it('ignores an old page status response after a confirmed settings save', async () => {
    let resolve!: (value: any) => void; (getAliMonthlyReportConfig as jest.Mock).mockReturnValue(new Promise(yes => { resolve = yes; }));
    let tree = render(); button(tree, '刷新状态').props.onClick();
    nodes(tree).find(node => node.type === EmailSettingsDialog)!.props.onSaved(config);
    resolve({ ...config, emailReady: false }); for (let i = 0; i < 6; i++) await Promise.resolve(); tree = render();
    expect(words(tree)).not.toContain('邮件暂未就绪');
  });
  it('does not apply a late save callback after switching administrator identity', () => {
    let tree = render(); const prior = nodes(tree).find(node => node.type === EmailSettingsDialog)!.props.onSaved;
    mockAccess = { ...mockAccess, accountId: 'another-admin' }; tree = render(); prior(config); tree = render();
    expect(words(tree)).toContain('邮件暂未就绪');
  });
  it.each<[Record<string, unknown>, boolean]>([
    [{ emailReady: false }, false],
    [{ missingEmailConfigKeys: ['AUTH_CODE'] }, false],
    [{ emailConfigurationIssue: '合成配置暂不可用' }, false],
    [{ emailReady: true, missingEmailConfigKeys: [], emailConfigurationIssue: undefined }, true],
  ])('uses one readiness rule for the task, warning and send button: %o', async (overrides, ready) => {
    (getAliMonthlyReportConfig as jest.Mock).mockResolvedValueOnce({ ...config, ...overrides });
    let tree = render(); await button(tree, '刷新状态').props.onClick(); tree = render();
    field(tree, '收件人邮箱').props.onChange({ target: { value: 'synthetic@example.invalid' } }); tree = render();
    expect(button(tree, '发送邮件').props.disabled).toBe(!ready);
    expect(nodes(tree).find(node => node.props.title === '邮件发送')!.props.state).toBe(ready ? 'idle' : 'warning');
    expect(words(tree).includes('邮件暂未就绪')).toBe(!ready);
  });
});
