require('reflect-metadata');
require('ts-node').register({
  project: 'tsconfig.node.json',
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    esModuleInterop: true,
  },
});
require('tsconfig-paths').register({
  baseUrl: require('node:path').resolve(__dirname, '../..'),
  paths: require('../../tsconfig.node.json').compilerOptions.paths,
});
const { Test } = require('@nestjs/testing');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const temporary = mkdtempSync(join(tmpdir(), 'nt-threshold-approval-browser-'));
const OriginalDate = Date;
let clockOffset = 0;
global.Date = class extends OriginalDate {
  constructor(...args) {
    super(...(args.length ? args : [OriginalDate.now() + clockOffset]));
  }
  static now() {
    return OriginalDate.now() + clockOffset;
  }
};
process.env.THRESHOLD_LEDGER_PATH = join(temporary, 'records.json');
process.env.THRESHOLD_APPROVAL_LEDGER_PATH = join(
  temporary,
  'adjustments.json',
);
process.env.INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH = join(
  temporary,
  'inventory.json',
);
const config = require('../../server/common/config/external-services.config');
config.getFeishuAuthPayload = () => ({
  app_id: 'qa-app',
  app_secret: 'qa-synthetic-only',
});
const {
  feishuIdentityFingerprint,
} = require('../../server/common/access/feishu-access-approved-grants');
const {
  ThresholdModule,
} = require('../../server/modules/threshold-management/threshold.module');
const {
  ThresholdBitableGateway,
} = require('../../server/modules/threshold-management/threshold-bitable.gateway');
const {
  ThresholdAdjustmentGateway,
} = require('../../server/modules/threshold-management/threshold-adjustment.gateway');
const {
  ThresholdAdjustmentService,
} = require('../../server/modules/threshold-management/threshold-adjustment.service');
const {
  ThresholdStore,
} = require('../../server/modules/threshold-management/threshold.store');
const {
  InventoryOutboundApprovalGateway,
} = require('../../server/modules/inventory-outbound-approval/inventory-outbound-approval.gateway');
const {
  InventoryOutboundApprovalScheduler,
} = require('../../server/modules/inventory-outbound-approval/inventory-outbound-approval.scheduler');
const {
  InventoryBatchCardService,
} = require('../../server/modules/inventory-outbound-approval/inventory-batch-card.service');
const roles = [];
for (const [index, building] of ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].entries()) {
  roles.push({
    openId: `ou_qa_leader_${index}`,
    name: `验收${building}楼长`,
    position: '设施运维示例人员001',
    professions: [],
    buildings: [building],
  });
  for (const profession of ['电气', '暖通'])
    roles.push({
      openId: `ou_qa_${profession === '电气' ? 'electric' : 'hvac'}_${index}`,
      name: `验收${building}${profession}工程师`,
      position: `${profession}工程师`,
      professions: [profession],
      buildings: [building],
    });
}
roles.push(
  {
    openId: 'ou_qa_prof_electric',
    name: '验收电气示例人员001',
    position: '电气示例人员001',
    professions: ['电气'],
    buildings: ['电气'],
  },
  {
    openId: 'ou_qa_prof_hvac',
    name: '验收暖通示例人员001',
    position: '暖通示例人员001',
    professions: ['暖通'],
    buildings: ['暖通'],
  },
  {
    openId: 'ou_qa_admin',
    name: '阈值验收账号',
    position: '设施运维经理',
    professions: [],
    buildings: ['H楼'],
  },
);
const context = {
  roles,
  engineers: roles
    .filter((r) => r.position.endsWith('工程师'))
    .map((r) => ({ ...r, profession: r.professions[0] })),
};
const cloud = new Map(),
  cards = [],
  requests = [];
let mode = 'normal',
  role = 'admin',
  actor = 'ou_qa_admin',
  sequence = 0;
const recordGateway = {
  readSnapshot: async () => Array.from(cloud.values()),
  readRecord: async (_profession, id) => cloud.get(id),
  sync: async (job) => {
    cloud.set(job.result.id, structuredClone(job.result.record));
  },
};
const approvalGateway = {
  peekContext: () => structuredClone(context),
  readContext: async () => structuredClone(context),
  recover: async () => [],
  sync: async () => 'rec_qa_approval',
};
const messaging = {
  sendInteractiveCard: async (openId, card, uuid) => {
    const old = cards.find((c) => c.uuid === uuid);
    if (old) return old.messageId;
    const messageId = `om_qa_${++sequence}`;
    cards.push({ openId, card, uuid, messageId });
    return messageId;
  },
  patchInteractiveCard: async (messageId, card) => {
    const message = cards.find((c) => c.messageId === messageId);
    if (!message) throw new Error('验收消息不存在');
    message.card = card;
  },
};
async function main() {
  const module = await Test.createTestingModule({ imports: [ThresholdModule] })
    .overrideProvider(ThresholdBitableGateway)
    .useValue(recordGateway)
    .overrideProvider(ThresholdAdjustmentGateway)
    .useValue(approvalGateway)
    .overrideProvider(InventoryOutboundApprovalGateway)
    .useValue(messaging)
    .overrideProvider(InventoryOutboundApprovalScheduler)
    .useValue({})
    .overrideProvider(InventoryBatchCardService)
    .useValue({})
    .compile();
  const store = module.get(ThresholdStore),
    approval = module.get(ThresholdAdjustmentService);
  for (const record of store.list().records)
    cloud.set(record.id, structuredClone(record));
  const app = module.createNestApplication({ logger: false });
  const stop = async () => {
    await app.close();
    if (
      !resolve(temporary).startsWith(
        resolve(tmpdir()) + require('node:path').sep,
      )
    )
      throw new Error('验收清理路径越界');
    rmSync(temporary, { recursive: true, force: true });
    process.exit(0);
  };
  app.use(async (req, res, next) => {
    const start = Date.now();
    res.on('finish', () =>
      requests.push({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      }),
    );
    if (req.path === '/__qa/shutdown') {
      res.json({ stopping: true });
      void stop();
      return;
    }
    if (req.path === '/__qa/status')
      return res.json({
        requests,
        cards,
        adjustments: approval.ledger.list(),
        count: store.list().records.length,
      });
    if (req.path === '/__qa/control') {
      mode = req.query.mode || 'normal';
      role = req.query.role || role;
      actor = req.query.actor || actor;
      return res.json({ mode, role, actor });
    }
    if (req.path === '/__qa/advance') {
      clockOffset += Number(req.query.minutes || 0) * 60000;
      await approval.runPending();
      return res.json({ now: new Date().toISOString() });
    }
    if (req.path === '/__qa/decision') {
      const entry = approval.ledger.list()[0],
        stage = req.query.role || 'building';
      if (!entry) return res.status(404).json({ message: '验收申请不存在' });
      const person =
        stage === 'engineer'
          ? entry.adjustment.engineer
          : entry.adjustment.stages.find((s) => s.role === stage).approver;
      const receipt = entry.messages.findLast(
        (m) =>
          m.openId === person.openId &&
          m.kind === (stage === 'engineer' ? 'confirmation' : 'approval'),
      );
      if (!receipt)
        return res.status(409).json({ message: '验收卡片尚未发送' });
      try {
        const result = await approval.handleCardAction({
          event_type: 'card.action.trigger',
          operator: { open_id: person.openId },
          context: { open_message_id: receipt.messageId },
          action: {
            tag: 'button',
            value: {
              workflowType: 'threshold_adjustment',
              requestId: entry.adjustment.id,
              role: stage,
              action: req.query.action || 'approve',
            },
          },
        });
        await approval.runPending();
        return res.json({
          claimed: result.claimed,
          state: approval.ledger.get(entry.adjustment.id).adjustment.state,
        });
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }
    if (req.path === '/api/access/session')
      return res.json({
        role,
        purchaseBuilding: null,
        displayName: '阈值验收账号',
        expiresAt: Date.now() + 3600000,
        principalFingerprint: `threshold-qa-${role}`,
        capabilities: {
          canEdit: ['admin', 'editor'].includes(role),
          canDelete: false,
          canForceRefresh: true,
          canAccessContracts: role === 'admin',
        },
      });
    if (req.path === '/api/access/feishu/config')
      return res.json({ enabled: false });
    req.accessPrincipal = {
      role,
      purchaseBuilding: null,
      accountId: `feishu-${feishuIdentityFingerprint('qa-app', actor)}`,
    };
    if (
      req.method === 'POST' &&
      req.path === '/api/threshold-management/adjustments'
    ) {
      const requested = mode;
      mode = 'normal';
      if (requested === 'fail')
        return res
          .status(400)
          .json({ message: '代表性校验失败，请修正后重试' });
      if (requested === 'delay') return setTimeout(next, 1200);
      if (requested === 'timeout') return setTimeout(next, 17000);
    }
    next();
  });
  await app.listen(4191, '127.0.0.1');
  console.log('isolated threshold approval fixture ready: 4191');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
