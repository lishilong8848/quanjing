import axios from 'axios';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;

async function main() {
  const recipientOpenId = String(process.argv[2] || '').trim();
  const leaveCode = String(process.argv[3] || '').trim();
  if (!OPEN_ID_PATTERN.test(recipientOpenId)) {
    throw new Error(
      'Usage: node scripts/verify-leave-card-schema.mjs <recipient-open-id>',
    );
  }
  await import('../dist/server/runtime-env.js');
  const [{ LeaveWorkflowGateway }, cardModule] = await Promise.all([
    import('../dist/server/modules/leave-workflow/leave-workflow.gateway.js'),
    import('../dist/server/modules/leave-workflow/leave-workflow.card.js'),
  ]);
  const gateway = new LeaveWorkflowGateway({ axiosRef: axios });
  let screenshotImageKeys = [];
  if (leaveCode) {
    const records = await gateway.findLeaveRecordsByCodes([leaveCode]);
    if (records.length !== 1) {
      throw new Error(
        `Expected one leave record for ${leaveCode}, received ${records.length}`,
      );
    }
    screenshotImageKeys = await gateway.prepareLeaveApprovalScreenshotImages(
      records[0].fields,
    );
    if (screenshotImageKeys.length !== 1) {
      throw new Error(
        `Leave record ${leaveCode} has no usable screenshot image`,
      );
    }
  }
  const context = {
    recordId: 'rec_leave_schema_verify',
    applicationKey: 'leave:rec_leave_schema_verify',
    stageKey: 'supervisor',
    stageVersion: 1,
    applicantName: 'CODEX卡片结构验证',
    building: 'D楼',
    position: '运维值班员',
    leaveType: '年假',
    startAt: '2026-08-25T09:00:00+08:00',
    endAt: '2026-08-25T18:00:00+08:00',
    leaveHours: 8,
    approvalDayCount: 1,
    reason: '仅验证飞书卡片结构，不产生请假记录',
    screenshotImageKeys,
    screenshotStatus: screenshotImageKeys.length ? 'ready' : undefined,
    substituteRequired: true,
    substituteCandidates: [
      {
        personRecordId: 'rec_schema_substitute',
        name: '测试替班候选人',
        openId: '',
        position: '长白',
        buildings: ['D楼'],
      },
    ],
  };
  const messageId = await gateway.sendInteractiveCard(
    recipientOpenId,
    cardModule.buildLeaveApprovalCard(context),
    `leave:schema-verify:${Date.now()}`,
  );
  try {
    await gateway.patchInteractiveCard(
      messageId,
      cardModule.buildLeaveRejectionPromptCard(context),
    );
  } finally {
    await gateway.patchInteractiveCard(
      messageId,
      cardModule.buildLeaveTerminalCard({
        ...context,
        outcome: 'approved',
        actorName: '系统自检',
        message: '卡片结构验证通过；未产生业务记录',
      }),
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, screenshotImageCount: screenshotImageKeys.length, messageTerminalized: true })}\n`,
  );
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${String(error instanceof Error ? error.message : error).slice(0, 500)}\n`,
    );
    process.exitCode = 1;
  });
}
