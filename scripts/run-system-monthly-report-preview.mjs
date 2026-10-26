import { config } from 'dotenv';

config({ path: '.env', override: true, quiet: true });
config({ path: '.env.local', override: true, quiet: true });

const main = await import('../dist/server/main.js');

process.env.SERVER_PORT = process.env.SYSTEM_MONTHLY_REPORT_PREVIEW_PORT || '3010';
process.env.PURCHASE_WORKFLOW_LEDGER_PATH =
  '.runtime/purchase-workflow-ledger-monthly-preview.json';
process.env.SYSTEM_MONTHLY_REPORT_RUNTIME_DIR =
  '.runtime/system-monthly-report-preview';
process.env.COS_CONTRACT_INDEX_PATH =
  '.runtime/contract-storage-index-monthly-preview.json';
process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'false';
delete process.env.HTTPS_KEY_PATH;
delete process.env.HTTPS_CERT_PATH;
delete process.env.HTTPS_CA_PATH;

await main.bootstrap();
