import { HttpService } from '@nestjs/axios';
import { NantongAssistantService } from './nantong-assistant.service';

const request = {
  messages: [{ role: 'user' as const, content: 'A楼有多少告警？' }],
  context: {
    scope: 'today' as const,
    start: '2026-09-22',
    end: '2026-09-28',
    total: 10,
    pending: 2,
    tagAnomalies: 1,
    buildings: [{ name: 'A楼', total: 4, anomalies: 1 }],
    review: { state: 'ready', reviewed: 10, total: 10 },
  },
};

describe('NantongAssistantService', () => {
  const previousKey = process.env.TODAY_OPERATIONS_ALARM_AI_API_KEY;
  const previousUrl = process.env.TODAY_OPERATIONS_ALARM_AI_BASE_URL;
  const previousModel = process.env.TODAY_OPERATIONS_ALARM_AI_MODEL;
  const post = jest.fn();
  const service = new NantongAssistantService({ axiosRef: { post } } as unknown as HttpService);

  beforeEach(() => {
    process.env.TODAY_OPERATIONS_ALARM_AI_API_KEY = 'test-only-placeholder';
    process.env.TODAY_OPERATIONS_ALARM_AI_BASE_URL = 'https://example.test/v1/chat/completions';
    process.env.TODAY_OPERATIONS_ALARM_AI_MODEL = 'test-model';
    post.mockReset();
    post.mockResolvedValue({ data: { choices: [{ message: { content: 'A楼有 4 条告警。' } }] } });
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.TODAY_OPERATIONS_ALARM_AI_API_KEY;
    else process.env.TODAY_OPERATIONS_ALARM_AI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.TODAY_OPERATIONS_ALARM_AI_BASE_URL;
    else process.env.TODAY_OPERATIONS_ALARM_AI_BASE_URL = previousUrl;
    if (previousModel === undefined) delete process.env.TODAY_OPERATIONS_ALARM_AI_MODEL;
    else process.env.TODAY_OPERATIONS_ALARM_AI_MODEL = previousModel;
  });

  it('uses the server configuration and current page summary for a response', async () => {
    await expect(service.chat(request, 'user-one', 'guest')).resolves.toEqual({ answer: 'A楼有 4 条告警。' });
    expect(post).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        model: 'test-model',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system', content: expect.stringContaining('当前身份是游客') }),
          expect.objectContaining({ role: 'system', content: expect.stringContaining('"total":10') }),
        ]),
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-only-placeholder' }) }),
    );
  });

  it('uses a different policy after login without accepting a role from the request body', async () => {
    await service.chat(request, 'admin-one', 'admin');
    const messages = post.mock.calls[0][1].messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('当前身份已登录') }),
    ]));
    expect(messages.some((message) => message.content.includes('当前身份是游客'))).toBe(false);
  });

  it('rejects invalid client data before calling the provider', async () => {
    await expect(service.chat({ messages: [{ role: 'assistant', content: 'hello' }] }, 'user-two', 'guest')).rejects.toThrow('请先输入问题');
    await expect(service.chat({ ...request, context: { ...request.context, total: -1 } }, 'user-two', 'guest')).rejects.toThrow('页面数据无效');
    await expect(service.chat({ ...request, context: { ...request.context, scope: 'private' as 'today' } }, 'user-two', 'guest')).rejects.toThrow('页面数据无效');
    expect(post).not.toHaveBeenCalled();
  });

  it('returns an actionable error when the provider fails', async () => {
    post.mockRejectedValueOnce(new Error('provider failure'));
    await expect(service.chat(request, 'user-three', 'guest')).rejects.toThrow('小帮手暂时无法回答，请重试');
  });

  it('distinguishes provider timeout from other failures', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(service.chat(request, 'user-timeout', 'guest')).rejects.toThrow('模型响应超时，请重试');
  });

  it('limits repeated questions by the same principal', async () => {
    for (let index = 0; index < 8; index += 1) await service.chat(request, 'user-four', 'guest');
    await expect(service.chat(request, 'user-four', 'guest')).rejects.toThrow('提问过于频繁');
    expect(post).toHaveBeenCalledTimes(8);
  });
});
