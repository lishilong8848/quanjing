import { HttpService } from '@nestjs/axios';
import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import { invalidateBitableRecordCache } from '../../common/feishu/bitable-direct-read';
import type {
  InventoryManagerNotificationHandover,
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalRecoveredResultDelivery,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';
import { normalizeInventoryOutboundRejectionReason } from './inventory-outbound-approval.validation';
import { normalizeInventoryManagerNotificationHandovers } from './inventory-manager-notification-route';

const FEISHU_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const INTERACTIVE_CARD_MAX_BYTES = 30 * 1_024;
const RECOVERY_PAGE_SIZE = 100;
const RECOVERY_MAXIMUM_PAGES = 20;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const APP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{3,128}$/u;
const TABLE_ID_PATTERN = /^tbl[A-Za-z0-9_-]{1,124}$/u;
const RFC_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const RECOVERABLE_WORKFLOW_STATUSES = new Set(['待路由', '待审批', '同步异常']);
const OUTBOUND_RECOVERY_FIELD_NAMES = [
  '物品类别号',
  '物品申请人',
  '楼栋',
  '出库原因/出库后使用地点',
  '程序出库状态',
  '程序出库申请数量',
  '程序出库申请时间',
  '出库数量',
  '出库时间',
  '出库创建标识',
  '出库请求指纹',
  '出库工作流状态',
  '出库当前审批人',
  '出库实际审批人',
  '出库审批时间',
  '出库审批策略版本',
  '出库驳回原因',
  '出库审批动作标识',
  '出库工作流错误',
  '出库审批快照',
  '出库审批投递台账',
  '出库审批收尾状态',
  '出库审批结果投递台账',
] as const;

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface InventoryOutboundBaseConfig {
  appToken: string;
  tableId: string;
}

type FieldExpectation =
  | { field: string; kind: 'text' | 'select'; value: string }
  | { field: string; kind: 'users'; value: string[] }
  | { field: string; kind: 'date'; value: number };

export interface InventoryOutboundApprovalBitableRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface InventoryOutboundApprovalDeliveryReceipt {
  recipientOpenId: string;
  recipientName: string;
  deliveryUuid: string;
  messageId: string;
}

export class InventoryOutboundApprovalSyncUnconfirmedException extends BadGatewayException {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
  }
}

@Injectable()
export class InventoryOutboundApprovalGateway {
  private tenantToken: TenantTokenState | null = null;
  private tenantTokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async sendInteractiveCard(
    recipientOpenId: string,
    card: Record<string, unknown>,
    deliveryUuid: string,
  ): Promise<string> {
    const recipient = requireOpenId(recipientOpenId);
    const uuid = requireRfcUuid(deliveryUuid);
    const content = serializeInteractiveCard(card);
    const token = await this.getTenantAccessToken();
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          receive_id: recipient,
          msg_type: 'interactive',
          content,
          uuid,
        },
        requestConfig(token),
      );
    } catch (error) {
      throw normalizeFeishuHttpError(error, '发送出库审批卡片失败');
    }
    assertFeishuSuccess(response.data, '发送出库审批卡片失败');
    const messageId = clean(
      (response.data as { data?: { message_id?: unknown } } | undefined)?.data
        ?.message_id,
    );
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadGatewayException(
        '发送出库审批卡片失败：响应缺少有效 message_id',
      );
    }
    return messageId;
  }

  async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const normalizedMessageId = requireMessageId(messageId);
    const content = serializeInteractiveCard(card);
    const token = await this.getTenantAccessToken();
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.patch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(normalizedMessageId)}`,
        { content },
        requestConfig(token),
      );
    } catch (error) {
      throw normalizeFeishuHttpError(error, '更新出库审批卡片失败');
    }
    assertFeishuSuccess(response.data, '更新出库审批卡片失败');
  }

  async readOutboundRecord(
    recordId: string,
  ): Promise<InventoryOutboundApprovalBitableRecord> {
    const normalizedRecordId = requireRecordId(recordId);
    const config = this.outboundConfig();
    const token = await this.getTenantAccessToken();
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.get(
        `${recordsUrl(config)}/${encodeURIComponent(normalizedRecordId)}`,
        requestConfig(token),
      );
    } catch (error) {
      throw normalizeFeishuHttpError(error, '读取出库审批多维记录失败');
    }
    assertFeishuSuccess(response.data, '读取出库审批多维记录失败');
    const record = (
      response.data as {
        data?: {
          record?: {
            id?: unknown;
            record_id?: unknown;
            fields?: unknown;
          };
        };
      }
    )?.data?.record;
    const responseRecordId = clean(record?.record_id || record?.id);
    if (
      !record ||
      responseRecordId !== normalizedRecordId ||
      !isPlainObject(record.fields)
    ) {
      throw new BadGatewayException(
        '读取出库审批多维记录失败：响应缺少目标记录或字段',
      );
    }
    return {
      recordId: responseRecordId,
      fields: clone(record.fields),
    };
  }

  async listRecoveryRecords(): Promise<
    InventoryOutboundApprovalBitableRecord[]
  > {
    const config = this.outboundConfig();
    const token = await this.getTenantAccessToken();
    const records = new Map<string, InventoryOutboundApprovalBitableRecord>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let page = 1; page <= RECOVERY_MAXIMUM_PAGES; page += 1) {
      let response: { data?: unknown };
      try {
        response = await this.httpService.axiosRef.post(
          `${recordsUrl(config)}/search`,
          {
            field_names: OUTBOUND_RECOVERY_FIELD_NAMES,
            filter: {
              conjunction: 'or',
              conditions: [
                ...[...RECOVERABLE_WORKFLOW_STATUSES].map((status) => ({
                  field_name: '出库工作流状态',
                  operator: 'is',
                  value: [status],
                })),
                {
                  field_name: '出库审批收尾状态',
                  operator: 'is',
                  value: ['待收尾'],
                },
              ],
            },
          },
          {
            ...requestConfig(token),
            params: {
              page_size: RECOVERY_PAGE_SIZE,
              page_token: pageToken,
            },
          },
        );
      } catch (error) {
        throw normalizeFeishuHttpError(error, '读取出库审批恢复记录失败');
      }
      assertFeishuSuccess(response.data, '读取出库审批恢复记录失败');
      const data = (response.data as { data?: unknown } | undefined)?.data;
      if (!isPlainObject(data) || !Array.isArray(data.items)) {
        throw new BadGatewayException(
          '读取出库审批恢复记录失败：响应缺少有效分页数据',
        );
      }

      for (const item of data.items) {
        const record = parseRecoveryRecord(item);
        if (
          (RECOVERABLE_WORKFLOW_STATUSES.has(
            extractSemanticText(record.fields['出库工作流状态']),
          ) ||
            extractSemanticText(record.fields['出库审批收尾状态']) ===
              '待收尾') &&
          !records.has(record.recordId)
        ) {
          records.set(record.recordId, record);
        }
      }

      const hasMore = data.has_more === true;
      if (!hasMore) return clone([...records.values()]);
      if (page === RECOVERY_MAXIMUM_PAGES) {
        throw new BadGatewayException(
          `读取出库审批恢复记录失败：分页超过 ${RECOVERY_MAXIMUM_PAGES} 页`,
        );
      }
      const nextPageToken = clean(data.page_token);
      if (!nextPageToken) {
        throw new BadGatewayException(
          '读取出库审批恢复记录失败：响应缺少分页标识',
        );
      }
      if (seenPageTokens.has(nextPageToken)) {
        throw new BadGatewayException('读取出库审批恢复记录失败：分页标识重复');
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }

    throw new BadGatewayException('读取出库审批恢复记录失败：分页未正常结束');
  }

  async writeWorkflowError(recordId: string, error: unknown): Promise<void> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedError = normalizeWorkflowError(error);
    await this.updateAndVerify(
      normalizedRecordId,
      { 出库工作流错误: normalizedError },
      [{ field: '出库工作流错误', kind: 'text', value: normalizedError }],
      '写入出库工作流错误',
    );
  }

  async clearWorkflowError(recordId: string): Promise<void> {
    const normalizedRecordId = requireRecordId(recordId);
    await this.updateAndVerify(
      normalizedRecordId,
      { 出库工作流错误: '' },
      [{ field: '出库工作流错误', kind: 'text', value: '' }],
      '清除出库工作流错误',
    );
  }

  async writePendingApproval(
    snapshot: InventoryOutboundApprovalSnapshot,
  ): Promise<void> {
    const recordId = requireRecordId(snapshot?.recordId);
    const policyVersion = requireText(
      snapshot?.policyVersion,
      '出库审批策略版本',
      256,
    );
    const approvers = unique(
      (snapshot?.approvers || []).map((approver) =>
        requireOpenId(approver?.openId),
      ),
    );
    if (approvers.length === 0) {
      throw new BadRequestException('出库当前审批人不能为空');
    }
    const persistedSnapshot = serializeApprovalSnapshot(snapshot);
    const fields: Record<string, unknown> = {
      程序出库状态: '待审批',
      出库工作流状态: '待审批',
      出库当前审批人: approvers.map((id) => ({ id })),
      出库审批策略版本: policyVersion,
      出库工作流错误: '',
      出库审批快照: persistedSnapshot,
    };
    await this.updateAndVerify(
      recordId,
      fields,
      [
        { field: '程序出库状态', kind: 'select', value: '待审批' },
        { field: '出库工作流状态', kind: 'select', value: '待审批' },
        { field: '出库当前审批人', kind: 'users', value: approvers },
        {
          field: '出库审批策略版本',
          kind: 'text',
          value: policyVersion,
        },
        { field: '出库工作流错误', kind: 'text', value: '' },
        {
          field: '出库审批快照',
          kind: 'text',
          value: persistedSnapshot,
        },
      ],
      '写入待审批状态',
    );
  }

  async writePendingHandover(
    previous: InventoryOutboundApprovalSnapshot,
    replacement: InventoryOutboundApprovalSnapshot,
  ): Promise<void> {
    const recordId = requireRecordId(previous?.recordId);
    if (replacement?.recordId !== recordId || requireApprovalVersion(replacement.version) !== requireApprovalVersion(previous.version) + 1) {
      throw new BadRequestException('出库交接必须绑定同一记录的下一待审批版本');
    }
    const current = await this.readOutboundRecord(recordId);
    const common: FieldExpectation[] = [
      { field: '程序出库状态', kind: 'select', value: '待审批' },
      { field: '出库工作流状态', kind: 'select', value: '待审批' },
      { field: '出库实际审批人', kind: 'users', value: [] },
      { field: '出库审批动作标识', kind: 'text', value: '' },
      { field: '出库审批时间', kind: 'text', value: '' },
      { field: '出库确认标识', kind: 'text', value: '' },
    ];
    const expected = (snapshot: InventoryOutboundApprovalSnapshot): FieldExpectation[] => [
      ...common,
      { field: '出库当前审批人', kind: 'users', value: unique(snapshot.approvers.map(person => requireOpenId(person.openId))) },
      { field: '出库审批策略版本', kind: 'text', value: requireText(snapshot.policyVersion, '出库审批策略版本', 256) },
      { field: '出库审批快照', kind: 'text', value: serializeApprovalSnapshot(snapshot) },
    ];
    if (!verifySemanticFields(current.fields, expected(replacement)).length) return;
    if (verifySemanticFields(current.fields, expected(previous)).length) throw new ConflictException('原出库待审批状态已变化，不能交接');
    await this.updateAndVerify(recordId, {
      出库当前审批人: replacement.approvers.map(person => ({ id: requireOpenId(person.openId) })),
      出库审批策略版本: replacement.policyVersion,
      出库审批快照: serializeApprovalSnapshot(replacement),
      出库审批投递台账: '',
      出库工作流错误: '',
    }, [...expected(replacement), { field: '出库审批投递台账', kind: 'text', value: '' }], '交接出库待审批');
  }

  async writeReroutedPendingApproval(
    previousSnapshot: InventoryOutboundApprovalSnapshot,
    previousDecision: InventoryOutboundApprovalDecision,
    replacementSnapshot: InventoryOutboundApprovalSnapshot,
  ): Promise<void> {
    const recordId = requireRecordId(previousSnapshot?.recordId);
    const previousVersion = requireApprovalVersion(previousSnapshot?.version);
    const replacementVersion = requireApprovalVersion(
      replacementSnapshot?.version,
    );
    const previousPolicyVersion = requireText(
      previousSnapshot?.policyVersion,
      '旧出库审批策略版本',
      256,
    );
    const replacementPolicyVersion = requireText(
      replacementSnapshot?.policyVersion,
      '新出库审批策略版本',
      256,
    );
    const previousActorOpenId = requireOpenId(previousDecision?.actorOpenId);
    const previousEventId = requireText(
      previousDecision?.eventId,
      '旧出库审批动作标识',
      256,
    );
    const previousDecidedAt = requireDateTime(previousDecision?.decidedAt);
    if (
      previousDecision?.action !== 'approve' ||
      replacementSnapshot?.recordId !== recordId ||
      replacementVersion !== previousVersion + 1
    ) {
      throw new BadRequestException('出库审批替代版本与旧审批决定不一致');
    }
    if (
      !(previousSnapshot?.approvers || []).some(
        (approver) => requireOpenId(approver?.openId) === previousActorOpenId,
      )
    ) {
      throw new BadRequestException('旧出库审批人不在旧审批快照中');
    }
    const replacementApprovers = unique(
      (replacementSnapshot?.approvers || []).map((approver) =>
        requireOpenId(approver?.openId),
      ),
    );
    if (replacementApprovers.length === 0) {
      throw new BadRequestException('新出库当前审批人不能为空');
    }
    const previousSerializedSnapshot =
      serializeApprovalSnapshot(previousSnapshot);
    const replacementSerializedSnapshot =
      serializeApprovalSnapshot(replacementSnapshot);
    const current = await this.readOutboundRecord(recordId);
    if (
      verifySemanticFields(current.fields, [
        { field: '程序出库状态', kind: 'select', value: '待审批' },
        { field: '出库工作流状态', kind: 'select', value: '待审批' },
        {
          field: '出库当前审批人',
          kind: 'users',
          value: replacementApprovers,
        },
        { field: '出库实际审批人', kind: 'users', value: [] },
        { field: '出库审批时间', kind: 'text', value: '' },
        {
          field: '出库审批策略版本',
          kind: 'text',
          value: replacementPolicyVersion,
        },
        { field: '出库驳回原因', kind: 'text', value: '' },
        { field: '出库审批动作标识', kind: 'text', value: '' },
        { field: '出库审批投递台账', kind: 'text', value: '' },
        { field: '出库审批收尾状态', kind: 'text', value: '' },
        { field: '出库审批结果投递台账', kind: 'text', value: '' },
        {
          field: '出库审批快照',
          kind: 'text',
          value: replacementSerializedSnapshot,
        },
        { field: '出库确认标识', kind: 'text', value: '' },
      ]).length === 0
    ) {
      return;
    }

    const preconditionMismatches = verifySemanticFields(current.fields, [
      { field: '程序出库状态', kind: 'select', value: '待库房确认' },
      { field: '出库工作流状态', kind: 'select', value: '已通过' },
      { field: '出库当前审批人', kind: 'users', value: [] },
      {
        field: '出库实际审批人',
        kind: 'users',
        value: [previousActorOpenId],
      },
      { field: '出库审批时间', kind: 'date', value: previousDecidedAt },
      {
        field: '出库审批策略版本',
        kind: 'text',
        value: previousPolicyVersion,
      },
      {
        field: '出库审批动作标识',
        kind: 'text',
        value: previousEventId,
      },
      {
        field: '出库审批快照',
        kind: 'text',
        value: previousSerializedSnapshot,
      },
      { field: '出库确认标识', kind: 'text', value: '' },
    ]);
    if (preconditionMismatches.length > 0) {
      throw new ConflictException(
        `旧出库审批状态已变化，不能重新路由（${preconditionMismatches.join('、')}）`,
      );
    }

    const fields: Record<string, unknown> = {
      程序出库状态: '待审批',
      出库工作流状态: '待审批',
      出库当前审批人: replacementApprovers.map((id) => ({ id })),
      出库实际审批人: [],
      出库审批时间: null,
      出库审批策略版本: replacementPolicyVersion,
      出库驳回原因: '',
      出库审批动作标识: '',
      出库工作流错误: '',
      出库审批快照: replacementSerializedSnapshot,
      出库审批投递台账: '',
      出库审批收尾状态: null,
      出库审批结果投递台账: '',
      出库确认标识: '',
    };
    await this.updateAndVerify(
      recordId,
      fields,
      [
        { field: '程序出库状态', kind: 'select', value: '待审批' },
        { field: '出库工作流状态', kind: 'select', value: '待审批' },
        {
          field: '出库当前审批人',
          kind: 'users',
          value: replacementApprovers,
        },
        { field: '出库实际审批人', kind: 'users', value: [] },
        { field: '出库审批时间', kind: 'text', value: '' },
        {
          field: '出库审批策略版本',
          kind: 'text',
          value: replacementPolicyVersion,
        },
        { field: '出库驳回原因', kind: 'text', value: '' },
        { field: '出库审批动作标识', kind: 'text', value: '' },
        { field: '出库工作流错误', kind: 'text', value: '' },
        {
          field: '出库审批快照',
          kind: 'text',
          value: replacementSerializedSnapshot,
        },
        { field: '出库审批投递台账', kind: 'text', value: '' },
        { field: '出库审批收尾状态', kind: 'text', value: '' },
        { field: '出库审批结果投递台账', kind: 'text', value: '' },
        { field: '出库确认标识', kind: 'text', value: '' },
      ],
      '重新路由待审批状态',
    );
  }

  async writeApprovalCardDeliveryLedger(
    snapshot: InventoryOutboundApprovalSnapshot,
    deliveriesValue: InventoryOutboundApprovalDeliveryReceipt[],
  ): Promise<void> {
    const recordId = requireRecordId(snapshot?.recordId);
    const version = requireApprovalVersion(snapshot?.version);
    if (!Array.isArray(deliveriesValue) || deliveriesValue.length === 0) {
      throw new BadRequestException('出库审批投递台账不能为空');
    }
    const approvers = new Map(
      (snapshot?.approvers || []).map((approver) => [
        requireOpenId(approver?.openId),
        requireText(approver?.name, '出库审批人姓名', 128),
      ]),
    );
    const seenRecipients = new Set<string>();
    const deliveries = deliveriesValue
      .map((delivery) => {
        const recipientOpenId = requireOpenId(delivery?.recipientOpenId);
        const recipientName = requireText(
          delivery?.recipientName,
          '出库审批卡接收人姓名',
          128,
        );
        if (
          approvers.get(recipientOpenId) !== recipientName ||
          seenRecipients.has(recipientOpenId)
        ) {
          throw new BadRequestException('出库审批投递台账与审批人快照不一致');
        }
        seenRecipients.add(recipientOpenId);
        return {
          recipientOpenId,
          recipientName,
          deliveryUuid: requireRfcUuid(delivery?.deliveryUuid),
          messageId: requireMessageId(delivery?.messageId),
        };
      })
      .sort((left, right) =>
        left.recipientOpenId.localeCompare(right.recipientOpenId),
      );
    const serializedLedger = JSON.stringify({
      schemaVersion: 1,
      recordId,
      version,
      deliveries,
    });
    await this.updateAndVerify(
      recordId,
      { 出库审批投递台账: serializedLedger },
      [
        {
          field: '出库审批投递台账',
          kind: 'text',
          value: serializedLedger,
        },
      ],
      '写入出库审批投递台账',
    );
  }

  async writeApprovalResultDeliveryLedger(
    snapshot: InventoryOutboundApprovalSnapshot,
    decision: InventoryOutboundApprovalDecision,
    deliveriesValue: InventoryOutboundApprovalRecoveredResultDelivery[],
    managerNotificationHandoversValue?: InventoryManagerNotificationHandover[],
  ): Promise<void> {
    const recordId = requireRecordId(snapshot?.recordId);
    const version = requireApprovalVersion(snapshot?.version);
    const decisionEventId = requireText(
      decision?.eventId,
      '出库审批动作标识',
      256,
    );
    if (decision?.action !== 'approve' && decision?.action !== 'reject') {
      throw new BadRequestException('出库审批动作无效');
    }
    if (!Array.isArray(deliveriesValue) || deliveriesValue.length === 0) {
      throw new BadRequestException('出库审批结果投递台账不能为空');
    }

    const approvers = new Set(
      (snapshot?.approvers || []).map((approver) =>
        requireOpenId(approver?.openId),
      ),
    );
    if (!approvers.has(requireOpenId(decision?.actorOpenId))) {
      throw new BadRequestException('出库审批决议与审批人快照不一致');
    }
    const recipientNames = new Map<string, string>();
    const managerNotificationHandovers = normalizeInventoryManagerNotificationHandovers(
      managerNotificationHandoversValue, snapshot,
    );
    const registerRecipient = (openIdValue: unknown, nameValue: unknown) => {
      const openId = requireOpenId(openIdValue);
      const name = requireText(nameValue, '出库审批结果接收人姓名', 128);
      if (!recipientNames.has(openId)) {
        recipientNames.set(openId, name);
      }
    };
    registerRecipient(snapshot?.applicantOpenId, snapshot?.applicantName);
    (snapshot?.approvers || []).forEach((approver) =>
      registerRecipient(approver?.openId, approver?.name),
    );
    (snapshot?.managerRecipients || []).forEach((manager) =>
      registerRecipient(manager?.openId, manager?.name),
    );
    managerNotificationHandovers.forEach(({ target }) =>
      registerRecipient(target.openId, target.name),
    );

    const seenRecipients = new Set<string>();
    const seenDeliveryUuids = new Set<string>();
    const seenMessageIds = new Set<string>();
    const deliveries = deliveriesValue
      .map((delivery) => {
        const recipientOpenId = requireOpenId(delivery?.recipientOpenId);
        const recipientName = requireText(
          delivery?.recipientName,
          '出库审批结果接收人姓名',
          128,
        );
        if (recipientNames.get(recipientOpenId) !== recipientName) {
          throw new BadRequestException(
            '出库审批结果接收人与申请人或审批人快照、管理人知会快照不一致',
          );
        }
        const deliveryUuid = requireRfcUuid(delivery?.deliveryUuid);
        const expectedDeliveryUuid = stableUuid(
          `inventory-outbound-approval-result:${recordId}:${version}:${decision.action}:${recipientOpenId}`,
        );
        if (deliveryUuid !== expectedDeliveryUuid) {
          throw new BadRequestException('出库审批结果投递 UUID 与决议不一致');
        }
        const messageId = requireMessageId(delivery?.messageId);
        if (
          seenRecipients.has(recipientOpenId) ||
          seenDeliveryUuids.has(deliveryUuid) ||
          seenMessageIds.has(messageId)
        ) {
          throw new BadRequestException('出库审批结果投递台账包含重复明细');
        }
        seenRecipients.add(recipientOpenId);
        seenDeliveryUuids.add(deliveryUuid);
        seenMessageIds.add(messageId);
        return {
          recipientOpenId,
          recipientName,
          deliveryUuid,
          messageId,
        };
      })
      .sort((left, right) =>
        left.recipientOpenId.localeCompare(right.recipientOpenId),
      );
    const serializedLedger = JSON.stringify({
      schemaVersion: managerNotificationHandovers.length ? 2 : 1,
      recordId,
      version,
      decisionEventId,
      decisionAction: decision.action,
      deliveries,
      ...(managerNotificationHandovers.length ? { managerNotificationHandovers } : {}),
    });
    if (Buffer.byteLength(serializedLedger, 'utf8') > INTERACTIVE_CARD_MAX_BYTES) {
      throw new BadRequestException('出库审批结果投递台账超过容量限制');
    }
    await this.updateAndVerify(
      recordId,
      { 出库审批结果投递台账: serializedLedger },
      [
        {
          field: '出库审批结果投递台账',
          kind: 'text',
          value: serializedLedger,
        },
      ],
      '写入出库审批结果投递台账',
    );
  }

  async writeFinalizationCompleted(
    snapshot: InventoryOutboundApprovalSnapshot,
  ): Promise<void> {
    const recordId = requireRecordId(snapshot?.recordId);
    requireApprovalVersion(snapshot?.version);
    await this.updateAndVerify(
      recordId,
      { 出库审批收尾状态: '已完成' },
      [{ field: '出库审批收尾状态', kind: 'select', value: '已完成' }],
      '写入出库审批收尾完成状态',
    );
  }

  async writeDecision(
    snapshot: InventoryOutboundApprovalSnapshot,
    decision: InventoryOutboundApprovalDecision,
  ): Promise<void> {
    const recordId = requireRecordId(snapshot?.recordId);
    const policyVersion = requireText(
      snapshot?.policyVersion,
      '出库审批策略版本',
      256,
    );
    const actorOpenId = requireOpenId(decision?.actorOpenId);
    const eventId = requireText(decision?.eventId, '出库审批动作标识', 256);
    const decidedAt = requireDateTime(decision?.decidedAt);
    if (decision?.action !== 'approve' && decision?.action !== 'reject') {
      throw new BadRequestException('出库审批动作无效');
    }
    const allowedApprovers = new Set(
      (snapshot?.approvers || []).map((approver) =>
        requireOpenId(approver?.openId),
      ),
    );
    if (!allowedApprovers.has(actorOpenId)) {
      throw new BadRequestException('实际审批人不在审批人快照中');
    }
    const rejectionReason =
      decision.action === 'reject'
        ? requireRejectionReason(decision.reason)
        : '';
    const programStatus =
      decision.action === 'approve' ? '待库房确认' : '已驳回';
    const workflowStatus = decision.action === 'approve' ? '已通过' : '已驳回';
    const current = await this.readOutboundRecord(recordId);
    if (
      assertDecisionDoesNotRegressTerminalRecord(
        current.fields,
        decision,
        policyVersion,
        actorOpenId,
        rejectionReason,
      )
    ) {
      return;
    }
    const fields: Record<string, unknown> = {
      程序出库状态: programStatus,
      出库工作流状态: workflowStatus,
      出库当前审批人: [],
      出库实际审批人: [{ id: actorOpenId }],
      出库审批时间: decidedAt,
      出库审批策略版本: policyVersion,
      出库审批动作标识: eventId,
      出库驳回原因: rejectionReason,
      出库工作流错误: '',
      出库审批收尾状态: '待收尾',
    };
    await this.updateAndVerify(
      recordId,
      fields,
      [
        {
          field: '程序出库状态',
          kind: 'select',
          value: programStatus,
        },
        {
          field: '出库工作流状态',
          kind: 'select',
          value: workflowStatus,
        },
        { field: '出库当前审批人', kind: 'users', value: [] },
        {
          field: '出库实际审批人',
          kind: 'users',
          value: [actorOpenId],
        },
        { field: '出库审批时间', kind: 'date', value: decidedAt },
        {
          field: '出库审批策略版本',
          kind: 'text',
          value: policyVersion,
        },
        { field: '出库审批动作标识', kind: 'text', value: eventId },
        {
          field: '出库驳回原因',
          kind: 'text',
          value: rejectionReason,
        },
        { field: '出库工作流错误', kind: 'text', value: '' },
        {
          field: '出库审批收尾状态',
          kind: 'select',
          value: '待收尾',
        },
      ],
      decision.action === 'approve' ? '写入审批通过结果' : '写入审批驳回结果',
    );
  }

  private async updateAndVerify(
    recordId: string,
    fields: Record<string, unknown>,
    expectations: FieldExpectation[],
    operationName: string,
  ): Promise<void> {
    const config = this.outboundConfig();
    const token = await this.getTenantAccessToken();
    let updateFailure: unknown;
    try {
      const response = await this.httpService.axiosRef.put(
        `${recordsUrl(config)}/${encodeURIComponent(recordId)}`,
        { fields: clone(fields) },
        requestConfig(token),
      );
      assertFeishuSuccess(response.data, `${operationName}失败`);
    } catch (error) {
      updateFailure = normalizeFeishuOperationError(
        error,
        `${operationName}失败`,
      );
    }

    let record: InventoryOutboundApprovalBitableRecord;
    try {
      record = await this.readOutboundRecord(recordId);
    } catch (error) {
      const updateDetail = updateFailure
        ? `；写入结果：${safeErrorMessage(updateFailure)}`
        : '';
      throw new InventoryOutboundApprovalSyncUnconfirmedException(
        `${operationName}结果未确认：多维表回读失败（${safeErrorMessage(error)}）${updateDetail}；可安全重试`,
      );
    }

    const mismatches = verifySemanticFields(record.fields, expectations);
    if (mismatches.length > 0) {
      const updateDetail = updateFailure
        ? `；写入结果：${safeErrorMessage(updateFailure)}`
        : '';
      throw new InventoryOutboundApprovalSyncUnconfirmedException(
        `${operationName}结果未确认：语义回读不一致（${mismatches.join('、')}）${updateDetail}；可安全重试`,
      );
    }

    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.tableId,
    });
  }

  private outboundConfig(): InventoryOutboundBaseConfig {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
    );
    const appToken = readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || source.appToken;
    const tableId = readEnv('FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID');
    if (!APP_TOKEN_PATTERN.test(appToken)) {
      throw new ServiceUnavailableException(
        '缺少有效的 FEISHU_WAREHOUSE_APP_TOKEN，且 FEISHU_WAREHOUSE_SOURCE_URL 未提供 Base app token',
      );
    }
    if (!TABLE_ID_PATTERN.test(tableId)) {
      throw new ServiceUnavailableException(
        '缺少有效的 FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
      );
    }
    return { appToken, tableId };
  }

  private async getTenantAccessToken(): Promise<string> {
    const current = Date.now();
    if (this.tenantToken && this.tenantToken.expiresAt > current) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenPromise) return this.tenantTokenPromise;
    this.tenantTokenPromise = this.fetchTenantAccessToken();
    try {
      return await this.tenantTokenPromise;
    } finally {
      this.tenantTokenPromise = null;
    }
  }

  private async fetchTenantAccessToken(): Promise<string> {
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: FEISHU_TOKEN_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      throw normalizeFeishuHttpError(error, '获取飞书租户令牌失败');
    }
    assertFeishuSuccess(response.data, '获取飞书租户令牌失败');
    const payload = response.data as {
      tenant_access_token?: unknown;
      expire?: unknown;
      data?: { tenant_access_token?: unknown; expire?: unknown };
    };
    const value = clean(
      payload.tenant_access_token || payload.data?.tenant_access_token,
    );
    if (!value) {
      throw new BadGatewayException('获取飞书租户令牌失败：响应缺少令牌');
    }
    const rawExpires = Number(payload.expire || payload.data?.expire || 7200);
    const expiresInSeconds = Number.isFinite(rawExpires)
      ? Math.max(60, rawExpires)
      : 7200;
    this.tenantToken = {
      value,
      expiresAt:
        Date.now() + Math.max(30_000, expiresInSeconds * 1_000 - 60_000),
    };
    return value;
  }
}

function recordsUrl(config: InventoryOutboundBaseConfig): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records`;
}

function parseRecoveryRecord(
  value: unknown,
): InventoryOutboundApprovalBitableRecord {
  if (!isPlainObject(value)) {
    throw new BadGatewayException('读取出库审批恢复记录失败：记录结构无效');
  }
  const recordId = clean(value.record_id || value.id);
  if (!RECORD_ID_PATTERN.test(recordId) || !isPlainObject(value.fields)) {
    throw new BadGatewayException(
      '读取出库审批恢复记录失败：记录标识或字段无效',
    );
  }
  return { recordId, fields: clone(value.fields) };
}

function requestConfig(accessToken: string): {
  headers: { Authorization: string };
  timeout: number;
} {
  if (!accessToken) {
    throw new ServiceUnavailableException('飞书访问令牌缺失');
  }
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: FEISHU_REQUEST_TIMEOUT_MS,
  };
}

function serializeInteractiveCard(card: Record<string, unknown>): string {
  if (!isPlainObject(card)) {
    throw new BadRequestException('飞书互动卡内容必须是纯对象');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(card);
  } catch {
    throw new BadRequestException('飞书互动卡内容无法序列化');
  }
  if (Buffer.byteLength(serialized, 'utf8') > INTERACTIVE_CARD_MAX_BYTES) {
    throw new BadRequestException('飞书互动卡内容不能超过 30 KB');
  }
  return serialized;
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  if (!isPlainObject(payload) || Number(payload.code) !== 0) {
    const code = isPlainObject(payload) ? Number(payload.code) : Number.NaN;
    const error = new BadGatewayException(
      `${prefix}：${feishuFailureDetail(payload)}`,
    );
    if (Number.isSafeInteger(code) && code !== 0) {
      Object.defineProperty(error, 'feishuCode', {
        value: code,
        enumerable: true,
      });
    }
    throw error;
  }
}

function normalizeFeishuOperationError(
  error: unknown,
  prefix: string,
): unknown {
  if (error instanceof BadGatewayException) return error;
  return normalizeFeishuHttpError(error, prefix);
}

function normalizeFeishuHttpError(
  error: unknown,
  prefix: string,
): BadGatewayException {
  const candidate = error as {
    response?: { status?: unknown; data?: unknown };
    code?: unknown;
  } | null;
  const status = Number(candidate?.response?.status);
  const responsePayload = candidate?.response?.data;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return new BadGatewayException(
      `${prefix}：HTTP ${status}；${feishuFailureDetail(responsePayload)}`,
    );
  }
  const networkCode = clean(candidate?.code).toUpperCase();
  return new BadGatewayException(
    networkCode
      ? `${prefix}：网络异常（${networkCode}，可安全重试）`
      : `${prefix}：网络请求失败，可安全重试`,
  );
}

function feishuFailureDetail(payload: unknown): string {
  if (!isPlainObject(payload)) return '响应缺少有效 code';
  const message = clean(payload.msg || payload.message)
    .replace(/\s+/gu, ' ')
    .slice(0, 500);
  const rawCode = payload.code;
  const code =
    typeof rawCode === 'number' || typeof rawCode === 'string'
      ? clean(String(rawCode))
      : '';
  if (message && code) return `飞书错误码 ${code}；${message}`;
  if (message) return message;
  return code ? `飞书错误码 ${code}` : '响应缺少有效 code';
}

function verifySemanticFields(
  fields: Record<string, unknown>,
  expectations: FieldExpectation[],
): string[] {
  const mismatches: string[] = [];
  for (const expectation of expectations) {
    const actual = fields[expectation.field];
    if (expectation.kind === 'users') {
      if (!sameStringSet(extractUserOpenIds(actual), expectation.value)) {
        mismatches.push(expectation.field);
      }
      continue;
    }
    if (expectation.kind === 'date') {
      if (extractDateTimeMilliseconds(actual) !== expectation.value) {
        mismatches.push(expectation.field);
      }
      continue;
    }
    if (extractSemanticText(actual) !== expectation.value) {
      mismatches.push(expectation.field);
    }
  }
  return mismatches;
}

function extractSemanticText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => extractSemanticText(item, seen))
      .join('')
      .trim();
  }
  const object = value as Record<string, unknown>;
  for (const key of ['select', 'text', 'value', 'name', 'label', 'title']) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const result = extractSemanticText(object[key], seen);
    if (result) return result;
  }
  return '';
}

function extractUserOpenIds(value: unknown): string[] {
  const result = new Set<string>();
  const seen = new Set<object>();
  const visit = (candidate: unknown, fromArray: boolean): void => {
    if (typeof candidate === 'string') {
      if (fromArray && OPEN_ID_PATTERN.test(candidate)) result.add(candidate);
      return;
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, true));
      return;
    }
    const object = candidate as Record<string, unknown>;
    for (const key of ['id', 'open_id', 'openId', 'user_id', 'userId']) {
      const openId = clean(object[key]);
      if (OPEN_ID_PATTERN.test(openId)) result.add(openId);
    }
    Object.values(object).forEach((nested) => {
      if (nested && typeof nested === 'object') visit(nested, false);
    });
  };
  visit(value, false);
  return [...result].sort();
}

function extractDateTimeMilliseconds(
  value: unknown,
  seen = new Set<object>(),
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return null;
    if (/^-?\d+(?:\.\d+)?$/u.test(normalized)) {
      return extractDateTimeMilliseconds(Number(normalized), seen);
    }
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = extractDateTimeMilliseconds(item, seen);
      if (result !== null) return result;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  for (const key of ['timestamp', 'date', 'value', 'text']) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const result = extractDateTimeMilliseconds(object[key], seen);
    if (result !== null) return result;
  }
  return null;
}

function sameStringSet(actual: string[], expected: string[]): boolean {
  const left = unique(actual).sort();
  const right = unique(expected).sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertDecisionDoesNotRegressTerminalRecord(
  fields: Record<string, unknown>,
  decision: InventoryOutboundApprovalDecision,
  policyVersion: string,
  actorOpenId: string,
  rejectionReason: string,
): boolean {
  const programStatus = extractSemanticText(fields['程序出库状态']);
  const workflowStatus = extractSemanticText(fields['出库工作流状态']);
  const approvedBusinessCompleted =
    decision.action === 'approve' && programStatus === '已出库';
  const rejectionCompleted =
    decision.action === 'reject' && programStatus === '已驳回';
  const conflictingTerminal =
    decision.action === 'approve'
      ? programStatus === '已驳回' || workflowStatus === '已驳回'
      : programStatus === '已出库' ||
        programStatus === '待库房确认' ||
        workflowStatus === '已通过';
  if (conflictingTerminal) {
    throw new ConflictException('出库记录已进入与当前审批决议冲突的终态');
  }
  if (!approvedBusinessCompleted && !rejectionCompleted) return false;

  const expectedProgramStatus =
    decision.action === 'approve' ? '已出库' : '已驳回';
  const expectedWorkflowStatus =
    decision.action === 'approve' ? '已通过' : '已驳回';
  const mismatches = verifySemanticFields(fields, [
    {
      field: '程序出库状态',
      kind: 'select',
      value: expectedProgramStatus,
    },
    {
      field: '出库工作流状态',
      kind: 'select',
      value: expectedWorkflowStatus,
    },
    { field: '出库当前审批人', kind: 'users', value: [] },
    { field: '出库实际审批人', kind: 'users', value: [actorOpenId] },
    {
      field: '出库审批时间',
      kind: 'date',
      value: requireDateTime(decision.decidedAt),
    },
    {
      field: '出库审批策略版本',
      kind: 'text',
      value: policyVersion,
    },
    {
      field: '出库审批动作标识',
      kind: 'text',
      value: decision.eventId,
    },
    {
      field: '出库驳回原因',
      kind: 'text',
      value: rejectionReason,
    },
  ]);
  if (mismatches.length > 0) {
    throw new ConflictException(
      `已完成出库记录的审批证据冲突（${mismatches.join('、')}）`,
    );
  }
  return true;
}

function requireRecordId(value: unknown): string {
  const normalized = clean(value);
  if (!RECORD_ID_PATTERN.test(normalized)) {
    throw new BadRequestException('出库记录标识无效');
  }
  return normalized;
}

function requireOpenId(value: unknown): string {
  const normalized = clean(value);
  if (!OPEN_ID_PATTERN.test(normalized)) {
    throw new BadRequestException('飞书人员 open_id 无效');
  }
  return normalized;
}

function requireMessageId(value: unknown): string {
  const normalized = clean(value);
  if (!MESSAGE_ID_PATTERN.test(normalized)) {
    throw new BadRequestException('飞书卡片消息标识无效');
  }
  return normalized;
}

function requireRfcUuid(value: unknown): string {
  if (typeof value !== 'string' || !RFC_UUID_PATTERN.test(value)) {
    throw new BadRequestException('飞书卡片投递标识必须是 RFC UUID');
  }
  return value;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  const normalized = clean(value);
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new BadRequestException(`${label}无效`);
  }
  return normalized;
}

function requireDateTime(value: unknown): number {
  const milliseconds = Date.parse(clean(value));
  if (!Number.isFinite(milliseconds)) {
    throw new BadRequestException('出库审批时间无效');
  }
  return milliseconds;
}

function requireApprovalVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new BadRequestException('出库审批版本无效');
  }
  return version;
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serializeApprovalSnapshot(
  snapshot: InventoryOutboundApprovalSnapshot,
): string {
  requireRecordId(snapshot?.recordId);
  requireApprovalVersion(snapshot?.version);
  let serialized: string;
  try {
    serialized = JSON.stringify({
      schemaVersion: snapshot.managerRecipients === undefined ? 1 : 2,
      snapshot: clone(snapshot),
    });
  } catch {
    throw new BadRequestException('出库审批快照无法序列化');
  }
  if (Buffer.byteLength(serialized, 'utf8') > INTERACTIVE_CARD_MAX_BYTES) {
    throw new BadRequestException('出库审批快照不能超过 30 KB');
  }
  return serialized;
}

function requireRejectionReason(value: unknown): string {
  const normalized = normalizeInventoryOutboundRejectionReason(value);
  if (!normalized) {
    throw new BadRequestException('出库驳回原因需填写 2–500 字');
  }
  return normalized;
}

function normalizeWorkflowError(value: unknown): string {
  const raw = value instanceof Error ? value.message : clean(value);
  const normalized = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 800);
  if (!normalized) {
    throw new BadRequestException('出库工作流错误不能为空');
  }
  return normalized;
}

function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || '未知错误');
  return message.replace(/\s+/gu, ' ').slice(0, 800);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
