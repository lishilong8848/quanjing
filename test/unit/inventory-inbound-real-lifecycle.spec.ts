import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const lifecycleModuleUrl = pathToFileURL(
  resolve('scripts/inventory-inbound-real-lifecycle.mjs'),
).href;

function runLifecycleScenario(source: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { runInventoryInboundLifecycle } from ${JSON.stringify(
        lifecycleModuleUrl,
      )};\n${source}`,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function expectScenarioResult(source: string): Record<string, unknown> {
  const result = runLifecycleScenario(source);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('inventory inbound real-data lifecycle', () => {
  it.each(['prepare', 'checkpoint', 'verify'])(
    'cleans persisted test state when %s fails and preserves the original error',
    (command) => {
      const result = expectScenarioResult(`
        const original = new Error('operation failed');
        let cleanupCalls = 0;
        try {
          await runInventoryInboundLifecycle({
            command: ${JSON.stringify(command)},
            operation: async () => { throw original; },
            hasState: async () => true,
            cleanup: async () => { cleanupCalls += 1; },
          });
        } catch (error) {
          process.stdout.write(JSON.stringify({
            cleanupCalls,
            sameError: error === original,
            message: error.message,
          }));
        }
      `);

      expect(result).toEqual({
        cleanupCalls: 1,
        sameError: true,
        message: 'operation failed',
      });
    },
  );

  it('does not invoke cleanup when a failed lifecycle command has no state', () => {
    const result = expectScenarioResult(`
      const original = new Error('operation failed');
      let cleanupCalls = 0;
      try {
        await runInventoryInboundLifecycle({
          command: 'verify',
          operation: async () => { throw original; },
          hasState: async () => false,
          cleanup: async () => { cleanupCalls += 1; },
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          cleanupCalls,
          sameError: error === original,
        }));
      }
    `);

    expect(result).toEqual({ cleanupCalls: 0, sameError: true });
  });

  it('cleans persisted test state after verify succeeds', () => {
    const result = expectScenarioResult(`
      let cleanupCalls = 0;
      const value = await runInventoryInboundLifecycle({
        command: 'verify',
        operation: async () => 'verified',
        hasState: async () => true,
        cleanup: async () => { cleanupCalls += 1; },
      });
      process.stdout.write(JSON.stringify({ value, cleanupCalls }));
    `);

    expect(result).toEqual({ value: 'verified', cleanupCalls: 1 });
  });

  it('reports both the operation and cleanup errors', () => {
    const result = expectScenarioResult(`
      try {
        await runInventoryInboundLifecycle({
          command: 'checkpoint',
          operation: async () => { throw new Error('checkpoint failed'); },
          hasState: async () => true,
          cleanup: async () => { throw new Error('cleanup failed'); },
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          name: error.name,
          message: error.message,
          errors: Array.from(error.errors || [], (item) => item.message),
        }));
      }
    `);

    expect(result).toEqual({
      name: 'AggregateError',
      message:
        'checkpoint 失败，自动清理也失败：checkpoint failed；cleanup failed',
      errors: ['checkpoint failed', 'cleanup failed'],
    });
  });

  it.each(['cleanup', 'cleanup-only', 'status'])(
    'does not attach automatic cleanup to %s',
    (command) => {
      const result = expectScenarioResult(`
        const original = new Error('operation failed');
        let stateChecks = 0;
        let cleanupCalls = 0;
        try {
          await runInventoryInboundLifecycle({
            command: ${JSON.stringify(command)},
            operation: async () => { throw original; },
            hasState: async () => { stateChecks += 1; return true; },
            cleanup: async () => { cleanupCalls += 1; },
          });
        } catch (error) {
          process.stdout.write(JSON.stringify({
            stateChecks,
            cleanupCalls,
            sameError: error === original,
          }));
        }
      `);

      expect(result).toEqual({
        stateChecks: 0,
        cleanupCalls: 0,
        sameError: true,
      });
    },
  );

  it('routes the real self-test commands through the lifecycle coordinator', () => {
    const script = readFileSync(
      resolve('scripts/self-test-inventory-inbound-real.mjs'),
      'utf8',
    );

    expect(script).toContain("from './inventory-inbound-real-lifecycle.mjs'");
    expect(script).toContain('await runInventoryInboundLifecycle({');
    expect(script).toContain(
      'hasState: async () => Boolean(await loadState(false))',
    );
  });
});
