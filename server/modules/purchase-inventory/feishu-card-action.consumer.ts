import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PublicAccess } from '../../common/access/unified-access.decorators';
import { getFeishuCardActionConsumerProfile } from '../../common/config/external-services.config';
import {
  FEISHU_CARD_ACTION_TRANSPORT,
  type FeishuCardActionTransport,
} from '../overtime-workflow/overtime-workflow.card-action.consumer';
import { FeishuCardActionRouter } from './feishu-card-action.router';

const RECONNECT_DELAY_MS = 5_000;
const ENABLED_VALUES = new Set(['true', '1', 'on', 'yes']);

export function isFeishuCardActionConsumerEnabled(): boolean {
  const profile = getFeishuCardActionConsumerProfile();
  if (profile) return profile !== 'disabled';
  return ENABLED_VALUES.has(
    (process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED || '')
      .trim()
      .toLowerCase(),
  );
}

@Injectable()
export class FeishuCardActionConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(FeishuCardActionConsumer.name);
  private bootstrapStarted = false;
  private destroyed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pendingClose?: Promise<void>;

  constructor(
    private readonly router: FeishuCardActionRouter,
    @Inject(FEISHU_CARD_ACTION_TRANSPORT)
    private readonly transport: FeishuCardActionTransport,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.bootstrapStarted) return;
    this.bootstrapStarted = true;
    this.destroyed = false;
    if (!isFeishuCardActionConsumerEnabled()) {
      this.logger.log(
        'Feishu shared card callback consumer: DISABLED for this runtime role',
      );
      return;
    }
    if (!this.router.isAnyEnabled()) return;

    try {
      await this.connect();
    } catch (error) {
      this.bootstrapStarted = false;
      await this.transport.close();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.bootstrapStarted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.pendingClose?.catch(() => undefined);
    this.pendingClose = undefined;
    await this.transport.close();
  }

  private async connect(): Promise<void> {
    await this.transport.connect(
      (payload) => this.router.handle(payload),
      (error) => this.handleTerminalFailure(error),
      (payload) => this.router.handleMessage(payload),
    );
    this.logger.log('Feishu shared card callback consumer: READY');
  }

  private handleTerminalFailure(error: Error): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.logger.error(
      `Feishu shared card callback connection terminated: ${safeErrorMessage(error)}`,
    );
    this.pendingClose = this.transport.close().catch((closeError: unknown) => {
      this.logger.warn(
        `Feishu shared card callback old connection cleanup failed: ${safeErrorMessage(closeError)}`,
      );
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (
      this.destroyed ||
      !isFeishuCardActionConsumerEnabled() ||
      !this.router.isAnyEnabled()
    ) {
      return;
    }
    try {
      await this.pendingClose;
      this.pendingClose = undefined;
      await this.connect();
    } catch (error) {
      this.logger.error(
        `Feishu shared card callback reconnect failed: ${safeErrorMessage(error)}`,
      );
      this.handleTerminalFailure(normalizeError(error));
    }
  }
}

@Controller('api/feishu-card-callback')
export class FeishuCardActionHealthController {
  constructor(
    private readonly router: FeishuCardActionRouter,
    @Inject(FEISHU_CARD_ACTION_TRANSPORT)
    private readonly transport: FeishuCardActionTransport,
  ) {}

  health(): { enabled: boolean; ready: boolean } {
    const enabled =
      isFeishuCardActionConsumerEnabled() && this.router.isAnyEnabled();
    const ready = enabled && this.transport.isReady();
    if (enabled && !ready) {
      throw new ServiceUnavailableException('飞书卡片回调长连接当前未就绪');
    }
    return { enabled, ready };
  }
}

const healthHandlerDescriptor = Object.getOwnPropertyDescriptor(
  FeishuCardActionHealthController.prototype,
  'health',
);
if (!healthHandlerDescriptor) {
  throw new Error('飞书卡片回调健康检查方法未定义');
}
PublicAccess()(
  FeishuCardActionHealthController.prototype,
  'health',
  healthHandlerDescriptor,
);
Get('health')(
  FeishuCardActionHealthController.prototype,
  'health',
  healthHandlerDescriptor,
);
Header('Cache-Control', 'no-store')(
  FeishuCardActionHealthController.prototype,
  'health',
  healthHandlerDescriptor,
);

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'unknown error';
  return error.message.replace(/[\r\n\t]/gu, ' ').slice(0, 300);
}
