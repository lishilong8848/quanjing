import {
  planPurchaseTableReconciliation,
  type PurchaseTableReconciliationRecord,
} from '../../server/modules/purchase-inventory/purchase-table-reconciliation';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function record(
  overrides: Partial<PurchaseTableReconciliationRecord> = {},
): PurchaseTableReconciliationRecord {
  return {
    recordId: 'record-1',
    code: 'CG251217-603',
    building: 'H楼',
    requester: '张文豪',
    itemName: '戴尔服务器硬盘',
    quantity: 1,
    createdAt: Date.parse('2025-12-17T10:00:00+08:00'),
    note: '服务器硬盘更换',
    unit: '个',
    ...overrides,
  };
}

describe('purchase table reconciliation', () => {
  it('provides a reconciliation planner', () => {
    const loadPlanner = () =>
      jest.requireActual(
        '../../server/modules/purchase-inventory/purchase-table-reconciliation',
      );

    expect(loadPlanner).not.toThrow();
    expect(loadPlanner().planPurchaseTableReconciliation).toBeInstanceOf(
      Function,
    );
  });

  it('inherits the authoritative execution code and C-building', () => {
    const plan = planPurchaseTableReconciliation(
      [record({ recordId: 'submission-zhang' })],
      [
        record({
          recordId: 'execution-zhang',
          code: 'CG251217-301',
          building: 'C楼',
          createdAt: Date.parse('2025-12-17T10:05:00+08:00'),
        }),
      ],
    );

    expect(plan.updates).toEqual([
      {
        submissionRecordId: 'submission-zhang',
        executionRecordId: 'execution-zhang',
        code: 'CG251217-301',
        building: 'C楼',
        previousCode: 'CG251217-603',
        previousBuilding: 'H楼',
      },
    ]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([]);
  });

  it('inherits the authoritative execution code and A-building', () => {
    const plan = planPurchaseTableReconciliation(
      [
        record({
          recordId: 'submission-shi',
          requester: '示例人员009',
          itemName: '数字钳形表表笔',
        }),
      ],
      [
        record({
          recordId: 'execution-shi',
          code: 'CG251217-101',
          building: 'A楼',
          requester: '示例人员009',
          itemName: '数字钳形表表笔',
          createdAt: Date.parse('2025-12-17T10:04:00+08:00'),
        }),
      ],
    );

    expect(plan.updates[0]).toMatchObject({
      submissionRecordId: 'submission-shi',
      code: 'CG251217-101',
      building: 'A楼',
    });
  });

  it('does not rewrite a submission that already matches execution', () => {
    const matching = record({ code: 'CG251217-301', building: 'C楼' });

    const plan = planPurchaseTableReconciliation(
      [matching],
      [record({ ...matching, recordId: 'execution-1' })],
    );

    expect(plan.updates).toEqual([]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([]);
  });

  it('refuses to choose between different authoritative execution batches', () => {
    const submission = record({ recordId: 'ambiguous-submission', note: '' });
    const plan = planPurchaseTableReconciliation(
      [submission],
      [
        record({
          recordId: 'execution-a',
          code: 'CG251217-101',
          building: 'A楼',
          note: '',
          createdAt: submission.createdAt + 5 * 60_000,
        }),
        record({
          recordId: 'execution-c',
          code: 'CG251217-301',
          building: 'C楼',
          note: '',
          createdAt: submission.createdAt + 5 * 60_000,
        }),
      ],
    );

    expect(plan.updates).toEqual([]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([
      'ambiguous-submission',
    ]);
  });

  it('uses an explicit non-H submission building to disambiguate a multi-building item', () => {
    const submission = record({
      recordId: 'submission-c-building',
      code: 'CG260112-301',
      building: 'C楼',
      requester: '示例人员010',
      itemName: '消防器材点检卡',
    });
    const plan = planPurchaseTableReconciliation(
      [submission],
      [
        record({
          recordId: 'execution-a-building',
          code: 'CG260112-102',
          building: 'A楼',
          requester: '示例人员010',
          itemName: '消防器材点检卡',
          createdAt: submission.createdAt + 60_000,
        }),
        record({
          recordId: 'execution-c-building',
          code: 'CG260112-302',
          building: 'C楼',
          requester: '示例人员010',
          itemName: '消防器材点检卡',
          createdAt: submission.createdAt + 70_000,
        }),
      ],
    );

    expect(plan.updates).toEqual([
      expect.objectContaining({
        submissionRecordId: 'submission-c-building',
        executionRecordId: 'execution-c-building',
        code: 'CG260112-302',
        building: 'C楼',
      }),
    ]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([]);
  });

  it('assigns remaining H submission to the only unclaimed execution authority', () => {
    const base = record({
      requester: '示例人员010',
      itemName: '藿香正气口服液',
      quantity: 5,
      unit: '盒',
      note: '夏季防暑药品',
    });
    const plan = planPurchaseTableReconciliation(
      [
        record({
          ...base,
          recordId: 'submission-a',
          code: 'CG260604-102',
          building: 'A楼',
        }),
        record({
          ...base,
          recordId: 'submission-h',
          code: 'CG260604-601',
          building: 'H楼',
          createdAt: base.createdAt + 10_000,
        }),
      ],
      [
        record({
          ...base,
          recordId: 'execution-a',
          code: 'CG260604-102',
          building: 'A楼',
          createdAt: base.createdAt + 60_000,
        }),
        record({
          ...base,
          recordId: 'execution-h',
          code: 'CG260604-602',
          building: 'H楼',
          createdAt: base.createdAt + 70_000,
        }),
      ],
    );

    expect(plan.updates).toEqual([
      expect.objectContaining({
        submissionRecordId: 'submission-h',
        executionRecordId: 'execution-h',
        code: 'CG260604-602',
        building: 'H楼',
      }),
    ]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([]);
  });

  it('pairs an equal-size ambiguous batch by creation order', () => {
    const first = record({
      recordId: 'submission-first',
      requester: '示例人员010',
      itemName: '电子称',
    });
    const second = record({
      ...first,
      recordId: 'submission-second',
      code: 'CG251215-602',
      createdAt: first.createdAt + 20 * 60_000,
    });
    const plan = planPurchaseTableReconciliation(
      [first, second],
      [
        record({
          ...first,
          recordId: 'execution-a',
          code: 'CG251215-101',
          building: 'A楼',
          createdAt: first.createdAt + 24 * 60_000,
        }),
        record({
          ...second,
          recordId: 'execution-d',
          code: 'CG251215-401',
          building: 'D楼',
          createdAt: first.createdAt + 25 * 60_000,
        }),
      ],
    );

    expect(plan.updates).toEqual([
      expect.objectContaining({
        submissionRecordId: 'submission-first',
        code: 'CG251215-101',
        building: 'A楼',
      }),
      expect.objectContaining({
        submissionRecordId: 'submission-second',
        code: 'CG251215-401',
        building: 'D楼',
      }),
    ]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([]);
  });

  it('does not propagate an execution code whose building segment is wrong', () => {
    const plan = planPurchaseTableReconciliation(
      [record({ recordId: 'submission-invalid' })],
      [
        record({
          recordId: 'execution-invalid',
          code: 'CG251217-601',
          building: 'C楼',
          createdAt: Date.parse('2025-12-17T10:05:00+08:00'),
        }),
      ],
    );

    expect(plan.updates).toEqual([]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([
      'submission-invalid',
    ]);
  });

  it('does not reconcile records without a real creation time', () => {
    const plan = planPurchaseTableReconciliation(
      [record({ recordId: 'submission-no-time', createdAt: 0 })],
      [
        record({
          recordId: 'execution-no-time',
          code: 'CG251217-301',
          building: 'C楼',
          createdAt: 0,
        }),
      ],
    );

    expect(plan.updates).toEqual([]);
    expect(plan.unresolvedSubmissionRecordIds).toEqual([]);
  });

  it('ships a dry-run-first reconciliation command', () => {
    const scriptPath = resolve(
      process.cwd(),
      'scripts/reconcile-purchase-table-codes.mjs',
    );

    expect(existsSync(scriptPath)).toBe(true);
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain("process.argv.includes('--apply')");
    expect(source).toContain('planPurchaseTableReconciliation');
    expect(source).toContain('fetchBitableRecords(httpService');
    expect(source).toContain("process.argv.indexOf('--restore')");
    expect(source).toContain('extractDateTimeIso');
    expect(source).toContain("fields['创建日期']");
    expect(source).toContain('sampleUnresolved:');
    expect(source).toContain('records/batch_update');
    expect(source).toContain('verification failed');
  });

  it('prevents the legacy backfill from defaulting missing buildings to H', () => {
    const legacySource = readFileSync(
      resolve(process.cwd(), 'scripts/backfill-purchase-order-codes.ps1'),
      'utf8',
    );

    expect(legacySource).not.toContain(
      'if ($usesDefaultBuilding) { $building = $DefaultBuilding }',
    );
    expect(legacySource).toContain('reconcile-purchase-table-codes.mjs');
  });
});
