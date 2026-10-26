import type { OvertimeConfirmationSubmitRequest } from './overtime-confirmation-state';

export interface OvertimeConfirmationCompletion {
  title: string;
  message: string;
  resultLabel: string;
  dispositionLabel: string;
}

interface OvertimeConfirmationExitTarget {
  readonly closed?: boolean;
  close: () => void;
  history?: { back: () => void };
}

export type OvertimeConfirmationExitResult =
  | 'closed'
  | 'history'
  | 'unavailable';

export function createOvertimeConfirmationCompletion(
  request: OvertimeConfirmationSubmitRequest,
): OvertimeConfirmationCompletion {
  const cancelled = request.actualHours === 0;
  return {
    title: cancelled ? '取消加班提交成功' : '加班确认提交成功',
    message: cancelled
      ? '取消结果已受理，正在退出…'
      : '确认结果已受理，正在退出…',
    resultLabel: cancelled ? '已取消加班' : `${request.actualHours} 小时`,
    dispositionLabel: cancelled
      ? '无需处置'
      : request.disposition === 'overtime_pay'
        ? '加班费'
        : '调休',
  };
}

export function exitOvertimeConfirmationPage(
  target: OvertimeConfirmationExitTarget,
): OvertimeConfirmationExitResult {
  try {
    target.close();
  } catch {
    // Some embedded WebViews reject window.close(); history is the fallback.
  }
  if (target.closed === true) return 'closed';

  try {
    if (target.history) {
      target.history.back();
      return 'history';
    }
  } catch {
    // Keep the success view visible when the host refuses both exit methods.
  }
  return 'unavailable';
}
