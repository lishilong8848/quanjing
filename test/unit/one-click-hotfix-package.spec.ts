import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('one-click hotfix package', () => {
  const projectRoot = resolve(__dirname, '../..');
  const installerPath = resolve(
    projectRoot,
    'scripts/install-hotfix-one-click.ps1',
  );
  const launcherPath = resolve(
    projectRoot,
    'scripts/install-hotfix-one-click.cmd',
  );
  const credentialLauncherPath = resolve(
    projectRoot,
    'scripts/update-dingtalk-credentials-one-click.cmd',
  );
  const packagerPath = resolve(
    projectRoot,
    'scripts/create-one-click-hotfix-package.ps1',
  );

  it('keeps the user flow one-click while retaining safe install and DingTalk CLI gates', () => {
    expect(existsSync(installerPath)).toBe(true);
    expect(existsSync(launcherPath)).toBe(true);
    expect(existsSync(credentialLauncherPath)).toBe(true);

    const installer = readFileSync(installerPath, 'utf8');
    const launcher = readFileSync(launcherPath, 'utf8');
    const credentialLauncher = readFileSync(credentialLauncherPath, 'utf8');

    expect(launcher).toContain('-AppRoot "%~dp0."');
    expect(launcher).toContain('ONE-CLICK-HOTFIX.ps1');
    expect(installer).toContain('Get-FileHash');
    expect(installer).toContain('Expand-Archive');
    expect(installer).toContain('[System.IO.Path]::GetTempPath()');
    expect(installer).toContain('INSTALL-HOTFIX.ps1');
    expect(installer).toContain('dingtalk-attendance-cli.mjs');
    expect(installer).toContain('--self-test');
    expect(installer).toContain('nantong-schedule.private.env');
    expect(installer).toContain('[EnvironmentVariableTarget]::User');
    expect(installer).toContain('[EnvironmentVariableTarget]::Machine');
    expect(installer).toContain('Read-ConsoleValue');
    expect(installer).toContain('[switch]$UpdateDingTalkCredentials');
    expect(installer).toContain('Test-DingTalkCredentialCandidate');
    expect(installer).toMatch(
      /Invoke-DingTalkCliSelfTest[\s\S]*-Phase 'pre-install'/,
    );
    expect(installer).not.toContain("-Phase 'post-install'");
    expect(installer).toContain(
      'installed release integrity was verified by the atomic installer',
    );
    expect(credentialLauncher).toContain('-UpdateDingTalkCredentials');
    expect(installer).toContain("'dist/server/main.js'");
    expect(installer).toContain("'node_modules'");
    expect(installer).not.toMatch(/Copy-Item[\s\S]*-Destination\s+\$appRoot/i);
  });

  it('does not report validated credentials as rejected when a later runtime update fails', () => {
    const credentialLauncher = readFileSync(credentialLauncherPath, 'utf8');

    expect(credentialLauncher).not.toContain(
      'New credentials were not accepted',
    );
    expect(credentialLauncher).toContain(
      'Runtime update was not completed',
    );
    expect(credentialLauncher).toContain(
      'credentials remain saved',
    );
  });

  it('passes the extracted application root through CMD without a trailing quote', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nantong-one-click-arg-'));
    try {
      const launcher = join(fixtureRoot, '一键更新并启动.cmd');
      copyFileSync(launcherPath, launcher);
      writeFileSync(
        join(fixtureRoot, 'ONE-CLICK-HOTFIX.ps1'),
        [
          'param([string]$AppRoot)',
          "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
          "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'captured-app-root.txt'), $AppRoot, $utf8NoBom)",
        ].join('\r\n'),
        'utf8',
      );

      const run = spawnSync('cmd.exe', ['/d', '/c', launcher], {
        cwd: fixtureRoot,
        input: '\r\n',
        encoding: 'utf8',
      });

      expect(run.status).toBe(0);
      const capturedRoot = readFileSync(
        join(fixtureRoot, 'captured-app-root.txt'),
        'utf8',
      );
      expect(capturedRoot).not.toContain('"');
      expect(resolve(capturedRoot)).toBe(resolve(fixtureRoot));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('resolves the application root from NANTONG_APP_ROOT when launched outside the app directory', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nantong-one-click-root-'));
    try {
      const launchRoot = join(fixtureRoot, 'downloaded-hotfix');
      const appRoot = join(fixtureRoot, 'app');
      mkdirSync(join(launchRoot), { recursive: true });
      mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
      mkdirSync(join(appRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(appRoot, 'package.json'), '{}\n', 'utf8');
      writeFileSync(join(appRoot, 'start.ps1'), '', 'utf8');
      writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '', 'utf8');
      copyFileSync(installerPath, join(launchRoot, 'ONE-CLICK-HOTFIX.ps1'));

      const run = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(launchRoot, 'ONE-CLICK-HOTFIX.ps1'),
          '-AppRoot',
          launchRoot,
        ],
        {
          cwd: launchRoot,
          env: { ...process.env, NANTONG_APP_ROOT: appRoot },
          encoding: 'utf8',
        },
      );

      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status).not.toBe(0);
      expect(output).toContain('Using application root:');
      expect(output).toContain('One-click payload is incomplete');
      expect(output).not.toContain(
        'Application root is missing required path: package.json',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('bootstraps missing DingTalk credentials from a legacy attachment or prompt before preflight', () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'nantong-one-click-dingtalk-bootstrap-'),
    );
    try {
      const appRoot = join(fixtureRoot, 'app');
      const sourceRoot = join(fixtureRoot, 'inner');
      const releaseScripts = join(sourceRoot, 'release-root', 'scripts');
      const payloadRoot = join(appRoot, '_hotfix-payload');
      mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
      mkdirSync(join(appRoot, 'node_modules'), { recursive: true });
      mkdirSync(releaseScripts, { recursive: true });
      mkdirSync(payloadRoot, { recursive: true });
      writeFileSync(join(appRoot, 'package.json'), '{}\n', 'utf8');
      writeFileSync(join(appRoot, 'start.ps1'), '', 'utf8');
      writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '', 'utf8');
      copyFileSync(installerPath, join(appRoot, 'ONE-CLICK-HOTFIX.ps1'));
      writeFileSync(
        join(appRoot, 'dingtalk_attendance.py'),
        [
          'import json',
          'CLIENT_ID = "fixture-client-id"',
          'CLIENT_SECRET = "fixture-client-secret"',
          '',
        ].join('\n'),
        'utf8',
      );
      copyFileSync(
        resolve(
          projectRoot,
          'scripts/migrate-dingtalk-attendance-credentials.ps1',
        ),
        join(releaseScripts, 'migrate-dingtalk-attendance-credentials.ps1'),
      );
      writeFileSync(
        join(releaseScripts, 'dingtalk-attendance-cli.mjs'),
        [
          "import { appendFileSync, readFileSync } from 'node:fs';",
          "let content = '';",
          "try { content = readFileSync('.env.local', 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }",
          "const clientId = process.env.DINGTALK_ATTENDANCE_CLIENT_ID || content.match(/DINGTALK_ATTENDANCE_CLIENT_ID=\\\"([^\\\"]+)/)?.[1] || '';",
          "const clientSecret = process.env.DINGTALK_ATTENDANCE_CLIENT_SECRET || content.match(/DINGTALK_ATTENDANCE_CLIENT_SECRET=\\\"([^\\\"]+)/)?.[1] || '';",
          "const ready = new Map([",
          "  ['fixture-client-id', 'fixture-client-secret'],",
          "  ['prompt-client-id', 'prompt-client-secret'],",
          "  ['recovery-client-id', 'recovery-client-secret'],",
          "  ['rotated-client-id', 'rotated-client-secret'],",
          "]).get(clientId) === clientSecret;",
          "appendFileSync('cli-self-test.log', ready ? 'passed\\n' : 'rejected\\n');",
          "if (!ready) { console.error('HTTP 400: Specified parameter appSecret is not valid.'); process.exit(21); }",
          "console.log(JSON.stringify({ authenticated: true }));",
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(sourceRoot, 'INSTALL-HOTFIX.ps1'),
        [
          'param([string]$AppRoot)',
          "Set-Content -LiteralPath (Join-Path $AppRoot 'installer-ran.log') -Value 'ran' -Encoding UTF8",
          "$destination = Join-Path $AppRoot 'scripts'",
          'New-Item -ItemType Directory -Path $destination -Force | Out-Null',
          "Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-root\\scripts\\dingtalk-attendance-cli.mjs') -Destination (Join-Path $destination 'dingtalk-attendance-cli.mjs') -Force",
        ].join('\r\n'),
        'utf8',
      );

      const innerZip = join(payloadRoot, 'hotfix-package.zip');
      const escapedSourceRoot = sourceRoot.replace(/'/g, "''");
      const escapedInnerZip = innerZip.replace(/'/g, "''");
      const compress = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${escapedSourceRoot}\\*' -DestinationPath '${escapedInnerZip}'`,
        ],
        { encoding: 'utf8' },
      );
      expect(compress.status).toBe(0);
      const innerBytes = readFileSync(innerZip);
      const innerSha = createHash('sha256').update(innerBytes).digest('hex');
      writeFileSync(
        `${innerZip}.sha256`,
        `${innerSha}  hotfix-package.zip\n`,
        'utf8',
      );

      const environment = {
        ...process.env,
        DINGTALK_ATTENDANCE_CLIENT_ID: '',
        DINGTALK_ATTENDANCE_CLIENT_SECRET: '',
        DINGTALK_ATTENDANCE_APP_KEY: '',
        DINGTALK_ATTENDANCE_APP_SECRET: '',
      };
      const run = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(appRoot, 'ONE-CLICK-HOTFIX.ps1'),
          '-AppRoot',
          appRoot,
        ],
        { cwd: appRoot, env: environment, encoding: 'utf8' },
      );

      expect(run.status).toBe(0);
      expect(readFileSync(join(appRoot, 'cli-self-test.log'), 'utf8')).toBe(
        'passed\n',
      );
      const environmentContent = readFileSync(
        join(appRoot, '.env.local'),
        'utf8',
      );
      expect(environmentContent).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_ID="fixture-client-id"',
      );
      expect(environmentContent).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_SECRET="fixture-client-secret"',
      );
      const migratedAttachment = readFileSync(
        join(appRoot, 'dingtalk_attendance.py'),
        'utf8',
      );
      expect(migratedAttachment).not.toContain('fixture-client-id');
      expect(migratedAttachment).not.toContain('fixture-client-secret');
      expect(migratedAttachment).toContain(
        'os.environ.get("DINGTALK_ATTENDANCE_CLIENT_ID"',
      );

      rmSync(join(appRoot, '.env.local'), { force: true });
      rmSync(join(appRoot, 'dingtalk_attendance.py'), { force: true });
      rmSync(join(appRoot, 'cli-self-test.log'), { force: true });
      const promptedRun = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(appRoot, 'ONE-CLICK-HOTFIX.ps1'),
          '-AppRoot',
          appRoot,
        ],
        {
          cwd: appRoot,
          env: environment,
          encoding: 'utf8',
          input: [
            'prompt-client-id',
            'prompt-client-secret',
            'mismatched-secret',
            'prompt-client-secret',
            'prompt-client-secret',
            '',
          ].join('\r\n'),
        },
      );

      expect(promptedRun.status).toBe(0);
      const promptedOutput = `${promptedRun.stdout}${promptedRun.stderr}`;
      expect(promptedOutput).toContain('DingTalk Client Secret (confirm):');
      expect(promptedOutput).toContain('Secret entries did not match');
      expect(promptedOutput).toContain(
        'Client Secret received: 20 characters',
      );
      expect(promptedOutput).toContain(
        'Confirmation received: 17 characters',
      );
      expect(promptedOutput).not.toContain('prompt-client-secret');
      expect(promptedOutput).not.toContain('mismatched-secret');
      expect(readFileSync(join(appRoot, 'cli-self-test.log'), 'utf8')).toBe(
        'passed\n',
      );
      const promptedEnvironment = readFileSync(
        join(appRoot, '.env.local'),
        'utf8',
      );
      expect(promptedEnvironment).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_ID="prompt-client-id"',
      );
      expect(promptedEnvironment).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_SECRET="prompt-client-secret"',
      );

      writeFileSync(
        join(appRoot, '.env.local'),
        [
          'DINGTALK_ATTENDANCE_CLIENT_ID="stale-client-id"',
          'DINGTALK_ATTENDANCE_CLIENT_SECRET="stale-client-secret"',
          '',
        ].join('\r\n'),
        'utf8',
      );
      rmSync(join(appRoot, 'cli-self-test.log'), { force: true });
      const recoveredRun = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(appRoot, 'ONE-CLICK-HOTFIX.ps1'),
          '-AppRoot',
          appRoot,
        ],
        {
          cwd: appRoot,
          env: environment,
          encoding: 'utf8',
          input: [
            'recovery-client-id',
            'recovery-client-secret',
            'recovery-client-secret',
            '',
          ].join('\r\n'),
        },
      );

      const recoveredOutput = `${recoveredRun.stdout}${recoveredRun.stderr}`;
      expect(recoveredOutput).not.toContain('[FAILED]');
      expect(recoveredRun.status).toBe(0);
      expect(recoveredOutput).toContain(
        'DingTalk rejected the configured attendance credentials',
      );
      expect(recoveredOutput).not.toContain('recovery-client-secret');
      expect(readFileSync(join(appRoot, 'cli-self-test.log'), 'utf8')).toBe(
        'rejected\npassed\n',
      );
      const recoveredEnvironment = readFileSync(
        join(appRoot, '.env.local'),
        'utf8',
      );
      expect(recoveredEnvironment).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_ID="recovery-client-id"',
      );
      expect(recoveredEnvironment).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_SECRET="recovery-client-secret"',
      );
      expect(recoveredEnvironment).not.toContain('stale-client-secret');

      rmSync(join(appRoot, 'cli-self-test.log'), { force: true });
      const rotatedRun = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(appRoot, 'ONE-CLICK-HOTFIX.ps1'),
          '-AppRoot',
          appRoot,
          '-UpdateDingTalkCredentials',
        ],
        {
          cwd: appRoot,
          env: environment,
          encoding: 'utf8',
          input: [
            'rotated-client-id',
            'rotated-client-secret',
            'rotated-client-secret',
            '',
          ].join('\r\n'),
        },
      );

      expect(rotatedRun.status).toBe(0);
      expect(`${rotatedRun.stdout}${rotatedRun.stderr}`).not.toContain(
        'rotated-client-secret',
      );
      const rotatedEnvironment = readFileSync(
        join(appRoot, '.env.local'),
        'utf8',
      );
      expect(rotatedEnvironment).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_ID="rotated-client-id"',
      );
      expect(rotatedEnvironment).toContain(
        'DINGTALK_ATTENDANCE_CLIENT_SECRET="rotated-client-secret"',
      );
      expect(readFileSync(join(appRoot, 'cli-self-test.log'), 'utf8')).toBe(
        'passed\n',
      );

      const staleEnvironment = [
          'DINGTALK_ATTENDANCE_CLIENT_ID="stale-client-id"',
          'DINGTALK_ATTENDANCE_CLIENT_SECRET="stale-client-secret"',
          'UNRELATED_SETTING="must-survive"',
          '',
        ].join('\r\n');
      writeFileSync(join(appRoot, '.env.local'), staleEnvironment, 'utf8');
      rmSync(join(appRoot, 'cli-self-test.log'), { force: true });
      rmSync(join(appRoot, 'installer-ran.log'), { force: true });
      const runtimeBeforeRejectedRetry = createHash('sha256')
        .update(readFileSync(join(appRoot, 'dist', 'server', 'main.js')))
        .digest('hex');
      const rejectedRetryRun = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(appRoot, 'ONE-CLICK-HOTFIX.ps1'),
          '-AppRoot',
          appRoot,
        ],
        {
          cwd: appRoot,
          env: environment,
          encoding: 'utf8',
          input: [
            'still-wrong-client-id',
            'still-wrong-client-secret',
            'still-wrong-client-secret',
            '',
          ].join('\r\n'),
        },
      );

      expect(rejectedRetryRun.status).not.toBe(0);
      expect(
        `${rejectedRetryRun.stdout}${rejectedRetryRun.stderr}`,
      ).not.toContain('still-wrong-client-secret');
      expect(readFileSync(join(appRoot, 'cli-self-test.log'), 'utf8')).toBe(
        'rejected\nrejected\n',
      );
      expect(existsSync(join(appRoot, 'installer-ran.log'))).toBe(false);
      expect(readFileSync(join(appRoot, '.env.local'), 'utf8')).toBe(
        staleEnvironment,
      );
      expect(
        createHash('sha256')
          .update(readFileSync(join(appRoot, 'dist', 'server', 'main.js')))
          .digest('hex'),
      ).toBe(runtimeBeforeRejectedRetry);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('builds a wrapper archive around an unchanged verified hotfix zip', () => {
    expect(existsSync(packagerPath)).toBe(true);
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nantong-one-click-test-'));
    try {
      const sourceZip = join(fixtureRoot, 'source-hotfix.zip');
      const sourceBytes = Buffer.from('immutable nested hotfix fixture');
      writeFileSync(sourceZip, sourceBytes);
      const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
      writeFileSync(
        `${sourceZip}.sha256`,
        `${sourceSha}  source-hotfix.zip\n`,
        'utf8',
      );
      const outputZip = join(fixtureRoot, 'one-click.zip');

      const build = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          packagerPath,
          '-SourceHotfixZip',
          sourceZip,
          '-OutputPath',
          outputZip,
        ],
        { cwd: projectRoot, encoding: 'utf8' },
      );
      expect(build.status).toBe(0);
      expect(build.stderr).toBe('');
      expect(existsSync(outputZip)).toBe(true);
      expect(existsSync(`${outputZip}.sha256`)).toBe(true);

      const extractRoot = join(fixtureRoot, 'extracted');
      const escapedOutputZip = outputZip.replace(/'/g, "''");
      const escapedExtractRoot = extractRoot.replace(/'/g, "''");
      const expand = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${escapedOutputZip}' -DestinationPath '${escapedExtractRoot}'`,
        ],
        { encoding: 'utf8' },
      );
      expect(expand.status).toBe(0);
      expect(
        existsSync(join(extractRoot, '一键更新并启动.cmd')),
      ).toBe(true);
      expect(
        existsSync(
          join(extractRoot, '\u66f4\u65b0\u9489\u9489\u51ed\u8bc1\u5e76\u4e00\u952e\u66f4\u65b0.cmd'),
        ),
      ).toBe(true);
      expect(existsSync(join(extractRoot, 'ONE-CLICK-HOTFIX.ps1'))).toBe(
        true,
      );
      // Receipt transport is not production-accepted yet; ordinary packages must not enable it.
      expect(readFileSync(join(extractRoot, 'ONE-CLICK-HOTFIX.ps1'), 'utf8')).not.toContain(
        'function Invoke-HotfixReceiptRelay',
      );
      expect(
        readFileSync(
          join(extractRoot, '_hotfix-payload/hotfix-package.zip'),
        ),
      ).toEqual(sourceBytes);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('refuses to wrap a hotfix whose declared hash does not match', () => {
    expect(existsSync(packagerPath)).toBe(true);
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nantong-one-click-hash-'));
    try {
      const sourceZip = join(fixtureRoot, 'source-hotfix.zip');
      writeFileSync(sourceZip, 'changed bytes');
      writeFileSync(`${sourceZip}.sha256`, `${'0'.repeat(64)}  source.zip\n`);

      const build = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          packagerPath,
          '-SourceHotfixZip',
          sourceZip,
          '-OutputPath',
          join(fixtureRoot, 'must-not-exist.zip'),
        ],
        { cwd: projectRoot, encoding: 'utf8' },
      );

      expect(build.status).not.toBe(0);
      expect(`${build.stdout}\n${build.stderr}`).toContain(
        'Source hotfix SHA-256 does not match',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
