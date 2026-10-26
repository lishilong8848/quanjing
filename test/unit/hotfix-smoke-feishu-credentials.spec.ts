import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const wrapper = resolve(
  __dirname,
  '../../scripts/run-hotfix-smoke-with-feishu-credentials.mjs',
);
const prepareStandby = resolve(__dirname, '../../scripts/prepare-hotfix-smoke-standby.ps1');

describe('hotfix smoke Feishu credential gate', () => {
  let root: string;
  let source: string;
  let app: string;
  let candidate: string;
  let marker: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hotfix-smoke-credentials-'));
    source = join(root, 'workspace');
    app = join(root, 'smoke-app');
    candidate = join(root, 'candidate');
    marker = join(root, 'installer-started.txt');
    mkdirSync(source);
    mkdirSync(app);
    mkdirSync(join(candidate, 'release-root', 'scripts'), { recursive: true });
    writeFileSync(join(source, '.env'), 'FEISHU_APP_ID=cli_valid_test\nFEISHU_APP_SECRET=secret_never_log\n');
    writeFileSync(join(source, '.env.local'), 'DINGTALK_ATTENDANCE_CLIENT_ID=test_client\nDINGTALK_ATTENDANCE_CLIENT_SECRET=dingtalk_secret_never_log\n');
    writeFileSync(join(app, '.env'), 'KEEP=1\n');
    writeFileSync(
      join(candidate, 'release-root', 'scripts', 'ensure-purchase-inventory-config.mjs'),
      'if (process.env.FEISHU_APP_ID !== "cli_valid_test" || process.env.FEISHU_APP_SECRET !== "secret_never_log" || !process.argv.includes("--check-only")) process.exit(17); console.log("read-only preflight passed");\n',
    );
    writeFileSync(
      join(candidate, 'release-root', 'scripts', 'dingtalk-attendance-cli.mjs'),
      'if (process.env.DINGTALK_ATTENDANCE_CLIENT_ID !== "test_client" || process.env.DINGTALK_ATTENDANCE_CLIENT_SECRET !== "dingtalk_secret_never_log" || !process.argv.includes("--self-test")) process.exit(17); console.log(JSON.stringify({ authenticated: true, attendanceApiCalls: 0, mode: "credential-only" }));\n',
    );
    writeFileSync(
      join(root, 'fake-installer.mjs'),
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "started");\n',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = () =>
    spawnSync(
      process.execPath,
      [
        wrapper,
        '--credential-root', source,
        '--app-root', app,
        '--candidate-root', candidate,
        '--', process.execPath, join(root, 'fake-installer.mjs'), marker,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            ![
              'FEISHU_APP_ID',
              'FEISHU_APP_SECRET',
              'DINGTALK_ATTENDANCE_CLIENT_ID',
              'DINGTALK_ATTENDANCE_CLIENT_SECRET',
            ].includes(name),
          ),
        ),
      },
    );

  it('runs the exact candidate check before starting the installer', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('started');
    expect(result.stdout + result.stderr).not.toContain('secret_never_log');
  });

  it('runs the candidate DingTalk credential-only check before the installer without copying secrets', () => {
    const selfTestMarker = join(root, 'dingtalk-self-test.txt');
    writeFileSync(
      join(source, '.env.local'),
      'DINGTALK_ATTENDANCE_CLIENT_ID=test_client\nDINGTALK_ATTENDANCE_CLIENT_SECRET=dingtalk_secret_never_log\n',
    );
    writeFileSync(
      join(candidate, 'release-root', 'scripts', 'dingtalk-attendance-cli.mjs'),
      `import { writeFileSync } from 'node:fs';
if (process.env.DINGTALK_ATTENDANCE_CLIENT_ID !== 'test_client' || process.env.DINGTALK_ATTENDANCE_CLIENT_SECRET !== 'dingtalk_secret_never_log' || !process.argv.includes('--self-test')) process.exit(17);
writeFileSync(${JSON.stringify(selfTestMarker)}, 'checked');
console.log(JSON.stringify({ authenticated: true, attendanceApiCalls: 0, mode: 'credential-only' }));
`,
    );
    writeFileSync(
      join(root, 'fake-installer.mjs'),
      `import { existsSync, writeFileSync } from 'node:fs'; if (!existsSync(${JSON.stringify(selfTestMarker)})) process.exit(19); writeFileSync(process.argv[2], 'started');\n`,
    );

    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(selfTestMarker, 'utf8')).toBe('checked');
    expect(readFileSync(marker, 'utf8')).toBe('started');
    expect(result.stdout).toContain('DingTalk credential-only preflight passed');
    expect(result.stdout + result.stderr).not.toContain('dingtalk_secret_never_log');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('KEEP=1\n');
  });

  it('rejects a conflicting fixture credential before starting the installer', () => {
    writeFileSync(join(app, '.env.local'), 'FEISHU_APP_ID=cli_wrong_test\n');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(result.stdout + result.stderr).not.toContain('secret_never_log');
  });

  it('rejects missing DingTalk credentials before starting the installer', () => {
    writeFileSync(join(source, '.env.local'), 'DINGTALK_ATTENDANCE_CLIENT_ID=test_client\n');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(result.stdout + result.stderr).not.toContain('dingtalk_secret_never_log');
  });

  it('rejects a conflicting DingTalk fixture credential before starting the installer', () => {
    writeFileSync(join(app, '.env.local'), 'DINGTALK_ATTENDANCE_CLIENT_SECRET=wrong_secret\n');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(result.stdout + result.stderr).not.toContain('dingtalk_secret_never_log');
  });

  it('rejects an identical or alias DingTalk credential stored in the fixture', () => {
    writeFileSync(
      join(app, '.env.local'),
      'DINGTALK_ATTENDANCE_CLIENT_ID=test_client\nDINGTALK_ATTENDANCE_APP_SECRET=alias_secret\n',
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(result.stdout + result.stderr).not.toContain('alias_secret');
  });

  it('rejects a DingTalk result that used an attendance API before starting the installer', () => {
    writeFileSync(
      join(candidate, 'release-root', 'scripts', 'dingtalk-attendance-cli.mjs'),
      'console.log(JSON.stringify({ authenticated: true, attendanceApiCalls: 1, mode: "credential-only" }));\n',
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(result.stdout + result.stderr).toContain('DingTalk credential-only preflight failed');
    expect(result.stdout + result.stderr).not.toContain('dingtalk_secret_never_log');
  });

  it('rejects a candidate preflight failure before starting the installer', () => {
    writeFileSync(
      join(candidate, 'release-root', 'scripts', 'ensure-purchase-inventory-config.mjs'),
      'process.exit(9);\n',
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  });

  it('rejects DingTalk credentials before copying a standby fixture', () => {
    const pool = join(root, 'pool');
    mkdirSync(pool);
    mkdirSync(join(source, 'node_modules'));
    writeFileSync(join(source, '.env'), 'export DINGTALK_ATTENDANCE_APP_SECRET=alias_secret\n');
    writeFileSync(join(source, '.env.local'), 'KEEP=1\n');
    const lock = '{}\n';
    writeFileSync(join(source, 'package-lock.json'), lock);
    const nodeSha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
    const lockSha256 = createHash('sha256').update(lock).digest('hex');
    writeFileSync(
      join(candidate, 'hotfix-manifest.json'),
      JSON.stringify({
        packageId: 'test-deployment',
        dependencyTreeMode: 'verified-existing-production-tree',
        buildNodeVersion: process.version.slice(1),
        buildNodeSha256: nodeSha256,
        candidatePackageLockSha256: lockSha256,
      }),
    );
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', prepareStandby,
        '-SourceAppRoot', source,
        '-BaselinePackageRoot', candidate,
        '-PoolParent', pool,
        '-SlotName', 'hotfix-smoke-test',
        '-ExpectedDeploymentId', 'test-deployment',
        '-NodePath', process.execPath,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('DingTalk credentials');
    expect(existsSync(join(pool, 'hotfix-smoke-test'))).toBe(false);
  });
});
