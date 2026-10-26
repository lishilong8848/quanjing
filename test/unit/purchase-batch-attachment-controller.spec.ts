import { BadRequestException } from '@nestjs/common';

import {
  processPurchaseBatchAttachmentUpload,
  renderPurchaseBatchAttachmentPage,
} from '../../server/modules/purchase-inventory/purchase-batch-attachment.logic';

describe('purchase batch attachment controller', () => {
  it('renders a responsive page that removes the ticket from the address bar', () => {
    const html = renderPurchaseBatchAttachmentPage({
      ticket: 'signed.ticket',
      purpose: 'receipt',
      hasReceiptPhoto: false,
      hasInvoice: false,
      purchaseMethod: '需求自采（楼内）',
    });

    expect(html).toContain('width=device-width');
    expect(html).toContain('history.replaceState');
    expect(html).toContain("headers:{'x-purchase-attachment-ticket':ticket}");
    expect(html).toContain('name="receiptPhotos"');
    expect(html).toContain('发票（必填）');
    expect(html).toContain('name="invoices"');
    expect(html).toContain('卡片会自动更新，无需刷新');
    expect(html).toContain('关闭页面');
  });

  it('hides invoice upload for comprehensive procurement', () => {
    const html = renderPurchaseBatchAttachmentPage({
      ticket: 'signed.ticket',
      purpose: 'receipt',
      hasReceiptPhoto: false,
      hasInvoice: false,
      purchaseMethod: '综合采购',
    });

    expect(html).toContain('name="receiptPhotos"');
    expect(html).not.toContain('name="invoices"');
    expect(html).toContain('综合采购仅需上传签收照片');
  });

  it('uploads receipt material, stages tokens, and enqueues a card refresh', async () => {
    const payload = {
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-2',
      actorOpenId: 'ou_requester',
      role: 'requester' as const,
      purpose: 'receipt' as const,
      issuedAt: Date.now(),
    };
    const gateway = {
      getTenantAccessTokenAsApp: jest.fn().mockResolvedValue('tenant-token'),
      uploadAttachment: jest
        .fn()
        .mockResolvedValueOnce('file_photo')
        .mockResolvedValueOnce('file_invoice'),
    };
    const batch = {
      approvalBatchId: 'purchase-application-task-1',
      requesterOpenId: 'ou_requester',
      cardContext: '{"version":3}',
      revision: 4,
      items: [
        {
          executionRecordId: 'rec-2',
          status: 'approved',
          receiptPhotoTokens: ['file_photo'],
          invoiceTokens: ['file_invoice'],
        },
      ],
    };
    const store = {
      findManagerApprovalBatch: jest.fn().mockResolvedValue({
        ...batch,
        items: [
          {
            ...batch.items[0],
            choice: 'building_self',
            receiptPhotoTokens: [],
            invoiceTokens: [],
          },
        ],
      }),
      stagePurchaseBatchAttachments: jest.fn().mockResolvedValue(batch),
      enqueueNotification: jest.fn().mockResolvedValue({ enqueued: true }),
    };
    const photo = {
      originalname: 'receipt.jpg',
      mimetype: 'image/jpeg',
      size: 10,
      buffer: Buffer.from('photo'),
    };
    const invoice = {
      originalname: 'invoice.pdf',
      mimetype: 'application/pdf',
      size: 10,
      buffer: Buffer.from('invoice'),
    };

    await expect(
      processPurchaseBatchAttachmentUpload(
        payload,
        {
          receiptPhotos: [photo],
          invoices: [invoice],
        },
        {
          gateway: gateway as never,
          store: store as never,
        },
      ),
    ).resolves.toEqual({
      success: true,
      receiptPhotoCount: 1,
      invoiceCount: 1,
    });
    expect(store.stagePurchaseBatchAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        actorOpenId: 'ou_requester',
        receiptPhotoTokens: ['file_photo'],
        invoiceTokens: ['file_invoice'],
      }),
    );
    expect(store.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manager_batch_receipt_refresh' }),
    );
  });

  it('rejects self-purchase receipt upload without an invoice', async () => {
    const gateway = { getTenantAccessTokenAsApp: jest.fn() };
    const store = {
      findManagerApprovalBatch: jest.fn().mockResolvedValue({
        items: [
          {
            executionRecordId: 'rec-2',
            choice: 'building_self',
            receiptPhotoTokens: [],
            invoiceTokens: [],
          },
        ],
      }),
    };

    await expect(
      processPurchaseBatchAttachmentUpload(
        {
          approvalBatchId: 'purchase-application-task-1',
          executionRecordId: 'rec-2',
          actorOpenId: 'ou_requester',
          role: 'requester',
          purpose: 'receipt',
          issuedAt: Date.now(),
        },
        {
          receiptPhotos: [
            {
              originalname: 'receipt.jpg',
              mimetype: 'image/jpeg',
              size: 1,
              buffer: Buffer.from('x'),
            },
          ],
        },
        { gateway: gateway as never, store: store as never },
      ),
    ).rejects.toThrow('自采签收必须上传发票');
    expect(gateway.getTenantAccessTokenAsApp).not.toHaveBeenCalled();
  });

  it('rejects a non-image receipt photo before any external upload', async () => {
    const gateway = { getTenantAccessTokenAsApp: jest.fn() };
    await expect(
      processPurchaseBatchAttachmentUpload(
        {
          approvalBatchId: 'purchase-application-task-1',
          executionRecordId: 'rec-2',
          actorOpenId: 'ou_requester',
          role: 'requester',
          purpose: 'receipt',
          issuedAt: Date.now(),
        },
        {
          receiptPhotos: [
            {
              originalname: 'receipt.txt',
              mimetype: 'text/plain',
              size: 1,
              buffer: Buffer.from('x'),
            },
          ],
        },
        { gateway: gateway as never, store: {} as never },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
