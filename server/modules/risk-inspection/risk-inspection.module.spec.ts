import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('RiskInspectionModule dependency injection', () => {
  it('starts and closes the real Nest application context', () => {
    expect(() => execFileSync(process.execPath, [
      resolve(process.cwd(), 'test/integration/risk-inspection-module-di.cjs'),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.node.json' },
      timeout: 60_000,
      stdio: 'pipe',
    })).not.toThrow();
  });
});
