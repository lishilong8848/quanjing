import { Injectable, Logger } from '@nestjs/common';
import * as Lark from '@larksuiteoapi/node-sdk';
import { getEffectiveFeishuAppCredentials } from '../../common/config/external-services.config';

const INITIAL_CONNECTION_TIMEOUT_MS = 15_000;

export type FeishuCardActionResponse = {
  toast: {
    type: 'info' | 'warning' | 'error';
    content: string;
  };
  card?: FeishuRawCardUpdate;
};

export type FeishuRawCardUpdate = {
  type: 'raw';
  data: Record<string, unknown>;
};

export function toFeishuRawCardUpdate(
  card: Record<string, unknown>,
): FeishuRawCardUpdate {
  if (card.schema !== '2.0') {
    throw new Error('飞书即时更新卡片必须使用 Card JSON 2.0');
  }
  return { type: 'raw', data: card };
}

export type FeishuCardActionHandler = (
  payload: unknown,
) => Promise<FeishuCardActionResponse>;

export type FeishuCardActionTerminalFailureHandler = (error: Error) => void;
export type FeishuMessageHandler = (payload: unknown) => Promise<void>;

export interface FeishuCardActionTransport {
  connect(
    handler: FeishuCardActionHandler,
    onTerminalFailure: FeishuCardActionTerminalFailureHandler,
    messageHandler?: FeishuMessageHandler,
  ): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
}

export const FEISHU_CARD_ACTION_TRANSPORT = Symbol(
  'FEISHU_CARD_ACTION_TRANSPORT',
);

type CardActionHandles = {
  'card.action.trigger': (
    payload: Record<string, unknown>,
  ) => Promise<FeishuCardActionResponse>;
  'im.message.receive_v1': (payload: Record<string, unknown>) => Promise<void>;
};

@Injectable()
export class FeishuCardActionLongConnectionTransport implements FeishuCardActionTransport {
  private readonly logger = new Logger(
    FeishuCardActionLongConnectionTransport.name,
  );
  private client?: Lark.WSClient;
  private closing = false;
  private ready = false;
  private terminalFailureReported = false;

  async connect(
    handler: FeishuCardActionHandler,
    onTerminalFailure: FeishuCardActionTerminalFailureHandler,
    messageHandler?: FeishuMessageHandler,
  ): Promise<void> {
    if (this.client) return;

    const { appId, appSecret } = getEffectiveFeishuAppCredentials();
    if (!appId || !appSecret) {
      throw new Error(
        '缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法启动飞书卡片回调长连接',
      );
    }

    this.closing = false;
    this.ready = false;
    this.terminalFailureReported = false;
    const dispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.error,
    }).register<CardActionHandles>({
      'card.action.trigger': async (payload) => handler(payload),
      'im.message.receive_v1': async (payload) => {
        await messageHandler?.(payload);
      },
    });

    await new Promise<void>((resolve, reject) => {
      let initialConnectionSettled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const settleInitialConnection = (operation: () => void): boolean => {
        if (initialConnectionSettled) return false;
        initialConnectionSettled = true;
        if (timeout) clearTimeout(timeout);
        operation();
        return true;
      };

      const reportTerminalFailure = (error: Error) => {
        if (this.closing || this.terminalFailureReported) return;
        this.terminalFailureReported = true;
        this.ready = false;
        client.close({ force: true });
        if (this.client === client) this.client = undefined;
        this.logger.error(
          `Feishu card callback long connection unavailable: ${safeErrorMessage(error)}`,
        );
        onTerminalFailure(error);
      };

      const handleConnectionFailure = (error: unknown) => {
        if (this.closing) return;
        const normalizedError = normalizeError(error);
        this.ready = false;
        const wasInitialFailure = settleInitialConnection(() => {
          client.close({ force: true });
          if (this.client === client) this.client = undefined;
          reject(normalizedError);
        });
        if (!wasInitialFailure) reportTerminalFailure(normalizedError);
      };

      const client = new Lark.WSClient({
        appId,
        appSecret,
        autoReconnect: true,
        handshakeTimeoutMs: 10_000,
        wsConfig: { pingTimeout: 10 },
        loggerLevel: Lark.LoggerLevel.error,
        onReady: () => {
          this.ready = true;
          settleInitialConnection(resolve);
        },
        onError: handleConnectionFailure,
        onReconnecting: () => {
          this.ready = false;
          if (!this.closing) {
            this.logger.warn(
              'Feishu card callback long connection reconnecting',
            );
          }
        },
        onReconnected: () => {
          this.ready = true;
          this.terminalFailureReported = false;
          if (!this.closing) {
            this.logger.log('Feishu card callback long connection restored');
          }
        },
      });
      this.client = client;

      timeout = setTimeout(() => {
        settleInitialConnection(() => {
          this.ready = false;
          client.close({ force: true });
          if (this.client === client) this.client = undefined;
          reject(new Error('飞书卡片回调长连接启动超时'));
        });
      }, INITIAL_CONNECTION_TIMEOUT_MS);

      void client
        .start({ eventDispatcher: dispatcher })
        .catch(handleConnectionFailure);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ready = false;
    this.client?.close({ force: true });
    this.client = undefined;
  }

  isReady(): boolean {
    if (!this.ready || !this.client) return false;
    try {
      return this.client.getConnectionStatus().state === 'connected';
    } catch {
      return false;
    }
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'unknown error';
  return error.message.replace(/[\r\n\t]/gu, ' ').slice(0, 300);
}
