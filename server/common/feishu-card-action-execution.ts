import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const DEADLINE_MS = 2_500;
export const CARD_ACTION_PROCESSING_RESPONSE = {
  toast: {
    type: 'warning' as const,
    content: '处理时间较长，请勿重复点击，稍后查看卡片状态',
  },
};

export class FeishuCardActionDeadlineError extends ServiceUnavailableException {
  constructor() {
    super('卡片回调处理超时');
  }
}

interface InFlightAction<T> {
  promise: Promise<T>;
  timedOut: boolean;
}

export class FeishuCardActionExecution<T> {
  private readonly pending = new Map<string, InFlightAction<T>>();

  constructor(
    private readonly onLateFailure: (error: unknown) => void,
    private readonly capacity = 256,
  ) {}

  async run(identity: object, execute: () => Promise<T>): Promise<T> {
    const key = fingerprint(identity);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= this.capacity) {
        throw new HttpException('当前处理中的操作较多，请稍后重试', 429);
      }
      const created: InFlightAction<T> = {
        timedOut: false,
        promise: execute().then(
          (result) => {
            this.pending.delete(key);
            return result;
          },
          (error: unknown) => {
            this.pending.delete(key);
            if (created.timedOut) this.onLateFailure(error);
            throw error;
          },
        ),
      };
      entry = created;
      this.pending.set(key, entry);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 前台等待超时不取消认领及其续程；结果不明时不能宣称成功或失败。
      return await Promise.race([
        entry.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            entry!.timedOut = true;
            reject(new FeishuCardActionDeadlineError());
          }, DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function fingerprint(identity: object): string {
  const stable = Object.fromEntries(
    Object.entries(identity).filter(
      ([key]) =>
        ![
          'eventId',
          'event_id',
          'token',
          'updateToken',
          'update_token',
        ].includes(key),
    ),
  );
  const serialized = JSON.stringify(stable, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
  return createHash('sha256').update(serialized).digest('hex');
}
