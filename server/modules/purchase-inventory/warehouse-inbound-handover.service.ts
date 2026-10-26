import { ConflictException, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import { buildWarehouseInboundHandoverCard } from './purchase-workflow-card';
import { resolvePurchaseStage } from './purchase-workflow.rules';

@Injectable()
export class WarehouseInboundHandoverService implements OnModuleDestroy {
  private readonly logger = new Logger(WarehouseInboundHandoverService.name);
  private running?: Promise<{ processed: number; failed: number }>;
  private stopped = false;

  constructor(
    private readonly store: PurchaseWorkflowStore,
    private readonly gateway: PurchaseWorkflowGateway,
    private readonly workflow: PurchaseWorkflowService,
    @Optional() private readonly configuration?: AccessConfigurationService,
  ) {}

  runPending(limit = 20, now = new Date()): Promise<{ processed: number; failed: number }> {
    if (this.running) return this.running;
    if (this.stopped || !this.workflow.isEnabled()) return Promise.resolve({ processed: 0, failed: 0 });
    this.running = this.process(limit, now).finally(() => { this.running = undefined; });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async process(limit: number, initialNow: Date): Promise<{ processed: number; failed: number }> {
    const started = Date.now();
    const now = () => new Date(initialNow.getTime() + Date.now() - started);
    let processed = 0, failed = 0;
    for (let index = 0; index < Math.min(20, Math.max(0, limit)) && !this.stopped; index++) {
      const job = await this.store.takeNextWarehouseInboundHandover(now());
      if (!job) break;
      let leaseError: unknown;
      let heartbeatWork: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (heartbeatWork || this.stopped) return;
        heartbeatWork = this.store.renewWarehouseInboundHandover(job.mutationId, job.claimToken, now())
          .catch(error => { leaseError = error; }).finally(() => { heartbeatWork = undefined; });
      }, 15_000);
      heartbeat.unref?.();
      const checkpoint = () => {
        if (leaseError || this.stopped) throw new ConflictException('入库提醒交接执行权已变化');
      };
      try {
        assertFeishuBusinessIdentity(this.configuration, job.target.openId);
        const record = await this.gateway.getExecutionRecordAsApp(job.recordId);
        checkpoint();
        if (record.recordId !== job.recordId || !['inbound', 'completed', 'terminated'].includes(resolvePurchaseStage(record.status))) throw new ConflictException('待入库记录阶段已变化');
        for (const messageId of job.oldMessageIds.filter(id => !job.patchedMessageIds.includes(id))) {
          checkpoint();
          assertFeishuBusinessIdentity(this.configuration, job.target.openId);
          await this.gateway.updateInteractiveCard(messageId, buildWarehouseInboundHandoverCard(record.itemName, job.target.name));
          checkpoint();
          await this.store.recordWarehouseInboundCardPatched(job.mutationId, job.claimToken, messageId, now());
        }
        checkpoint();
        await this.store.completeWarehouseInboundHandover(job.mutationId, job.claimToken, now());
        processed++;
      } catch {
        failed++;
        if (!this.stopped) {
          try { await this.store.failWarehouseInboundHandover(job.mutationId, job.claimToken, now()); }
          catch { this.logger.warn('入库提醒交接租约已变化，保留原进度'); }
        }
      } finally {
        clearInterval(heartbeat);
        await heartbeatWork;
      }
    }
    return { processed, failed };
  }
}
