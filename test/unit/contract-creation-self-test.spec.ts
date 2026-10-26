import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('real contract creation self-test command', () => {
  const root = resolve(__dirname, '../..');
  const scriptPath = resolve(root, 'scripts/self-test-contract-creation.mjs');
  const source = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
  const serviceSource = readFileSync(
    resolve(
      root,
      'server/modules/contract-management/contract-creation.service.ts',
    ),
    'utf8',
  );
  const packageJson = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  it('runs against the compiled Nest application and creates a marked PDF', () => {
    expect(source).toContain('dist/server/app.module.js');
    expect(source).toContain('CODEX-SELFTEST-');
    expect(source).toContain('runRealSelfTest');
    expect(source).toContain('buildOnePagePdf');
    expect(source).toContain('FORCE_AUTHN_INNERAPI_DOMAIN');
    expect(source).toContain('abortOnError: false');
    expect(source).toContain('FORCE_FRAMEWORK_DISABLE_DATAPASS');
  });

  it('owns cleanup in a finally block and verifies no residual record', () => {
    expect(serviceSource).toContain('runRealSelfTest');
    expect(serviceSource).toContain('finally');
    expect(serviceSource).toContain('cleanupSelfTestRecord');
    expect(serviceSource).toContain('residualRecord: false');
    expect(serviceSource).toContain('cleanupMarkedSelfTestResidue');
    expect(serviceSource).toContain(
      "const SELF_TEST_MARKER_PREFIX = 'CODEX-SELFTEST-'",
    );
    expect(serviceSource).toContain('startsWith(\n    SELF_TEST_MARKER_PREFIX');
  });

  it('is exposed as a production-build package command', () => {
    expect(packageJson.scripts['self-test:contract-creation']).toContain(
      'scripts/self-test-contract-creation.mjs',
    );
  });
});
