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
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(4);
    job.resolve('accepted');
    await Promise.all([a, replay, changed, otherActor, otherMessage]);
  });

  it('contains synchronous throws and releases capacity for the same identity', async () => {
    const execution = new FeishuCardActionExecution<string>(jest.fn(), 1);
    await expect(execution.run({ action: 'approve' }, () => { throw new Error('disk unavailable'); }))
      .rejects.toThrow('disk unavailable');
    await expect(execution.run({ action: 'approve' }, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('installs the identity before invoking an immediately reentrant callback', async () => {
    const execution = new FeishuCardActionExecution<string>(jest.fn());
    let replay!: Promise<string>;
    const other = jest.fn(async () => 'wrong second decision');
    const first = execution.run({ action: 'approve' }, async () => {
      replay = execution.run({ action: 'approve' }, other);
      return 'one decision';
    });
    await expect(first).resolves.toBe('one decision');
    await expect(replay).resolves.toBe('one decision');
    expect(other).not.toHaveBeenCalled();
  });

  it('reports a late failure once for all waiting duplicates without repeating the action', async () => {
    jest.useFakeTimers();
    const job = deferred<string>(), late = jest.fn(), fallback = jest.fn(), timing = jest.fn();
    const start = jest.fn(() => job.promise);
    const execution = new FeishuCardActionExecution<string>(fallback);
    const a = execution.run({ actor: 'a' }, start, { onLateFailure: late, onTiming: timing });
    const b = execution.run({ actor: 'a', eventId: 'retry' }, start, { onLateFailure: late });
    const settled = Promise.allSettled([a, b]);
    await jest.advanceTimersByTimeAsync(2501);
    expect((await settled).every(row => row.status === 'rejected')).toBe(true);
    const failure = new Error('temporary write error');
    job.reject(failure);
    await jest.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(failure);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls.map(([row]) => row.outcome)).toEqual(['timed_out', 'late_failed']);
    await expect(execution.run({ actor: 'a' }, async () => 'retry accepted')).resolves.toBe('retry accepted');
  });

  it('never lets diagnostics or a recovery notification replace the business error', async () => {
    jest.useFakeTimers();
    const job = deferred<string>(), failure = new Error('original error');
    const execution = new FeishuCardActionExecution<string>(() => { throw new Error('diagnostic failed'); });
    const result = execution.run({ action: 'approve' }, () => job.promise, {
      onTiming: () => { throw new Error('logger failed'); },
      onLateFailure: async () => { throw new Error('notification failed'); },
    });
    const done = expect(result).rejects.toBeInstanceOf(FeishuCardActionDeadlineError);
    await jest.advanceTimersByTimeAsync(2501); await done;
    job.reject(failure); await jest.advanceTimersByTimeAsync(0);
    await expect(execution.run({ action: 'approve' }, async () => 'accepted')).resolves.toBe('accepted');
  });

  it('coalesces refreshed transport envelopes while keeping different form values distinct', async () => {
    const job = deferred<string>(), start = jest.fn(() => job.promise);
    const execution = new FeishuCardActionExecution<string>(jest.fn());
    const identity = { header: { event_id: 'evt1', create_time: '1', app_id: 'cli_synthetic' },
      event: { token: 'cap1', context: { open_message_id: 'om_original' }, operator: { open_id: 'ou_original' },
        action: { form_value: { token: 'business-token-1' } } } };
    const a = execution.run(identity, start);
    const b = execution.run({ ...identity, header: { ...identity.header, event_id: 'evt2', create_time: '2' }, event: { ...identity.event, token: 'cap2' } }, start);
    const changed = execution.run({ ...identity, event: { ...identity.event, action: { form_value: { token: 'business-token-2' } } } }, start);
    await Promise.resolve(); expect(start).toHaveBeenCalledTimes(2);
    job.resolve('one per actual action'); await Promise.all([a, b, changed]);
  });

  it('allows late returned error results to be reported without converting them into another attempt', async () => {
    jest.useFakeTimers();
    const job = deferred<string>(), lateResult = jest.fn(), start = jest.fn(() => job.promise);
    const execution = new FeishuCardActionExecution<string>(jest.fn());
    const result = execution.run({ action: 'approve' }, start, { onLateResult: lateResult });
    const timedOut = expect(result).rejects.toBeInstanceOf(FeishuCardActionDeadlineError);
    await jest.advanceTimersByTimeAsync(2501); await timedOut;
    job.resolve('returned-error'); await jest.advanceTimersByTimeAsync(0);
    expect(lateResult).toHaveBeenCalledTimes(1); expect(lateResult).toHaveBeenCalledWith('returned-error');
    expect(start).toHaveBeenCalledTimes(1);
  });
});
