import {
  ArgumentsHost,
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from '../../server/common/filters/exception.filter';

function createMockHost(
  headersSent = false,
  request: { method?: string; originalUrl?: string; url?: string } = {},
) {
  const response = {
    headersSent,
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe('GlobalExceptionFilter', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    jest.restoreAllMocks();
  });

  it('exposes http exception messages at the top level for client toasts', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();

    filter.catch(
      new BadRequestException('每日施工准备需上传挂牌与隔离照片'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: '每日施工准备需上传挂牌与隔离照片',
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: '每日施工准备需上传挂牌与隔离照片',
        }),
      }),
    );
  });

  it('preserves the safe leave write disposition without exposing arbitrary exception fields', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();

    filter.catch(
      new BadGatewayException({
        message: '请休假人员资料加载失败，尚未建立请休假记录',
        writeDisposition: 'definitely-not-written',
        internalToken: 'must-not-leak',
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(response.status).toHaveBeenCalledWith(502);
    expect(payload).toMatchObject({
      success: false,
      message: '请休假人员资料加载失败，尚未建立请休假记录',
      writeDisposition: 'definitely-not-written',
    });
    expect(payload.internalToken).toBeUndefined();
    expect(payload.error.details).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
  });

  it('marks only the exact emergency-duty endpoint as definitely-not-written', () => {
    const filter = new GlobalExceptionFilter();
    const emergency = createMockHost(false, {
      method: 'POST',
      originalUrl: '/api/duty-schedules/emergency-duty?source=monthly',
    });
    const lookalikes = [
      createMockHost(false, {
        method: 'POST',
        originalUrl: '/api/other/duty-schedules/emergency-duty',
      }),
      createMockHost(false, {
        method: 'POST',
        originalUrl: '/foo/duty-schedules/emergency-duty',
      }),
    ];

    filter.catch(new ForbiddenException('无权调整应急值班'), emergency.host);
    lookalikes.forEach(({ host }) =>
      filter.catch(new ForbiddenException('无权提交'), host),
    );

    expect(emergency.response.json.mock.calls[0]?.[0]).toMatchObject({
      message: '无权调整应急值班',
      writeDisposition: 'definitely-not-written',
    });
    lookalikes.forEach(({ response }) => {
      expect(response.json.mock.calls[0]?.[0].writeDisposition).toBeUndefined();
    });
  });

  it('preserves an explicit emergency-duty unknown-result over route inference', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost(false, {
      method: 'POST',
      originalUrl: '/api/duty-schedules/emergency-duty',
    });

    filter.catch(
      new ForbiddenException({
        message: '写入结果尚未确认',
        writeDisposition: 'unknown-result',
      }),
      host,
    );

    expect(response.json.mock.calls[0]?.[0]).toMatchObject({
      message: '写入结果尚未确认',
      writeDisposition: 'unknown-result',
    });
  });

  it('preserves only a validated leave impact from an http exception', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();

    filter.catch(
      new ConflictException({
        message: '排班已变化，请确认最新工时后重试',
        writeDisposition: 'definitely-not-written',
        internalToken: 'root-secret',
        latestImpact: {
          affectedSchedules: [
            {
              recordId: 'schedule-1',
              date: '2026-08-04',
              building: 'H楼',
              team: '长白',
              shift: '白',
              scheduledHours: 8,
              leaveHours: 8,
              countedHours: 8,
              internalToken: 'nested-secret',
            },
          ],
          excludedSchedules: [],
          rawHours: 8,
          minimumHours: 4,
          unrecognizedShifts: [],
          missingCalendarYears: [],
          invalidRange: false,
          invalidRangeReason: null,
          internalToken: 'impact-secret',
        },
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(response.status).toHaveBeenCalledWith(409);
    expect(payload).toMatchObject({
      success: false,
      message: '排班已变化，请确认最新工时后重试',
      writeDisposition: 'definitely-not-written',
      latestImpact: {
        affectedSchedules: [
          {
            recordId: 'schedule-1',
            date: '2026-08-04',
            building: 'H楼',
            team: '长白',
            shift: '白',
            scheduledHours: 8,
            leaveHours: 8,
            countedHours: 8,
          },
        ],
        excludedSchedules: [],
        rawHours: 8,
        minimumHours: 4,
        unrecognizedShifts: [],
        missingCalendarYears: [],
        invalidRange: false,
        invalidRangeReason: null,
      },
    });
    expect(payload.error.details).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  it('preserves only the whitelisted overtime unknown-result disposition', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();

    filter.catch(
      new ServiceUnavailableException({
        message: '加班写入结果未知，请使用原申请标识安全重试',
        writeDisposition: 'unknown-result',
        ledgerPath: 'D:\\private\\overtime-ledger.json',
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(response.status).toHaveBeenCalledWith(503);
    expect(payload).toMatchObject({
      success: false,
      message: '加班写入结果未知，请使用原申请标识安全重试',
      writeDisposition: 'unknown-result',
    });
    expect(JSON.stringify(payload)).not.toContain('overtime-ledger');
  });

  it('preserves only a strictly sanitized overtime impact from a conflict', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();

    filter.catch(
      new ConflictException({
        message: '排班已发生变化，本次加班未提交',
        writeDisposition: 'definitely-not-written',
        internalToken: 'root-secret',
        latestImpact: {
          rawHours: 3,
          payableHours: 3,
          conflictingSchedules: [
            {
              recordId: 'schedule-overtime-1',
              date: '2026-08-05',
              building: 'A楼',
              team: '一班',
              shift: '夜间值守',
              overlapHours: 2,
              internalToken: 'nested-secret',
            },
          ],
          isWholeHour: true,
          invalidRangeReason: null,
          canSubmit: false,
          internalToken: 'impact-secret',
        },
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(response.status).toHaveBeenCalledWith(409);
    expect(payload).toMatchObject({
      success: false,
      message: '排班已发生变化，本次加班未提交',
      writeDisposition: 'definitely-not-written',
      latestImpact: {
        rawHours: 3,
        payableHours: 3,
        conflictingSchedules: [
          {
            recordId: 'schedule-overtime-1',
            date: '2026-08-05',
            building: 'A楼',
            team: '一班',
            shift: '夜间值守',
            overlapHours: 2,
          },
        ],
        isWholeHour: true,
        invalidRangeReason: null,
        canSubmit: false,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  it('drops an invalid disposition and malformed latest impact without leaking fields', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();

    filter.catch(
      new ConflictException({
        message: 'invalid overtime preview',
        writeDisposition: 'unknown-or-written',
        latestImpact: {
          rawHours: 3,
          payableHours: 3,
          conflictingSchedules: [{ recordId: 'incomplete' }],
          isWholeHour: true,
          invalidRangeReason: null,
          canSubmit: false,
          internalToken: 'malformed-secret',
        },
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.writeDisposition).toBeUndefined();
    expect(payload.latestImpact).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('malformed-secret');
  });

  it('redacts unknown exception diagnostics in production and logs them server-side', () => {
    process.env.NODE_ENV = 'production';
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();
    const exception = new Error('failed at D:\\private\\service.ts');
    exception.stack = 'Error: failed\n    at D:\\private\\service.ts:10:2';
    exception.cause = 'D:\\private\\database.ts';

    filter.catch(exception, host);

    const payload = response.json.mock.calls[0][0];
    expect(payload.error.stack).toBeUndefined();
    expect(payload.error.cause).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('D:\\private');
    expect(loggerError).toHaveBeenCalledWith(
      exception.message,
      exception.stack,
    );
  });

  it('keeps unknown exception diagnostics in development', () => {
    process.env.NODE_ENV = 'development';
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost();
    const exception = new Error('development failure');
    exception.stack = 'Error: development failure\n    at server.ts:10:2';
    exception.cause = 'database unavailable';

    filter.catch(exception, host);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          stack: exception.stack,
          cause: exception.cause,
        }),
      }),
    );
  });

  it('logs an unknown exception even when response headers were already sent', () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const filter = new GlobalExceptionFilter();
    const { host, response } = createMockHost(true);
    const exception = new Error('stream failed after headers');

    filter.catch(exception, host);

    expect(loggerError).toHaveBeenCalledWith(
      exception.message,
      exception.stack,
    );
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });
});
