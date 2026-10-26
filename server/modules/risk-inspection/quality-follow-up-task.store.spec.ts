import { ConflictException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualityFollowUpTaskStore } from './quality-follow-up-task.store';

describe('QualityFollowUpTaskStore', () => {
  test('persists accepted work, resumes it, and deduplicates retries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quality-follow-up-ledger-'));
    try {
      const path = join(directory, 'ledger.json');
      const first = new QualityFollowUpTaskStore(path);
      const input = {
        recordId: 'recQuality1',
        clientMutationId: 'quality-mutation-1',
        supplemental: '检查完成',
        expectedSupplemental: '原始描述',
        principal: { role: 'building_admin' as const, purchaseBuilding: '110站' as const },
      };
      const accepted = first.create(input);
      expect(accepted.status).toBe('pending');

      const restarted = new QualityFollowUpTaskStore(path);
      expect(restarted.listReady()).toEqual([accepted]);
      expect(restarted.create(input).id).toBe(accepted.id);
      expect(() => restarted.create({ ...input, supplemental: '其他内容' }))
        .toThrow(ConflictException);
      expect(() => restarted.create({ ...input, clientMutationId: 'quality-mutation-2' }))
        .toThrow(ConflictException);

      restarted.update(accepted.id, (task) => ({
        ...task, status: 'success', message: '已同步', attempts: 1,
      }));
      expect(new QualityFollowUpTaskStore(path).get(accepted.id)).toMatchObject({
        status: 'success', attempts: 1,
      });
      expect(restarted.listReady()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
