import { HttpException } from '@nestjs/common';
import {
  FeishuCardActionDeadlineError,
  FeishuCardActionExecution,
} from './feishu-card-action-execution';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('shared Feishu card action execution', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the original continuation alive and shares retries after timeout', async () => {
    jest.useFakeTimers();
    const job = deferred<string>();
    const continued = jest.fn();
    const start = jest.fn(() =>
      job.promise.then((result) => {
        continued();
        return result;
      }),
    );
    const errors = jest.fn();
    const execution = new FeishuCardActionExecution<string>(errors);
    const identity = {
      actor: 'ou_a',
      message: 'om_1',
      action: 'approve',
      eventId: 'evt_1',
    };
    const first = execution.run(identity, start);
    const timedOut = expect(first).rejects.toBeInstanceOf(
      FeishuCardActionDeadlineError,
    );
    await jest.advanceTimersByTimeAsync(2501);
    await timedOut;
    const retry = execution.run({ ...identity, eventId: 'evt_2' }, start);
    job.resolve('accepted');
    await expect(retry).resolves.toBe('accepted');
    expect(start).toHaveBeenCalledTimes(1);
    expect(continued).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds distinct in-flight work while allowing an existing action to finish and freeing capacity', async () => {
    const execution = new FeishuCardActionExecution<string>(jest.fn(), 2);
    const a = deferred<string>();
    const b = deferred<string>();
    const startA = jest.fn(() => a.promise);
    const first = execution.run({ record: 'a' }, startA);
    const second = execution.run({ record: 'b' }, () => b.promise);
    await expect(
      execution.run({ record: 'c' }, async () => 'c'),
    ).rejects.toMatchObject({ status: 429 });
    const replay = execution.run({ record: 'a' }, startA);
    a.resolve('a');
    b.resolve('b');
    await expect(Promise.all([first, second, replay])).resolves.toEqual([
      'a',
      'b',
      'a',
    ]);
    expect(startA).toHaveBeenCalledTimes(1);
    await expect(execution.run({ record: 'c' }, async () => 'c')).resolves.toBe(
      'c',
    );
  });

  it('preserves a business error and permits a later retry without reporting acceptance', async () => {
    const errors = jest.fn();
    const execution = new FeishuCardActionExecution<string>(errors);
    const denied = new HttpException('无权限', 403);
    await expect(
      execution.run({ record: 'a' }, async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    expect(errors).not.toHaveBeenCalled();
    await expect(
      execution.run({ record: 'a' }, async () => 'accepted'),
    ).resolves.toBe('accepted');
  });

  it('separates form values and canonicalizes object key order without merging another actor or message', async () => {
    const execution = new FeishuCardActionExecution<string>(jest.fn());
    const job = deferred<string>();
    const start = jest.fn(() => job.promise);
    const a = execution.run(
      { actor: 'a', message: 'm', form: { amount: '1', quantity: '2' } },
      start,
    );
    const replay = execution.run(
      { form: { quantity: '2', amount: '1' }, message: 'm', actor: 'a' },
      start,
    );
    const changed = execution.run(
      { actor: 'a', message: 'm', form: { amount: '2', quantity: '2' } },
      start,
    );
    const otherActor = execution.run(
      { actor: 'b', message: 'm', form: { amount: '1', quantity: '2' } },
      start,
    );
    const otherMessage = execution.run(
      { actor: 'a', message: 'n', form: { amount: '1', quantity: '2' } },
      start,
    );
    expect(start).toHaveBeenCalledTimes(4);
    job.resolve('accepted');
    await Promise.all([a, replay, changed, otherActor, otherMessage]);
  });
});
