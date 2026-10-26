import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

describe('run-with-env credential preservation', () => {
  it('keeps inherited object-storage credentials when dotenv placeholders are empty', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nantong-run-with-env-'));
    try {
      writeFileSync(
        join(fixtureDir, '.env'),
        [
          'TENCENTCLOUD_SECRET_ID=',
          'TENCENTCLOUD_SECRET_KEY=from-env-key',
          'TENCENTCLOUD_SESSION_TOKEN=from-env-token',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(fixtureDir, '.env.local'),
        [
          'TENCENTCLOUD_SECRET_ID=',
          'TENCENTCLOUD_SECRET_KEY=',
          'TENCENTCLOUD_SESSION_TOKEN=from-local-token',
        ].join('\n'),
        'utf8',
      );
      const probePath = join(fixtureDir, 'probe.mjs');
      writeFileSync(
        probePath,
        `process.stdout.write(JSON.stringify({
          inheritedSecretPreserved: process.env.TENCENTCLOUD_SECRET_ID === 'from-process-id',
          envSecretPreserved: process.env.TENCENTCLOUD_SECRET_KEY === 'from-env-key',
          localSecretApplied: process.env.TENCENTCLOUD_SESSION_TOKEN === 'from-local-token',
        }));`,
        'utf8',
      );

      const result = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../../scripts/run-with-env.mjs'),
          process.execPath,
          probePath,
        ],
        {
          cwd: fixtureDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TENCENTCLOUD_SECRET_ID: 'from-process-id',
            TENCENTCLOUD_SECRET_KEY: 'from-process-key',
            TENCENTCLOUD_SESSION_TOKEN: 'from-process-token',
          },
          timeout: 15_000,
        },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        inheritedSecretPreserved: true,
        envSecretPreserved: true,
        localSecretApplied: true,
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
