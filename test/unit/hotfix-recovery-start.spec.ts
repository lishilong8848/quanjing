import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(__dirname, '../..');
const RECOVERY_SCRIPT = join(ROOT, 'deploy', 'hotfix-recovery-start.ps1');
const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

jest.setTimeout(30_000);

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for recovery environment capture: ${path}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function stopFixtureRuntime(root: string): void {
  const pidPath = join(root, 'app.pid');
  if (!existsSync(pidPath)) return;

  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as {
      pid?: unknown;
    };
    const pid = Number(record.pid);
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // The test assertion reports launcher failures; cleanup remains best-effort.
  }
}

describeWindows('hotfix recovery standalone environment', () => {
  it('accepts the proven Node runtime in every fixed sample without terminating its version process early', () => {
    const script = [
      "$ErrorActionPreference='Stop'",
      '$tokens=$null; $errors=$null',
      `$ast=[Management.Automation.Language.Parser]::ParseFile('${RECOVERY_SCRIPT.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors)`,
      "if($errors.Count){throw 'Recovery script parse failure'}",
      "$definition=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Test-NodeRuntime'})",
      "if($definition.Count -ne 1){throw 'Missing runtime detector'}",
      '. ([scriptblock]::Create($definition[0].Extent.Text))',
      `$nodePath='${process.execPath.replace(/'/g, "''")}'`,
      '$rejected=0',
      'for($i=0;$i -lt 24;$i++){if(-not (Test-NodeRuntime -Path $nodePath -RequiredMajor 22)){$rejected++}}',
      "if(Test-NodeRuntime -Path ($nodePath+'.missing') -RequiredMajor 22){throw 'Missing runtime accepted'}",
      "if(Test-NodeRuntime -Path $nodePath -RequiredMajor 99){throw 'Insufficient runtime accepted'}",
      '[pscustomobject]@{samples=24;rejected=$rejected}|ConvertTo-Json -Compress',
    ].join('; ');
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ samples: 24, rejected: 0 });
  });

  it('uses the installer-proven Node executable and forces Datapass off for recovery', async () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-recovery-env-'),
    );
    const launcherPath = join(fixtureRoot, '.hotfix-recovery-start.test.ps1');
    const capturePath = join(fixtureRoot, 'captured-environment.json');
    const mainPath = join(fixtureRoot, 'dist', 'server', 'main.js');

    try {
      mkdirSync(dirname(mainPath), { recursive: true });
      copyFileSync(RECOVERY_SCRIPT, launcherPath);
      writeFileSync(
        join(fixtureRoot, '.env'),
        'SUDA_DATABASE_URL=\r\n',
        'utf8',
      );
      writeFileSync(
        mainPath,
        [
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.RECOVERY_ENV_CAPTURE, JSON.stringify({ nodeEnv: process.env.NODE_ENV, forceFrameworkDisableDatapass: process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS, nodePath: process.execPath, changeIndexPath: process.env.COS_CHANGE_INDEX_PATH }), 'utf8');",
          'setTimeout(() => process.exit(0), 5_000);',
        ].join('\r\n'),
        'utf8',
      );

      const result = spawnSync(
        POWERSHELL,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          launcherPath,
          '-NoBrowser',
        ],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => key.toLowerCase() !== 'path',
              ),
            ),
            Path: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
            ProgramFiles: '',
            'ProgramFiles(x86)': '',
            LOCALAPPDATA: '',
            NANTONG_HOTFIX_RECOVERY_NODE_PATH: process.execPath,
            RECOVERY_ENV_CAPTURE: capturePath,
            SUDA_DATABASE_URL: '',
            FORCE_FRAMEWORK_DISABLE_DATAPASS: 'false',
          },
        },
      );

      expect(result.error).toBeUndefined();
      if (result.status !== 0) {
        throw new Error(
          `Recovery launcher failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      await waitForFile(capturePath);
      expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual({
        nodeEnv: 'production',
        forceFrameworkDisableDatapass: 'true',
        nodePath: process.execPath,
        changeIndexPath: join(
          dirname(fixtureRoot),
          'nantong-schedule-state',
          'change-attachment-cos-index.json',
        ),
      });
    } finally {
      stopFixtureRuntime(fixtureRoot);
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('isolates legacy attachment locks whose PID belongs to a newer process generation', async () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-recovery-lock-'),
    );
    const launcherPath = join(fixtureRoot, '.hotfix-recovery-start.test.ps1');
    const capturePath = join(fixtureRoot, 'captured-environment.json');
    const mainPath = join(fixtureRoot, 'dist', 'server', 'main.js');
    const changeIndexPath = join(fixtureRoot, 'state', 'change-index.json');
    const contractIndexPath = join(fixtureRoot, 'state', 'contract-index.json');
    const changeLockPath = `${changeIndexPath}.lock`;
    const contractLockPath = `${contractIndexPath}.migration.lock`;

    try {
      mkdirSync(dirname(mainPath), { recursive: true });
      mkdirSync(dirname(changeIndexPath), { recursive: true });
      copyFileSync(RECOVERY_SCRIPT, launcherPath);
      writeFileSync(
        join(fixtureRoot, '.env'),
        [
          'SUDA_DATABASE_URL=',
          `COS_CHANGE_INDEX_PATH=${changeIndexPath}`,
          `COS_CONTRACT_INDEX_PATH=${contractIndexPath}`,
        ].join('\r\n'),
        'utf8',
      );
      for (const lockPath of [changeLockPath, contractLockPath]) {
        writeFileSync(
          lockPath,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            token: 'legacy-reused-pid-token',
          }),
          'utf8',
        );
        utimesSync(lockPath, new Date(0), new Date(0));
      }
      writeFileSync(
        mainPath,
        [
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.RECOVERY_ENV_CAPTURE, JSON.stringify({ ready: true }), 'utf8');",
          'setTimeout(() => process.exit(0), 5_000);',
        ].join('\r\n'),
        'utf8',
      );

      const result = spawnSync(
        POWERSHELL,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          launcherPath,
          '-NoBrowser',
        ],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => key.toLowerCase() !== 'path',
              ),
            ),
            Path: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
            ProgramFiles: '',
            'ProgramFiles(x86)': '',
            LOCALAPPDATA: '',
            NANTONG_HOTFIX_RECOVERY_NODE_PATH: process.execPath,
            RECOVERY_ENV_CAPTURE: capturePath,
            COS_CHANGE_INDEX_PATH: '',
            COS_CONTRACT_INDEX_PATH: '',
          },
        },
      );

      expect(result.error).toBeUndefined();
      if (result.status !== 0) {
        throw new Error(
          `Recovery launcher failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      await waitForFile(capturePath);
      expect(existsSync(changeLockPath)).toBe(false);
      expect(existsSync(contractLockPath)).toBe(false);
    } finally {
      stopFixtureRuntime(fixtureRoot);
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
