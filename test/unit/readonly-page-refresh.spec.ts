import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createLatestRequestCoordinator } from '../../client/src/pages/ContractManagement/latest-request';

// Execute the page's real callback and dependencies, without running external APIs.
function callbackHost(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression) throw new Error(`Missing real callback: ${name}`);
  const code = ts.transpileModule(`const callback = ${expression.getText(source)}; exports.callback = callback;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let memo: { fn: (...args: any[]) => any; deps: unknown[] } | undefined;
  return (bindings: Record<string, unknown>) => {
    const exported: any = {};
    const useCallback = (fn: (...args: any[]) => any, deps: unknown[]) => {
      if (!memo || deps.some((dep, index) => dep !== memo!.deps[index])) memo = { fn, deps };
      return memo.fn;
    };
    new Function('exports', 'useCallback', ...Object.keys(bindings), code)(exported, useCallback, ...Object.values(bindings));
    return exported.callback as (...args: any[]) => Promise<unknown>;
  };
}

describe('actual page refresh callbacks respect read-only capabilities', () => {
  const toolsFile = 'client/src/pages/OperationsToolsManagement/index.tsx';
  const contractsFile = 'client/src/pages/ContractManagement/index.tsx';
  it.each([false, true])('tools manual/return/retry refresh sends force=%s', async canForceRefresh => {
    const api = jest.fn(async () => ({}));
    const refreshInFlight = { current: false };
    const bindings = {
      access: { capabilities: { canForceRefresh } }, queryKey: ['fixture'],
      queryClient: { cancelQueries: jest.fn(), fetchQuery: ({ queryFn }: any) => queryFn({ signal: undefined }) },
      getToolsSnapshot: api, refreshInFlight, lastRefresh: { current: 0 },
      setManualRefresh: jest.fn(), setRefreshError: jest.fn(),
    };
    await callbackHost(toolsFile, 'refresh')(bindings)();
    expect(api).toHaveBeenCalledWith(canForceRefresh, undefined);
    expect(refreshInFlight.current).toBe(false);
    expect(bindings.setManualRefresh.mock.calls).toEqual([[true], [false]]);
  });
  it('tools callback updates after permission downgrade and rejects repeated clicks while pending', async () => {
    const render = callbackHost(toolsFile, 'refresh');
    let finish!: (value: {}) => void;
    const api = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const bindings = {
      access: { capabilities: { canForceRefresh: true } }, queryKey: ['fixture'],
      queryClient: { cancelQueries: jest.fn(), fetchQuery: ({ queryFn }: any) => queryFn({}) },
      getToolsSnapshot: api, refreshInFlight: { current: false }, lastRefresh: { current: 0 },
      setManualRefresh: jest.fn(), setRefreshError: jest.fn(),
    };
    render(bindings);
    const callback = render({ ...bindings, access: { capabilities: { canForceRefresh: false } } });
    const pending = callback(); await Promise.resolve();
    await callback(); expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(false, undefined);
    finish({}); await pending;
  });
  it.each([false, true])('contract header/retry/mutation refresh sends force=%s and edit prefetch follows permission', async canForceRefresh => {
    const dashboard = { contractRisks: [] };
    const api = jest.fn(async () => dashboard), prefetch = jest.fn();
    const bindings = {
      capabilities: { canForceRefresh }, canManageContracts: canForceRefresh,
      requestCoordinator: createLatestRequestCoordinator(),
      getContractManagementDashboard: api, prefetchContractDialogOptions: prefetch,
      dashboardRef: { current: dashboard }, hiddenNoPaymentRequiredRef: { current: new Set() },
      setRefreshing: jest.fn(), setLoading: jest.fn(), setDashboard: jest.fn(), setLoadError: jest.fn(),
    };
    await callbackHost(contractsFile, 'loadDashboard')(bindings)(true);
    expect(api).toHaveBeenCalledWith(canForceRefresh);
    expect(prefetch).toHaveBeenCalledTimes(canForceRefresh ? 1 : 0);
    expect(bindings.setDashboard).toHaveBeenCalledWith(dashboard);
  });
  it('contract failure retains data; retry after downgrade uses ordinary reading and no editor prefetch', async () => {
    const render = callbackHost(contractsFile, 'loadDashboard');
    const dashboard = { contractRisks: [] }, prefetch = jest.fn();
    const api = jest.fn().mockRejectedValueOnce(new Error('fixture unavailable')).mockResolvedValue(dashboard);
    const bindings = {
      capabilities: { canForceRefresh: true }, canManageContracts: true,
      requestCoordinator: createLatestRequestCoordinator(), getContractManagementDashboard: api,
      prefetchContractDialogOptions: prefetch, dashboardRef: { current: dashboard },
      hiddenNoPaymentRequiredRef: { current: new Set() }, setRefreshing: jest.fn(), setLoading: jest.fn(),
      setDashboard: jest.fn(), setLoadError: jest.fn(),
    };
    await render(bindings)(true);
    expect(bindings.dashboardRef.current).toBe(dashboard);
    expect(bindings.setDashboard).not.toHaveBeenCalled();
    await render({ ...bindings, capabilities: { canForceRefresh: false }, canManageContracts: false })(true);
    expect(api.mock.calls.map(args => args[0])).toEqual([true, false]);
    expect(prefetch).not.toHaveBeenCalled();
  });
});
