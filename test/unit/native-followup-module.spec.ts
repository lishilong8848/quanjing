import 'reflect-metadata';
import { Global, Module, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { BitableSyncModule } from '../../server/modules/bitable-sync/bitable-sync.module';
import { TodayOperationsAnomalyGateway } from '../../server/modules/bitable-sync/today-operations-anomaly.gateway';
import { TodayOperationsFollowUpCardService } from '../../server/modules/bitable-sync/today-operations-follow-up-card.service';
import { FOLLOW_UP_CARD_LEDGER_PATH, TodayOperationsFollowUpCardStore } from '../../server/modules/bitable-sync/today-operations-follow-up-card.store';
import { DutyScheduleModule } from '../../server/modules/duty-schedule/duty-schedule.module';
import { DailyOperationsPatrolService } from '../../server/modules/duty-schedule/daily-operations-patrol.service';
import { PurchaseInventoryModule } from '../../server/modules/purchase-inventory/purchase-inventory.module';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';

it('registers and exports one native follow-up service shared by the publisher and callback router', async () => {
  const providers = Reflect.getMetadata('providers', BitableSyncModule) as Provider[];
  expect(providers).toEqual(expect.arrayContaining([TodayOperationsFollowUpCardStore, TodayOperationsFollowUpCardService]));
  expect(Reflect.getMetadata('exports', BitableSyncModule)).toContain(TodayOperationsFollowUpCardService);
  for (const consumer of [DutyScheduleModule, PurchaseInventoryModule]) {
    expect(Reflect.getMetadata('imports', consumer)).toContain(BitableSyncModule);
  }
  class SyntheticIdentityModule {}
  Global()(SyntheticIdentityModule);
  Module({ providers: [{ provide: AccessConfigurationService, useValue: {} }], exports: [AccessConfigurationService] })(SyntheticIdentityModule);
  class NativeScope {}
  Module({ providers: [TodayOperationsFollowUpCardStore, TodayOperationsFollowUpCardService,
    { provide: TodayOperationsAnomalyGateway, useValue: {} },
    { provide: FOLLOW_UP_CARD_LEDGER_PATH, useValue: join(tmpdir(), `native-di-${randomUUID()}`, 'ledger.json') },
  ], exports: [TodayOperationsFollowUpCardService] })(NativeScope);
  const dependencies = (consumer: Function): Provider[] => [...new Set<Function>(Reflect.getMetadata('design:paramtypes', consumer))]
    .filter(type => type !== TodayOperationsFollowUpCardService && type !== AccessConfigurationService)
    .map(type => ({ provide: type as never, useValue: {} }));
  class PublisherScope {}
  Module({ imports: [NativeScope], providers: [DailyOperationsPatrolService, ...dependencies(DailyOperationsPatrolService)] })(PublisherScope);
  class CallbackScope {}
  Module({ imports: [NativeScope], providers: [FeishuCardActionRouter, ...dependencies(FeishuCardActionRouter)] })(CallbackScope);
  const module = await Test.createTestingModule({ imports: [SyntheticIdentityModule, PublisherScope, CallbackScope] }).compile();
  try {
    const native = module.get(TodayOperationsFollowUpCardService);
    expect((module.get(DailyOperationsPatrolService) as unknown as { followUpCards: unknown }).followUpCards).toBe(native);
    expect((module.get(FeishuCardActionRouter) as unknown as { followUpCards: unknown }).followUpCards).toBe(native);
    expect((native as unknown as { store: unknown }).store).toBe(module.get(TodayOperationsFollowUpCardStore));
    expect((native as unknown as { timer: unknown }).timer).toBeUndefined();
  } finally { await module.close(); }
});
