import { resolve } from 'node:path';

await import('../dist/server/runtime-env.js');

process.env.NODE_ENV = 'production';
process.env.SERVER_HOST = '127.0.0.1';
process.env.SERVER_PORT = process.env.INVENTORY_E2E_PORT || '3101';
process.env.PUBLIC_BASE_URL = `https://127.0.0.1:${process.env.SERVER_PORT}`;
process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'false';
process.env.PURCHASE_WORKFLOW_LEDGER_PATH = resolve(
  process.cwd(),
  'output/playwright/purchase-workflow-ledger-3101.json',
);
process.env.COS_CONTRACT_INDEX_PATH = resolve(
  process.cwd(),
  'output/playwright/contract-attachment-index-3101.json',
);
process.env.COS_SECRET_ID = '';
process.env.COS_SECRET_KEY = '';
process.env.COS_SESSION_TOKEN = '';
process.env.TENCENTCLOUD_SECRET_ID = '';
process.env.TENCENTCLOUD_SECRET_KEY = '';
process.env.TENCENTCLOUD_SESSION_TOKEN = '';

const { bootstrap } = await import('../dist/server/main.js');
await bootstrap();
