import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('reused build toolchain gate', () => {
  const script = resolve(
    __dirname,
    '../../scripts/verify-reused-build-toolchain.mjs',
  );
  const packagePath = resolve(__dirname, '../../package.json');
  const lockPath = resolve(__dirname, '../../package-lock.json');
  const nodeModulesRoot = resolve(__dirname, '../../node_modules');

  const run = (root = nodeModulesRoot) =>
    spawnSync(
      process.execPath,
      [
        script,
        '--package',
        packagePath,
        '--lock',
        lockPath,
        '--node-modules-root',
        root,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

  it('proves the locked build dependencies in the reused tree', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      packages: expect.arrayContaining([
        expect.objectContaining({ name: '@nestjs/cli' }),
        expect.objectContaining({ name: '@rspack/cli' }),
        expect.objectContaining({ name: 'typescript' }),
      ]),
    });
  });

  it('fails closed when the reusable dependency root is unavailable', () => {
    const result = run(resolve(__dirname, '../../missing-node-modules'));
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
  });
});
