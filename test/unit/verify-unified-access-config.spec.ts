import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const verifier = resolve('scripts/verify-unified-access-config.mjs');
const HASH_NAMES = [
  'LOCAL_ADMIN_PASSWORD_HASH',
  'LOCAL_EDITOR_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_A_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_B_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_C_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_D_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_E_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_H_PASSWORD_HASH',
  'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_A_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_B_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_C_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_D_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_E_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_H_PASSWORD_HASH',
  'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH',
] as const;

describe('unified access configuration verifier', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'unified-access-verify-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads .env.local after .env and reports only aggregate readiness', () => {
    const baseHash = makeHash(1, 2);
    const overrideHash = makeHash(3, 4);
    writeFileSync(
      join(root, '.env'),
      [
        ...HASH_NAMES.map((name) => `${name}=${baseHash}`),
        `LOCAL_ACCESS_SESSION_SECRET=${Buffer.alloc(32, 5).toString('base64')}`,
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(root, '.env.local'),
      `LOCAL_EDITOR_PASSWORD_HASH=${overrideHash}\n`,
      'utf8',
    );

    const result = runVerifier(root);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      coreConfigured: true,
      inventoryConfigured: true,
      purchaseConfigured: true,
      constructionConfigured: true,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(baseHash);
    expect(`${result.stdout}${result.stderr}`).not.toContain(overrideHash);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/PASSWORD|SECRET/);
  });

  it('fails closed when .env.local overrides a valid value with malformed data', () => {
    const hash = makeHash(6, 7);
    writeFileSync(
      join(root, '.env'),
      [
        ...HASH_NAMES.map((name) => `${name}=${hash}`),
        `LOCAL_ACCESS_SESSION_SECRET=${Buffer.alloc(32, 8).toString('base64')}`,
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(root, '.env.local'),
      'LOCAL_ADMIN_PASSWORD_HASH=malformed-test-value\n',
      'utf8',
    );

    const result = runVerifier(root);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      coreConfigured: false,
      inventoryConfigured: true,
      purchaseConfigured: true,
      constructionConfigured: true,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'malformed-test-value',
    );
  });

  it('reports incomplete domains without failing in report-only mode', () => {
    const hash = makeHash(9, 10);
    const configuredNames = HASH_NAMES.filter(
      (name) =>
        name.startsWith('LOCAL_ADMIN_') ||
        name.startsWith('LOCAL_EDITOR_') ||
        name.startsWith('LOCAL_INVENTORY_ADMIN_'),
    );
    writeFileSync(
      join(root, '.env'),
      [
        ...configuredNames.map((name) => `${name}=${hash}`),
        `LOCAL_ACCESS_SESSION_SECRET=${Buffer.alloc(32, 11).toString('base64')}`,
      ].join('\n'),
      'utf8',
    );

    const strictResult = runVerifier(root);
    const reportResult = runVerifier(root, ['--report-only']);

    expect(strictResult.status).not.toBe(0);
    expect(reportResult.status).toBe(0);
    expect(JSON.parse(reportResult.stdout)).toEqual({
      coreConfigured: true,
      inventoryConfigured: true,
      purchaseConfigured: false,
      constructionConfigured: false,
    });
    expect(reportResult.stderr).toBe('');
  });
});

function makeHash(saltByte: number, derivedByte: number): string {
  return `scrypt$${Buffer.alloc(16, saltByte).toString('base64')}$${Buffer.alloc(32, derivedByte).toString('base64')}`;
}

function runVerifier(appRoot: string, extraArguments: string[] = []) {
  return spawnSync(
    process.execPath,
    [verifier, `--root=${appRoot}`, ...extraArguments],
    {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    },
  );
}
