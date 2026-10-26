import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('DingTalk attendance hotfix packaging', () => {
  const packager = readFileSync(
    resolve(
      __dirname,
      '../../scripts/create-safe-full-runtime-hotfix-package.ps1',
    ),
    'utf8',
  );

  it('installs the sanitized CLI and credential migration helper as release files', () => {
    expect(packager).toContain(
      "'scripts/dingtalk-attendance-cli.mjs' = 'scripts/dingtalk-attendance-cli.mjs'",
    );
    expect(packager).toContain(
      "'scripts/migrate-dingtalk-attendance-credentials.ps1' = 'scripts/migrate-dingtalk-attendance-credentials.ps1'",
    );
  });

  it('documents secret-free server configuration and the packaged CLI self-test', () => {
    expect(packager).toContain('DINGTALK_ATTENDANCE_CLIENT_ID');
    expect(packager).toContain('DINGTALK_ATTENDANCE_CLIENT_SECRET');
    expect(packager).toContain(
      'node scripts/dingtalk-attendance-cli.mjs --self-test',
    );
    expect(packager).toContain(
      'The archive never contains DingTalk credentials.',
    );
  });
});
