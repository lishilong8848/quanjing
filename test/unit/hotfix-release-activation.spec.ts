import { mkdir, mkdtemp, readFile, realpath, writeFile, lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';
import { ContractWorkflowService } from '../../server/modules/contract-management/contract-workflow.service';
import type { ContractWorkflowGateway } from '../../server/modules/contract-management/contract-workflow.gateway';
import { closeHotfixActivation, currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { inspectHotfixReleaseProof } from '../../server/common/hotfix-release-proof';
const { journalChecksum } = require('../../scripts/hotfix-receipt-relay.cjs') as { journalChecksum(value: Record<string, unknown>): string };

describe('hotfix pre-commit activation boundary', () => {
  it('does not recover an interrupted contract delivery while maintenance is held', async () => {
    const priorCwd = process.cwd();
    const parent = await realpath(tmpdir());
    const folder = await mkdtemp(join(parent, 'nt-release-activation-'));
    const owner = randomUUID();
    await writeFile(join(folder, '.test-owner'), owner, { flag: 'wx' });
    const ledgerPath = join(folder, 'contract-workflow-ledger.json');
    const previousAppId = process.env.FEISHU_APP_ID;
    let service: ContractWorkflowService | undefined;
    try {
      process.env.FEISHU_APP_ID = 'cli_synthetic_release_activation';
      const store = new ContractWorkflowStore(ledgerPath);
      await store.enqueueRoleNotification({
        key: 'synthetic-interrupted-delivery', kind: 'text',
        content: 'Synthetic release test; never send', fallbackRecipients: ['ou_syntheticreceiver'],
      });
      expect(await store.claimRoleNotification(() => ['ou_syntheticreceiver'])).toBeDefined();
      const original = await readFile(ledgerPath);
      const transactionId = randomUUID(), deploymentId = 'nantong-safe-full-runtime-hotfix-20261016-000003';
      await mkdir(join(folder, 'dist/server'), { recursive: true });
      await writeFile(join(folder, 'dist/server/hotfix-runtime-identity.json'), JSON.stringify({ schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId }));
      const transaction = async (phase: string) => {
        const journal = { schemaVersion: 1, transactionId, deploymentId, appRoot: folder, intent: 'deploy', phase,
          releaseFiles: [{ targetPath: 'package.json', baselineExisted: true, baselineSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64) }] };
        await writeFile(join(folder, '.hotfix-transaction.json'), JSON.stringify({ ...journal, transactionChecksum: journalChecksum(journal) }));
      };
      await transaction('candidate-started');
      await writeFile(join(folder, '.maintenance.lock'), JSON.stringify({
        schemaVersion: 1, pid: process.pid,
        processStartTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        transactionId, deploymentId, appRoot: folder,
      }), { flag: 'wx' });
      process.chdir(folder);
      const gateway = new Proxy({}, { get: (_target, method) => {
        throw new Error(`Unexpected external gateway access: ${String(method)}`);
      } }) as ContractWorkflowGateway;
      service = new ContractWorkflowService(gateway, store);
      jest.spyOn(service as unknown as { scheduleNotificationFlush(): void }, 'scheduleNotificationFlush').mockImplementation(() => undefined);
      const recover = jest.spyOn(store, 'recoverRoleNotifications');
      expect(inspectHotfixReleaseProof(folder)).toMatchObject({ mode: 'candidate-held', canInitialize: false });
      await service.onModuleInit();
      expect(await readFile(ledgerPath)).toEqual(original);
      expect(recover).not.toHaveBeenCalled();
      const gate = currentHotfixActivation(); gate.completeBootstrap(); await gate.refresh();
      expect(await readFile(ledgerPath)).toEqual(original);
      await transaction('committed');
      expect(inspectHotfixReleaseProof(folder)).toMatchObject({ mode: 'candidate-committed', canInitialize: true, canAcceptNewWork: false });
      await gate.refresh();
      expect(recover).toHaveBeenCalledTimes(1);
      expect(await readFile(ledgerPath)).not.toEqual(original);
      await service.onModuleInit(); await gate.refresh();
      expect(recover).toHaveBeenCalledTimes(1);
    } finally {
      await service?.onModuleDestroy();
      await closeHotfixActivation();
      process.chdir(priorCwd);
      if (previousAppId === undefined) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = previousAppId;
      const canonical = (value: string) => resolve(value).toLowerCase();
      if (canonical(dirname(folder)) !== canonical(parent) ||
          !/^nt-release-activation-[A-Za-z0-9]+$/.test(basename(folder)) ||
          (await lstat(folder)).isSymbolicLink() ||
          canonical(await realpath(folder)) !== canonical(folder) ||
          await readFile(join(folder, '.test-owner'), 'utf8') !== owner) {
        throw new Error('Refusing cleanup of an unowned release fixture');
      }
      const check = async (directory: string) => { for (const name of await readdir(directory)) {
        const path = join(directory, name), file = await lstat(path);
        if (file.isSymbolicLink() || canonical(await realpath(path)) !== canonical(path)) throw new Error('Refusing unsafe fixture contents');
        if (file.isDirectory()) await check(path);
        else if (!file.isFile() || file.nlink !== 1) throw new Error('Refusing cleanup of unexpected fixture contents');
      } }; await check(folder);
      await rm(folder, { recursive: true });
    }
  });
});
