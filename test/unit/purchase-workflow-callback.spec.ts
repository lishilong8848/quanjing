import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  parsePurchaseCardCallback,
  type PurchaseCardCallbackConfig,
  type PurchaseCardCallbackInput,
} from '../../server/modules/purchase-inventory/purchase-workflow-callback';

const verificationToken = 'verify_test_6f4cb8';
const encryptKey = 'encrypt_test_8bd2ae';
const now = new Date('2026-07-16T04:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

const config: PurchaseCardCallbackConfig = {
  verificationToken,
  encryptKey: '',
  legacyApproverOpenIds: ['ou_approver_01'],
  managerApproverOpenId: 'ou_manager_01',
};

const callbackInputHasNoBody: 'body' extends keyof PurchaseCardCallbackInput
  ? false
  : true = true;

function actionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_card_01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: 'ou_approver_01' },
      action: {
        value: {
          version: 1,
          action: 'approve',
          executionRecordId: 'rec_exec_01-A',
        },
      },
    },
    ...overrides,
  };
}

type ManagerInitialAction =
  | 'choose_comprehensive'
  | 'choose_building_self'
  | 'open_reject';

function managerActionPayload(
  action: ManagerInitialAction = 'choose_comprehensive',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_manager_card_01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: 'ou_manager_01' },
      action: {
        tag: 'button',
        value: {
          version: 2,
          action,
          executionRecordId: 'rec_manager_01-A',
        },
      },
      context: { open_message_id: 'om_manager_card_01' },
    },
    ...overrides,
  };
}

function managerRejectSubmitPayload(
  rejectionReason: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_manager_reject_01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: 'ou_manager_01' },
      action: {
        tag: 'button',
        name: 'purchase_reject_submit',
        form_value: {
          rejection_reason: rejectionReason,
        },
      },
      context: { open_message_id: 'om_manager_card_01' },
    },
    ...overrides,
  };
}

function parsePlain(
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
) {
  const rawBody = JSON.stringify(body);
  return parsePurchaseCardCallback({ headers, rawBody, now }, config);
}

function encryptedRequest(payload: Record<string, unknown>) {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64');
  const body = { encrypt: encrypted };
  const rawBody = JSON.stringify(body);
  const timestamp = String(nowSeconds);
  const nonce = 'nonce_test_17';
  const signature = createHash('sha256')
    .update(timestamp + nonce + encryptKey + rawBody)
    .digest('hex');
  return {
    headers: {
      'X-Lark-Request-Timestamp': [timestamp],
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    },
    rawBody,
    now,
  };
}

describe('parsePurchaseCardCallback', () => {
  it('does not expose a separately parsed body in its input type', () => {
    expect(callbackInputHasNoBody).toBe(true);
  });

  it('accepts a plaintext URL verification challenge with the right token', () => {
    expect(
      parsePlain({
        type: 'url_verification',
        token: verificationToken,
        challenge: 'challenge_test_01',
      }),
    ).toEqual({ kind: 'challenge', challenge: 'challenge_test_01' });
  });

  it('rejects a URL verification challenge with a wrong token', () => {
    expect(() =>
      parsePlain({
        type: 'url_verification',
        token: 'wrong_test_token',
        challenge: 'challenge_test_01',
      }),
    ).toThrow(UnauthorizedException);
  });

  it('parses a plaintext JSON 2.0 card action', () => {
    expect(
      parsePlain(actionPayload(), {
        'X-Lark-Request-Timestamp': String(nowSeconds),
      }),
    ).toEqual({
      kind: 'legacy_action',
      eventId: 'evt_card_01',
      operatorOpenId: 'ou_approver_01',
      action: 'approve',
      executionRecordId: 'rec_exec_01-A',
    });
  });

  it.each<
    [
      ManagerInitialAction,
      'choose_comprehensive' | 'choose_building_self' | 'open_reject',
    ]
  >([
    ['choose_comprehensive', 'choose_comprehensive'],
    ['choose_building_self', 'choose_building_self'],
    ['open_reject', 'open_reject'],
  ])('parses manager initial action %s', (action, expectedAction) => {
    expect(parsePlain(managerActionPayload(action))).toEqual({
      kind: 'manager_action',
      eventId: 'evt_manager_card_01',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_card_01',
      action: expectedAction,
      executionRecordId: 'rec_manager_01-A',
    });
  });

  it('parses a reject form submission without trusting a client record id', () => {
    expect(
      parsePlain(managerRejectSubmitPayload('  Cafe\u0301\n设备不适用  ')),
    ).toEqual({
      kind: 'manager_action',
      eventId: 'evt_manager_reject_01',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_card_01',
      action: 'submit_reject',
      rejectionReason: 'Café\n设备不适用',
    });
  });

  it('counts reject reasons by Unicode code point', () => {
    const rejectionReason = '😀'.repeat(500);
    expect(parsePlain(managerRejectSubmitPayload(rejectionReason))).toEqual({
      kind: 'manager_action',
      eventId: 'evt_manager_reject_01',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_card_01',
      action: 'submit_reject',
      rejectionReason,
    });
  });

  it('trusts only rawBody and never reads a forged parsed body object', () => {
    const authenticatedPayload = actionPayload();
    let forgedBodyReads = 0;
    const forgedBody = new Proxy(
      actionPayload({
        header: {
          event_id: 'evt_forged_01',
          event_type: 'card.action.trigger',
          token: verificationToken,
        },
        event: {
          operator: { open_id: 'ou_approver_01' },
          action: {
            value: {
              version: 1,
              action: 'reject',
              executionRecordId: 'rec_forged_01',
            },
          },
        },
      }),
      {
        get(target, property, receiver) {
          forgedBodyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const legacyInput = {
      headers: {},
      rawBody: JSON.stringify(authenticatedPayload),
      body: forgedBody,
      now,
    } as unknown as PurchaseCardCallbackInput;

    expect(parsePurchaseCardCallback(legacyInput, config)).toEqual({
      kind: 'legacy_action',
      eventId: 'evt_card_01',
      operatorOpenId: 'ou_approver_01',
      action: 'approve',
      executionRecordId: 'rec_exec_01-A',
    });
    expect(forgedBodyReads).toBe(0);
  });

  it.each([
    ['wrong schema', { schema: '1.0' }],
    [
      'wrong event type',
      {
        header: {
          event_id: 'evt_card_01',
          event_type: 'im.message.receive_v1',
          token: verificationToken,
        },
      },
    ],
    [
      'wrong action',
      {
        event: {
          operator: { open_id: 'ou_approver_01' },
          action: {
            value: {
              version: 1,
              action: 'delete',
              executionRecordId: 'rec_exec_01-A',
            },
          },
        },
      },
    ],
    [
      'wrong version',
      {
        event: {
          operator: { open_id: 'ou_approver_01' },
          action: {
            tag: 'button',
            value: {
              version: 2,
              action: 'approve',
              executionRecordId: 'rec_exec_01-A',
            },
          },
        },
      },
    ],
    [
      'invalid record id',
      {
        event: {
          operator: { open_id: 'ou_approver_01' },
          action: {
            value: {
              version: 1,
              action: 'approve',
              executionRecordId: '../rec?token=secret',
            },
          },
        },
      },
    ],
    [
      'extra action value field',
      {
        event: {
          operator: { open_id: 'ou_approver_01' },
          action: {
            value: {
              version: 1,
              action: 'approve',
              executionRecordId: 'rec_exec_01-A',
              operatorOpenId: 'ou_attacker',
            },
          },
        },
      },
    ],
  ])('rejects %s', (_label, override) => {
    expect(() => parsePlain(actionPayload(override))).toThrow(
      BadRequestException,
    );
  });

  it.each([
    ['missing action tag', undefined],
    ['wrong action tag', 'select_static'],
  ])('rejects a manager action with %s', (_label, tag) => {
    expect(() =>
      parsePlain(
        managerActionPayload('choose_comprehensive', {
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              ...(tag === undefined ? {} : { tag }),
              value: {
                version: 2,
                action: 'choose_comprehensive',
                executionRecordId: 'rec_manager_01-A',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['missing message id', {}],
    ['empty message id', { open_message_id: '' }],
    ['empty om_ body', { open_message_id: 'om_' }],
    ['wrong message prefix', { open_message_id: 'bm_manager_card_01' }],
    ['path-like message id', { open_message_id: 'om_manager/card_01' }],
    ['query-like message id', { open_message_id: 'om_manager?card=01' }],
    ['trim-unsafe message id', { open_message_id: ' om_manager_card_01 ' }],
    ['control character message id', { open_message_id: 'om_bad\u0000id' }],
    ['overlong message id', { open_message_id: `om_${'a'.repeat(300)}` }],
  ])('rejects a manager action with %s', (_label, context) => {
    expect(() =>
      parsePlain(
        managerActionPayload('choose_comprehensive', {
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              tag: 'button',
              value: {
                version: 2,
                action: 'choose_comprehensive',
                executionRecordId: 'rec_manager_01-A',
              },
            },
            context,
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects an extra manager action value key', () => {
    expect(() =>
      parsePlain(
        managerActionPayload('choose_comprehensive', {
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              tag: 'button',
              value: {
                version: 2,
                action: 'choose_comprehensive',
                executionRecordId: 'rec_manager_01-A',
                operatorOpenId: 'ou_attacker',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects an extra reject form key that could carry a client record id', () => {
    expect(() =>
      parsePlain(
        managerRejectSubmitPayload('不符合采购要求', {
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              tag: 'button',
              name: 'purchase_reject_submit',
              form_value: {
                rejection_reason: '不符合采购要求',
                executionRecordId: 'rec_attacker_01',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n '],
    ['over 500 code points', '😀'.repeat(501)],
    ['NUL', '原因\u0000注入'],
    ['tab control character', '原因\t注入'],
    ['delete control character', '原因\u007f注入'],
  ])('rejects a %s rejection reason', (_label, rejectionReason) => {
    expect(() =>
      parsePlain(managerRejectSubmitPayload(rejectionReason)),
    ).toThrow(BadRequestException);
  });

  it('rejects a reject form with a wrong submit name', () => {
    expect(() =>
      parsePlain(
        managerRejectSubmitPayload('不符合采购要求', {
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              tag: 'button',
              name: 'purchase_reject_submit_forged',
              form_value: {
                rejection_reason: '不符合采购要求',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a reject form whose submit action is not a button', () => {
    expect(() =>
      parsePlain(
        managerRejectSubmitPayload('不符合采购要求', {
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              tag: 'select_static',
              name: 'purchase_reject_submit',
              form_value: {
                rejection_reason: '不符合采购要求',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects an empty event id and overlong protocol identifiers', () => {
    expect(() =>
      parsePlain(
        actionPayload({
          header: {
            event_id: '',
            event_type: 'card.action.trigger',
            token: verificationToken,
          },
        }),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      parsePlain(
        actionPayload({
          event: {
            operator: { open_id: `ou_${'a'.repeat(200)}` },
            action: {
              value: {
                version: 1,
                action: 'approve',
                executionRecordId: 'rec_exec_01-A',
              },
            },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('forbids an operator outside the configured approver allowlist', () => {
    const body = actionPayload({
      event: {
        operator: { open_id: 'ou_unlisted_01' },
        action: {
          value: {
            version: 1,
            action: 'reject',
            executionRecordId: 'rec_exec_01-A',
          },
        },
      },
    });
    expect(() => parsePlain(body)).toThrow(ForbiddenException);
  });

  it('forbids a legacy-only approver from version 2 manager actions', () => {
    expect(() =>
      parsePlain(
        managerActionPayload('choose_building_self', {
          event: {
            operator: { open_id: 'ou_approver_01' },
            action: {
              tag: 'button',
              value: {
                version: 2,
                action: 'choose_building_self',
                executionRecordId: 'rec_manager_01-A',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('forbids the manager-only approver from version 1 legacy actions', () => {
    expect(() =>
      parsePlain(
        actionPayload({
          event: {
            operator: { open_id: 'ou_manager_01' },
            action: {
              value: {
                version: 1,
                action: 'approve',
                executionRecordId: 'rec_exec_01-A',
              },
            },
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('parses the protocol before checking the matching allowlist', () => {
    expect(() =>
      parsePlain(
        managerActionPayload('choose_comprehensive', {
          event: {
            operator: { open_id: 'ou_unlisted_01' },
            action: {
              tag: 'button',
              value: {
                version: 2,
                action: 'delete',
                executionRecordId: 'rec_manager_01-A',
              },
            },
            context: { open_message_id: 'om_manager_card_01' },
          },
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects the obsolete merged approver configuration', () => {
    expect(() =>
      parsePurchaseCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify(actionPayload()),
          now,
        },
        {
          verificationToken,
          encryptKey: '',
          approverOpenIds: ['ou_approver_01'],
        } as unknown as Parameters<typeof parsePurchaseCardCallback>[1],
      ),
    ).toThrow(BadRequestException);
  });

  it('accepts challenges while the manager feature is not configured', () => {
    expect(
      parsePurchaseCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify({
            type: 'url_verification',
            token: verificationToken,
            challenge: 'challenge_without_manager_01',
          }),
          now,
        },
        {
          ...config,
          managerApproverOpenId: '',
        },
      ),
    ).toEqual({
      kind: 'challenge',
      challenge: 'challenge_without_manager_01',
    });
  });

  it('parses legacy actions while the manager feature is not configured', () => {
    expect(
      parsePurchaseCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify(actionPayload()),
          now,
        },
        {
          ...config,
          managerApproverOpenId: '',
        },
      ),
    ).toEqual({
      kind: 'legacy_action',
      eventId: 'evt_card_01',
      operatorOpenId: 'ou_approver_01',
      action: 'approve',
      executionRecordId: 'rec_exec_01-A',
    });
  });

  it('forbids manager actions while the manager feature is not configured', () => {
    expect(() =>
      parsePurchaseCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify(managerActionPayload()),
          now,
        },
        {
          ...config,
          managerApproverOpenId: '',
        },
      ),
    ).toThrow(ForbiddenException);
  });

  it.each([
    [
      'manager id without ou_ prefix',
      {
        ...config,
        managerApproverOpenId: 'manager_01',
      },
    ],
    [
      'manager id with path characters',
      {
        ...config,
        managerApproverOpenId: 'ou_manager/01',
      },
    ],
    [
      'empty legacy id suffix',
      {
        ...config,
        legacyApproverOpenIds: ['ou_'],
      },
    ],
    [
      'legacy id with query characters',
      {
        ...config,
        legacyApproverOpenIds: ['ou_approver?admin=true'],
      },
    ],
  ])('rejects callback config with %s', (_label, invalidConfig) => {
    expect(() =>
      parsePurchaseCardCallback(
        {
          headers: {},
          rawBody: JSON.stringify({
            type: 'url_verification',
            token: verificationToken,
            challenge: 'challenge_invalid_config_01',
          }),
          now,
        },
        invalidConfig,
      ),
    ).toThrow(BadRequestException);
  });

  it('decrypts and parses a correctly signed encrypted action', () => {
    const request = encryptedRequest(actionPayload());
    expect(
      parsePurchaseCardCallback(request, {
        ...config,
        encryptKey,
      }),
    ).toEqual({
      kind: 'legacy_action',
      eventId: 'evt_card_01',
      operatorOpenId: 'ou_approver_01',
      action: 'approve',
      executionRecordId: 'rec_exec_01-A',
    });
  });

  it('decrypts and parses a correctly signed manager action', () => {
    const request = encryptedRequest(
      managerActionPayload('choose_building_self'),
    );
    expect(
      parsePurchaseCardCallback(request, {
        ...config,
        encryptKey,
      }),
    ).toEqual({
      kind: 'manager_action',
      eventId: 'evt_manager_card_01',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_card_01',
      action: 'choose_building_self',
      executionRecordId: 'rec_manager_01-A',
    });
  });

  it('accepts an encrypted URL verification challenge without signature headers', () => {
    const request = encryptedRequest({
      type: 'url_verification',
      token: verificationToken,
      challenge: 'challenge_encrypted_01',
    });

    expect(
      parsePurchaseCardCallback(
        { ...request, headers: {} },
        { ...config, encryptKey },
      ),
    ).toEqual({
      kind: 'challenge',
      challenge: 'challenge_encrypted_01',
    });
  });

  it('rejects an unsigned encrypted card action', () => {
    const request = encryptedRequest(actionPayload());

    expect(() =>
      parsePurchaseCardCallback(
        { ...request, headers: {} },
        { ...config, encryptKey },
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects an encrypted challenge with only some signature headers', () => {
    const request = encryptedRequest({
      type: 'url_verification',
      token: verificationToken,
      challenge: 'challenge_partial_headers_01',
    });

    expect(() =>
      parsePurchaseCardCallback(
        {
          ...request,
          headers: {
            'x-lark-request-timestamp': String(nowSeconds),
          },
        },
        { ...config, encryptKey },
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects an unsigned encrypted challenge with the wrong verification token', () => {
    const request = encryptedRequest({
      type: 'url_verification',
      token: 'wrong_encrypted_challenge_token',
      challenge: 'challenge_wrong_token_01',
    });

    expect(() =>
      parsePurchaseCardCallback(
        { ...request, headers: {} },
        { ...config, encryptKey },
      ),
    ).toThrow(UnauthorizedException);
  });

  it('decrypts a fixed AES-256-CBC vector bound to fixed raw bytes', () => {
    const encrypted =
      'AAECAwQFBgcICQoLDA0OD36n45+KszRxiNK+Pm4odXJOjyUAIWrufnpCvCx+O32hQpDTD2HPp94eYTfQLg1oKdJ4664Bg5Qv4IEKzZKK9/+vero0aJknsCgmXhO8S6ZnDEw0VIn4pBMOGaUsp9mu58RdrRLVv+c/ZYuHfMlRgaV/NhftjIFVIDrLTHl0m1PeiUPJAjTtx/HGP5zsydL9AosSJ94U9RNIx8FA0FHXyohLAUUEICAP10D3Ve7eiNe6sEG63t4oT9XMLl6v4eo/t6Fk4XQlOQJHU+vt4e1J/8dvIM/zWOMZlr8GuDTEE6LVS+c9J4qP2teDzHgDiet/Mpp6oCfn8+Cnu5+/MwDFMak=';
    const rawBody = Buffer.from(`{"encrypt":"${encrypted}"}`, 'utf8');

    expect(
      parsePurchaseCardCallback(
        {
          headers: {
            'x-lark-request-timestamp': '1784174400',
            'x-lark-request-nonce': 'nonce_vector_01',
            'x-lark-signature':
              'e3150feeb59039335c676281a2a742f7e32d05c06999e90f8d7dfb9b65f5f635',
          },
          rawBody,
          now,
        },
        { ...config, encryptKey },
      ),
    ).toEqual({
      kind: 'legacy_action',
      eventId: 'evt_vector_01',
      operatorOpenId: 'ou_approver_01',
      action: 'reject',
      executionRecordId: 'rec_vector_01',
    });
  });

  it.each([
    ['missing signature', { 'x-lark-signature': undefined }],
    ['wrong signature', { 'x-lark-signature': '0'.repeat(64) }],
  ])('rejects encrypted requests with %s', (_label, headerPatch) => {
    const request = encryptedRequest(actionPayload());
    request.headers = { ...request.headers, ...headerPatch };
    expect(() =>
      parsePurchaseCardCallback(request, { ...config, encryptKey }),
    ).toThrow(UnauthorizedException);
  });

  it('rejects stale plaintext and encrypted requests', () => {
    const staleTimestamp = String(nowSeconds - 301);
    expect(() =>
      parsePlain(actionPayload(), {
        'x-lark-request-timestamp': staleTimestamp,
      }),
    ).toThrow(UnauthorizedException);

    const request = encryptedRequest(actionPayload());
    request.headers['X-Lark-Request-Timestamp'] = [staleTimestamp];
    request.headers['x-lark-signature'] = createHash('sha256')
      .update(
        staleTimestamp +
          request.headers['x-lark-request-nonce'] +
          encryptKey +
          request.rawBody,
      )
      .digest('hex');
    expect(() =>
      parsePurchaseCardCallback(request, { ...config, encryptKey }),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a validly signed request containing malformed ciphertext', () => {
    const body = {
      encrypt: Buffer.from('not-a-valid-ciphertext').toString('base64'),
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(nowSeconds);
    const nonce = 'nonce_test_bad_cipher';
    const signature = createHash('sha256')
      .update(timestamp + nonce + encryptKey + rawBody)
      .digest('hex');

    expect(() =>
      parsePurchaseCardCallback(
        {
          headers: {
            'x-lark-request-timestamp': timestamp,
            'x-lark-request-nonce': nonce,
            'x-lark-signature': signature,
          },
          rawBody,
          now,
        },
        { ...config, encryptKey },
      ),
    ).toThrow(BadRequestException);
  });

  it('does not leak credentials or payloads in validation errors', () => {
    const secretBody = actionPayload({
      schema: '1.0',
      secretField: 'private_body_value',
    });
    let error: unknown;
    try {
      parsePlain(secretBody);
    } catch (reason) {
      error = reason;
    }
    const message = String((error as Error | undefined)?.message ?? '');
    expect(message).not.toContain(verificationToken);
    expect(message).not.toContain('private_body_value');
    expect(message).not.toContain(encryptKey);
  });
});
