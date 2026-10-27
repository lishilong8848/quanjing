import { BadRequestException } from '@nestjs/common';
import {
  buildManualInventoryInboundCompletedCard,
  buildPurchaseApprovalCard,
  buildResolvedPurchaseApprovalCard,
  buildWarehouseInboundCard,
} from '../../server/modules/purchase-inventory/purchase-workflow-card';
import * as purchaseWorkflowCards from '../../server/modules/purchase-inventory/purchase-workflow-card';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

type JsonObject = Record<string, unknown>;

function collectButtons(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(collectButtons);
  if (!value || typeof value !== 'object') return [];
  const object = value as JsonObject;
  return [
    ...(object.tag === 'button' ? [object] : []),
    ...Object.values(object).flatMap(collectButtons),
  ];
}

function callbackValue(button: JsonObject): unknown {
  const behaviors = button.behaviors;
  if (!Array.isArray(behaviors)) return undefined;
  const callback = behaviors.find(
    (behavior) =>
      behavior &&
      typeof behavior === 'object' &&
      (behavior as JsonObject).type === 'callback',
  ) as JsonObject | undefined;
  return callback?.value;
}

function collectContent(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectContent);
  if (!value || typeof value !== 'object') return [];
  const object = value as JsonObject;
  return [
    ...(typeof object.content === 'string' ? [object.content] : []),
    ...Object.values(object).flatMap(collectContent),
  ];
}

describe('buildPurchaseApprovalCard', () => {
  it('builds a Feishu JSON 2.0 approval card with exact callback values', () => {
    const input = {
      executionRecordId: 'rec_exec_01-A',
      requester: '张三',
      building: 'H楼',
      title: '温湿度传感器',
      quantity: 3,
      unit: '个',
      createdAt: '2026-07-16 09:30',
      statusLabel: '未开始（待审批）',
      amount: 1280.5,
      purchaseMethod: '综合采购',
      expectedDeliveryAt: '2026-07-21 17:00',
      requestCode: 'PR-202607-001',
    };
    const card = buildPurchaseApprovalCard(input);

    expect(card).toMatchObject({
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
      },
      header: {
        template: 'purple',
        icon: { tag: 'standard_icon', token: 'approve_colorful' },
        title: { tag: 'plain_text', content: '采购管理---经理审批' },
        text_tag_list: [
          {
            tag: 'text_tag',
            text: { tag: 'plain_text', content: '待审批' },
            color: 'yellow',
          },
        ],
      },
    });
    const content = collectContent(card).join('\n');
    for (const expected of [
      '申请人',
      '张三',
      '楼栋',
      'H楼',
      '物品',
      '温湿度传感器',
      '数量',
      '3 个',
      '金额',
      '1280.5',
      '采购方式',
      '综合采购',
      '计划到货',
      '2026-07-21 17:00',
      '单号',
      'PR-202607-001',
      '申请时间',
      '2026-07-16 09:30',
      '状态',
      '未开始（待审批）',
    ]) {
      expect(content).toContain(expected);
    }

    const buttons = collectButtons(card);
    expect(
      buttons.map(
        (button) =>
          (button.text as JsonObject | undefined)?.content as
            | string
            | undefined,
      ),
    ).toEqual(['确认', '驳回']);
    expect(buttons.map((button) => button.type)).toEqual([
      'primary_filled',
      'danger',
    ]);
    const values = buttons.map(callbackValue);
    expect(values).toEqual([
      {
        version: 1,
        action: 'approve',
        executionRecordId: 'rec_exec_01-A',
      },
      {
        version: 1,
        action: 'reject',
        executionRecordId: 'rec_exec_01-A',
      },
    ]);
    expect(Object.keys(values[0] as JsonObject).sort()).toEqual([
      'action',
      'executionRecordId',
      'version',
    ]);
  });

  it('normalizes, escapes, and limits untrusted business strings', () => {
    const oversizedItem = `  **${'传感器'.repeat(200)}**\u0000\r\n  `;
    const oversizedRequestCode = ` PR-${'单'.repeat(250)} `;
    const input = {
      executionRecordId: 'rec_safe_1',
      requester: '  <script>\u0000 张\r\n三  ',
      building: ' H楼\t东区 ',
      title: oversizedItem,
      quantity: 2,
      unit: ' 件 ',
      amount: ' 1280*元 ',
      purchaseMethod: ' **综合\r\n采购** ',
      expectedDeliveryAt: ' <2026-07-21>\r\n17:00 ',
      requestCode: oversizedRequestCode,
      createdAt: ' 2026-07-16\r\n09:30 ',
      statusLabel: ' **待审批** ',
    };
    const card = buildPurchaseApprovalCard(input);
    const contents = collectContent(card);
    const content = contents.join('\n');

    expect(content).not.toContain('\u0000');
    expect(content).not.toContain('<script>');
    expect(content).toContain('\\<script\\> 张 三');
    expect(content).toContain('H楼 东区');
    expect(content).toContain('2 件');
    expect(content).not.toContain('传感器'.repeat(100));
    expect(content).toContain('\\*\\*待审批\\*\\*');
    expect(content).toContain('1280\\*元');
    expect(content).toContain('\\*\\*综合 采购\\*\\*');
    expect(content).toContain('\\<2026-07-21\\> 17:00');
    expect(contents).toContain(`**单号**\nPR-${'单'.repeat(196)}…`);
  });

  it('renders 未提供 for empty optional approval fields', () => {
    const input = {
      executionRecordId: 'rec_empty_fields',
      requester: '张三',
      building: 'H楼',
      title: '温湿度传感器',
      quantity: 3,
      unit: '个',
      amount: null,
      purchaseMethod: ' \u0000\r\n ',
      expectedDeliveryAt: null,
      requestCode: '',
      createdAt: '2026-07-16 09:30',
      statusLabel: '未开始（待审批）',
    };
    const contents = collectContent(buildPurchaseApprovalCard(input));

    for (const label of ['金额', '采购方式', '计划到货', '单号']) {
      expect(contents).toContain(`**${label}**\n未提供`);
    }
  });

  it.each(['', '   ', '../rec?token=secret', 'a'.repeat(101)])(
    'rejects an invalid execution record id: %j',
    (executionRecordId) => {
      expect(() =>
        buildPurchaseApprovalCard({
          executionRecordId,
          requester: '张三',
          building: 'H楼',
          title: '传感器',
          quantity: 1,
          unit: '个',
          createdAt: '2026-07-16 09:30',
          statusLabel: '待审批',
        }),
      ).toThrow(BadRequestException);
    },
  );
});

describe('buildResolvedPurchaseApprovalCard', () => {
  it.each([
    ['approve', '已确认'],
    ['reject', '已驳回'],
  ] as const)(
    'builds a non-interactive Feishu JSON 2.0 card for %s',
    (decision, decisionLabel) => {
      const input = {
        executionRecordId: 'rec_exec_01-A',
        requester: '张三',
        building: 'H楼',
        title: '温湿度传感器',
        quantity: 3,
        unit: '个',
        amount: 1280.5,
        purchaseMethod: '综合采购',
        expectedDeliveryAt: '2026-07-21 17:00',
        requestCode: 'PR-202607-001',
        createdAt: '2026-07-16 09:30',
        statusLabel: '未开始（待审批）',
      };
      const card = buildResolvedPurchaseApprovalCard(input, {
        decision,
        actorName: '李四',
        processedAt: '2026-07-17 10:45',
      });

      expect(card).toMatchObject({ schema: '2.0' });
      const content = collectContent(card).join('\n');
      for (const expected of [
        '申请人',
        '张三',
        '楼栋',
        'H楼',
        '物品',
        '温湿度传感器',
        '数量',
        '3 个',
        '金额',
        '1280.5',
        '采购方式',
        '综合采购',
        '计划到货',
        '2026-07-21 17:00',
        '单号',
        'PR-202607-001',
        '申请时间',
        '2026-07-16 09:30',
        '状态',
        '未开始（待审批）',
        '处理结果',
        decisionLabel,
        '处理人',
        '李四',
        '处理时间',
        '2026-07-17 10:45',
      ]) {
        expect(content).toContain(expected);
      }

      const serialized = JSON.stringify(card);
      for (const forbidden of [
        '"action"',
        '"tag":"button"',
        '"behaviors"',
        '"callback"',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );
});

describe('buildWarehouseInboundCard', () => {
  const inboundRecord: PurchaseWorkflowRecord = {
    recordId: 'rec_inbound_1',
    requestCode: 'CG-202607-001',
    status: '到货已签收（待入库）',
    itemName: '润滑油',
    building: 'D楼',
    requesterOpenId: 'ou_requester',
    requesterName: '陶必亮',
    purchaserOpenId: 'ou_purchaser',
    purchaserName: '曹李培',
    purchaseMethod: '综合采购',
    requestedQuantity: 10,
    actualQuantity: 8,
    actualAmount: 1095,
    approvalCompleted: true,
    warehouseConfirmed: true,
    purchaseCompleted: true,
    receiptConfirmed: true,
    signer: '陶必亮',
    receiptTime: 1784246400000,
    receiptPhotoTokens: [],
    invoiceTokens: [],
    unit: '件',
  };

  it('builds a JSON 2.0 inbound card with current receipt fields and the exact inventory deep link', () => {
    const card = buildWarehouseInboundCard(
      inboundRecord,
      'https://ops.example.com/',
    );
    const content = collectContent(card).join('\n');

    expect(card).toMatchObject({ schema: '2.0' });
    for (const expected of [
      '物品',
      '润滑油',
      '实际到货数量',
      '8 件',
      '申请人',
      '陶必亮',
      '采购人',
      '曹李培',
      '楼栋',
      'D楼',
      '签收人',
      '签收时间',
      '1784246400000',
      '单号',
      'CG-202607-001',
    ]) {
      expect(content).toContain(expected);
    }
    expect(JSON.stringify(card)).toContain(
      'https://ops.example.com/inventory-management?view=inbound&purchase=rec_inbound_1',
    );
  });

  it('falls back to requested quantity and encodes the record id in the inventory link', () => {
    const card = buildWarehouseInboundCard(
      {
        ...inboundRecord,
        recordId: 'rec inbound/二',
        actualQuantity: null,
        requestedQuantity: 3,
      },
      'http://127.0.0.1:5173',
    );
    const content = collectContent(card).join('\n');

    expect(content).toContain('3 件');
    expect(JSON.stringify(card)).toContain(
      'http://127.0.0.1:5173/inventory-management?view=inbound&purchase=rec%20inbound%2F%E4%BA%8C',
    );
  });

  it('renders an empty purchaser as not provided', () => {
    const contents = collectContent(
      buildWarehouseInboundCard(
        { ...inboundRecord, purchaserName: '' },
        'https://ops.example.com',
      ),
    );

    expect(contents).toContain('**采购人**\n未提供');
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:8080',
    'http://[::1]:3000',
  ])('allows loopback HTTP for local development: %s', (publicBaseUrl) => {
    expect(() =>
      buildWarehouseInboundCard(inboundRecord, publicBaseUrl),
    ).not.toThrow();
  });

  it.each([
    ['', 'PUBLIC_BASE_URL 未配置'],
    ['not-a-url', 'PUBLIC_BASE_URL 配置无效'],
    ['ftp://secret.example.com/token', 'PUBLIC_BASE_URL 配置无效'],
    ['https://user:secret@example.com', 'PUBLIC_BASE_URL 配置无效'],
    ['http://ops.example.com:8080', 'PUBLIC_BASE_URL 配置无效'],
  ])(
    'fails safely for an invalid public base URL',
    (publicBaseUrl, message) => {
      let error: unknown;
      try {
        buildWarehouseInboundCard(inboundRecord, publicBaseUrl);
      } catch (reason) {
        error = reason;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain('secret');
    },
  );
});

describe('buildInventoryInboundCompletedCard', () => {
  it('builds a non-interactive inbound success card with the completed inventory facts', () => {
    const buildInventoryInboundCompletedCard = (
      purchaseWorkflowCards as typeof purchaseWorkflowCards & {
        buildInventoryInboundCompletedCard(
          record: PurchaseWorkflowRecord,
          details?: { sku?: string; specification?: string; location?: string },
        ): Record<string, unknown>;
      }
    ).buildInventoryInboundCompletedCard;
    const card = buildInventoryInboundCompletedCard(
      {
        recordId: 'rec_inbound_completed_1',
        requestCode: 'CG-202608-024',
        status: '物品签收已入库',
        itemName: '地磅秤',
        specification: '称重范围 5 吨',
        building: 'H楼',
        requesterOpenId: 'ou_requester',
        requesterName: '申请人',
        purchaserOpenId: 'ou_purchaser',
        purchaserName: '采购人',
        purchaseMethod: '综合采购',
        requestedQuantity: 1,
        actualQuantity: 1,
        actualAmount: 1000,
        approvalCompleted: true,
        warehouseConfirmed: true,
        purchaseCompleted: true,
        receiptConfirmed: true,
        signer: '签收人',
        receiptTime: 1784246400000,
        receiptPhotoTokens: [],
        invoiceTokens: [],
        unit: '台',
      },
      { sku: 'D1373', location: 'H-2F-226储存间01-OF' },
    );
    const content = collectContent(card).join('\n');

    expect(card).toMatchObject({ schema: '2.0' });
    for (const expected of [
      '入库成功',
      '物品',
      '地磅秤',
      'D1373',
      '称重范围 5 吨',
      'H-2F-226储存间01-OF',
      '数量',
      '1 台',
      '楼栋',
      'H楼',
      '采购单号',
      'CG-202608-024',
    ]) {
      expect(content).toContain(expected);
    }
    expect(collectButtons(card)).toEqual([]);
    expect(JSON.stringify(card)).not.toMatch(/callback|behaviors/);
  });
});

describe('buildManualInventoryInboundCompletedCard', () => {
  it('builds a non-interactive manual inbound success card with all inventory facts', () => {
    const card = buildManualInventoryInboundCompletedCard({
      name: '地磅秤',
      sku: 'B1056',
      specification: '0.6*0.8米 1吨',
      quantity: 1,
      unit: '台',
      building: 'H楼',
      location: 'H-2F-226储存间01-0F',
      occurredAt: '2026-08-26T09:30:00.000+08:00',
    });
    const content = collectContent(card).join('\n');

    expect(card).toMatchObject({ schema: '2.0' });
    for (const expected of [
      '手工入库成功',
      '物品',
      '地磅秤',
      '类别号',
      'B1056',
      '规格',
      '0.6\\*0.8米 1吨',
      '数量',
      '1 台',
      '楼栋',
      'H楼',
      '存放位置',
      'H-2F-226储存间01-0F',
      '入库时间',
      '2026-08-26T09:30:00.000+08:00',
    ]) {
      expect(content).toContain(expected);
    }
    expect(collectButtons(card)).toEqual([]);
    expect(JSON.stringify(card)).not.toMatch(/callback|behaviors/);
  });

  it('renders the quantity without a dangling placeholder when unit is empty', () => {
    const card = buildManualInventoryInboundCompletedCard({
      name: '备用物品',
      sku: 'D2001',
      specification: '通用',
      quantity: 2,
      unit: '',
      building: 'H楼',
      location: 'H库房',
      occurredAt: '2026-08-26T10:00:00.000+08:00',
    });
    const content = collectContent(card);

    expect(content).toContain('**数量**\n2');
    expect(content).not.toContain('2 未提供');
  });

  it('renders a missing inbound time as not provided', () => {
    const card = buildManualInventoryInboundCompletedCard({
      name: '备用物品',
      sku: 'D2001',
      specification: '通用',
      quantity: 2,
      unit: '件',
      building: 'H楼',
      location: 'H库房',
      occurredAt: null,
    });

    expect(collectContent(card)).toContain('**入库时间**\n未提供');
  });
});
