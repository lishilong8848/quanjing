import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { InventoryInboundTaskService } from '../../server/modules/inventory-management/inventory-inbound-task.service';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { DutyScheduleAutomationService } from '../../server/modules/duty-schedule/duty-schedule.automation';
import { closeHotfixActivation, currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { inspectHotfixReleaseProof } from '../../server/common/hotfix-release-proof';

const { journalChecksum } = require('../../scripts/hotfix-receipt-relay.cjs') as { journalChecksum(value: Record<string, unknown>): string };
describe('actual business activation wiring', () => {
  let root: string, parent: string, owner: string, cwd: string;
  const candidate = 'nantong-safe-full-runtime-hotfix-20261016-000004';
  let transactionId: string, configPath: string;
  let previous: Record<string, string | undefined>;
  const services: Array<{ onModuleDestroy(): Promise<void> }> = [];
  function phase(value: string) {
    const journal = { schemaVersion: 1, transactionId, deploymentId: candidate, appRoot: root, intent: 'deploy', phase: value,
      releaseFiles: [{ targetPath: 'package.json', baselineExisted: true, baselineSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64) }] };
    writeFileSync(join(root, '.hotfix-transaction.json'), JSON.stringify({ ...journal, transactionChecksum: journalChecksum(journal) }));
  }
  beforeEach(() => {
    cwd = process.cwd(); parent = realpathSync(tmpdir()); root = mkdtempSync(join(parent, 'nt-business-activation-')); owner = randomUUID(); transactionId = randomUUID();
    writeFileSync(join(root, '.test-owner'), owner, { flag: 'wx' }); mkdirSync(join(root, 'dist/server'), { recursive: true });
    writeFileSync(join(root, 'dist/server/hotfix-runtime-identity.json'), JSON.stringify({ schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId: candidate }));
    phase('candidate-started'); writeFileSync(join(root, '.maintenance.lock'), JSON.stringify({ schemaVersion: 1, pid: process.pid, processStartTime: new Date().toISOString(), transactionId, deploymentId: candidate, appRoot: root }));
    configPath = join(root, 'configuration.json'); writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, revision: 9, legacySessionsRevoked: false, accounts: {}, cardRules: {}, audit: [], mutations: {} }));
    previous = { ACCESS_CONFIGURATION_FILE: process.env.ACCESS_CONFIGURATION_FILE, FEISHU_APP_ID: process.env.FEISHU_APP_ID, NANTONG_HOTFIX_SMOKE_MODE: process.env.NANTONG_HOTFIX_SMOKE_MODE };
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    process.env.ACCESS_CONFIGURATION_FILE = configPath; process.env.FEISHU_APP_ID = 'cli_synthetic_activation'; process.chdir(root);
  });
  afterEach(async () => {
    try { for (const service of services.splice(0)) await service.onModuleDestroy(); await closeHotfixActivation(); }
    finally {
      process.chdir(cwd); for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
      const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
      if (!same(dirname(root), parent) || !/^nt-business-activation-[A-Za-z0-9]+$/.test(basename(root)) || !same(realpathSync(root), root) || lstatSync(root).isSymbolicLink() || readFileSync(join(root, '.test-owner'), 'utf8') !== owner) throw Error('Unowned fixture');
      const check = (directory: string) => { for (const name of readdirSync(directory)) { const file = join(directory, name), stats = lstatSync(file); if (stats.isSymbolicLink() || !same(realpathSync(file), file)) throw Error('Unsafe fixture'); if (stats.isDirectory()) check(file); else if (!stats.isFile() || stats.nlink !== 1) throw Error('Unsafe fixture file'); } }; check(root); rmSync(root, { recursive: true });
    }
  });
  it('reads original access configuration before commit without running write initialization', async () => {
    const service = new AccessConfigurationService(); services.push(service);
    const initialize = jest.spyOn(service as unknown as { initializeProfessionalDefaults(): Promise<void> }, 'initializeProfessionalDefaults');
    const original = readFileSync(configPath); await service.onModuleInit();
    expect(inspectHotfixReleaseProof(root).mode).toBe('candidate-held'); expect(service.snapshot().revision).toBe(9); expect(readFileSync(configPath)).toEqual(original); expect(initialize).not.toHaveBeenCalled();
    phase('committed'); const gate = currentHotfixActivation(); gate.completeBootstrap(); await gate.refresh();
    expect(initialize).toHaveBeenCalledTimes(1); await service.onModuleInit(); await gate.refresh(); expect(initialize).toHaveBeenCalledTimes(1);
  });
  it('still rejects corrupt read-only access configuration before commit', async () => {
    const service = new AccessConfigurationService(); services.push(service); writeFileSync(configPath, '{');
    await expect(Promise.resolve().then(() => service.onModuleInit())).rejects.toThrow('权限配置文件无效');
  });
  it('does not start the native inbound recovery after destruction while held', async () => {
    const dependency = new Proxy({}, { get: (_value, name) => { throw Error(`Unexpected business access ${String(name)}`); } });
    const service = new InventoryInboundTaskService(dependency as never, dependency as never, dependency as never, dependency as never, dependency as never);
    await service.onModuleInit(); await service.onModuleDestroy(); phase('committed');
    const gate = currentHotfixActivation(); gate.completeBootstrap(); await expect(gate.refresh()).resolves.toBeUndefined();
  });
  it('rejects new card actions without a card update and rejects IM messages without successful handling', async () => {
    const dependency = new Proxy({}, { get: (_value, name) => { throw Error(`Unexpected business access ${String(name)}`); } });
    const router = new FeishuCardActionRouter(dependency as never, dependency as never, dependency as never, dependency as never, dependency as never, dependency as never, dependency as never, dependency as never, dependency as never);
    const result = await router.handle({ event: 'synthetic' });
    expect(result.toast).toMatchObject({ type: 'error', content: expect.stringContaining('未受理') }); expect(result).not.toHaveProperty('card');
    await expect(router.handleMessage({ event: 'synthetic' })).rejects.toThrow('未受理');
  });
  it('keeps non-smoke duty startup asynchronous and starts it only once after commit', async () => {
    const refresh = jest.fn().mockResolvedValue({ message: 'Synthetic refresh' });
    const service = new DutyScheduleAutomationService({ refreshProgramModifiedDutyStaffFromRules: refresh } as never, {} as never, {} as never, {} as never); services.push(service);
    await service.onApplicationBootstrap(); expect(refresh).not.toHaveBeenCalled();
    expect((service as unknown as { startupProgramModifiedRefreshTimer?: unknown }).startupProgramModifiedRefreshTimer).toBeUndefined();
    phase('committed'); const gate = currentHotfixActivation(); gate.completeBootstrap(); await gate.refresh();
    expect(refresh).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 15)); expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({ source: 'startup' });
    await service.onApplicationBootstrap(); await gate.refresh(); await new Promise(resolve => setTimeout(resolve, 5)); expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('cancels held duty startup and waits for an already running native refresh', async () => {
    const cancelledRefresh = jest.fn();
    const cancelled = new DutyScheduleAutomationService({ refreshProgramModifiedDutyStaffFromRules: cancelledRefresh } as never, {} as never, {} as never, {} as never);
    await cancelled.onApplicationBootstrap(); await cancelled.onModuleDestroy();
    let finish!: (value: { message: string }) => void;
    const refresh = jest.fn(() => new Promise<{ message: string }>(resolve => { finish = resolve; }));
    const service = new DutyScheduleAutomationService({ refreshProgramModifiedDutyStaffFromRules: refresh } as never, {} as never, {} as never, {} as never); services.push(service);
    await service.onApplicationBootstrap(); phase('committed'); const gate = currentHotfixActivation(); gate.completeBootstrap(); await gate.refresh();
    await new Promise(resolve => setTimeout(resolve, 15)); expect(cancelledRefresh).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
    let closed = false; const closing = service.onModuleDestroy().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    finish({ message: 'Synthetic refresh finished' }); await closing; expect(closed).toBe(true);
  });
});
