require('reflect-metadata');
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { NestFactory } = require('@nestjs/core');
const { RiskInspectionModule } = require('../../server/modules/risk-inspection/risk-inspection.module');
const { RiskInspectionService } = require('../../server/modules/risk-inspection/risk-inspection.service');
const { QualityFollowUpTaskStore } = require('../../server/modules/risk-inspection/quality-follow-up-task.store');

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'risk-module-di-'));
  const previousPath = process.env.RISK_QUALITY_FOLLOW_UP_LEDGER_PATH;
  process.env.RISK_QUALITY_FOLLOW_UP_LEDGER_PATH = join(directory, 'tasks.json');
  let application;
  try {
    application = await NestFactory.createApplicationContext(RiskInspectionModule, {
      logger: false,
      abortOnError: false,
    });
    assert.ok(application.get(QualityFollowUpTaskStore) instanceof QualityFollowUpTaskStore);
    assert.ok(application.get(RiskInspectionService) instanceof RiskInspectionService);
    process.stdout.write('RiskInspectionModule DI ready\n');
  } finally {
    if (application) await application.close();
    if (previousPath === undefined) delete process.env.RISK_QUALITY_FOLLOW_UP_LEDGER_PATH;
    else process.env.RISK_QUALITY_FOLLOW_UP_LEDGER_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
