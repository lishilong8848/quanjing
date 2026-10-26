import { PurchaseWorkflowStore } from '../modules/purchase-inventory/purchase-workflow.store';

const NOTIFICATION_KEY_MAX_LENGTH = 600;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9][A-Za-z0-9_-]{0,252}$/;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f]/u;

export type PurchaseManagerApprovalReconciliationArgs =
  | {
      mode: 'verified-delivered';
      notificationKey: string;
      operatorOpenId: string;
      messageId: string;
    }
  | {
      mode: 'verified-absent';
      notificationKey: string;
      operatorOpenId: string;
    };

export interface PurchaseManagerApprovalReconciliationResult {
  mode: PurchaseManagerApprovalReconciliationArgs['mode'];
  status: 'completed' | 'pending';
  deliveryGeneration: number;
}

interface ReconciliationRunOptions {
  ledgerPath?: string;
  writeLine?: (line: string) => void;
}

export function parsePurchaseManagerApprovalReconciliationArgs(
  argv: readonly string[],
): PurchaseManagerApprovalReconciliationArgs {
  const mode = argv[0];
  if (mode !== 'verified-delivered' && mode !== 'verified-absent') {
    throw new Error('对账模式无效');
  }

  let notificationKey = '';
  let operatorOpenId = '';
  let messageId = '';
  let confirmNewGeneration = false;
  const seen = new Set<string>();

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--confirm-new-generation') {
      assertOptionNotRepeated(seen, option);
      confirmNewGeneration = true;
      continue;
    }
    if (
      option !== '--notification-key' &&
      option !== '--operator-open-id' &&
      option !== '--message-id'
    ) {
      throw new Error('存在未知对账参数');
    }
    assertOptionNotRepeated(seen, option);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('对账参数值缺失');
    }
    index += 1;
    if (option === '--notification-key') notificationKey = value;
    if (option === '--operator-open-id') operatorOpenId = value;
    if (option === '--message-id') messageId = value;
  }

  assertSafeExactText(
    notificationKey,
    NOTIFICATION_KEY_MAX_LENGTH,
    '通知键无效',
  );
  if (!OPEN_ID_PATTERN.test(operatorOpenId)) {
    throw new Error('操作人 open_id 无效');
  }

  if (mode === 'verified-delivered') {
    if (confirmNewGeneration) {
      throw new Error('确认已送达时不得创建新代际');
    }
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new Error('消息 ID 无效');
    }
    return { mode, notificationKey, operatorOpenId, messageId };
  }

  if (messageId) {
    throw new Error('确认未送达时不得绑定消息 ID');
  }
  if (!confirmNewGeneration) {
    throw new Error('确认未送达必须显式授权新代际');
  }
  return { mode, notificationKey, operatorOpenId };
}

export async function runPurchaseManagerApprovalDeliveryReconciliation(
  argv: readonly string[],
  options: ReconciliationRunOptions = {},
): Promise<PurchaseManagerApprovalReconciliationResult> {
  const input = parsePurchaseManagerApprovalReconciliationArgs(argv);
  const store = new PurchaseWorkflowStore(options.ledgerPath);
  try {
    await store.onModuleInit();
    const resolved = await store.resolveUnknownManagerApprovalDelivery(
      input.notificationKey,
      input.mode === 'verified-delivered'
        ? {
            resolution: 'verified_delivered',
            operatorOpenId: input.operatorOpenId,
            messageId: input.messageId,
          }
        : {
            resolution: 'verified_absent',
            operatorOpenId: input.operatorOpenId,
          },
    );
    const result: PurchaseManagerApprovalReconciliationResult = {
      mode: input.mode,
      status:
        resolved.notification.status === 'completed' ? 'completed' : 'pending',
      deliveryGeneration: resolved.notification.deliveryGeneration,
    };
    (options.writeLine || defaultWriteLine)(
      input.mode === 'verified-delivered'
        ? `送达核对已完成；代际 ${result.deliveryGeneration} 已绑定。`
        : `未送达核对已完成；代际 ${result.deliveryGeneration} 已受控排队。`,
    );
    return result;
  } finally {
    await store.onModuleDestroy();
  }
}

function assertOptionNotRepeated(seen: Set<string>, option: string): void {
  if (seen.has(option)) throw new Error('对账参数重复');
  seen.add(option);
}

function assertSafeExactText(
  value: string,
  maxLength: number,
  message: string,
): void {
  if (
    !value ||
    value.length > maxLength ||
    value.trim() !== value ||
    UNSAFE_TEXT_PATTERN.test(value)
  ) {
    throw new Error(message);
  }
}

function defaultWriteLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

if (require.main === module) {
  void runPurchaseManagerApprovalDeliveryReconciliation(
    process.argv.slice(2),
  ).catch(() => {
    process.stderr.write('采购经理审批卡送达对账失败，请核对账本状态。\n');
    process.exitCode = 1;
  });
}
