import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import {
  buildPurchaseBatchAttachmentUrl,
  issuePurchaseBatchAttachmentTicket,
  verifyPurchaseBatchAttachmentTicket,
} from '../../server/modules/purchase-inventory/purchase-batch-attachment-ticket';

const SECRET = 'test-purchase-attachment-secret-with-32-bytes';
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

const payload = {
  approvalBatchId: 'purchase-application-task-1',
  executionRecordId: 'rec-2',
  actorOpenId: 'ou_requester',
  role: 'requester' as const,
  purpose: 'receipt' as const,
  issuedAt: NOW,
};

describe('purchase batch attachment ticket', () => {
  it('round-trips a short-lived role-bound ticket and builds an HTTPS entry URL', () => {
    const ticket = issuePurchaseBatchAttachmentTicket(payload, SECRET);

    expect(
      verifyPurchaseBatchAttachmentTicket(ticket, SECRET, { now: NOW + 1_000 }),
    ).toEqual(payload);
    const url = new URL(
      buildPurchaseBatchAttachmentUrl(
        'https://ops.example.com/platform/',
        ticket,
      ),
    );
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/platform/purchase-card-attachments');
    expect(url.searchParams.get('ticket')).toBe(ticket);
  });

  it('rejects tampering and expiration', () => {
    const ticket = issuePurchaseBatchAttachmentTicket(payload, SECRET);
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('a') ? 'b' : 'a'}`;

    expect(() =>
      verifyPurchaseBatchAttachmentTicket(tampered, SECRET, {
        now: NOW + 1_000,
      }),
    ).toThrow(UnauthorizedException);
    expect(() =>
      verifyPurchaseBatchAttachmentTicket(ticket, SECRET, {
        now: NOW + 16 * 60_000,
      }),
    ).toThrow('采购附件上传令牌已过期');
  });

  it('includes the configured client base path without duplicating it', () => {
    const ticket = issuePurchaseBatchAttachmentTicket(payload, SECRET);

    expect(
      new URL(
        buildPurchaseBatchAttachmentUrl(
          'https://ops.example.com/',
          ticket,
          '/nantong',
        ),
      ).pathname,
    ).toBe('/nantong/purchase-card-attachments');
    expect(
      new URL(
        buildPurchaseBatchAttachmentUrl(
          'https://ops.example.com/nantong/',
          ticket,
          '/nantong',
        ),
      ).pathname,
    ).toBe('/nantong/purchase-card-attachments');
  });

  it('rejects an unsafe client base path', () => {
    const ticket = issuePurchaseBatchAttachmentTicket(payload, SECRET);

    expect(() =>
      buildPurchaseBatchAttachmentUrl(
        'https://ops.example.com/',
        ticket,
        '/../admin',
      ),
    ).toThrow(BadRequestException);
  });
});
