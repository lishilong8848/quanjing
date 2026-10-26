import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const scriptPath = resolve(
  'scripts/repair-ali-monthly-report-python-runtime.ps1',
);
const cmdGeneratorPath = resolve(
  'scripts/create-ali-monthly-report-runtime-repair-cmd.ps1',
);

function writeCompletePywin32Fixture(bundlePath: string): void {
  const files = [
    ['pythoncom.py'],
    ['pywin32.pth'],
    ['pywin32_system32', 'pythoncom312.dll'],
    ['pywin32_system32', 'pywintypes312.dll'],
    ['win32', '_win32sysloader.pyd'],
    ['win32', 'win32api.pyd'],
    ['win32', 'lib', 'pywin32_bootstrap.py'],
    ['win32', 'lib', 'pywintypes.py'],
    ['win32com', '__init__.py'],
    ['win32com', 'client', '__init__.py'],
  ];
  for (const parts of files) {
    const filePath = join(bundlePath, ...parts);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '# fixture\n');
  }
}

describe('Ali monthly report Python runtime repair', () => {
  let appRoot = '';

  afterEach(() => {
    if (appRoot) {
      rmSync(appRoot, { recursive: true, force: true });
      appRoot = '';
    }
  });

  it('builds a self-contained CMD launcher that always pauses', () => {
    expect(existsSync(cmdGeneratorPath)).toBe(true);
    if (!existsSync(cmdGeneratorPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-cmd-'));
    const cmdPath = join(appRoot, 'repair-ali-monthly-report.cmd');
    const portablePythonArchive = join(appRoot, 'portable-python.zip');
    const pywin32RepairArchive = join(appRoot, 'pywin32-repair.zip');
    const portableFixture = Buffer.alloc(5000, 0x41);
    writeFileSync(portablePythonArchive, portableFixture);
    writeFileSync(pywin32RepairArchive, 'fixture pywin32\n');
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        cmdGeneratorPath,
        '-PayloadPath',
        scriptPath,
        '-OutputPath',
        cmdPath,
        '-PortablePythonArchivePath',
        portablePythonArchive,
        '-Pywin32RepairArchivePath',
        pywin32RepairArchive,
      ],
      { encoding: 'utf8' },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    const cmd = readFileSync(cmdPath, 'utf8');
    expect(cmd).toContain('@@POWERSHELL_PAYLOAD@@');
    expect(cmd).toContain('@@PORTABLE_PYTHON_ZIP_BASE64@@');
    expect(cmd).toContain('@@PYWIN32_REPAIR_ZIP_BASE64@@');
    expect(cmd).toContain('ALI_REPAIR_PYTHON_SHA256=');
    expect(cmd).toContain('ALI_REPAIR_PYWIN32_SHA256=');
    expect(cmd).toContain('Zml4dHVyZSBweXdpbjMyCg==');
    expect(cmd).toContain('-ForcePortablePython');
    expect(cmd).toContain('ExecutionPolicy Bypass');
    expect(cmd).toContain('pause >nul');
    const payloadBoundary = cmd.lastIndexOf('\r\n@@POWERSHELL_PAYLOAD@@\r\n');
    expect(payloadBoundary).toBeGreaterThan(0);
    const launcher = cmd.slice(0, payloadBoundary);
    expect(launcher).toContain('[INFO] Extracting embedded repair program...');
    expect(launcher).toContain('[INFO] Embedded repair program ready.');
    expect(launcher).toContain('[IO.File]::OpenText');
    expect(launcher).not.toContain('ReadAllLines');
    expect(cmd).toContain('function Read-EmbeddedBase64Payload');
    expect(cmd).toContain('function Invoke-WithFileSystemRetry');
    expect(cmd).toContain('was temporarily blocked');
    expect(cmd).toContain('function Invoke-PowerShellScriptWithTimeout');
    expect(cmd).toContain("Write-RepairSubstep -Substep '1/5'");
    expect(cmd).toContain("Write-RepairSubstep -Substep '5/5'");
    expect(cmd).toContain("Write-RepairProgress -Step '1/6'");
    expect(cmd).toContain('function Test-PythonRuntime');
    expect(cmd).toContain('function Install-PortablePythonRuntime');
    expect(cmd).not.toContain('repair-ali-monthly-report-python-runtime.ps1"');
    const portableBoundary = cmd.lastIndexOf(
      '\r\n@@PORTABLE_PYTHON_ZIP_BASE64@@\r\n',
    );
    const pywin32Boundary = cmd.lastIndexOf(
      '\r\n@@PYWIN32_REPAIR_ZIP_BASE64@@\r\n',
    );
    const portableBase64 = cmd.slice(
      portableBoundary + '\r\n@@PORTABLE_PYTHON_ZIP_BASE64@@\r\n'.length,
      pywin32Boundary,
    );
    expect(portableBase64.trim().split(/\r?\n/u)).toHaveLength(2);
    expect(
      Buffer.from(portableBase64.replace(/\s/gu, ''), 'base64').equals(
        portableFixture,
      ),
    ).toBe(true);
  });

  it('repairs an incomplete pywin32 bundle and configures its import paths', () => {
    expect(existsSync(scriptPath)).toBe(true);
    if (!existsSync(scriptPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-pywin32-repair-'));
    const expectedBundle = join(
      appRoot,
      'python',
      'ali-monthly-report-packages',
    );
    const repairSource = join(appRoot, 'pywin32-repair-source');
    const repairArchive = join(appRoot, 'pywin32-repair.zip');
    const probePath = join(
      appRoot,
      'tools',
      'ali-monthly-report',
      'python_dependency_probe.py',
    );
    const fakePython = join(appRoot, 'fake-python.cmd');

    mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
    mkdirSync(join(expectedBundle, 'win32com', 'client'), { recursive: true });
    mkdirSync(join(repairSource, 'pywin32_system32'), { recursive: true });
    mkdirSync(join(repairSource, 'win32', 'lib'), { recursive: true });
    mkdirSync(join(repairSource, 'win32com', 'client'), { recursive: true });
    mkdirSync(dirname(probePath), { recursive: true });
    writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '// fixture\n');
    writeFileSync(join(expectedBundle, 'pythoncom.py'), '# incomplete\n');
    writeFileSync(
      join(expectedBundle, 'win32com', 'client', '__init__.py'),
      '# incomplete\n',
    );
    writeFileSync(join(repairSource, 'pythoncom.py'), '# repaired\n');
    writeFileSync(join(repairSource, 'pywin32.pth'), '# repaired\n');
    writeFileSync(
      join(repairSource, 'win32', 'lib', 'pywin32_bootstrap.py'),
      '# repaired\n',
    );
    writeFileSync(
      join(repairSource, 'pywin32_system32', 'pythoncom312.dll'),
      'fixture\n',
    );
    writeFileSync(
      join(repairSource, 'pywin32_system32', 'pywintypes312.dll'),
      'fixture\n',
    );
    writeFileSync(
      join(repairSource, 'win32', '_win32sysloader.pyd'),
      'fixture\n',
    );
    writeFileSync(
      join(repairSource, 'win32', 'win32api.pyd'),
      'fixture\n',
    );
    writeFileSync(
      join(repairSource, 'win32', 'lib', 'pywintypes.py'),
      '# repaired\n',
    );
    writeFileSync(
      join(repairSource, 'win32com', '__init__.py'),
      '# repaired\n',
    );
    writeFileSync(
      join(repairSource, 'win32com', 'client', '__init__.py'),
      '# repaired\n',
    );
    writeFileSync(probePath, '# fixture\n');
    const archiveResult = spawnSync(
      'tar.exe',
      ['-a', '-cf', repairArchive, '-C', repairSource, '.'],
      { encoding: 'utf8' },
    );
    expect(archiveResult).toMatchObject({ status: 0, stderr: '' });
    writeFileSync(
      fakePython,
      [
        '@echo off',
        'if "%~1"=="-c" (',
        '  echo {"major":3,"minor":12,"bits":64,"system":"Windows"}',
        '  exit /b 0',
        ')',
        'echo {"ready":true}',
        'exit /b 0',
      ].join('\r\n'),
    );

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-Python',
        fakePython,
        '-Pywin32RepairArchivePath',
        repairArchive,
        '-NoRestart',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ALI_MONTHLY_REPORT_PYTHON: '',
          PYTHON: '',
          PYTHONPATH: '',
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('REPAIR_READY');
    expect(
      existsSync(join(expectedBundle, 'win32', 'lib', 'pywintypes.py')),
    ).toBe(true);
    expect(
      existsSync(
        join(expectedBundle, 'pywin32_system32', 'pythoncom312.dll'),
      ),
    ).toBe(true);
    const envLocal = readFileSync(join(appRoot, '.env.local'), 'utf8');
    expect(envLocal).toContain(join(expectedBundle, 'win32'));
    expect(envLocal).toContain(join(expectedBundle, 'win32', 'lib'));
  });

  it('pauses and removes its temporary payload after a CMD failure', () => {
    expect(existsSync(cmdGeneratorPath)).toBe(true);
    if (!existsSync(cmdGeneratorPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-cmd-fail-'));
    const cmdPath = join(appRoot, 'repair-ali-monthly-report.cmd');
    const isolatedTemp = join(appRoot, 'temp');
    mkdirSync(isolatedTemp, { recursive: true });
    const generatorResult = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        cmdGeneratorPath,
        '-PayloadPath',
        scriptPath,
        '-OutputPath',
        cmdPath,
      ],
      { encoding: 'utf8' },
    );
    expect(generatorResult).toMatchObject({ status: 0, stderr: '' });

    const result = spawnSync('cmd.exe', ['/d', '/c', cmdPath], {
      encoding: 'utf8',
      input: '\n',
      env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[ERROR] Repair failed.');
    expect(result.stdout).toContain('Press any key to close this window');
    expect(readdirSync(isolatedTemp)).toHaveLength(0);
  });

  it('promotes a nested bundled runtime and preserves unrelated dotenv values', () => {
    expect(existsSync(scriptPath)).toBe(true);
    if (!existsSync(scriptPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-repair-'));
    const nestedBundle = join(
      appRoot,
      'ali-monthly-report-server-runtime-hotfix-fixture',
      'python',
      'ali-monthly-report-packages',
    );
    const expectedBundle = join(
      appRoot,
      'python',
      'ali-monthly-report-packages',
    );
    const probePath = join(
      appRoot,
      'tools',
      'ali-monthly-report',
      'python_dependency_probe.py',
    );
    const fakePython = join(appRoot, 'fake-python.cmd');
    const envLocalPath = join(appRoot, '.env.local');

    mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
    mkdirSync(join(appRoot, 'deploy'), { recursive: true });
    mkdirSync(join(nestedBundle, 'win32com', 'client'), { recursive: true });
    mkdirSync(join(probePath, '..'), { recursive: true });
    writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '// fixture\n');
    writeFileSync(join(nestedBundle, 'pythoncom.py'), '# fixture\n');
    writeFileSync(
      join(nestedBundle, 'win32com', 'client', '__init__.py'),
      '# fixture\n',
    );
    writeCompletePywin32Fixture(nestedBundle);
    writeFileSync(probePath, '# fixture\n');
    writeFileSync(
      fakePython,
      [
        '@echo off',
        'if "%~1"=="-c" (',
        '  echo {"major":3,"minor":12,"bits":64,"system":"Windows"}',
        '  exit /b 0',
        ')',
        'echo {"ready":true}',
        'exit /b 0',
      ].join('\r\n'),
    );
    writeFileSync(
      envLocalPath,
      [
        'SECRET_VALUE=keep-me',
        'ALI_MONTHLY_REPORT_PYTHON=stale-python',
        'PYTHONPATH=stale-path',
        '',
      ].join('\r\n'),
    );

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-Python',
        fakePython,
        '-NoRestart',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ALI_MONTHLY_REPORT_PYTHON: '',
          PYTHON: '',
          PYTHONPATH: '',
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('REPAIR_READY');
    expect(result.stdout).not.toContain('keep-me');
    expect(existsSync(join(expectedBundle, 'pythoncom.py'))).toBe(true);
    expect(
      existsSync(join(expectedBundle, 'win32com', 'client', '__init__.py')),
    ).toBe(true);

    const envLocal = readFileSync(envLocalPath, 'utf8');
    expect(envLocal).toContain('SECRET_VALUE=keep-me');
    expect(envLocal).toContain(
      `ALI_MONTHLY_REPORT_PYTHON='${fakePython}'`,
    );
    expect(envLocal).toContain(
      `PYTHONPATH='${[
        expectedBundle,
        join(expectedBundle, 'win32'),
        join(expectedBundle, 'win32', 'lib'),
        join(expectedBundle, 'Pythonwin'),
        'stale-path',
      ].join(';')}'`,
    );
    expect(envLocal.match(/^ALI_MONTHLY_REPORT_PYTHON=/gmu)).toHaveLength(1);
    expect(envLocal.match(/^PYTHONPATH=/gmu)).toHaveLength(1);

    const backups = readdirSync(appRoot).filter((name) =>
      /^\.env\.local\.ali-monthly-report-repair-.+\.bak$/u.test(name),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(appRoot, backups[0]), 'utf8')).toContain(
      'ALI_MONTHLY_REPORT_PYTHON=stale-python',
    );
    expect(
      readdirSync(join(appRoot, 'python')).some((name) =>
        name.startsWith('.ali-stage-'),
      ),
    ).toBe(false);
  });

  it('restores the previous runtime and config when the repaired service cannot start', () => {
    expect(existsSync(scriptPath)).toBe(true);
    if (!existsSync(scriptPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-rollback-'));
    const nestedBundle = join(
      appRoot,
      'ali-monthly-report-server-runtime-hotfix-fixture',
      'python',
      'ali-monthly-report-packages',
    );
    const expectedBundle = join(
      appRoot,
      'python',
      'ali-monthly-report-packages',
    );
    const probePath = join(
      appRoot,
      'tools',
      'ali-monthly-report',
      'python_dependency_probe.py',
    );
    const fakePython = join(appRoot, 'fake-python.cmd');
    const envLocalPath = join(appRoot, '.env.local');
    const startCountPath = join(appRoot, 'start-count.txt');
    const originalEnv = 'SECRET_VALUE=keep-me\r\nPYTHONPATH=old-path\r\n';

    mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
    mkdirSync(join(appRoot, 'deploy'), { recursive: true });
    mkdirSync(expectedBundle, { recursive: true });
    mkdirSync(join(nestedBundle, 'win32com', 'client'), { recursive: true });
    mkdirSync(join(probePath, '..'), { recursive: true });
    writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '// fixture\n');
    writeFileSync(join(expectedBundle, 'old-marker.txt'), 'old runtime\n');
    writeFileSync(join(nestedBundle, 'pythoncom.py'), '# fixture\n');
    writeFileSync(
      join(nestedBundle, 'win32com', 'client', '__init__.py'),
      '# fixture\n',
    );
    writeCompletePywin32Fixture(nestedBundle);
    writeFileSync(probePath, '# fixture\n');
    writeFileSync(
      fakePython,
      [
        '@echo off',
        'if "%~1"=="-c" (',
        '  echo {"major":3,"minor":12,"bits":64,"system":"Windows"}',
        '  exit /b 0',
        ')',
        'echo {"ready":true}',
        'exit /b 0',
      ].join('\r\n'),
    );
    writeFileSync(
      join(appRoot, 'deploy', 'stop.ps1'),
      'param([int]$Port = 0)\nexit 0\n',
    );
    writeFileSync(
      join(appRoot, 'start.ps1'),
      [
        'param([int]$Port = 0, [string]$HostName = "", [switch]$NoBrowser)',
        '$count = 0',
        'if (Test-Path -LiteralPath $env:ALI_REPAIR_START_COUNT) {',
        '  $count = [int][IO.File]::ReadAllText($env:ALI_REPAIR_START_COUNT)',
        '}',
        '$count += 1',
        '[IO.File]::WriteAllText($env:ALI_REPAIR_START_COUNT, [string]$count)',
        'if ($count -eq 1) { exit 23 }',
        'exit 0',
      ].join('\r\n'),
    );
    writeFileSync(envLocalPath, originalEnv);

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-Python',
        fakePython,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ALI_MONTHLY_REPORT_PYTHON: '',
          ALI_REPAIR_START_COUNT: startCountPath,
          PYTHON: '',
          PYTHONPATH: '',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('REPAIR_READY');
    expect(result.stderr).toContain('Service restart failed');
    expect(result.stderr).not.toContain('keep-me');
    expect(readFileSync(envLocalPath, 'utf8')).toBe(originalEnv);
    expect(existsSync(join(expectedBundle, 'old-marker.txt'))).toBe(true);
    expect(existsSync(join(expectedBundle, 'pythoncom.py'))).toBe(false);
    expect(readFileSync(startCountPath, 'utf8')).toBe('2');
  });

  it('terminates a hanging service process tree and reports the exact restart stage', () => {
    expect(existsSync(scriptPath)).toBe(true);
    if (!existsSync(scriptPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-timeout-'));
    const expectedBundle = join(
      appRoot,
      'python',
      'ali-monthly-report-packages',
    );
    const probePath = join(
      appRoot,
      'tools',
      'ali-monthly-report',
      'python_dependency_probe.py',
    );
    const fakePython = join(appRoot, 'fake-python.cmd');
    const envLocalPath = join(appRoot, '.env.local');
    const childScriptPath = join(appRoot, 'hanging-child.ps1');
    const childPidPath = join(appRoot, 'hanging-child.pid');
    const childCompletedPath = join(appRoot, 'hanging-child-completed.txt');
    const actionsPath = join(appRoot, 'service-actions.txt');
    const originalEnv = 'SECRET_VALUE=keep-me\r\nPYTHONPATH=old-path\r\n';

    mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
    mkdirSync(join(appRoot, 'deploy'), { recursive: true });
    mkdirSync(dirname(probePath), { recursive: true });
    writeCompletePywin32Fixture(expectedBundle);
    writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '// fixture\n');
    writeFileSync(probePath, '# fixture\n');
    writeFileSync(
      fakePython,
      [
        '@echo off',
        'if "%~1"=="-c" (',
        '  echo {"major":3,"minor":12,"bits":64,"system":"Windows"}',
        '  exit /b 0',
        ')',
        'echo {"ready":true}',
        'exit /b 0',
      ].join('\r\n'),
    );
    writeFileSync(
      join(appRoot, 'deploy', 'stop.ps1'),
      [
        'param([int]$Port = 0)',
        '[IO.File]::AppendAllText($env:ALI_REPAIR_ACTIONS, "stop`n")',
        'exit 0',
      ].join('\r\n'),
    );
    writeFileSync(
      childScriptPath,
      [
        '[IO.File]::WriteAllText($env:ALI_REPAIR_CHILD_PID, [string]$PID)',
        'Start-Sleep -Seconds 30',
        '[IO.File]::WriteAllText($env:ALI_REPAIR_CHILD_COMPLETED, "completed")',
      ].join('\r\n'),
    );
    writeFileSync(
      join(appRoot, 'start.ps1'),
      [
        'param([int]$Port = 0, [string]$HostName = "", [switch]$NoBrowser)',
        '[IO.File]::AppendAllText($env:ALI_REPAIR_ACTIONS, "start`n")',
        '$child = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList @("-NoProfile", "-File", $env:ALI_REPAIR_CHILD_SCRIPT) -PassThru',
        '$child.WaitForExit()',
        'exit $child.ExitCode',
      ].join('\r\n'),
    );
    writeFileSync(envLocalPath, originalEnv);

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-Python',
        fakePython,
        '-ServiceStartTimeoutSeconds',
        '15',
        '-ServiceStopTimeoutSeconds',
        '20',
        '-RollbackStartTimeoutSeconds',
        '15',
      ],
      {
        encoding: 'utf8',
        timeout: 65_000,
        env: {
          ...process.env,
          ALI_MONTHLY_REPORT_PYTHON: '',
          ALI_REPAIR_ACTIONS: actionsPath,
          ALI_REPAIR_CHILD_SCRIPT: childScriptPath,
          ALI_REPAIR_CHILD_PID: childPidPath,
          ALI_REPAIR_CHILD_COMPLETED: childCompletedPath,
          PYTHON: '',
          PYTHONPATH: '',
        },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[STEP 5/6][5/5]');
    expect(result.stderr).toContain(
      'Service restart timed out after 15 second(s)',
    );
    expect(result.stderr).toContain(
      'Failed to restart the previous service after rollback',
    );
    expect(readFileSync(envLocalPath, 'utf8')).toBe(originalEnv);
    expect(existsSync(childPidPath)).toBe(true);
    expect(existsSync(childCompletedPath)).toBe(false);
  }, 70_000);

  it('runs from a self-contained CMD beside the application files', () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(existsSync(cmdGeneratorPath)).toBe(true);
    if (!existsSync(scriptPath)) return;
    if (!existsSync(cmdGeneratorPath)) return;

    appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-root-'));
    const rootCmdPath = join(appRoot, 'repair-ali-monthly-report.cmd');
    const nestedBundle = join(
      appRoot,
      'ali-monthly-report-server-runtime-hotfix-fixture',
      'python',
      'ali-monthly-report-packages',
    );
    const probePath = join(
      appRoot,
      'tools',
      'ali-monthly-report',
      'python_dependency_probe.py',
    );
    const fakePython = join(appRoot, 'fake-python.cmd');
    const actionsPath = join(appRoot, 'service-actions.txt');

    const generatorResult = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        cmdGeneratorPath,
        '-PayloadPath',
        scriptPath,
        '-OutputPath',
        rootCmdPath,
      ],
      { encoding: 'utf8' },
    );
    expect(generatorResult).toMatchObject({ status: 0, stderr: '' });
    mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
    mkdirSync(join(appRoot, 'deploy'), { recursive: true });
    mkdirSync(join(nestedBundle, 'win32com', 'client'), { recursive: true });
    mkdirSync(join(probePath, '..'), { recursive: true });
    writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '// fixture\n');
    writeFileSync(join(nestedBundle, 'pythoncom.py'), '# fixture\n');
    writeFileSync(
      join(nestedBundle, 'win32com', 'client', '__init__.py'),
      '# fixture\n',
    );
    writeCompletePywin32Fixture(nestedBundle);
    writeFileSync(probePath, '# fixture\n');
    writeFileSync(
      fakePython,
      [
        '@echo off',
        'if "%~1"=="-c" (',
        '  echo {"major":3,"minor":12,"bits":64,"system":"Windows"}',
        '  exit /b 0',
        ')',
        'echo {"ready":true}',
        'exit /b 0',
      ].join('\r\n'),
    );
    writeFileSync(
      join(appRoot, 'deploy', 'stop.ps1'),
      [
        'param([int]$Port = 0)',
        '[IO.File]::AppendAllText($env:ALI_REPAIR_ACTIONS, "stop`n")',
        'exit 0',
      ].join('\r\n'),
    );
    writeFileSync(
      join(appRoot, 'start.ps1'),
      [
        'param([int]$Port = 0, [string]$HostName = "", [switch]$NoBrowser)',
        '[IO.File]::AppendAllText($env:ALI_REPAIR_ACTIONS, "start`n")',
        'exit 0',
      ].join('\r\n'),
    );
    writeFileSync(
      join(appRoot, '.env.local'),
      `ALI_MONTHLY_REPORT_PYTHON='${fakePython}'\r\n`,
    );

    const result = spawnSync(
      'cmd.exe',
      ['/d', '/c', rootCmdPath],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        input: '\n',
        env: {
          ...process.env,
          ALI_MONTHLY_REPORT_PYTHON: '',
          ALI_REPAIR_ACTIONS: actionsPath,
          PYTHON: '',
          PYTHONPATH: '',
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('REPAIR_READY');
    expect(result.stdout).toContain('Press any key to close this window');
    expect(readFileSync(actionsPath, 'utf8')).toBe('stop\nstart\n');
    expect(
      existsSync(
        join(
          appRoot,
          'python',
          'ali-monthly-report-packages',
          'pythoncom.py',
        ),
      ),
    ).toBe(true);
  });

  const portableArchivePath = process.env.ALI_REPAIR_TEST_PORTABLE_ARCHIVE;
  const runtimePackagePath = process.env.ALI_REPAIR_TEST_RUNTIME_PACKAGE;
  const pywin32RepairArchivePath =
    process.env.ALI_REPAIR_TEST_PYWIN32_ARCHIVE;
  const portableIntegrationTest =
    portableArchivePath && runtimePackagePath && pywin32RepairArchivePath
      ? it
      : it.skip;

  portableIntegrationTest(
    'runs the complete CMD flow with embedded portable Python',
    () => {
      appRoot = mkdtempSync(join(tmpdir(), 'ali-monthly-runtime-portable-'));
      const rootCmdPath = join(appRoot, 'repair-ali-monthly-report.cmd');
      const nestedBundle = join(
        appRoot,
        'python',
        'ali-monthly-report-packages',
      );
      const probePath = join(
        appRoot,
        'tools',
        'ali-monthly-report',
        'python_dependency_probe.py',
      );
      const actionsPath = join(appRoot, 'service-actions.txt');

      mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
      mkdirSync(join(appRoot, 'deploy'), { recursive: true });
      mkdirSync(join(probePath, '..'), { recursive: true });
      writeFileSync(join(appRoot, 'dist', 'server', 'main.js'), '// fixture\n');
      writeFileSync(
        probePath,
        readFileSync(
          resolve('tools/ali-monthly-report/python_dependency_probe.py'),
        ),
      );
      writeFileSync(
        join(appRoot, 'deploy', 'stop.ps1'),
        [
          'param([int]$Port = 0)',
          '[IO.File]::AppendAllText($env:ALI_REPAIR_ACTIONS, "stop`n")',
          'exit 0',
        ].join('\r\n'),
      );
      writeFileSync(
        join(appRoot, 'start.ps1'),
        [
          'param([int]$Port = 0, [string]$HostName = "", [switch]$NoBrowser)',
          '[IO.File]::AppendAllText($env:ALI_REPAIR_ACTIONS, "start`n")',
          'exit 0',
        ].join('\r\n'),
      );

      const generatorResult = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          cmdGeneratorPath,
          '-PayloadPath',
          scriptPath,
          '-OutputPath',
          rootCmdPath,
          '-PortablePythonArchivePath',
          portableArchivePath!,
          '-Pywin32RepairArchivePath',
          pywin32RepairArchivePath!,
        ],
        { encoding: 'utf8' },
      );
      expect(generatorResult).toMatchObject({ status: 0, stderr: '' });

      const result = spawnSync('cmd.exe', ['/d', '/c', rootCmdPath], {
        cwd: dirname(runtimePackagePath!),
        encoding: 'utf8',
        input: '\n',
        env: {
          ...process.env,
          ALI_MONTHLY_REPORT_PYTHON: '',
          ALI_REPAIR_ACTIONS: actionsPath,
          PYTHON: '',
          PYTHONPATH: '',
        },
      });

      expect(result).toMatchObject({ status: 0, stderr: '' });
      expect(result.stdout).toContain('[INFO] Embedded repair program ready.');
      expect(result.stdout).toContain('[STEP 1/6]');
      expect(result.stdout).toContain('[STEP 6/6]');
      expect(result.stdout).toContain('REPAIR_READY');
      expect(result.stdout).toContain(
        join(
          appRoot,
          '.runtime',
          'python312-ali-monthly-report',
          'python.exe',
        ),
      );
      expect(readFileSync(actionsPath, 'utf8')).toBe('stop\nstart\n');
      expect(existsSync(join(nestedBundle, 'pythoncom.py'))).toBe(true);
      expect(
        existsSync(
          join(
            appRoot,
            '.runtime',
            'python312-ali-monthly-report',
            'python.exe',
          ),
        ),
      ).toBe(true);
    },
    240_000,
  );
});
