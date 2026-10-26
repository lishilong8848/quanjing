import { optionalAccountPermissions, accountRevisionError } from '../../client/src/pages/SystemConfiguration/account-mutation';
import type { ManagedAccount } from '../../shared/access-configuration.interface';
import { requireMutation } from '../../server/common/access/access-configuration.validation';
const account: ManagedAccount = { id: 'local-editor-all', kind: 'local', name: '合成账号', role: 'editor', building: null, enabled: true, deleted: false, version: 2, source: 'configuration' };
describe('角色保存请求及可执行校验错误', () => {
  it('未修改的空可选权限不随角色变更提交', () => {
    expect(optionalAccountPermissions(account, [], [])).toEqual({});
    expect(optionalAccountPermissions(undefined, [], [])).toEqual({});
  });
  it('实际添加和清空权限必须显式发送，不能以兼容为由丢弃', () => {
    expect(optionalAccountPermissions(account, [], ['/operations-kb'])).toEqual({ pagePaths: ['/operations-kb'] });
    expect(optionalAccountPermissions({ ...account, pagePaths: ['/operations-kb'] }, [], [])).toEqual({ pagePaths: [] });
    const rules = [{ id: 'rule', effect: 'deny' as const, module: 'inventory' as const, actions: ['read' as const], buildings: null, specialties: null }];
    expect(optionalAccountPermissions({ ...account, personalRules: rules }, [], [])).toEqual({ personalRules: [] });
  });
  it('刷新不覆盖他人修改；无效版本在发请求前阻止', () => {
    expect(accountRevisionError(3, account, [{ ...account, version: 3 }])).toContain('重新打开');
    expect(accountRevisionError(3, account, [account])).toBe('');
    expect(accountRevisionError(undefined, account, [account])).toContain('版本');
    expect(accountRevisionError(3, account, [])).toContain('重新打开');
  });
  it('服务端分别报告字段、请求标识和版本，且不输出值', () => {
    const request = { clientMutationId: 'synthetic-mutation-001', expectedRevision: 1 };
    expect(() => requireMutation({ ...request, pagePaths: [] }, Object.keys(request))).toThrow('不支持的字段');
    expect(() => requireMutation({ ...request, clientMutationId: 'bad' }, Object.keys(request))).toThrow('请求标识');
    expect(() => requireMutation({ ...request, expectedRevision: '1' }, Object.keys(request))).toThrow('配置版本');
    expect(() => requireMutation(request, Object.keys(request))).not.toThrow();
  });
});
