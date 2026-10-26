import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const LEDGER_FILE_NAME = 'inventory-outbound-approval-ledger.json';

type LedgerPathResolver = (options?: {
  configuredPath?: string;
  cwd?: string;
  nodeEnv?: string;
}) => string;

function source(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function loadLedgerPathResolver(): LedgerPathResolver | undefined {
  try {
    const moduleExports =
      require('../../server/modules/inventory-outbound-approval/inventory-outbound-approval.module') as Record<
        string,
        unknown
      >;
    return moduleExports.resolveInventoryOutboundApprovalLedgerPath as
      | LedgerPathResolver
      | undefined;
  } catch {
    return undefined;
  }
}

describe('inventory outbound approval ledger path safety', () => {
  it('uses one shared production ledger across timestamped release directories', () => {
    const resolver = loadLedgerPathResolver();
    expect(typeof resolver).toBe('function');

    const releasesRoot = resolve(ROOT, '.tmp', 'approval-ledger-releases');
    const firstRelease = join(releasesRoot, 'release-20260826-101500');
    const secondRelease = join(releasesRoot, 'release-20260826-113000');
    const expected = join(
      releasesRoot,
      'nantong-schedule-state',
      LEDGER_FILE_NAME,
    );

    expect(resolver!({ cwd: firstRelease, nodeEnv: 'production' })).toBe(
      expected,
    );
    expect(resolver!({ cwd: secondRelease, nodeEnv: 'production' })).toBe(
      expected,
    );
  });

  it('honors an explicit ledger path and keeps development state local', () => {
    const resolver = loadLedgerPathResolver();
    expect(typeof resolver).toBe('function');

    const cwd = resolve(ROOT, '.tmp', 'approval-ledger-development');
    expect(
      resolver!({
        configuredPath: 'state/custom-outbound-approval.json',
        cwd,
        nodeEnv: 'production',
      }),
    ).toBe(join(cwd, 'state', 'custom-outbound-approval.json'));
    expect(resolver!({ cwd, nodeEnv: 'development' })).toBe(
      join(cwd, '.runtime', LEDGER_FILE_NAME),
    );
  });

  it('registers the path provider in the Nest module', () => {
    const moduleSource = source(
      'server/modules/inventory-outbound-approval/inventory-outbound-approval.module.ts',
    );

    expect(moduleSource).toContain('INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH');
    expect(moduleSource).toContain(
      'resolveInventoryOutboundApprovalLedgerPath',
    );
    expect(moduleSource).toMatch(
      /provide:\s*INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH[\s\S]*useFactory:/u,
    );
  });

  it.each(['start.ps1', 'deploy/start.ps1'])(
    '%s exports an absolute shared outbound approval ledger path',
    (launcher) => {
      const script = source(launcher);
      const expectedDefault =
        "$defaultInventoryOutboundApprovalLedgerPath = Join-Path (Join-Path (Split-Path -Parent $appRoot) 'nantong-schedule-state') 'inventory-outbound-approval-ledger.json'";

      expect(script).toContain(expectedDefault);
      expect(script).toContain(
        "Get-DotEnvValue -FilePath $envFile -Name 'INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH'",
      );
      expect(script).toContain(
        "Get-DotEnvValue -FilePath $envLocalFile -Name 'INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH'",
      );
      expect(script).toContain(
        '$env:INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH = [System.IO.Path]::GetFullPath($inventoryOutboundApprovalLedgerPath)',
      );
    },
  );

  it('documents the configurable persistent ledger path', () => {
    const envExample = source('.env.example');
    expect(envExample).toContain('INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH=');
  });

  it('forbids shared runtime state from the safe hotfix payload and manifest', () => {
    const packager = source(
      'scripts/create-safe-full-runtime-hotfix-package.ps1',
    );
    const forbiddenSegmentMatches = packager.match(
      /\/nantong-schedule-state\//gu,
    );

    expect(forbiddenSegmentMatches?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(packager).toContain(
      "forbiddenPaths = @('.env', '.runtime', 'nantong-schedule-state', 'logs', 'node_modules', 'certs')",
    );
  });

  it('keeps the production default outside either release directory', () => {
    const resolver = loadLedgerPathResolver();
    expect(typeof resolver).toBe('function');

    const release = resolve(ROOT, '.tmp', 'releases', 'release-1');
    const ledger = resolver!({ cwd: release, nodeEnv: 'production' });
    expect(dirname(dirname(ledger))).toBe(dirname(release));
    expect(ledger.startsWith(`${release}\\`)).toBe(false);
  });
});
