import type {
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportRoom,
  SystemMonthlyReportStage,
  SystemMonthlyReportTask,
} from '@shared/system-monthly-report.interface';
import {
  SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES,
  buildSystemMonthlyReportVersionedFileName as buildSharedSystemMonthlyReportVersionedFileName,
} from '@shared/system-monthly-report.interface';

export type SystemMonthlyReportPrimaryAction =
  | {
      kind: 'submit';
      stage: SystemMonthlyReportStage;
      label: string;
    }
  | {
      kind: 'review';
      round: SystemMonthlyReportReviewRound;
      label: string;
    };

export interface SystemMonthlyReportTaskPresentation {
  label: string;
  busy: boolean;
  terminalSuccess: boolean;
  tone: 'info' | 'success' | 'error' | 'warning';
}

export interface SystemMonthlyReportSubmissionStageOption {
  stage: SystemMonthlyReportStage;
  label: string;
  state: 'available' | 'replaceable' | 'completed' | 'locked';
  canDelete: boolean;
}

export interface SystemMonthlyReportPersonalTodo {
  room: SystemMonthlyReportRoom;
  action: SystemMonthlyReportPrimaryAction;
}

const SUBMISSION_STAGES: Array<
  Pick<SystemMonthlyReportSubmissionStageOption, 'stage' | 'label'>
> = [
  { stage: 'initial', label: '初版月报' },
  { stage: 'recheck', label: '复审月报' },
  { stage: 'final', label: '终版月报' },
];

export function getSystemMonthlyReportPrimaryAction(
  room: Pick<SystemMonthlyReportRoom, 'status'>,
): SystemMonthlyReportPrimaryAction | null {
  switch (room.status) {
    case 'initial_pending':
      return { kind: 'submit', stage: 'initial', label: '提交初版' };
    case 'initial_review':
      return { kind: 'review', round: 'initial', label: '审核初版' };
    case 'recheck_pending':
      return {
        kind: 'submit',
        stage: 'recheck',
        label: '提交复审版（初版修改稿）',
      };
    case 'recheck_review':
      return { kind: 'review', round: 'recheck', label: '审核复审版' };
    case 'final_pending':
      return { kind: 'submit', stage: 'final', label: '提交终版' };
    case 'completed':
      return null;
  }
}

export function getSystemMonthlyReportAuthorizedAction(
  room: Pick<SystemMonthlyReportRoom, 'status' | 'access'>,
) {
  const action = getSystemMonthlyReportPrimaryAction(room);
  if (!action || !room.access) return null;
  if (action.kind === 'submit') {
    return room.access.canSubmit ? action : null;
  }
  return room.access.reviewRounds.includes(action.round) ? action : null;
}

export function buildSystemMonthlyReportPersonalTodos(
  rooms: SystemMonthlyReportRoom[],
): SystemMonthlyReportPersonalTodo[] {
  return rooms.flatMap((room) => {
    const action = getSystemMonthlyReportAuthorizedAction(room);
    return action ? [{ room, action }] : [];
  });
}

export function buildSystemMonthlyReportSubmissionStageOptions(
  room: Pick<SystemMonthlyReportRoom, 'status'>,
  editable = true,
): SystemMonthlyReportSubmissionStageOption[] {
  const completedStages =
    room.status === 'initial_pending'
      ? 0
      : room.status === 'initial_review' || room.status === 'recheck_pending'
        ? 1
        : room.status === 'recheck_review' || room.status === 'final_pending'
          ? 2
          : 3;
  const currentAction = getSystemMonthlyReportPrimaryAction(room);
  const availableStage =
    currentAction?.kind === 'submit' ? currentAction.stage : null;

  const replaceable: Record<
    SystemMonthlyReportStage,
    SystemMonthlyReportRoom['status'][]
  > = {
    initial: ['initial_review', 'recheck_pending', 'recheck_review'],
    recheck: ['recheck_review', 'final_pending'],
    final: ['completed'],
  };
  const deletable: Record<
    SystemMonthlyReportStage,
    SystemMonthlyReportRoom['status'][]
  > = {
    initial: ['initial_review'],
    recheck: ['recheck_review'],
    final: ['completed'],
  };
  const dependencyLocked: Record<
    SystemMonthlyReportStage,
    SystemMonthlyReportRoom['status'][]
  > = {
    initial: ['final_pending', 'completed'],
    recheck: ['completed'],
    final: [],
  };

  return SUBMISSION_STAGES.map((item, index) => {
    const completed = index < completedStages;
    const canReplace =
      editable && completed && replaceable[item.stage].includes(room.status);
    return {
      ...item,
      state: canReplace
        ? 'replaceable'
        : editable && item.stage === availableStage
          ? 'available'
          : dependencyLocked[item.stage].includes(room.status)
            ? 'locked'
            : completed
              ? 'completed'
              : 'locked',
      canDelete:
        editable && completed && deletable[item.stage].includes(room.status),
    };
  });
}

export function getSystemMonthlyReportTaskPresentation(
  task: Pick<SystemMonthlyReportTask, 'status'>,
): SystemMonthlyReportTaskPresentation {
  switch (task.status) {
    case 'accepted':
      return {
        label: '已受理',
        busy: true,
        terminalSuccess: false,
        tone: 'info',
      };
    case 'syncing':
      return {
        label: '处理中',
        busy: true,
        terminalSuccess: false,
        tone: 'info',
      };
    case 'success':
      return {
        label: '已完成',
        busy: false,
        terminalSuccess: true,
        tone: 'success',
      };
    case 'error':
      return {
        label: '处理失败',
        busy: false,
        terminalSuccess: false,
        tone: 'error',
      };
    case 'uncertain':
      return {
        label: '结果待确认',
        busy: false,
        terminalSuccess: false,
        tone: 'warning',
      };
  }
}

export function validateSystemMonthlyReportUploadFile(file: {
  name: string;
  size: number;
}): string {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return '月报附件内容为空。';
  }
  if (!/\.(xlsx|xls|pdf)$/iu.test(file.name.trim())) {
    return '月报附件仅支持 XLSX、XLS、PDF 格式。';
  }
  if (file.size > SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES) {
    return '月报附件不能超过 150 MB。';
  }
  return '';
}

export function getSystemMonthlyReportSubmissionError(
  task: Pick<SystemMonthlyReportTask, 'status' | 'message' | 'sync'>,
): string {
  if (task.status === 'uncertain') {
    return '提交结果暂时无法确认。点击重新提交将安全确认或补齐失败步骤。';
  }

  const branchMessages = [
    task.message,
    task.sync?.feishu.message,
    task.sync?.cos.message,
  ].filter(Boolean);
  const connectionInterrupted = branchMessages.some((message) =>
    /ECONNRESET|ECONNABORTED|ETIMEDOUT|timed?\s*out|连接(?:被)?(?:中断|重置)|网络(?:连接)?(?:中断|异常)/iu.test(
      message || '',
    ),
  );
  const reason = connectionInterrupted ? '（连接中断）' : '';
  const feishuStatus = task.sync?.feishu.status;
  const cosStatus = task.sync?.cos.status;

  if (feishuStatus === 'error' && cosStatus === 'success') {
    return `附件已安全保存，业务记录同步失败${reason}。点击重新提交将只重试失败步骤。`;
  }
  if (feishuStatus === 'success' && cosStatus === 'error') {
    return `业务记录已更新，附件归档失败${reason}。点击重新提交将只重试失败步骤。`;
  }
  if (feishuStatus === 'error' || cosStatus === 'error') {
    return `附件提交未完成${reason}。点击重新提交将只重试失败步骤。`;
  }
  return '月报提交未完成。请重新提交。';
}

export function shouldCommitSystemMonthlyReportResponse(
  activeRequestId: number,
  responseRequestId: number,
): boolean {
  return activeRequestId === responseRequestId;
}

export const buildSystemMonthlyReportVersionedFileName =
  buildSharedSystemMonthlyReportVersionedFileName;
