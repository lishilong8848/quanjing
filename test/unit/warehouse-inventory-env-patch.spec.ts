import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const WAREHOUSE_KEYS = [
  'FEISHU_WAREHOUSE_SOURCE_URL',
  'FEISHU_WAREHOUSE_APP_TOKEN',
  'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  'FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_BORROW_TABLE_ID',
  'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
  'FEISHU_WAREHOUSE_PRICE_TABLE_ID',
  'FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID',
  'FEISHU_WAREHOUSE_MANAGER_TABLE_ID',
] as const;

function parseEnv(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('warehouse inventory deployment env patch', () => {
  const applyScript = resolve(
    __dirname,
    '../../deploy/apply-warehouse-inventory-env.ps1',
  );
  const examplePatch = resolve(
    __dirname,
    '../../deploy/warehouse-inventory-env.patch.example',
  );
  const deployStart = readFileSync(
    resolve(__dirname, '../../deploy/start.ps1'),
    'utf8',
  );
  const packager = readFileSync(
    resolve(__dirname, '../../scripts/create-migration-package.ps1'),
    'utf8',
  );

  it('fills only missing warehouse values and preserves existing env settings', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'warehouse-env-patch-'));
    const envPath = join(fixtureDir, '.env');
    const patchPath = join(fixtureDir, 'warehouse-inventory-env.patch.local');

    try {
      writeFileSync(
        envPath,
        [
          'FEISHU_APP_SECRET=keep-this-secret',
          'FEISHU_WAREHOUSE_SOURCE_URL=https://existing.example/base/existing',
          'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID=',
          'FEISHU_WAREHOUSE_INBOUND_TABLE_ID=tbl787d9bb32f6f92a',
          'UNRELATED_SETTING=keep-this-value',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        patchPath,
        [
          'FEISHU_WAREHOUSE_SOURCE_URL=https://patch.example/base/patch',
          'FEISHU_WAREHOUSE_APP_TOKEN=appPatch',
          'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID=tblInventory',
          'FEISHU_WAREHOUSE_INBOUND_TABLE_ID=tbl807b6675671c',
          'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID=tblOutbound',
          'FEISHU_WAREHOUSE_BORROW_TABLE_ID=tblBorrow',
          'FEISHU_WAREHOUSE_CATALOG_TABLE_ID=tblCatalog',
          'FEISHU_WAREHOUSE_PRICE_TABLE_ID=tblPrice',
          'FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID=tblStocktake',
          'FEISHU_WAREHOUSE_MANAGER_TABLE_ID=tblManager',
        ].join('\n'),
        'utf8',
      );

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          applyScript,
          '-EnvPath',
          envPath,
          '-PatchPath',
          patchPath,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status).toBe(0);
      const environment = parseEnv(readFileSync(envPath, 'utf8'));
      expect(environment).toMatchObject({
        FEISHU_APP_SECRET: 'keep-this-secret',
        FEISHU_WAREHOUSE_SOURCE_URL:
          'https://existing.example/base/existing',
        FEISHU_WAREHOUSE_INVENTORY_TABLE_ID: 'tblInventory',
        FEISHU_WAREHOUSE_INBOUND_TABLE_ID: 'tbl787d9bb32f6f92a',
        FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: 'tblOutbound',
        FEISHU_WAREHOUSE_BORROW_TABLE_ID: 'tblBorrow',
        FEISHU_WAREHOUSE_CATALOG_TABLE_ID: 'tblCatalog',
        FEISHU_WAREHOUSE_PRICE_TABLE_ID: 'tblPrice',
        FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID: 'tblStocktake',
        FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tblManager',
        UNRELATED_SETTING: 'keep-this-value',
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('documents every dashboard source without including global credentials', () => {
    const patch = readFileSync(examplePatch, 'utf8');

    for (const key of WAREHOUSE_KEYS) {
      expect(patch).toContain(`${key}=`);
    }
    expect(patch).not.toContain('FEISHU_APP_SECRET');
  });

  it('auto-merges and packages a private warehouse patch for server upgrades', () => {
    expect(deployStart).toContain('function Ensure-WarehouseInventoryEnv');
    expect(deployStart).toContain('warehouse-inventory-env.patch.local');
    expect(deployStart).toContain(
      'Ensure-WarehouseInventoryEnv -Root $appRoot -EnvPath $envFile',
    );

    expect(packager).toContain('[switch]$IncludeWarehouseInventoryEnvPatch');
    expect(packager).toContain('function Write-WarehouseInventoryEnvPatch');
    expect(packager).toContain(
      'warehouse-inventory-env.patch.local',
    );
    expect(packager).toContain('apply-warehouse-inventory-env.ps1');
    expect(packager).toContain('README_WAREHOUSE_INVENTORY.md');
  });
});
