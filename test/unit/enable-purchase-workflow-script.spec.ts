import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(
  __dirname,
  '../../deploy/enable-purchase-workflow.ps1',
);
const CMD = resolve(
  __dirname,
  '../../deploy/enable-purchase-workflow.cmd',
);
describe('deploy/enable-purchase-workflow.ps1', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('requires explicit confirmation that the legacy automation is disabled', () => {
    const root = createDeploymentRoot(roots);
    const original = validEnvironment();
    writeFileSync(join(root, '.env'), original, 'utf8');

    const result = runScript(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('OldAutomationDisabled');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('.env.purchase-workflow-backup-'),
      ),
    ).toBe(false);
  });

  it('updates known values idempotently, validates configuration, and restarts', () => {
    const root = createDeploymentRoot(roots);
    const secret = 'verification_token_must_never_be_printed';
    writeFileSync(
      join(root, '.env'),
      [
        validEnvironment(secret).trimEnd(),
        'PURCHASE_WORKFLOW_PROGRAM_ENABLED=false',
        'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS=ou_stale_one,ou_stale_two',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(root, '.env.local'),
      [
        'LOCAL_ONLY_VALUE=keep-local',
        'PURCHASE_WORKFLOW_PROGRAM_ENABLED=false',
        'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS=ou_local_stale_one,ou_local_stale_two',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const result = runScript(root, '-OldAutomationDisabled');

    expect(result.status).toBe(0);
    expect(result.output).not.toContain(secret);
    expect(existsSync(join(root, 'stop.marker'))).toBe(true);
    expect(existsSync(join(root, 'start.marker'))).toBe(true);

    const updated = readFileSync(join(root, '.env'), 'utf8');
    expect(readValues(updated)).toMatchObject({
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_manager_primary',
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS:
        'ou_a6644e62a43b916c6bc26148cf74f208,ou_6e607320c167d816366acba893b339b1',
      PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID:
        'ou_86e0b9a248f9d7e7bada9ecbd1ea62a9',
      FEISHU_PURCHASE_ORGANIZATION_TABLE_ID: 'tblRtv0XGQVTihw7',
      PUBLIC_BASE_URL: 'https://www.sm.sjhl.online:3001',
      PURCHASE_WORKFLOW_LEDGER_PATH:
        '.runtime/purchase-workflow-ledger.json',
      FEISHU_WAREHOUSE_MANAGER_SOURCE_URL:
        'https://tenant.example/base/app_valid_manager?table=tbl_valid_manager',
      FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl_valid_manager',
    });
    for (const key of [
      'PURCHASE_WORKFLOW_PROGRAM_ENABLED',
      'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED',
      'PURCHASE_MANAGER_APPROVER_OPEN_ID',
      'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS',
      'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
      'FEISHU_PURCHASE_ORGANIZATION_TABLE_ID',
    ]) {
      expect(
        updated
          .split(/\r?\n/)
          .filter((line) => line.startsWith(`${key}=`)),
      ).toHaveLength(1);
    }
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('.env.purchase-workflow-backup-'),
      ),
    ).toBe(true);
    const updatedLocal = readFileSync(join(root, '.env.local'), 'utf8');
    expect(updatedLocal).toContain('LOCAL_ONLY_VALUE=keep-local');
    expect(readValues(updatedLocal)).toMatchObject({
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_manager_primary',
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS:
        'ou_a6644e62a43b916c6bc26148cf74f208,ou_6e607320c167d816366acba893b339b1',
    });
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('.env.local.purchase-workflow-backup-'),
      ),
    ).toBe(true);
  });

  it('restores the original environment when configuration validation fails', () => {
    const root = createDeploymentRoot(roots);
    const original = validEnvironment();
    writeFileSync(join(root, '.env'), original, 'utf8');
    writeFileSync(
      join(root, 'scripts/ensure-purchase-inventory-config.mjs'),
      "process.stderr.write('controlled validation failure\\n'); process.exit(1);\n",
      'utf8',
    );

    const result = runScript(root, '-OldAutomationDisabled');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('controlled validation failure');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
    expect(existsSync(join(root, 'stop.marker'))).toBe(false);
    expect(existsSync(join(root, 'start.marker'))).toBe(false);
  });

  it('restores the original environment and starts the old configuration when the new start fails', () => {
    const root = createDeploymentRoot(roots);
    const original = validEnvironment();
    writeFileSync(join(root, '.env'), original, 'utf8');
    writeFileSync(
      join(root, 'start.ps1'),
      [
        'param([switch]$NoBrowser)',
        "$attemptPath = Join-Path $PSScriptRoot 'start-attempt.txt'",
        '$attempt = if (Test-Path -LiteralPath $attemptPath) { [int](Get-Content -LiteralPath $attemptPath -Raw) + 1 } else { 1 }',
        'Set-Content -LiteralPath $attemptPath -Value $attempt',
        'if ($attempt -eq 1) { exit 9 }',
        "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'rollback-start.marker') -Value 'ok'",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runScript(root, '-OldAutomationDisabled');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /original environment(?: configuration)? was restored/i,
    );
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
    expect(
      readFileSync(join(root, 'start-attempt.txt'), 'utf8').trim(),
    ).toBe('2');
    expect(existsSync(join(root, 'rollback-start.marker'))).toBe(true);
  });

  it('never embeds a callback verification token and prompts securely if absent', () => {
    const script = readFileSync(SCRIPT, 'utf8');

    expect(script).toContain('Read-Host');
    expect(script).toContain('-AsSecureString');
    expect(script).not.toMatch(
      /FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN\s*=\s*['"][^'"]+['"]/,
    );
  });

  it('does not embed the obsolete manager Base and requires semantic activation validation', () => {
    const script = readFileSync(SCRIPT, 'utf8');

    expect(script).not.toContain('SiW9wuy9DiIsykkTkNUcM0HfnSb');
    expect(script).not.toContain('tblA67nLWVPQ5DQL');
    expect(script).toMatch(
      /\$configCheckPath\s+'--root'\s+\$appRoot\s+'--activate-workflow'/u,
    );
  });

  it('keeps a double-clicked command window open and requires safety confirmation', () => {
    const command = readFileSync(CMD, 'utf8');

    expect(command).toContain('choice /C YN');
    expect(command).toContain('enable-purchase-workflow*.ps1');
    expect(command).toContain('-OldAutomationDisabled');
    expect(command).toContain('pause');
  });

  it('finds the copied PowerShell script and forwards the safety switch', () => {
    const root = mkdtempSync(join(tmpdir(), 'purchase-workflow-cmd-'));
    roots.push(root);
    copyFileSync(CMD, join(root, 'enable-purchase-workflow.cmd'));
    writeFileSync(
      join(root, 'enable-purchase-workflow-20990101.ps1'),
      [
        'param([switch]$OldAutomationDisabled)',
        'if (!$OldAutomationDisabled) { exit 8 }',
        "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'cmd.marker') -Value 'ok'",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = spawnSync(
      'cmd.exe',
      ['/d', '/c', join(root, 'enable-purchase-workflow.cmd')],
      {
        input: 'Y\r\n\r\n',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'cmd.marker'))).toBe(true);
  });
});

function createDeploymentRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'purchase-workflow-activation-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts/ensure-purchase-inventory-config.mjs'),
    [
      "if (!process.argv.includes('--activate-workflow')) {",
      "  process.stderr.write('missing --activate-workflow\\n');",
      '  process.exit(7);',
      '}',
      "process.stdout.write('[OK] semantic activation validated\\n');",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'stop.ps1'),
    "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'stop.marker') -Value 'ok'\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'start.ps1'),
    "param([switch]$NoBrowser)\nSet-Content -LiteralPath (Join-Path $PSScriptRoot 'start.marker') -Value 'ok'\n",
    'utf8',
  );
  return root;
}

function runScript(root: string, ...extra: string[]) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Root',
      root,
      '-NodePath',
      process.execPath,
      ...extra,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function validEnvironment(
  verificationToken = 'verification-placeholder',
): string {
  return [
    'FEISHU_APP_ID=cli_test_app_id',
    'FEISHU_APP_SECRET=cli_test_app_secret',
    'FEISHU_PURCHASE_INVENTORY_APP_TOKEN=configured_app_token',
    'FEISHU_PURCHASE_SUBMISSION_TABLE_ID=configured_submission',
    'FEISHU_PURCHASE_EXECUTION_TABLE_ID=configured_execution',
    'FEISHU_ITEM_CATEGORY_TABLE_ID=configured_category',
    'FEISHU_INVENTORY_LEDGER_TABLE_ID=configured_inventory',
    'FEISHU_INBOUND_TABLE_ID=configured_inbound',
    'FEISHU_OUTBOUND_TABLE_ID=configured_outbound',
    'PURCHASE_WORKFLOW_PROGRAM_ENABLED=false',
    'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=false',
    'PURCHASE_MANAGER_APPROVER_OPEN_ID=ou_manager_primary',
    'FEISHU_WAREHOUSE_MANAGER_SOURCE_URL=https://tenant.example/base/app_valid_manager?table=tbl_valid_manager',
    'FEISHU_WAREHOUSE_MANAGER_TABLE_ID=tbl_valid_manager',
    `FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN=${verificationToken}`,
    'PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS=5000',
    '',
  ].join('\n');
}

function readValues(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
}
