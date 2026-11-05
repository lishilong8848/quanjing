import { randomUUID } from 'node:crypto';
import { LifecyclePaymentPerFileOrchestrator, type LifecyclePaymentPerFileStorePort, type LifecyclePaymentPerFileTask } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-per-file';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadReceivedFile, LifecyclePaymentUploadSelector } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-isolated';

describe('isolated per-file lifecycle payment upload', () => {
  const identity: LifecyclePaymentUploadIdentity = { accountId: 'account', authorizationVersion: 1, appId: 'cli_test', openId: 'ou_buyer', kind: 'feishu', origin: 'https://example.test', assertCurrent: () => {} };
  const selector: LifecyclePaymentUploadSelector = { approvalBatchId: 'purchase-application-test', executionRecordId: 'rec_one', generation: 1 };
  const file = (name: string, data: string): LifecyclePaymentUploadReceivedFile => ({ originalname: name, mimetype: 'image/png', buffer: Buffer.from(data), size: Buffer.byteLength(data) });
  const files = () => [file('a.png', 'first'), file('b.png', 'second')];
  let task: LifecyclePaymentPerFileTask | undefined, tokens: Map<number, string>, store: LifecyclePaymentPerFileStorePort, uploadOne: jest.Mock;

  beforeEach(() => {
    task = undefined; tokens = new Map();
    const copy = () => structuredClone(task!);
    store = {
      async reserve(_identity, _selector, request) {
        if (!task) task = { key: 'a'.repeat(64), state: 'active', files: request.files.map((row, index) => ({ ...row, index, state: 'pending' })) };
        else if (task.files.length !== request.files.length || task.files.some((row, index) => row.name !== request.files[index]?.name || row.sha256 !== request.files[index]?.sha256 || row.size !== request.files[index]?.size)) throw new Error('different content');
        return copy();
      },
      async beginFile(_identity, _selector, _request, _key, index, attemptId) {
        if (!task || task.files[index]?.state !== 'pending') throw new Error('claim conflict');
        task.files[index] = { ...task.files[index]!, state: 'dispatching', attemptId };
        return copy();
      },
      async confirmFile(_key, index, attemptId, token) {
        if (!task || task.files[index]?.state !== 'dispatching' || task.files[index]?.attemptId !== attemptId) throw new Error('fence mismatch');
        tokens.set(index, token); task.files[index] = { ...task.files[index]!, state: 'confirmed' };
        return copy();
      },
      async markFileUncertain(_key, index, attemptId) {
        if (!task || task.files[index]?.state !== 'dispatching' || task.files[index]?.attemptId !== attemptId) throw new Error('fence mismatch');
        task.files[index] = { ...task.files[index]!, state: 'manual_reconciliation' };
      },
      async commit() { if (!task || task.files.some(row => row.state !== 'confirmed')) throw new Error('incomplete'); task.state = 'committed'; return copy(); },
    };
    uploadOne = jest.fn(async (item: LifecyclePaymentUploadReceivedFile) => item.originalname === 'a.png' ? 'file_one' : 'file_two');
  });

  it('persists each file confirmation before dispatching the next and never exposes tokens', async () => {
    const order: string[] = [], begin = store.beginFile, confirm = store.confirmFile;
    store.beginFile = async (...args) => { order.push(`begin:${args[4]}`); return begin(...args); };
    store.confirmFile = async (...args) => { order.push(`confirm:${args[1]}`); return confirm(...args); };
    uploadOne.mockImplementation(async item => { order.push(`upload:${item.originalname}`); return item.originalname === 'a.png' ? 'file_one' : 'file_two'; });
    const result = await new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, randomUUID(), files());
    expect(result).toEqual({ state: 'completed' }); expect(JSON.stringify(result)).not.toContain('file_one');
    expect(order).toEqual(['begin:0', 'upload:a.png', 'confirm:0', 'begin:1', 'upload:b.png', 'confirm:1']);
  });

  it('resumes only the unstarted file after a crash following the first confirmed token', async () => {
    const id = randomUUID(), begin = store.beginFile;
    store.beginFile = jest.fn(async (...args) => { if (args[4] === 1) throw new Error('simulated process crash'); return begin(...args); });
    await expect(new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).rejects.toThrow();
    expect(tokens.get(0)).toBe('file_one'); expect(task!.files.map(row => row.state)).toEqual(['confirmed', 'pending']);
    store.beginFile = begin;
    expect(await new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).toEqual({ state: 'completed' });
    expect(uploadOne.mock.calls.map(call => call[0].originalname)).toEqual(['a.png', 'b.png']);
  });

  it('retains earlier confirmed evidence and never retries an uncertain later file', async () => {
    const id = randomUUID(); uploadOne.mockResolvedValueOnce('file_one').mockRejectedValueOnce(new Error('unknown remote outcome'));
    await expect(new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).rejects.toThrow('结果待核对');
    expect(tokens.get(0)).toBe('file_one'); expect(task!.files.map(row => row.state)).toEqual(['confirmed', 'manual_reconciliation']);
    expect(await new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).toEqual({ state: 'manual_reconciliation' });
    expect(uploadOne).toHaveBeenCalledTimes(2);
  });

  it('treats a confirmed remote result with failed local persistence as uncertain', async () => {
    store.confirmFile = jest.fn(async () => { throw new Error('disk failure'); });
    const id = randomUUID();
    await expect(new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).rejects.toThrow('结果待核对');
    expect(task!.files.map(row => row.state)).toEqual(['manual_reconciliation', 'pending']);
    expect(await new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).toEqual({ state: 'manual_reconciliation' });
    expect(uploadOne).toHaveBeenCalledTimes(1);
  });

  it('retains all confirmed evidence when authorization is lost at commit', async () => {
    const id = randomUUID(), commit = store.commit;
    store.commit = jest.fn(async () => { throw new Error('permission revoked'); });
    await expect(new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).rejects.toThrow('permission revoked');
    expect(task!.files.map(row => row.state)).toEqual(['confirmed', 'confirmed']);
    store.commit = commit;
    expect(await new LifecyclePaymentPerFileOrchestrator(store, { uploadOne }).upload(identity, selector, id, files())).toEqual({ state: 'completed' });
    expect(uploadOne).toHaveBeenCalledTimes(2);
  });

  it('rejects missing dependencies and malformed store snapshots without dispatch', async () => {
    await expect(new LifecyclePaymentPerFileOrchestrator(undefined, { uploadOne }).upload(identity, selector, randomUUID(), files())).rejects.toThrow('尚未接入');
    const bad = { ...store, reserve: async () => ({ key: 'a'.repeat(64), state: 'active', files: [], token: 'should-not-leak' } as unknown as LifecyclePaymentPerFileTask) };
    await expect(new LifecyclePaymentPerFileOrchestrator(bad, { uploadOne }).upload(identity, selector, randomUUID(), files())).rejects.toThrow('不可核对');
    expect(uploadOne).not.toHaveBeenCalled();
  });
});
