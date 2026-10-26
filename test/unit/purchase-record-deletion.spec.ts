import { BadRequestException } from '@nestjs/common';
import { PurchaseRecordDeletionService } from '../../server/modules/purchase-inventory/purchase-record-deletion.service';

describe('PurchaseRecordDeletionService', () => {
  it('rejects an empty selection without calling Feishu', async () => {
    const gateway = { batchDeleteRecordsAsApp: jest.fn() };
    const service = new PurchaseRecordDeletionService(gateway as never);

    await expect(
      service.deleteRecords({
        records: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.batchDeleteRecordsAsApp).not.toHaveBeenCalled();
  });

  it('deduplicates linked records and sends one grouped batch delete', async () => {
    const gateway = {
      batchDeleteRecordsAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseRecordDeletionService(gateway as never);

    await expect(
      service.deleteRecords({
        records: [
          {
            key: 'row-1',
            submissionRecordId: 'rec_submission_1',
            executionRecordId: 'rec_execution_1',
          },
          {
            key: 'row-2',
            submissionRecordId: 'rec_submission_1',
            executionRecordId: 'rec_execution_2',
          },
        ],
      }),
    ).resolves.toMatchObject({
      deletedItems: 2,
      deletedSubmissionRecords: 1,
      deletedExecutionRecords: 2,
    });

    expect(gateway.batchDeleteRecordsAsApp).toHaveBeenCalledTimes(1);
    expect(gateway.batchDeleteRecordsAsApp).toHaveBeenCalledWith({
      submissionRecordIds: ['rec_submission_1'],
      executionRecordIds: ['rec_execution_1', 'rec_execution_2'],
    });
  });

  it('deletes a valid selection without a secondary password', async () => {
    const gateway = {
      batchDeleteRecordsAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseRecordDeletionService(gateway as never);

    await expect(
      service.deleteRecords({
        records: [
          {
            key: 'row-1',
            submissionRecordId: 'rec_submission_1',
            executionRecordId: null,
          },
        ],
      }),
    ).resolves.toMatchObject({ deletedItems: 1 });
    expect(gateway.batchDeleteRecordsAsApp).toHaveBeenCalledTimes(1);
  });
});
