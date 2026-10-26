import type { LeaveRequestImpact } from '@shared/leave-request-impact';
import type { OvertimeRequestImpact } from '@shared/overtime-request-impact';

// 错误统一响应
export interface ApiErrorResponse {
  /** 请求是否成功 */
  success: false;
  /** 错误消息，兼容前端通用提示读取 */
  message: string;
  /** 写入结果判定；仅在服务端能确认未落库时返回 */
  writeDisposition?: 'definitely-not-written' | 'unknown-result';
  /** 服务端重新计算并校验过的请休假排班影响 */
  latestImpact?: LeaveRequestImpact | OvertimeRequestImpact;
  /** 错误详情 */
  error: {
    /** 错误代码 */
    code: string;
    /** 错误消息 */
    message: string;
    /** 错误详情 */
    details?: string;
    /** 字段验证错误 */
    fieldErrors?: Record<string, string[]>;
    /** 调用栈（仅开发环境） */
    stack?: string;
    /** 错误原因 */
    cause?: string;
    /** 错误发生时间 */
    timestamp?: number;
  };
}
