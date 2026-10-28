let mockAccess: any;
let mockRefs: Array<{ current: any }>;
let mockCursor: number;
let mockCleanup: (() => void) | undefined;
const mockRequest = jest.fn();
jest.mock('react', () => ({
  useRef: (value: unknown) => { const index = mockCursor++; return mockRefs[index] || (mockRefs[index] = { current: value }); },
  useEffect: (effect: () => (() => void)) => { mockCleanup = effect(); },
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => mockAccess }));
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: (...args: unknown[]) => mockRequest(...args) }));
import { useMonthlyOperationsExport } from '../../client/src/pages/MonthlyOperations/use-export-access';

const render = () => { mockCursor = 0; return useMonthlyOperationsExport(); };
const pending = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};
beforeEach(() => {
  mockAccess = { role: 'editor', purchaseBuilding: null, principalFingerprint: 'synthetic-A' };
  mockRefs = []; mockCursor = 0; mockCleanup = undefined; mockRequest.mockReset();
});
it('waits for the server export check before creating any download', async () => {
  const gate = pending(); mockRequest.mockReturnValue(gate.promise);
  const hook = render(), download = jest.fn(), feedback = jest.fn();
  const result = hook.authorizeExport(download, feedback);
  expect(download).not.toHaveBeenCalled();
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/api/bitable/monthly-operations/export-access' }));
  gate.resolve({ data: { allowed: true } }); await result;
  expect(download).toHaveBeenCalledTimes(1);
});
it('retains the current view on denial or temporary network failure', async () => {
  const hook = render(), download = jest.fn(), feedback = jest.fn();
  mockRequest.mockRejectedValueOnce({ response: { status: 403 } });
  await hook.authorizeExport(download, feedback);
  expect(download).not.toHaveBeenCalled(); expect(feedback).toHaveBeenLastCalledWith(expect.stringContaining('无导出权限'));
  mockRequest.mockRejectedValueOnce({ response: { status: 503 } });
  await hook.authorizeExport(download, feedback);
  expect(feedback).toHaveBeenLastCalledWith(expect.stringContaining('暂时未能确认'));
});
it('coalesces a second click while authorization is in flight', async () => {
  const gate = pending(); mockRequest.mockReturnValue(gate.promise);
  const hook = render(), download = jest.fn(), feedback = jest.fn();
  const first = hook.authorizeExport(download, feedback);
  await hook.authorizeExport(download, feedback);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  gate.resolve({}); await first; expect(download).toHaveBeenCalledTimes(1);
});
it('rejects a late authorization result after the account changes', async () => {
  const gate = pending(); mockRequest.mockReturnValue(gate.promise);
  const download = jest.fn(), feedback = jest.fn();
  const first = render().authorizeExport(download, feedback);
  mockAccess = { ...mockAccess, principalFingerprint: 'synthetic-B' }; render();
  gate.resolve({}); await first;
  expect(download).not.toHaveBeenCalled();
});
it('does not download after the source panel unmounts', async () => {
  const gate = pending(); mockRequest.mockReturnValue(gate.promise);
  const download = jest.fn(); const first = render().authorizeExport(download, jest.fn());
  mockCleanup?.(); gate.resolve({}); await first;
  expect(download).not.toHaveBeenCalled();
});
