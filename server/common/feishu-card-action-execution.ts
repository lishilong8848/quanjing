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

export interface FeishuCardActionTiming {
  outcome: 'completed' | 'failed' | 'timed_out' | 'late_completed' | 'late_failed';
  elapsedMs: number;
}

export interface FeishuCardActionExecutionOptions<T> {
  /** Receives no payload; callers may log only their fixed business/action labels. */
  onTiming?: (timing: FeishuCardActionTiming) => void;
  /** A late error must not turn into a second business attempt. */
  onLateFailure?: (error: unknown) => void | Promise<void>;
  onLateResult?: (result: T) => void | Promise<void>;
}

export class FeishuCardActionExecution<T> {
  private readonly pending = new Map<string, InFlightAction<T>>();

  constructor(
    private readonly onLateFailure: (error: unknown) => void,
    private readonly capacity = 256,
  ) {}

  async run(identity: object, execute: () => Promise<T>, options: FeishuCardActionExecutionOptions<T> = {}): Promise<T> {
    const waitingAt = performance.now();
    const key = fingerprint(identity);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= this.capacity) {
        throw new HttpException('当前处理中的操作较多，请稍后重试', 429);
      }
      const startedAt = performance.now();
      const timing = (outcome: FeishuCardActionTiming['outcome']) => {
        try { options.onTiming?.({ outcome, elapsedMs: Math.round(performance.now() - startedAt) }); }
        catch { /* Diagnostics cannot change a decision or prevent recovery. */ }
      };
      const created: InFlightAction<T> = {
        timedOut: false,
        // Install the in-flight identity before invoking any user code, including
        // synchronous throws and immediate recursive delivery of the same action.
        promise: Promise.resolve().then(execute).then(
          (result) => {
            this.pending.delete(key);
            timing(created.timedOut ? 'late_completed' : 'completed');
            if (created.timedOut) {
              try { void Promise.resolve(options.onLateResult?.(result)).catch(() => undefined); }
              catch { /* Result recovery must not execute the action again. */ }
            }
            return result;
          },
          (error: unknown) => {
            this.pending.delete(key);
            timing(created.timedOut ? 'late_failed' : 'failed');
            if (created.timedOut) {
              try { this.onLateFailure(error); } catch { /* Preserve the original error. */ }
              try { void Promise.resolve(options.onLateFailure?.(error)).catch(() => undefined); }
              catch { /* A failed recovery notification must not repeat the business action. */ }
            }
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
            try { options.onTiming?.({ outcome: 'timed_out', elapsedMs: Math.round(performance.now() - waitingAt) }); } catch { /* Diagnostics only. */ }
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
  const metadata = new Set(['eventId', 'event_id', 'token', 'updateToken', 'update_token', 'create_time']);
  const withoutMetadata = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
  const stable = withoutMetadata(identity);
  // SDK/encrypted HTTP envelopes can carry fresh transport IDs inside header/event.
  // Form values remain intact: an input named "token" may be real business content.
  for (const name of ['header', 'event']) {
    const value = stable[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) stable[name] = withoutMetadata(value);
  }
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
