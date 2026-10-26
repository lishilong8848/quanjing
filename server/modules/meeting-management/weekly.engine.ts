import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { acquireWeeklyLock } from './weekly.store';

const ENGINE_ERRORS = {
  timeout: '周报采集或写入请求超时，已保留进度，请重试失败步骤',
  'target-date': '目标周报日期与结束日期不一致，请核对目标条目',
  'target-missing': '未找到唯一的目标周报，请核对源表条目',
  'previous-content': '上一期内容读取失败，请核对专业线、运营线章节与文档权限',
  config: '周报引擎配置不匹配，请核对Python及飞书应用配置',
  'app-auth': '飞书应用认证失败，请核对服务应用配置后重新检查',
  'api-permission': '飞书应用无法访问周报来源或文档，请核对权限后重试',
  'api-request': '飞书接口请求未确认，已保留进度，请重试失败步骤',
  'document-format': '周报包含暂不支持的文档格式，请核对模板后重试',
  'document-conflict': '周报文档已发生变化，请核对内容后重试',
  execution:
    '周报引擎执行失败，已保留进度，请重试失败步骤；再次失败请联系管理员',
  'runtime-start': '周报进程无法启动，请核对服务运行账号可用的解释器路径',
  'runtime-access': '周报进程无执行权限，请核对服务运行账号权限',
  'script-missing': '周报运行文件缺失，请核对部署包中的周报脚本',
  workspace: '周报工作目录不可用，请核对服务运行账号的目录权限',
  busy: '周报任务正在运行，请完成后重新检查',
  'bridge-output': '周报检查结果无法识别，请核对运行文件版本',
  'cli-missing': '服务运行环境未找到飞书CLI，请核对服务账号的CLI路径',
  'cli-config-read': '飞书CLI配置读取失败，请核对服务运行账号后重新检查',
  'cli-config-output': '飞书CLI配置输出无法识别，请核对CLI版本后重新检查',
  'cli-app-missing': '服务未提供飞书应用标识，请核对服务环境配置',
  'cli-app-mismatch': '飞书CLI与系统的应用不一致，请核对服务运行账号的应用配置',
};
export interface WeeklyEngineDiagnostic {
  category: keyof typeof ENGINE_ERRORS;
  type: string;
  frames: string[];
}
export function safeWeeklyEngineDiagnostic(
  value: unknown,
): WeeklyEngineDiagnostic {
  const source =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return {
    category:
      typeof source.category === 'string' &&
      Object.prototype.hasOwnProperty.call(ENGINE_ERRORS, source.category)
        ? (source.category as keyof typeof ENGINE_ERRORS)
        : 'execution',
    type:
      typeof source.type === 'string' &&
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(source.type)
        ? source.type
        : 'UnknownError',
    frames: Array.isArray(source.frames)
      ? source.frames
          .filter(
            (frame): frame is string =>
              typeof frame === 'string' &&
              /^[A-Za-z_][A-Za-z0-9_]{0,63}:\d{1,6}$/.test(frame),
          )
          .slice(-12)
      : [],
  };
}

export class WeeklyEngineError extends Error {
  readonly diagnostic: WeeklyEngineDiagnostic;
  constructor(
    message: string,
    readonly documentUrl?: string,
    diagnostic?: unknown,
  ) {
    super(message);
    this.diagnostic = safeWeeklyEngineDiagnostic(diagnostic);
  }
}

@Injectable()
export class WeeklyEngine {
  constructor(private readonly http: HttpService) {}
  private checking?: Promise<ReturnType<WeeklyEngine['status']>>;
  private lastCheckStarted = 0;
  private readiness: {
    ready: boolean;
    message: string | null;
    templateVersion: string;
  } = {
    ready: false,
    message: '正在检查周报引擎',
    templateVersion: 'standalone-20261009-template-v3',
  };
  check() {
    if (this.checking) return this.checking;
    if (this.readiness.ready) return Promise.resolve(this.status());
    this.lastCheckStarted = Date.now();
    this.readiness.message = '正在检查周报引擎';
    this.checking = (async () => {
      try {
        const result = await this.call({ action: 'check' }, 20000);
        if (
          result.ready !== true ||
          result.version !== this.readiness.templateVersion
        )
          throw new WeeklyEngineError(
            ENGINE_ERRORS['bridge-output'],
            undefined,
            { category: 'bridge-output' },
          );
        this.readiness.ready = true;
        this.readiness.message = null;
      } catch (error) {
        this.readiness.ready = false;
        const category =
          error instanceof WeeklyEngineError
            ? error.diagnostic.category
            : 'execution';
        this.readiness.message =
          category === 'timeout'
            ? '周报引擎检查超时，请重新检查'
            : ENGINE_ERRORS[category];
      }
      return this.status();
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  requestCheck() {
    if (
      this.readiness.ready ||
      this.checking ||
      Date.now() - this.lastCheckStarted < 5000
    )
      return;
    void this.check();
  }
  status() {
    return { ...this.readiness };
  }
  async call(
    payload: Record<string, unknown>,
    timeout = 360000,
  ): Promise<Record<string, unknown>> {
    const root = resolve(
      process.env.NANTONG_WEEKLY_ENGINE_DIR ||
        join(process.cwd(), 'scripts/weekly-report'),
    );
    if (!existsSync(join(root, 'bridge.py')))
      return Promise.reject(
        new WeeklyEngineError(ENGINE_ERRORS['script-missing'], undefined, {
          category: 'script-missing',
        }),
      );
    let accessToken: string | undefined;
    if (
      ['check', 'prepare', 'create', 'document'].includes(
        String(payload.action),
      )
    ) {
      try {
        const deadline = Date.now() + Math.min(timeout, 15000);
        accessToken = await getTenantAccessToken(this.http, undefined, {
          requestTimeoutMs: () => Math.max(1, deadline - Date.now()),
          waitFor: (promise) =>
            new Promise((resolveAuth, rejectAuth) => {
              const timer = setTimeout(
                () => rejectAuth(new Error('auth deadline')),
                Math.max(1, deadline - Date.now()),
              );
              promise
                .then(resolveAuth, rejectAuth)
                .finally(() => clearTimeout(timer));
            }),
        });
      } catch {
        throw new WeeklyEngineError(ENGINE_ERRORS['app-auth'], undefined, {
          category: 'app-auth',
        });
      }
    }
    const work = resolve(
      process.env.WEEKLY_WORKSPACE_DIR ||
        join(
          process.env.FEISHU_LOCAL_CACHE_DIR || join(process.cwd(), '.cache'),
          'weekly-workspace',
        ),
      'engine',
    );
    const processLock = join(work, 'active-process');
    let release: ReturnType<typeof acquireWeeklyLock>;
    try {
      mkdirSync(work, { recursive: true });
      release = acquireWeeklyLock(processLock);
    } catch {
      return Promise.reject(
        new WeeklyEngineError(ENGINE_ERRORS.workspace, undefined, {
          category: 'workspace',
        }),
      );
    }
    if (!release)
      return Promise.reject(
        new WeeklyEngineError(ENGINE_ERRORS.busy, undefined, {
          category: 'busy',
        }),
      );
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        process.env.NANTONG_WEEKLY_PYTHON || 'python',
        ['-B', join(root, 'bridge.py')],
        {
          cwd: root,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONDONTWRITEBYTECODE: '1',
            FEISHU_ENV_FILE: join(work, 'disabled-env'),
            NANTONG_WEEKLY_WORK_DIR: work,
          },
        },
      );
      if (child.pid)
        writeFileSync(join(processLock, 'child-pid'), String(child.pid), {
          mode: 0o600,
        });
      let output = '';
      let failure: string | null = null;
      let released = false;
      let exitDeadline: ReturnType<typeof setTimeout> | undefined;
      const releaseOnce = () => {
        if (!released) {
          released = true;
          release();
        }
      };
      const decoder = new StringDecoder('utf8');
      const stop = (message: string) => {
        if (failure) return;
        failure = message;
        exitDeadline = setTimeout(() => {
          // Keep the process lock until close; an unconfirmed process must never allow a new writer.
          reject(
            new WeeklyEngineError(
              '周报进程退出未确认，后续生成已暂停；请核对任务状态',
            ),
          );
        }, 20000);
        if (!child.pid) return;
        // Terminate only the process tree created by this invocation, including its CLI descendants.
        if (process.platform === 'win32')
          execFile(
            join(
              process.env.SystemRoot || 'C:\\Windows',
              'System32',
              'taskkill.exe',
            ),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 15000 },
            () => undefined,
          );
        else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill();
          }
        }
      };
      const timer = setTimeout(() => {
        stop('周报引擎超时，请查看任务状态');
      }, timeout);
      child.stdout.on('data', (chunk: Buffer) => {
        output += decoder.write(chunk);
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) {
          stop('周报内容超出限制');
        }
      });
      child.stderr.on('data', () => {
        /* The bridge returns sanitized errors; never expose raw CLI output. */
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (exitDeadline) clearTimeout(exitDeadline);
        releaseOnce();
        const category =
          error.code === 'EACCES' || error.code === 'EPERM'
            ? 'runtime-access'
            : 'runtime-start';
        reject(
          new WeeklyEngineError(ENGINE_ERRORS[category], undefined, {
            category,
            type: 'ProcessStartError',
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (exitDeadline) clearTimeout(exitDeadline);
        releaseOnce();
        if (failure) {
          reject(
            new WeeklyEngineError(failure, undefined, {
              category: failure.includes('超时') ? 'timeout' : 'execution',
            }),
          );
          return;
        }
        output += decoder.end();
        try {
          const value = JSON.parse(output);
          if (code !== 0 || !value.ok || !value.result) {
            const diagnostic = safeWeeklyEngineDiagnostic(value.diagnostic);
            reject(
              new WeeklyEngineError(
                ENGINE_ERRORS[diagnostic.category],
                /^https:\/\/vnet\.feishu\.cn\/docx\/[A-Za-z0-9]+$/.test(
                  value.documentUrl || '',
                )
                  ? value.documentUrl
                  : undefined,
                diagnostic,
              ),
            );
            return;
          }
          resolveResult(value.result);
        } catch {
          reject(
            new WeeklyEngineError(ENGINE_ERRORS['bridge-output'], undefined, {
              category: 'bridge-output',
            }),
          );
        }
      });
      child.stdin.on('error', () => {
        /* Spawn/close handlers report process failure. */
      });
      // The short-lived application token stays off command lines, logs and the task ledger.
      child.stdin.end(
        JSON.stringify({
          ...payload,
          ...(accessToken ? { _nativeAccessToken: accessToken } : {}),
        }),
      );
    });
  }
}
