import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BusinessException } from '../interfaces/exception.interface';
import {
  HTTP_STATUS_TO_RESPONSE_CODE_MAP,
  ResponseCode,
} from '../constants/api_response_code';
import { ApiErrorResponse } from '../interfaces/api_response.interface';
import {
  createLeaveRequestImpactComparisonKey,
  type LeaveRequestImpact,
} from '@shared/leave-request-impact';
import {
  createOvertimeRequestImpactComparisonKey,
  type OvertimeRequestImpact,
} from '@shared/overtime-request-impact';

// 全局异常过滤器，用于捕获所有未处理的异常
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // 如果响应头已发送，则不处理
    if (response.headersSent) {
      if (
        !(exception instanceof BusinessException) &&
        !(exception instanceof HttpException)
      ) {
        this.normalizeAndLogUnknownException(exception);
      }
      return;
    }

    let errorResponse: Omit<ApiErrorResponse, 'httpStatus'>;
    let httpStatus: HttpStatus;

    if (exception instanceof BusinessException) {
      // 业务异常
      httpStatus = exception.httpStatus;
      errorResponse = {
        success: false,
        message: exception.message,
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          fieldErrors: exception.fieldErrors,
          timestamp: Date.now(),
        },
      };
    } else if (exception instanceof HttpException) {
      // HTTP异常
      httpStatus = exception.getStatus() as HttpStatus;
      const exceptionResponse = exception.getResponse();
      const request =
        typeof ctx.getRequest === 'function'
          ? ctx.getRequest<Request>()
          : undefined;
      const rawWriteDisposition =
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null &&
        (exceptionResponse as { writeDisposition?: unknown }).writeDisposition;
      const writeDisposition =
        rawWriteDisposition === 'definitely-not-written' ||
        rawWriteDisposition === 'unknown-result'
          ? rawWriteDisposition
          : isEmergencyDutyPreWriteHttpFailure(request, httpStatus)
            ? 'definitely-not-written'
            : undefined;
      const rawLatestImpact =
        typeof exceptionResponse === 'object' && exceptionResponse !== null
          ? (exceptionResponse as { latestImpact?: unknown }).latestImpact
          : undefined;
      const leaveImpactKey =
        createLeaveRequestImpactComparisonKey(rawLatestImpact);
      const overtimeImpactKey = leaveImpactKey
        ? null
        : createOvertimeRequestImpactComparisonKey(rawLatestImpact);
      const latestImpact:
        | LeaveRequestImpact
        | OvertimeRequestImpact
        | undefined = leaveImpactKey
        ? (JSON.parse(leaveImpactKey) as LeaveRequestImpact)
        : overtimeImpactKey
          ? (JSON.parse(overtimeImpactKey) as OvertimeRequestImpact)
          : undefined;
      const message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : exception.message;

      errorResponse = {
        success: false,
        message,
        ...(writeDisposition ? { writeDisposition } : {}),
        ...(latestImpact ? { latestImpact } : {}),
        error: {
          code: HTTP_STATUS_TO_RESPONSE_CODE_MAP[httpStatus],
          message,
          timestamp: Date.now(),
        },
      };
    } else {
      // 未知异常
      const unknownError = this.normalizeAndLogUnknownException(exception);
      const debugDetails =
        process.env.NODE_ENV === 'production'
          ? {}
          : {
              stack: unknownError.stack,
              cause:
                unknownError.cause === undefined
                  ? undefined
                  : String(unknownError.cause),
            };
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
      errorResponse = {
        success: false,
        message: '服务器内部错误',
        error: {
          code: ResponseCode.INTERNAL_ERROR,
          message: '服务器内部错误',
          ...debugDetails,
          timestamp: Date.now(),
        },
      };
    }

    response.status(httpStatus).json(errorResponse);
  }

  private normalizeAndLogUnknownException(exception: unknown): Error {
    const unknownError =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(unknownError.message, unknownError.stack);
    return unknownError;
  }
}

function isEmergencyDutyPreWriteHttpFailure(
  request: Pick<Request, 'method' | 'originalUrl' | 'url'> | undefined,
  httpStatus: HttpStatus,
): boolean {
  if (String(request?.method || '').toUpperCase() !== 'POST') return false;
  if (![400, 401, 403, 422].includes(Number(httpStatus))) return false;
  const pathname = String(request?.originalUrl || request?.url || '')
    .split('?')[0]
    .replace(/\/+$/u, '');
  const configuredBasePath = String(process.env.CLIENT_BASE_PATH || '')
    .trim()
    .replace(/^\/+|\/+$/gu, '');
  const endpoint = `${configuredBasePath ? `/${configuredBasePath}` : ''}/api/duty-schedules/emergency-duty`;
  return pathname === endpoint;
}
