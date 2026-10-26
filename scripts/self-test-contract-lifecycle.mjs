import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';

process.env.FORCE_AUTHN_INNERAPI_DOMAIN ||= 'http://localhost:3001';
process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';

const { AppModule } = await import('../dist/server/app.module.js');
const { ContractCreationService } =
  await import('../dist/server/modules/contract-management/contract-creation.service.js');
const { ContractPaymentFollowUpService } =
  await import('../dist/server/modules/contract-management/contract-payment-follow-up.service.js');
const { ContractEditService } =
  await import('../dist/server/modules/contract-management/contract-edit.service.js');
const { ContractExpiryDispositionService } =
  await import('../dist/server/modules/contract-management/contract-expiry-disposition.service.js');
const { ContractCreationGateway } =
  await import('../dist/server/modules/contract-management/contract-creation.gateway.js');
const { ContractWorkflowService } =
  await import('../dist/server/modules/contract-management/contract-workflow.service.js');
const { CONTRACT_PAYMENT_PERIODS } =
  await import('../dist/shared/contract-field-config.js');

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ['error', 'warn'],
  abortOnError: false,
});

let created = null;
let cleanup = null;

try {
  const contractCreation = app.get(ContractCreationService);
  const paymentFollowUp = app.get(ContractPaymentFollowUpService);
  const contractEdit = app.get(ContractEditService);
  const expiryDisposition = app.get(ContractExpiryDispositionService);
  const gateway = app.get(ContractCreationGateway);
  const workflow = app.get(ContractWorkflowService);
  const marker = `CODEX-SELFTEST-LIFECYCLE-${Date.now()}`;
  const skipAttachments =
    process.env.CONTRACT_LIFECYCLE_SELF_TEST_SKIP_ATTACHMENTS === 'true';
  const today = shanghaiDateKey(new Date());
  const initialEndDate = addShanghaiDays(today, 1);
  const renewalEndDate = addShanghaiDays(today, 45);
  const initialPeriod = CONTRACT_PAYMENT_PERIODS[0];
  if (!initialPeriod) throw new Error('真实自测无法执行：付款计划周期未配置');

  const options = await contractCreation.getOptions('execution');
  const owner = options.people[0];
  const supplier = options.suppliers[0];
  if (!owner || !supplier) {
    throw new Error('真实自测无法执行：缺少可用的合同跟进人或供应商');
  }

  const fields = {};
  assignField(options.fields, fields, '合同编号', marker);
  assignField(options.fields, fields, '合同名称', `${marker} 合同生命周期自测`);
  assignField(options.fields, fields, '跟进人', owner.openId);
  assignFirstOption(options.fields, fields, '合同类型');
  assignField(options.fields, fields, '合同金额', 0.01);
  assignField(options.fields, fields, '合同开始日期', today);
  assignField(options.fields, fields, '合同结束日期', initialEndDate);
  assignFirstOption(options.fields, fields, '专业类别');

  const initialPaymentDate = addShanghaiDays(today, 1);
  created = await contractCreation.create(
    {
      kind: 'execution',
      idempotencyKey: uuidFor(marker, 'contract'),
      fields,
      supplier: { mode: 'existing', recordId: supplier.recordId },
      linkFramework: false,
      paymentPlans: [
        {
          period: initialPeriod,
          plannedAmount: 0.01,
          plannedPaymentDate: initialPaymentDate,
          ownerOpenId: owner.openId,
        },
      ],
    },
    skipAttachments ? [] : [buildTestPdf(marker)],
    { selfTest: true },
  );
  assertNotification(created.notification, '新合同完成卡片通知');
  assert(created.paymentRecordIds.length === 1, '新合同首笔付款计划未创建');

  const expiryReminder = await waitForExpiryReminder(workflow);
  assert(
    expiryReminder.matched >= 1 &&
      expiryReminder.sent >= 1 &&
      expiryReminder.failed === 0,
    `合同到期风险卡片通知失败：${expiryReminder.message}`,
  );

  const followUpOptions = await paymentFollowUp.getOptions(created.recordId);
  const supplementalPeriod =
    followUpOptions.periods.find((item) => item !== initialPeriod) ||
    followUpOptions.periods[0];
  if (!supplementalPeriod)
    throw new Error('真实自测无法执行：付款计划周期未配置');
  const supplemental = await paymentFollowUp.createPlan(created.recordId, {
    idempotencyKey: uuidFor(marker, 'supplemental-payment'),
    period: supplementalPeriod,
    plannedAmount: 0.02,
    plannedPaymentDate: addShanghaiDays(today, 2),
    ownerOpenId: owner.openId,
  });
  assertPaymentAction(supplemental, '补充付款计划');

  const adjusted = await paymentFollowUp.adjustPlan(
    created.recordId,
    supplemental.paymentRecordId,
    {
      period: supplementalPeriod,
      plannedAmount: 0.03,
      plannedPaymentDate: addShanghaiDays(today, 3),
      ownerOpenId: owner.openId,
    },
  );
  assertPaymentAction(adjusted, '付款计划调整');

  const confirmed = await paymentFollowUp.confirmPlan(
    created.recordId,
    supplemental.paymentRecordId,
    { actualAmount: 0.03, paymentDate: addShanghaiDays(today, 3) },
  );
  assertPaymentAction(confirmed, '付款计划确认');

  const editOptions = await contractEdit.getOptions(created.recordId);
  const contractNameField = editOptions.fields.find(
    (item) => item.name === '合同名称',
  );
  if (!contractNameField) throw new Error('真实自测无法执行：合同名称字段缺失');
  await contractEdit.update(created.recordId, {
    fields: {
      [contractNameField.fieldId]: `${marker} 已迭代`,
    },
  });

  const renewed = await expiryDisposition.execute(created.recordId, {
    action: 'renew',
    renewalEndDate,
    idempotencyKey: uuidFor(marker, 'renewal'),
    paymentPlans: [
      {
        period: supplementalPeriod,
        plannedAmount: 0.01,
        plannedPaymentDate: addShanghaiDays(today, 4),
        ownerOpenId: owner.openId,
      },
    ],
  });
  assertQueuedNotification(renewed.notification, '合同续期后台通知');

  const voided = await expiryDisposition.execute(created.recordId, {
    action: 'void',
  });
  assertQueuedNotification(voided.notification, '合同作废后台通知');

  const finalRecord = await gateway.getRecord('execution', created.recordId);
  const finalFields = finalRecord.fields || {};
  assert(
    displayText(finalFields['合同名称']).includes('已迭代'),
    '合同信息迭代未回读成功',
  );
  assert(
    displayText(finalFields['合同到期处置']).includes('到期作废'),
    '合同作废状态未回读成功',
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      marker,
      contractRecordId: created.recordId,
      verified: {
        create: true,
        initialPaymentPlan: true,
        supplementalPaymentPlan: true,
        paymentAdjustment: true,
        paymentConfirmation: true,
        contractEdit: true,
        renewal: true,
        void: true,
        weeklyExpiryReminder: true,
        cardNotifications: true,
        lifecycleNotificationsQueued: true,
        attachments: skipAttachments ? 'skipped' : true,
      },
    })}\n`,
  );
} finally {
  if (created) {
    const paymentFollowUp = app.get(ContractPaymentFollowUpService);
    const contractCreation = app.get(ContractCreationService);
    const planIds = await paymentFollowUp
      .getOptions(created.recordId)
      .then((options) => options.plans.map((item) => item.recordId))
      .catch(() => created.paymentRecordIds);
    cleanup = await contractCreation.cleanupSelfTestRecord(
      created.recordId,
      created.attachments.map((item) => item.accessId),
      [...new Set([...created.paymentRecordIds, ...planIds])],
      created.supplierCreated ? created.supplierRecordId : null,
    );
    if (!cleanup.baseDeleted || !cleanup.cosDeleted || cleanup.residualRecord) {
      throw new Error('真实自测清理校验失败');
    }
    process.stdout.write(`${JSON.stringify({ cleanup })}\n`);
  }
  await app.close();
}

function assignField(definitions, values, name, value) {
  const field = definitions.find((item) => item.name === name);
  if (!field) throw new Error(`真实自测无法执行：缺少${name}字段`);
  values[field.fieldId] = value;
}

function assignFirstOption(definitions, values, name) {
  const field = definitions.find((item) => item.name === name);
  const value = field?.options?.[0]?.value;
  if (!field || !value)
    throw new Error(`真实自测无法执行：${name}没有可用选项`);
  values[field.fieldId] = value;
}

function assertNotification(notification, name) {
  assert(
    notification?.attempted && notification.sent >= 1 && !notification.failed,
    `${name}失败：${notification?.message || '未返回发送结果'}`,
  );
}

function assertQueuedNotification(notification, name) {
  assert(
    notification?.attempted &&
      notification.sent === 0 &&
      notification.failed === 0 &&
      notification.message.includes('后台发送'),
    `${name}失败：${notification?.message || '未返回后台通知状态'}`,
  );
}

function assertPaymentAction(result, name) {
  assert(
    result?.ok &&
      typeof result.paymentRecordId === 'string' &&
      result.paymentRecordId,
    `${name}失败：${result?.message || '未返回付款计划记录标识'}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function displayText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value))
    return value.map(displayText).filter(Boolean).join('、');
  if (!value || typeof value !== 'object') return '';
  const item = value;
  return (
    ['text', 'name', 'value']
      .map((key) => displayText(item[key]))
      .find(Boolean) || ''
  );
}

function uuidFor(seed, scope) {
  const hash = createHash('sha256').update(`${seed}:${scope}`).digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function shanghaiDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addShanghaiDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return shanghaiDateKey(new Date(Date.UTC(year, month - 1, day + days, 4)));
}

async function waitForExpiryReminder(workflow) {
  let lastResult = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastResult = await workflow.run('contract_expiry_reminder', {
      trigger: 'manual',
    });
    if (lastResult.matched >= 1 && lastResult.sent >= 1) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return (
    lastResult || {
      matched: 0,
      sent: 0,
      failed: 0,
      message: '未生成到期提醒结果',
    }
  );
}

function buildTestPdf(marker) {
  const safeMarker = marker.replace(/[()\\]/g, '');
  const stream = `BT /F1 12 Tf 72 760 Td (${safeMarker}) Tj 0 -22 Td (Contract lifecycle self-test; auto-cleaned.) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(content, 'latin1'));
    content += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(content, 'latin1');
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    content += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const buffer = Buffer.from(content, 'latin1');
  return {
    originalname: `${marker}.pdf`,
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
  };
}
