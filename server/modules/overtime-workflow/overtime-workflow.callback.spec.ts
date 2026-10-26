import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createCipheriv, createHash } from 'node:crypto';
import {
  parseOvertimeCardCallback,
  readOvertimeCardCallbackConfig,
} from './overtime-workflow.callback';

const NOW = new Date('2026-08-12T08:00:00.000Z');
const CONFIG = { verificationToken: 'verification-secret', encryptKey: '' };

function actionPayload(value: Record<string, unknown>) {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_overtime_1',
      event_type: 'card.action.trigger',
      token: CONFIG.verificationToken,
    },
    event: {
      operator: { open_id: 'ou_approver_1' },
      context: { open_message_id: 'om_message_1' },
      action: { tag: 'button', value },
    },
  };
}

describe('parseOvertimeCardCallback', () => {
  it('authenticates and parses the strict overtime action schema', () => {
    const result = parseOvertimeCardCallback(
      {
        headers: {},
        rawBody: JSON.stringify(
          actionPayload({ version: 1, action: 'approve', recordId: 'rec_1' }),
        ),
        now: NOW,
      },
      CONFIG,
    );
    expect(result).toEqual({
      kind: 'overtime_action',
      eventId: 'evt_overtime_1',
      actorOpenId: 'ou_approver_1',
      messageId: 'om_message_1',
      action: 'approve',
      recordId: 'rec_1',
    });
  });

  it('returns not_overtime for an authenticated purchase action', () => {
    const purchaseLegacy = actionPayload({
      version: 1,
      action: 'approve',
      executionRecordId: 'rec_purchase',
    });
    delete (purchaseLegacy.event as Record<string, unknown>).context;
    delete (purchaseLegacy.event.action as Record<string, unknown>).tag;
    expect(
      parseOvertimeCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify(purchaseLegacy),
          now: NOW,
        },
        CONFIG,
      ),
    ).toEqual({ kind: 'not_overtime' });

    const purchaseReject = actionPayload({});
    purchaseReject.event.action = {
      tag: 'button',
      name: 'purchase_reject_submit',
      form_value: { rejection_reason: '预算不符' },
    } as unknown as typeof purchaseReject.event.action;
    expect(
      parseOvertimeCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify(purchaseReject),
          now: NOW,
        },
        CONFIG,
      ),
    ).toEqual({ kind: 'not_overtime' });
  });

  it('rejects token mismatches and action values with extra keys', () => {
    const invalidToken = actionPayload({
      version: 1,
      action: 'approve',
      recordId: 'rec_1',
    });
    invalidToken.header.token = 'wrong';
    expect(() =>
      parseOvertimeCardCallback(
        { headers: {}, rawBody: JSON.stringify(invalidToken), now: NOW },
        CONFIG,
      ),
    ).toThrow(UnauthorizedException);
    expect(() =>
      parseOvertimeCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify(
            actionPayload({
              version: 1,
              action: 'approve',
              recordId: 'rec_1',
              injected: true,
            }),
          ),
          now: NOW,
        },
        CONFIG,
      ),
    ).toThrow(BadRequestException);
  });

  it('verifies signed encrypted callbacks before parsing', () => {
    const encryptKey = 'encrypt-secret';
    const envelope = encryptPayload(
      actionPayload({ version: 1, action: 'reject', recordId: 'rec_1' }),
      encryptKey,
    );
    const rawBody = JSON.stringify(envelope);
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const nonce = 'nonce-1';
    const signature = createHash('sha256')
      .update(timestamp)
      .update(nonce)
      .update(encryptKey)
      .update(rawBody)
      .digest('hex');
    const result = parseOvertimeCardCallback(
      {
        headers: {
          'x-lark-request-timestamp': timestamp,
          'x-lark-request-nonce': nonce,
          'x-lark-signature': signature,
        },
        rawBody,
        now: NOW,
      },
      { ...CONFIG, encryptKey },
    );
    expect(result.kind).toBe('overtime_action');
    expect(() =>
      parseOvertimeCardCallback(
        {
          headers: {
            'x-lark-request-timestamp': timestamp,
            'x-lark-request-nonce': nonce,
            'x-lark-signature': '0'.repeat(64),
          },
          rawBody,
          now: NOW,
        },
        { ...CONFIG, encryptKey },
      ),
    ).toThrow(UnauthorizedException);
  });

  it('uses generic, overtime, then purchase card credentials in that order', () => {
    const before = { ...process.env };
    try {
      process.env.FEISHU_CARD_VERIFICATION_TOKEN = 'generic-token';
      process.env.FEISHU_CARD_ENCRYPT_KEY = 'generic-key';
      process.env.FEISHU_OVERTIME_CARD_VERIFICATION_TOKEN = 'overtime-token';
      process.env.FEISHU_OVERTIME_CARD_ENCRYPT_KEY = 'overtime-key';
      process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN = 'purchase-token';
      process.env.FEISHU_PURCHASE_CARD_ENCRYPT_KEY = 'purchase-key';
      expect(readOvertimeCardCallbackConfig()).toEqual({
        verificationToken: 'generic-token',
        encryptKey: 'generic-key',
      });
      delete process.env.FEISHU_CARD_VERIFICATION_TOKEN;
      delete process.env.FEISHU_CARD_ENCRYPT_KEY;
      expect(readOvertimeCardCallbackConfig()).toEqual({
        verificationToken: 'overtime-token',
        encryptKey: 'overtime-key',
      });
      delete process.env.FEISHU_OVERTIME_CARD_VERIFICATION_TOKEN;
      delete process.env.FEISHU_OVERTIME_CARD_ENCRYPT_KEY;
      expect(readOvertimeCardCallbackConfig()).toEqual({
        verificationToken: 'purchase-token',
        encryptKey: 'purchase-key',
      });
    } finally {
      process.env = before;
    }
  });
});

function encryptPayload(payload: unknown, encryptKey: string) {
  const iv = Buffer.alloc(16, 7);
  const key = createHash('sha256').update(encryptKey).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return { encrypt: Buffer.concat([iv, ciphertext]).toString('base64') };
}
