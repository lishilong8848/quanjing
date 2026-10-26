import type { HttpService } from '@nestjs/axios';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AlarmTagSemanticReviewer,
  type AlarmTagSemanticInput,
} from './today-operations-alarm-tag-ai';

const input: AlarmTagSemanticInput = {
  id: 'alarm-1',
  description: '传输链路中断',
  location: 'A楼',
  monitorObject: '监控链路',
  acceptanceDescription: '【维护】传输链路中断',
  confirmationDescription: '【通讯故障】传输链路中断',
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('AI 复核未在预期时间内完成');
}

describe('alarm tag semantic reviewer', () => {
  const previous = {
    key: process.env.TODAY_OPERATIONS_ALARM_AI_API_KEY,
    url: process.env.TODAY_OPERATIONS_ALARM_AI_BASE_URL,
    model: process.env.TODAY_OPERATIONS_ALARM_AI_MODEL,
    path: process.env.TODAY_OPERATIONS_ALARM_AI_CACHE_PATH,
  };
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'alarm-tag-ai-'));
    process.env.TODAY_OPERATIONS_ALARM_AI_API_KEY = 'test-key';
    process.env.TODAY_OPERATIONS_ALARM_AI_BASE_URL =
      'https://example.test/v1/chat/completions';
    process.env.TODAY_OPERATIONS_ALARM_AI_MODEL = 'test-model';
    process.env.TODAY_OPERATIONS_ALARM_AI_CACHE_PATH = join(
      directory,
      'cache.json',
    );
  });

  afterEach(() => {
    for (const [name, value] of [
      ['TODAY_OPERATIONS_ALARM_AI_API_KEY', previous.key],
      ['TODAY_OPERATIONS_ALARM_AI_BASE_URL', previous.url],
      ['TODAY_OPERATIONS_ALARM_AI_MODEL', previous.model],
      ['TODAY_OPERATIONS_ALARM_AI_CACHE_PATH', previous.path],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('reviews each side separately and reuses the persisted result', async () => {
    const post = jest.fn().mockImplementation(async (_url, request) => {
      if (request.messages.length === 1) {
        return { data: { choices: [{ message: { content: 'OK' } }] } };
      }
      const entries = JSON.parse(request.messages[1].content) as Array<{
        id: string;
      }>;
      return {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [
                    {
                      id: entries[0].id,
                      side: 'acceptance',
                      suspected: true,
                      reason: '描述写明链路中断，与维护标签不符',
                      suggestedTag: '通讯故障',
                    },
                    {
                      id: entries[0].id,
                      side: 'confirmation',
                      suspected: false,
                      reason: '',
                      suggestedTag: '',
                    },
                  ],
                }),
              },
            },
          ],
        },
      };
    });
    const reviewer = new AlarmTagSemanticReviewer({
      axiosRef: { post },
    } as unknown as HttpService);
    const duplicate = { ...input, id: 'alarm-2' };
    expect(reviewer.snapshot([input, duplicate]).status).toEqual({
      state: 'processing',
      connection: 'connecting',
      reviewed: 0,
      total: 2,
    });
    await waitUntil(
      () =>
        reviewer.snapshot([input, duplicate]).status.state === 'ready' &&
        existsSync(join(directory, 'cache.json')),
    );
    expect(reviewer.snapshot([input, duplicate]).status).toEqual({
      state: 'ready',
      connection: 'online',
      reviewed: 2,
      total: 2,
    });
    expect(reviewer.snapshot([input]).issuesById.get(input.id)).toEqual([
      expect.objectContaining({
        code: 'semantic',
        side: 'acceptance',
        suggestedTag: '通讯故障',
      }),
    ]);
    expect(post).toHaveBeenCalledTimes(1);

    const restarted = new AlarmTagSemanticReviewer({
      axiosRef: { post },
    } as unknown as HttpService);
    expect(restarted.snapshot([input]).status.state).toBe('ready');
    await waitUntil(() => restarted.snapshot([input]).status.connection === 'online');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].messages).toEqual([{ role: 'user', content: '只回复 OK' }]);
  });

  it('reports connection failure and retries the lightweight check', async () => {
    const post = jest.fn()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValue({ data: { choices: [{ message: { content: 'OK' } }] } });
    const reviewer = new AlarmTagSemanticReviewer({
      axiosRef: { post },
    } as unknown as HttpService);
    expect(reviewer.snapshot([]).status.connection).toBe('connecting');
    await waitUntil(() => reviewer.snapshot([]).status.connection === 'error');
    expect(post).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    try {
      expect(reviewer.snapshot([]).status.connection).toBe('connecting');
      await waitUntil(() => reviewer.snapshot([]).status.connection === 'online');
      expect(post).toHaveBeenCalledTimes(2);
      dateSpy.mockReturnValue(now + 11 * 60_000 + 2);
      expect(reviewer.snapshot([]).status.connection).toBe('connecting');
      await waitUntil(() => reviewer.snapshot([]).status.connection === 'online');
      expect(post).toHaveBeenCalledTimes(3);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('rejects nonboolean model verdicts instead of treating the string false as true', async () => {
    const post = jest.fn().mockImplementation(async (_url, request) => {
      const entries = JSON.parse(request.messages[1].content) as Array<{
        id: string;
      }>;
      return {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [
                    {
                      id: entries[0].id,
                      side: 'acceptance',
                      suspected: 'false',
                      reason: '',
                      suggestedTag: '',
                    },
                  ],
                }),
              },
            },
          ],
        },
      };
    });
    const reviewer = new AlarmTagSemanticReviewer({
      axiosRef: { post },
    } as unknown as HttpService);
    reviewer.snapshot([input]);
    await waitUntil(() => reviewer.snapshot([input]).status.state === 'error');
    expect(reviewer.snapshot([input]).issuesById.get(input.id)).toEqual([]);
  });

  it('processes multiple batches and persists the complete cache', async () => {
    const inputs = Array.from({ length: 11 }, (_, index) => ({
      ...input,
      id: `alarm-${index}`,
      description: `${input.description}-${index}`,
    }));
    const post = jest.fn().mockImplementation(async (_url, request) => {
      if (request.messages.length === 1) {
        return { data: { choices: [{ message: { content: 'OK' } }] } };
      }
      const entries = JSON.parse(request.messages[1].content) as Array<{
        id: string;
        reviewSides: Array<'acceptance' | 'confirmation'>;
      }>;
      return {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: entries.flatMap((entry) =>
                    entry.reviewSides.map((side) => ({
                      id: entry.id,
                      side,
                      suspected: false,
                    })),
                  ),
                }),
              },
            },
          ],
        },
      };
    });
    const reviewer = new AlarmTagSemanticReviewer({
      axiosRef: { post },
    } as unknown as HttpService);
    reviewer.snapshot(inputs);
    await waitUntil(() => reviewer.snapshot(inputs).status.state === 'ready');
    expect(post).toHaveBeenCalledTimes(2);
    expect(reviewer.snapshot(inputs).status.reviewed).toBe(11);
    const restarted = new AlarmTagSemanticReviewer({
      axiosRef: { post },
    } as unknown as HttpService);
    expect(restarted.snapshot(inputs).status.state).toBe('ready');
    await waitUntil(() => restarted.snapshot(inputs).status.connection === 'online');
    expect(post).toHaveBeenCalledTimes(3);
  });
});
