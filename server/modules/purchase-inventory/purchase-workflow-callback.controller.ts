import { AccessConfigurationService, useConfiguredCardAuthorizationSnapshots } from '../../common/access/access-configuration.service';
import { isReadonlyCopyCallback, observeCardCallbackResult } from '../../common/feishu-card-copy/transport';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import {
  BadRequestException,
  Controller,
  Inject,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { readEnv } from '../../common/config/external-services.config';
import {
  parseOvertimeCardCallback,
  readOvertimeCardCallbackConfig,
} from '../overtime-workflow/overtime-workflow.callback';
import { OvertimeWorkflowService } from '../overtime-workflow/overtime-workflow.service';
import { toFeishuRawCardUpdate } from '../overtime-workflow/overtime-workflow.card-action.consumer';
import {
  isPurchaseManagerApprovalEnabled,
  readPurchaseManagerApprover, readPurchaseManagerApprovers,
} from './purchase-manager-approval.config';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import {
  parsePurchaseCardCallback,
  type PurchaseCardCallbackConfig,
  type PurchaseCardCallbackInput,
} from './purchase-workflow-callback';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import { FeishuCardActionExecution, FeishuCardActionDeadlineError, CARD_ACTION_PROCESSING_RESPONSE } from '../../common/feishu-card-action-execution';
import type { FeishuCardActionResponse } from '../overtime-workflow/overtime-workflow.card-action.consumer';

type CallbackResponse = Omit<FeishuCardActionResponse, 'card'> & {
  card?: Record<string, unknown> | FeishuCardActionResponse['card'];
};



@Controller('callbacks/feishu')
export class PurchaseWorkflowCallbackController {
  private readonly logger = new Logger(PurchaseWorkflowCallbackController.name);
  private readonly execution = new FeishuCardActionExecution<CallbackResponse>((error) => {
    this.logger.error(`卡片延后处理失败，可安全重试：${safeErrorMessage(error)}`);
  });

  constructor(
    private readonly store: PurchaseWorkflowStore,
    @Optional()
    private readonly managerApprovalService?: PurchaseManagerApprovalService,
    @Optional()
    private readonly overtimeWorkflowService?: OvertimeWorkflowService,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
    @Inject(PurchaseWorkflowService)
    private readonly workflowService?: PurchaseWorkflowService,
  ) {}

  @Post('purchase-card')
  @HttpCode(HttpStatus.OK)
  handlePurchaseCardCallback(@Req() request: RawBodyRequest<Request>) {
    const rawBody = request.rawBody;
    if (!rawBody?.length) {
      throw new BadRequestException('回调原始请求体不能为空');
    }
    // A registered copied-message identity is a deny-only shortcut. All original
    // callbacks still pass their existing signature, actor and business checks.
    let rawPayload: unknown;
    try { rawPayload = JSON.parse(rawBody.toString('utf8')); } catch { /* Existing parser reports malformed input. */ }
    if (isReadonlyCopyCallback(rawPayload)) {
      throw new ForbiddenException('此卡片为只读同步副本，请在原卡片办理');
    }

    if (this.overtimeWorkflowService?.isEnabled()) {
      const overtimeResult = parseOvertimeCardCallback(
        {
          headers: toCallbackHeaders(request.headers),
          rawBody,
          now: Date.now(),
        },
        readOvertimeCardCallbackConfig(),
      );
      if (overtimeResult.kind === 'challenge') {
        return { challenge: overtimeResult.challenge };
      }
      if (overtimeResult.kind === 'overtime_action') {
        return this.execute(overtimeResult, () => this.claimOvertimeCardAction(overtimeResult));
      }
    }

    const result = parsePurchaseCardCallback(
      {
        headers: toCallbackHeaders(request.headers),
        rawBody,
        now: Date.now(),
      },
      readPurchaseCardCallbackConfig(),
    );

    if (result.kind === 'challenge') {
      return { challenge: result.challenge };
    }

    if (result.kind === 'legacy_action') {
      assertFeishuBusinessIdentity(this.accessConfiguration, result.operatorOpenId);
      if (!isPurchaseWorkflowProgramEnabled()) {
        throw new ServiceUnavailableException('采购工作流程序未启用');
      }
      return this.execute(result, () => this.claimCardAction(result));
    }

    if (!isPurchaseManagerApprovalEnabled()) {
      throw new ServiceUnavailableException('采购经理审批卡片未启用');
    }
    if (!this.managerApprovalService) {
      throw new ServiceUnavailableException('采购经理审批服务不可用');
    }
    if (result.kind === 'manager_batch_action') {
      return this.execute(result, () => this.handleManagerBatchCardAction(result, request.res));
    }
    if (result.kind === 'purchase_batch_fulfillment_action') {
      return this.execute(result, () => this.handlePurchaseBatchFulfillmentCardAction(result, request.res));
    }
    return this.execute(result, () => this.handleManagerCardAction(result, request.res));
  }

  private async execute(identity: object, operation: () => Promise<CallbackResponse>): Promise<CallbackResponse> {
    if (isReadonlyCopyCallback(identity)) throw new ForbiddenException('此卡片为只读同步副本，请在原卡片办理');
    try {
      return await this.execution.run(identity, async () => {
        const result = await operation();
        await observeCardCallbackResult((identity as { kind?: string }).kind === 'overtime_action' ? 'overtime' : 'purchase', identity, result);
        return result;
      });
    } catch (error) {
      if (error instanceof FeishuCardActionDeadlineError) return CARD_ACTION_PROCESSING_RESPONSE;
      throw error;
    }
  }

  private async claimOvertimeCardAction(
    result: Extract<
      ReturnType<typeof parseOvertimeCardCallback>,
      { kind: 'overtime_action' }
    >,
  ) {
    try {
      const claim = await (this.overtimeWorkflowService!.acceptApprovalAction({
          eventId: result.eventId,
          recordId: result.recordId,
          action: result.action,
          actorOpenId: result.actorOpenId,
          messageId: result.messageId,
        }));
      if (claim.claimed) {
        void this.overtimeWorkflowService!.runPendingTasks().catch((error) => {
          this.logger.error(`加班审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`);
        });
      }
      return claim.claimed
        ? {
            toast: { type: 'info' as const, content: '审批操作已受理' },
            card: claim.card,
          }
        : {
            toast: {
              type: 'warning' as const,
              content: '该申请已处理或正在处理',
            },
            card: claim.card,
          };
    } catch {
      throw new ServiceUnavailableException('加班审批回调暂时不可用');
    }
  }

  private async claimCardAction(
    result: Extract<
      ReturnType<typeof parsePurchaseCardCallback>,
      { kind: 'legacy_action' }
    >,
  ) {
    try {
      if (!this.workflowService) throw new ServiceUnavailableException('采购审批鉴权入口未配置');
      const claim = await (this.workflowService.acceptApprovalCardAction({
          eventId: result.eventId,
          recordId: result.executionRecordId,
          action: result.action,
          actorOpenId: result.operatorOpenId,
          ...(result.messageId ? { deliveryMessageId: result.messageId } : {}),
        }));
      return claim.claimed
        ? {
            toast: { type: 'info' as const, content: '审批操作已受理' },
          }
        : {
            toast: {
              type: 'warning' as const,
              content: '该申请已处理或正在处理',
            },
          };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException('采购审批回调暂时不可用');
    }
  }

  private async handleManagerCardAction(
    result: Extract<
      ReturnType<typeof parsePurchaseCardCallback>,
      { kind: 'manager_action' }
    >,
    httpResponse?: RawBodyRequest<Request>['res'],
  ) {
    const card = await (this.managerApprovalService!.handleManagerCardAction(result));
    if (result.action === 'open_reject') {
      this.scheduleManagerCardViewPatch(result.messageId, result.operatorOpenId, false, httpResponse);
      return { toast: { type: 'info' as const, content: '请填写驳回原因' } };
    }
    void this.managerApprovalService!.runAcceptedTasks().catch((error) => {
      this.logger.error(`采购审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`);
    });
    return {
      toast: { type: 'info' as const, content: '审批操作已受理' },
      card: toFeishuRawCardUpdate(card),
    };
  }

  private async handleManagerBatchCardAction(
    result: Extract<
      ReturnType<typeof parsePurchaseCardCallback>,
      { kind: 'manager_batch_action' }
    >,
    httpResponse?: RawBodyRequest<Request>['res'],
  ) {
    const card = await (this.managerApprovalService!.handleManagerBatchCardAction(result));
    if (result.action === 'open_item_reject' || result.action === 'cancel_item_reject') {
      this.scheduleManagerCardViewPatch(result.messageId, result.operatorOpenId, true, httpResponse);
      return { toast: { type: 'info' as const, content: result.action === 'open_item_reject' ? '请填写驳回原因' : '已返回审批列表' } };
    }
    if (
      result.action === 'approve_pending_comprehensive' ||
      result.action === 'approve_pending_building_self' ||
      result.action === 'submit_item_reject'
    ) {
      void this.managerApprovalService!.runAcceptedTasks().catch((error) => {
        this.logger.error(
          `采购批次审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
        );
      });
    }
    return {
      toast: { type: 'info' as const, content: '审批操作已受理' },
      card: toFeishuRawCardUpdate(card),
    };
  }

  private scheduleManagerCardViewPatch(messageId: string, actorOpenId: string, batch: boolean, response?: RawBodyRequest<Request>['res']): void {
    if (!response) throw new ServiceUnavailableException('采购审批卡片回调响应不可用');
    const patch = () => {
      void this.managerApprovalService!.patchManagerApprovalCardView(messageId, actorOpenId, batch)
        .catch(error => this.logger.error(`采购审批卡片视图切换失败，可由用户重试：${safeErrorMessage(error)}`));
    };
    if (response.writableFinished) patch(); else response.once('finish', patch);
  }

  private async handlePurchaseBatchFulfillmentCardAction(
    result: Extract<
      ReturnType<typeof parsePurchaseCardCallback>,
      { kind: 'purchase_batch_fulfillment_action' }
    >,
    httpResponse?: RawBodyRequest<Request>['res'],
  ) {
    const response = await (this.managerApprovalService!.handlePurchaseBatchFulfillmentCardAction(
        result,
      ));
    if (response.claimed) {
      void this.managerApprovalService!.runAcceptedTasks().catch((error) => {
        this.logger.error(
          `采购履约操作已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
        );
      });
    }
    const isNavigation =
      result.action === 'open_order' ||
      result.action === 'return_purchase_list' ||
      result.action === 'open_receipt' ||
      result.action === 'return_receipt_list';
    if (isNavigation) {
      if (!httpResponse) {
        throw new ServiceUnavailableException('采购履约卡片回调响应不可用');
      }
      const patchAfterFinish = () => {
        void this.managerApprovalService!.patchPurchaseBatchFulfillmentCardView(
          result.messageId,
          response.card,
          result.updateToken,
        ).catch((error) => {
          this.logger.error(
            `采购履约卡片视图切换失败，可由用户重试：${safeErrorMessage(error)}`,
          );
        });
      };
      if (httpResponse.writableFinished) {
        patchAfterFinish();
      } else {
        httpResponse.once('finish', patchAfterFinish);
        httpResponse.once('close', () =>
          httpResponse.off('finish', patchAfterFinish),
        );
      }
    }
    const callbackResponse = {
      toast: isNavigation
        ? {
            type: 'info' as const,
            content:
              result.action === 'open_order'
                ? '请填写下单结果'
                : result.action === 'open_receipt'
                  ? '请填写签收信息'
                  : '已返回任务列表',
          }
        : response.claimed
          ? { type: 'info' as const, content: '操作已受理，正在后台同步' }
          : {
              type: 'warning' as const,
              content: '该操作已处理或正在处理',
            },
    };
    return isNavigation
      ? callbackResponse
      : { ...callbackResponse, card: toFeishuRawCardUpdate(response.card) };
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
        .replace(/\bc-[A-Za-z0-9_-]+\b/gu, '[redacted callback token]')
        .replace(/[\r\n\t]/gu, ' ')
        .slice(0, 300)
    : 'unknown error';
}

export function readPurchaseCardCallbackConfig(): PurchaseCardCallbackConfig {
  const verificationToken = readEnv('FEISHU_CARD_VERIFICATION_TOKEN', [
    'FEISHU_OVERTIME_CARD_VERIFICATION_TOKEN',
    'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
  ]);
  if (!verificationToken) {
    throw new ServiceUnavailableException(
      'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
    );
  }

  const legacyApproverOpenIds = Array.from(
    new Set(
      readEnv('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS')
        .split(',')
        .map((openId) => openId.trim())
        .filter(Boolean),
    ),
  );
  const snapshots = useConfiguredCardAuthorizationSnapshots();
  if (!snapshots && isPurchaseWorkflowProgramEnabled() && !legacyApproverOpenIds.length) throw new ServiceUnavailableException('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS');
  const managerApproverOpenId = snapshots ? '' : isPurchaseManagerApprovalEnabled() ? readPurchaseManagerApprover().openId : readEnv('PURCHASE_MANAGER_APPROVER_OPEN_ID').trim();

  return {
    ...(snapshots ? { authorizeFromDeliverySnapshot: true } : {}),
    verificationToken,
    encryptKey: readEnv('FEISHU_CARD_ENCRYPT_KEY', [
      'FEISHU_OVERTIME_CARD_ENCRYPT_KEY',
      'FEISHU_PURCHASE_CARD_ENCRYPT_KEY',
    ]),
    legacyApproverOpenIds,
    managerApproverOpenId,
    managerApproverOpenIds: !snapshots && isPurchaseManagerApprovalEnabled() ? readPurchaseManagerApprovers().map(person => person.openId) : undefined,
  };
}

function isPurchaseWorkflowProgramEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(
    readEnv('PURCHASE_WORKFLOW_PROGRAM_ENABLED'),
  );
}

function toCallbackHeaders(
  headers: Request['headers'],
): PurchaseCardCallbackInput['headers'] {
  const converted = Object.create(null) as PurchaseCardCallbackInput['headers'];
  for (const [name, value] of Object.entries(headers)) {
    converted[name] = Array.isArray(value) ? [...value] : value;
  }
  return converted;
}
