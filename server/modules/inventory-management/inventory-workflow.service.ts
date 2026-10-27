import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  InventoryWorkflowCode,
  InventoryWorkflowRunResult,
  InventoryWorkflowTrigger,
  InventoryWorkflowLogItem,
  InventoryWorkflowSelfTestResponse,
} from '../../../shared/inventory-management.interface';
import {
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  parseFeishuBitableLink,
  readEnv,
} from '@server/common/config/external-services.config';
import { InventoryWorkflowGateway } from './inventory-workflow.gateway';
import {
  buildBackfillInboundFields,
  buildPurchaseAutomationActions,
  extractOpenIds,
  isItemConfirmationCandidate,
  isPurchaseBackfillCandidate,
} from './inventory-workflow.rules';
import {
  InventoryWorkflowStore,
  type InventoryWorkflowExecution,
  type InventoryWorkflowStage,
} from './inventory-workflow.store';

const WORKFLOW_NAMES: Record<InventoryWorkflowCode, string> = {
  purchase_backfill: '采购入库自动补录',
  purchase_h: '采购新增（H） 新',
  purchase_abcde: '采购新增(abcde)',
  item_confirmation: '物品确认',
};

const STAGE_ORDER: Record<InventoryWorkflowStage, number> = {
  处理中: 0,
  业务已写入: 1,
  源记录已回写: 2,
  已完成: 3,
  失败: -1,
  已清理: 4,
};

interface RunOptions {
  trigger: InventoryWorkflowTrigger;
}

interface WorkflowConfig {
  appToken: string;
  purchaseTableId: string;
  inboundTableId: string;
  outboundTableId: string;
  logTableId: string;
}

@Injectable()
export class InventoryWorkflowService {
  private readonly logger = new Logger(InventoryWorkflowService.name);
  private readonly running = new Set<InventoryWorkflowCode>();
  private readonly lastRuns = new Map<InventoryWorkflowCode, InventoryWorkflowRunResult>();

  constructor(
    private readonly gateway: InventoryWorkflowGateway,
    private readonly store: InventoryWorkflowStore,
  ) {}

  async run(
    code: InventoryWorkflowCode,
    options: RunOptions,
  ): Promise<InventoryWorkflowRunResult> {
    const startedAt = new Date();
    const result = createRunResult(code, options.trigger, startedAt);
    if (this.running.has(code)) {
      result.skipped = 1;
      result.errors.push({ recordId: '', message: '工作流正在运行，本次触发已跳过' });
      return finishRunResult(result);
    }

    this.running.add(code);
    try {
      const config = resolveWorkflowConfig();
      if (code === 'purchase_backfill') {
        await this.runBackfill(config, result);
      } else if (code === 'purchase_h' || code === 'purchase_abcde') {
        await this.runPurchase(code, config, result);
      } else {
        await this.runItemConfirmation(config, result);
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push({ recordId: '', message: safeError(error) });
    } finally {
      this.running.delete(code);
    }

    const completed = finishRunResult(result);
    this.lastRuns.set(code, completed);
    return completed;
  }

  isRunning(code: InventoryWorkflowCode): boolean {
    return this.running.has(code);
  }

  getLastRun(code: InventoryWorkflowCode): InventoryWorkflowRunResult | null {
    return this.lastRuns.get(code) || null;
  }

  async listRecentLogs(): Promise<InventoryWorkflowLogItem[]> {
    const config = resolveWorkflowConfig();
    return this.store.listRecent(config.appToken, config.logTableId, 30);
  }

  async selfTest(): Promise<InventoryWorkflowSelfTestResponse> {
    const startedAt = new Date();
    const marker = `CODEX-WORKFLOW-SELFTEST-${startedAt.getTime()}`;
    const createdRecordIds: string[] = [];
    const createdInboundRecordIds: string[] = [];
    const createdLogRecordIds: string[] = [];
    const deletedRecordIds: string[] = [];
    const checks: InventoryWorkflowSelfTestResponse['checks'] = [];
    let config: WorkflowConfig | null = null;
    let remainingRecords = 0;

    try {
      config = resolveWorkflowConfig();
      const inboundRecordId = await this.gateway.createRecord(
        config.appToken,
        config.inboundTableId,
        {
          物品类别号: marker,
          楼栋: 'H楼',
          入库数量: 0,
          入库日期: Date.now(),
          '采购入库后是否需要即可领用出库（勿点）': false,
        },
        '入库填写',
      );
      createdRecordIds.push(inboundRecordId);
      createdInboundRecordIds.push(inboundRecordId);
      const inbound = await this.gateway.getRecord(
        config.appToken,
        config.inboundTableId,
        inboundRecordId,
        '入库填写',
      );
      const inboundMatches = fieldText(inbound.fields?.['物品类别号']) === marker;
      checks.push({
        name: '真实入库写入与回读',
        success: inboundMatches,
        message: inboundMatches ? '写入字段与回读一致' : '回读标识不一致',
      });

      const log = await this.store.claim(config.appToken, config.logTableId, {
        idempotencyKey: marker,
        code: 'item_confirmation',
        workflowName: '程序工作流真实自测',
        runId: marker,
        sourceTable: '自测',
        sourceRecordId: marker,
        selfTest: true,
      });
      createdRecordIds.push(log.recordId);
      createdLogRecordIds.push(log.recordId);
      const logRead = await this.store.find(config.appToken, config.logTableId, marker);
      checks.push({
        name: '幂等日志写入与回读',
        success: logRead?.recordId === log.recordId && logRead.selfTest,
        message:
          logRead?.recordId === log.recordId && logRead.selfTest
            ? '日志标识和自测标记一致'
            : '日志回读不一致',
      });
    } catch (error) {
      checks.push({ name: '真实 Base 自测', success: false, message: safeError(error) });
    } finally {
      if (config) {
        remainingRecords = await this.cleanupSelfTestRecords(
          config,
          marker,
          createdInboundRecordIds,
          createdLogRecordIds,
          deletedRecordIds,
          checks,
        );
      }
    }

    return {
      success: checks.length > 0 && checks.every((check) => check.success),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      marker,
      createdRecordIds,
      deletedRecordIds,
      remainingRecords,
      checks,
    };
  }

  private async runBackfill(
    config: WorkflowConfig,
    result: InventoryWorkflowRunResult,
  ): Promise<void> {
    const [purchases, inbound] = await Promise.all([
      this.gateway.listRecords({
        appToken: config.appToken,
        tableId: config.purchaseTableId,
        tableName: '【引用】采购管理',
      }),
      this.gateway.listRecords({
        appToken: config.appToken,
        tableId: config.inboundTableId,
        tableName: '入库填写',
      }),
    ]);
    result.scanned = purchases.length;
    const inboundSkus = new Set(
      inbound.map((record) => fieldText(record.fields?.['物品类别号'])).filter(Boolean),
    );

    for (const record of purchases.filter(isPurchaseBackfillCandidate)) {
      result.candidates += 1;
      const sourceRecordId = getRecordId(record);
      const key = `purchase_backfill:${sourceRecordId}`;
      const existing = await this.store.find(config.appToken, config.logTableId, key);
      if (existing?.stage === '已完成') {
        result.skipped += 1;
        continue;
      }
      const sku = fieldText(record.fields?.['物品类别码']);
      if (!existing && inboundSkus.has(sku)) {
        result.skipped += 1;
        continue;
      }
      await this.processPurchaseRecord({
        config,
        result,
        record,
        key,
        inboundFields: buildBackfillInboundFields(record),
        recipients: [],
        detailButton: false,
        existing,
      });
      inboundSkus.add(sku);
    }
  }

  private async runPurchase(
    code: Extract<InventoryWorkflowCode, 'purchase_h' | 'purchase_abcde'>,
    config: WorkflowConfig,
    result: InventoryWorkflowRunResult,
  ): Promise<void> {
    const purchases = await this.gateway.listRecords({
      appToken: config.appToken,
      tableId: config.purchaseTableId,
      tableName: '【引用】采购管理',
    });
    result.scanned = purchases.length;

    for (const record of purchases) {
      const actions = buildPurchaseAutomationActions(code, record);
      for (const action of actions) {
        result.candidates += 1;
        const sourceRecordId = getRecordId(record);
        const key = `${code}:${sourceRecordId}:${action.building}`;
        const existing = await this.store.find(config.appToken, config.logTableId, key);
        if (existing?.stage === '已完成') {
          result.skipped += 1;
          continue;
        }
        await this.processPurchaseRecord({
          config,
          result,
          record,
          key,
          inboundFields: action.inboundFields,
          recipients: action.recipients,
          detailButton: action.detailButton,
          existing,
        });
      }
    }
  }

  private async processPurchaseRecord(input: {
    config: WorkflowConfig;
    result: InventoryWorkflowRunResult;
    record: BitableRecordItem;
    key: string;
    inboundFields: Record<string, unknown>;
    recipients: string[];
    detailButton: boolean;
    existing: InventoryWorkflowExecution | null;
  }): Promise<void> {
    const sourceRecordId = getRecordId(input.record);
    let execution = input.existing;
    try {
      execution = await this.store.claim(input.config.appToken, input.config.logTableId, {
        idempotencyKey: input.key,
        code: input.result.code,
        workflowName: WORKFLOW_NAMES[input.result.code],
        runId: input.result.runId,
        sourceTable: '【引用】采购管理',
        sourceRecordId,
      });

      if (!execution.targetRecordId) {
        const targetRecordId = await this.gateway.createRecord(
          input.config.appToken,
          input.config.inboundTableId,
          input.inboundFields,
          '入库填写',
        );
        execution = await this.saveExecution(input.config, {
          ...execution,
          targetRecordId,
          stage: '业务已写入',
          result: '入库记录已创建',
        });
      }

      if (STAGE_ORDER[execution.stage] < STAGE_ORDER['源记录已回写']) {
        await this.gateway.updateRecord(
          input.config.appToken,
          input.config.purchaseTableId,
          sourceRecordId,
          { 是否已入库: true },
          '【引用】采购管理',
        );
        execution = await this.saveExecution(input.config, {
          ...execution,
          stage: '源记录已回写',
          result: '采购记录已标记入库',
        });
      }

      for (const recipient of input.recipients) {
        if (execution.messageState[recipient]) continue;
        const card = purchaseNotificationCard(
          input.detailButton,
          input.detailButton
            ? this.gateway.recordLink(
                input.config.appToken,
                input.config.inboundTableId,
                execution.targetRecordId,
              )
            : '',
        );
        const messageId = await this.gateway.sendInteractiveCard(recipient, card);
        input.result.notified += 1;
        execution = await this.saveExecution(input.config, {
          ...execution,
          messageState: { ...execution.messageState, [recipient]: messageId },
        });
      }

      await this.saveExecution(input.config, {
        ...execution,
        stage: '已完成',
        result: input.recipients.length ? '入库、回写和通知均已完成' : '入库和回写均已完成',
        error: '',
        completedAt: new Date().toISOString(),
      });
      input.result.processed += 1;
    } catch (error) {
      input.result.failed += 1;
      input.result.errors.push({ recordId: sourceRecordId, message: safeError(error) });
      if (execution) {
        try {
          await this.saveExecution(input.config, {
            ...execution,
            error: safeError(error),
            result: execution.result || '处理失败，等待重试',
          });
        } catch (storeError) {
          this.logger.error(`工作流失败状态写入失败：${safeError(storeError)}`);
        }
      }
    }
  }

  private async runItemConfirmation(
    config: WorkflowConfig,
    result: InventoryWorkflowRunResult,
  ): Promise<void> {
    const records = await this.gateway.listRecords({
      appToken: config.appToken,
      tableId: config.outboundTableId,
      tableName: '出库填写',
      filter: 'CurrentValue.[是否借出本楼栋]="是"',
    });
    result.scanned = records.length;

    const cutoverAt = workflowCutoverAtMs();
    for (const record of records.filter(isItemConfirmationCandidate)) {
      if (cutoverAt && recordCreatedAtMs(record) < cutoverAt) continue;
      result.candidates += 1;
      const sourceRecordId = getRecordId(record);
      const key = `item_confirmation:${sourceRecordId}`;
      let execution = await this.store.find(config.appToken, config.logTableId, key);
      if (execution?.stage === '已完成') {
        result.skipped += 1;
        continue;
      }
      try {
        execution = await this.store.claim(config.appToken, config.logTableId, {
          idempotencyKey: key,
          code: 'item_confirmation',
          workflowName: WORKFLOW_NAMES.item_confirmation,
          runId: result.runId,
          sourceTable: '出库填写',
          sourceRecordId,
        });
        const recipients = extractOpenIds(record.fields?.['应入库管理员']);
        if (!recipients.length) throw new Error('未解析到应入库管理员');
        for (const recipient of recipients) {
          if (execution.messageState[recipient]) continue;
          const messageId = await this.gateway.sendInteractiveCard(
            recipient,
            itemConfirmationCard(),
          );
          result.notified += 1;
          execution = await this.saveExecution(config, {
            ...execution,
            messageState: { ...execution.messageState, [recipient]: messageId },
          });
        }
        await this.saveExecution(config, {
          ...execution,
          stage: '已完成',
          result: '物品确认通知已发送',
          error: '',
          completedAt: new Date().toISOString(),
        });
        result.processed += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ recordId: sourceRecordId, message: safeError(error) });
        if (execution) {
          try {
            await this.saveExecution(config, { ...execution, error: safeError(error) });
          } catch (storeError) {
            this.logger.error(`物品确认失败状态写入失败：${safeError(storeError)}`);
          }
        }
      }
    }
  }

  private saveExecution(
    config: WorkflowConfig,
    execution: InventoryWorkflowExecution,
  ): Promise<InventoryWorkflowExecution> {
    return this.store.update(config.appToken, config.logTableId, execution);
  }

  private async cleanupSelfTestRecords(
    config: WorkflowConfig,
    marker: string,
    createdInboundRecordIds: string[],
    createdLogRecordIds: string[],
    deletedRecordIds: string[],
    checks: InventoryWorkflowSelfTestResponse['checks'],
  ): Promise<number> {
    try {
      const [inbound, logs] = await Promise.all([
        this.gateway.listRecords({
          appToken: config.appToken,
          tableId: config.inboundTableId,
          tableName: '入库填写',
          filter: `CurrentValue.[物品类别号]="${marker}"`,
        }),
        this.gateway.listRecords({
          appToken: config.appToken,
          tableId: config.logTableId,
          tableName: '程序工作流执行日志',
          filter: `CurrentValue.[幂等键]="${marker}"`,
        }),
      ]);
      const inboundIds = inbound.map(getRecordId).filter(Boolean);
      const logIds = logs.map(getRecordId).filter(Boolean);
      for (const recordId of [...new Set([...createdInboundRecordIds, ...inboundIds])]) {
        await this.gateway.deleteRecord(
          config.appToken,
          config.inboundTableId,
          recordId,
          '入库填写',
        );
        deletedRecordIds.push(recordId);
      }
      for (const recordId of [...new Set([...createdLogRecordIds, ...logIds])]) {
        await this.gateway.deleteRecord(
          config.appToken,
          config.logTableId,
          recordId,
          '程序工作流执行日志',
        );
        deletedRecordIds.push(recordId);
      }
      const [remainingInbound, remainingLogs] = await Promise.all([
        this.gateway.listRecords({
          appToken: config.appToken,
          tableId: config.inboundTableId,
          tableName: '入库填写',
          filter: `CurrentValue.[物品类别号]="${marker}"`,
        }),
        this.gateway.listRecords({
          appToken: config.appToken,
          tableId: config.logTableId,
          tableName: '程序工作流执行日志',
          filter: `CurrentValue.[幂等键]="${marker}"`,
        }),
      ]);
      const remaining = remainingInbound.length + remainingLogs.length;
      checks.push({
        name: '测试数据清理',
        success: remaining === 0,
        message: remaining === 0 ? '自测记录已全部删除' : `仍有 ${remaining} 条自测记录`,
      });
      return remaining;
    } catch (error) {
      checks.push({ name: '测试数据清理', success: false, message: safeError(error) });
      return -1;
    }
  }
}

function resolveWorkflowConfig(): WorkflowConfig {
  const sourceUrl = readEnv('FEISHU_WAREHOUSE_SOURCE_URL');
  const parsed = parseFeishuBitableLink(sourceUrl);
  const config = {
    appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || parsed.appToken,
    purchaseTableId: readEnv('FEISHU_WAREHOUSE_PURCHASE_TABLE_ID'),
    inboundTableId: readEnv('FEISHU_WAREHOUSE_INBOUND_TABLE_ID'),
    outboundTableId: readEnv('FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID'),
    logTableId: readEnv('FEISHU_WAREHOUSE_WORKFLOW_LOG_TABLE_ID'),
  };
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`库存工作流配置缺失：${missing.join('、')}`);
  return config;
}

function purchaseNotificationCard(
  detailButton: boolean,
  detailUrl: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '采购入库' },
    },
    elements: detailButton
      ? [
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '查看详情' },
                type: 'primary',
                url: detailUrl,
              },
            ],
          },
        ]
      : [],
  };
}

function itemConfirmationCard(): Record<string, unknown> {
  const buttons = [
    ['入库', 'https://vnet.feishu.cn/share/base/form/shrcns4L7KGk25hfbmbVj9V4tOd'],
    ['借调', 'https://vnet.feishu.cn/share/base/form/shrcnIrdtq98224Ub2XmW6f0Itr'],
    ['出库', 'https://vnet.feishu.cn/share/base/form/shrcnvvIVWACv1Fb4moOigY24we'],
  ];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '物品确认' },
    },
    elements: [
      {
        tag: 'action',
        actions: buttons.map(([label, url], index) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: label },
          type: index === 0 ? 'primary' : 'default',
          url,
        })),
      },
    ],
  };
}

function createRunResult(
  code: InventoryWorkflowCode,
  trigger: InventoryWorkflowTrigger,
  startedAt: Date,
): InventoryWorkflowRunResult {
  return {
    runId: randomUUID(),
    code,
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    scanned: 0,
    candidates: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    notified: 0,
    errors: [],
  };
}

function finishRunResult(result: InventoryWorkflowRunResult): InventoryWorkflowRunResult {
  return { ...result, finishedAt: new Date().toISOString(), errors: result.errors.slice(0, 20) };
}

function fieldText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return fieldText(object.text ?? object.name ?? object.value);
  }
  return '';
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(app_secret|tenant_access_token|authorization|token)=[^\s&]+/gi, '$1=***')
    .slice(0, 500);
}

function workflowCutoverAtMs(): number {
  const value = readEnv('FEISHU_WAREHOUSE_WORKFLOW_CUTOVER_AT');
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function recordCreatedAtMs(record: BitableRecordItem): number {
  const raw = Number(record.created_time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}
