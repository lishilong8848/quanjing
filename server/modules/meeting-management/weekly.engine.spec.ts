import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeeklyEngine, WeeklyEngineError } from './weekly.engine';
import { HttpService } from '@nestjs/axios';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
jest.mock('../../common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('qa-token'),
}));
const http = {} as HttpService;

describe('weekly isolated process bridge', () => {
  it('复用系统应用认证，仅通过stdin传给Python，不依赖CLI', async () => {
    writeFileSync(
      join(root, 'bridge.py'),
      'import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({"ok":True,"result":{"ready":p.get("_nativeAccessToken")=="qa-token","version":"standalone-20261009-template-v3"}}))\n',
    );
    const result = await new WeeklyEngine(http).check();
    expect(result.ready).toBe(true);
    expect(getTenantAccessToken).toHaveBeenCalledWith(
      http,
      undefined,
      expect.any(Object),
    );
    expect(JSON.stringify(result)).not.toContain('qa-token');
  });
  it('系统应用认证失败保留安全提示，不启动Python或暴露密钥', async () => {
    writeFileSync(join(root, 'bridge.py'), 'raise Exception("must not start")');
    jest
      .mocked(getTenantAccessToken)
      .mockRejectedValueOnce(new Error('PRIVATE_SECRET'));
    const result = await new WeeklyEngine(http).check();
    expect(result.ready).toBe(false);
    expect(result.message).toContain('应用认证失败');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  });
  it('检查失败保留安全类别，显式重检可恢复，同轮并发只执行一次', async () => {
    const engine = new WeeklyEngine(http);
    let finish: (result: Record<string, unknown>) => void = () => undefined;
    const call = jest
      .spyOn(engine, 'call')
      .mockRejectedValueOnce(
        new WeeklyEngineError('PRIVATE_SENTINEL', undefined, {
          category: 'timeout',
          type: 'TimeoutError',
          frames: [],
        }),
      )
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const failed = await engine.check();
    expect(failed.message).toContain('检查超时');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
    const first = engine.check();
    const second = engine.check();
    expect(call).toHaveBeenCalledTimes(2);
    expect(engine.status().message).toBe('正在检查周报引擎');
    finish({ ready: true, version: 'standalone-20261009-template-v3' });
    expect(await first).toMatchObject({ ready: true, message: null });
    expect(await second).toMatchObject({ ready: true, message: null });
  });
  it.each([
    ['cli-config-read', '配置读取失败'],
    ['cli-config-output', '配置输出无法识别'],
    ['cli-app-mismatch', '应用不一致'],
    ['busy', '正在运行'],
  ])('检查%s展示区别，不暴露原始信息', async (category, message) => {
    const engine = new WeeklyEngine(http);
    jest.spyOn(engine, 'call').mockRejectedValue(
      new WeeklyEngineError('PRIVATE_SENTINEL', undefined, {
        category,
        type: 'MockError',
        frames: [],
      }),
    );
    const status = await engine.check();
    expect(status.ready).toBe(false);
    expect(status.message).toContain(message);
    expect(JSON.stringify(status)).not.toContain('PRIVATE_SENTINEL');
  });
  it('成功信封但没有ready或模板版本不一致时不能伪报就绪', async () => {
    const engine = new WeeklyEngine(http);
    const call = jest
      .spyOn(engine, 'call')
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValueOnce({ ready: true, version: 'unknown' });
    expect((await engine.check()).ready).toBe(false);
    expect((await engine.check()).ready).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('显式请求有冷却且不自动循环，普通status不执行检查', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10000);
    try {
      const engine = new WeeklyEngine(http);
      const call = jest
        .spyOn(engine, 'call')
        .mockRejectedValue(
          new WeeklyEngineError('PRIVATE', undefined, { category: 'timeout' }),
        );
      await engine.check();
      engine.requestCheck();
      engine.status();
      expect(call).toHaveBeenCalledTimes(1);
      now.mockReturnValue(15001);
      engine.requestCheck();
      await engine.check();
      expect(call).toHaveBeenCalledTimes(2);
      engine.status();
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
  it('重检遇到生成锁时不终止在途任务，完成后可再次检查', async () => {
    writeFileSync(
      join(root, 'bridge.py'),
      'import sys,json,time\njson.load(sys.stdin)\ntime.sleep(.2)\nprint(json.dumps({"ok":True,"result":{"ready":True,"version":"standalone-20261009-template-v3"}}))\n',
    );
    const engine = new WeeklyEngine(http);
    const running = engine.call({ action: 'qa' }, 5000);
    const status = await engine.check();
    expect(status.ready).toBe(false);
    expect(status.message).toContain('正在运行');
    await expect(running).resolves.toMatchObject({ ready: true });
    await expect(engine.check()).resolves.toMatchObject({
      ready: true,
      message: null,
    });
  });
  it('缺失脚本和无法启动的解释器提示明确且没有原始路径', async () => {
    const engine = new WeeklyEngine(http);
    expect((await engine.check()).message).toContain('运行文件缺失');
    writeFileSync(join(root, 'bridge.py'), 'print("not executed")');
    const oldPython = process.env.NANTONG_WEEKLY_PYTHON;
    process.env.NANTONG_WEEKLY_PYTHON = join(
      root,
      'PRIVATE_SENTINEL-python.exe',
    );
    try {
      const failed = await engine.check();
      expect(failed.message).toContain('无法启动');
      expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
    } finally {
      if (oldPython === undefined) delete process.env.NANTONG_WEEKLY_PYTHON;
      else process.env.NANTONG_WEEKLY_PYTHON = oldPython;
    }
  });
  it('maps timeout to an actionable error and only preserves bounded safe diagnostic fields', async () => {
    writeFileSync(
      join(root, 'bridge.py'),
      'import sys,json\njson.load(sys.stdin)\nprint(json.dumps({"ok":False,"diagnostic":{"category":"timeout","type":"RuntimeError","frames":["main:68","SECRET token=private"],"raw":"SECRET"}}))\nsys.exit(1)\n',
    );
    try {
      await new WeeklyEngine(http).call({ action: 'prepare' }, 5000);
      throw new Error('expected failure');
    } catch (error) {
      expect(error.message).toContain('超时');
      expect(error.diagnostic).toEqual({
        category: 'timeout',
        type: 'RuntimeError',
        frames: ['main:68'],
      });
      expect(JSON.stringify(error)).not.toContain('SECRET');
    }
  });
  jest.setTimeout(30000);
  let root: string;
  const keys = ['NANTONG_WEEKLY_ENGINE_DIR', 'WEEKLY_WORKSPACE_DIR'];
  const before: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of keys) before[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'weekly-engine-test-'));
    process.env.NANTONG_WEEKLY_ENGINE_DIR = root;
    process.env.WEEKLY_WORKSPACE_DIR = root;
  });
  afterEach(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  it('decodes Chinese output split across UTF-8 chunks and serializes engine calls', async () => {
    writeFileSync(
      join(root, 'bridge.py'),
      'import sys,time,json\njson.load(sys.stdin)\nb=json.dumps({"ok":True,"result":{"text":"南通周报"}},ensure_ascii=False).encode("utf-8")\ni=b.index("南".encode("utf-8"))+1\nsys.stdout.buffer.write(b[:i]);sys.stdout.flush();time.sleep(.15);sys.stdout.buffer.write(b[i:]);sys.stdout.flush()\n',
    );
    const engine = new WeeklyEngine(http);
    const first = engine.call({ action: 'qa' }, 5000);
    await expect(engine.call({ action: 'qa' }, 5000)).rejects.toThrow(
      '正在运行',
    );
    await expect(first).resolves.toEqual({ text: '南通周报' });
    await expect(engine.call({ action: 'qa' }, 5000)).resolves.toEqual({
      text: '南通周报',
    });
  });
  it('terminates its own timed-out child and permits a later invocation', async () => {
    writeFileSync(
      join(root, 'bridge.py'),
      'import sys,time,json\njson.load(sys.stdin)\ntime.sleep(30)\n',
    );
    const engine = new WeeklyEngine(http);
    await expect(engine.call({ action: 'qa' }, 150)).rejects.toThrow('超时');
    writeFileSync(
      join(root, 'bridge.py'),
      'import json,sys\njson.load(sys.stdin)\nprint(json.dumps({"ok":True,"result":{"ready":True}}))\n',
    );
    await expect(engine.call({ action: 'qa' }, 5000)).resolves.toEqual({
      ready: true,
    });
  });
});
