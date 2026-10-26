import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ATTACHED_BANK } from '../../output/mbti-static-preview/attached-bank-model';

const { createMbtiPreviewSyncService } = require('../../output/mbti-static-preview/preview-sync-service.cjs');

describe('MBTI preview Feishu sync', () => {
  const ledgerPath = join(tmpdir(), `mbti-sync-test-${randomUUID()}.json`);
  const recordId = 'recTest123';
  const name = '测试员工';
  const record = { record_id: recordId, fields: { 姓名: name } };
  const snapshot = { records: [record], fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  const payload = () => ({
    clientMutationId: randomUUID(), recordId, name, version: 'short',
    answers: Array(60).fill(7), sourceSha256: ATTACHED_BANK.sourceSha256,
  });

  afterAll(async () => { await rm(ledgerPath, { force: true }); });

  it('recomputes the type, writes once, and recognizes the same retry after persistence', async () => {
    const gateway = { readRecord: jest.fn().mockResolvedValue({ 姓名: name }), updateMbti: jest.fn().mockResolvedValue(undefined) };
    const service = createMbtiPreviewSyncService({ gateway, readSnapshot: async () => snapshot, ledgerPath });
    const request = payload();
    await expect(service.sync(request)).resolves.toEqual({ recordId, type: 'ENFJ', syncState: 'success' });
    await expect(createMbtiPreviewSyncService({ gateway, readSnapshot: async () => snapshot, ledgerPath }).sync(request))
      .resolves.toEqual({ recordId, type: 'ENFJ', syncState: 'success' });
    expect(gateway.updateMbti).toHaveBeenCalledTimes(1);
    expect(gateway.updateMbti).toHaveBeenCalledWith(recordId, 'ENFJ');
    await expect(service.sync({ ...request, answers: Array(60).fill(1) })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an employee mismatch before any Feishu write', async () => {
    const gateway = { readRecord: jest.fn(), updateMbti: jest.fn() };
    const service = createMbtiPreviewSyncService({ gateway, readSnapshot: async () => snapshot, ledgerPath });
    await expect(service.sync({ ...payload(), name: '其他员工' })).rejects.toMatchObject({ status: 409 });
    expect(gateway.updateMbti).not.toHaveBeenCalled();
  });

  it('uses the 93-question scoring key for the full version', async () => {
    const gateway = { readRecord: jest.fn().mockResolvedValue({ 姓名: name }), updateMbti: jest.fn().mockResolvedValue(undefined) };
    const service = createMbtiPreviewSyncService({ gateway, readSnapshot: async () => snapshot, ledgerPath });
    await expect(service.sync({ ...payload(), version: 'full', answers: Array(93).fill('A') }))
      .resolves.toMatchObject({ recordId, type: 'INFP', syncState: 'success' });
    expect(gateway.updateMbti).toHaveBeenCalledWith(recordId, 'INFP');
  });

  it('keeps failed writes retryable with the same mutation ID', async () => {
    const gateway = {
      readRecord: jest.fn().mockResolvedValue({ 姓名: name }),
      updateMbti: jest.fn().mockRejectedValueOnce(new Error('Feishu unavailable')).mockResolvedValue(undefined),
    };
    const service = createMbtiPreviewSyncService({ gateway, readSnapshot: async () => snapshot, ledgerPath });
    const request = payload();
    await expect(service.sync(request)).rejects.toThrow('Feishu unavailable');
    await expect(service.sync(request)).resolves.toMatchObject({ syncState: 'success' });
    expect(gateway.updateMbti).toHaveBeenCalledTimes(2);
  });
});
