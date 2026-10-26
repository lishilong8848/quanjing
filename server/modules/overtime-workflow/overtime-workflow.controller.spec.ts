jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Get: decorator,
    Header: decorator,
    Headers: decorator,
    HttpCode: decorator,
    Param: decorator,
    Post: decorator,
    SetMetadata: decorator,
  };
});

import { BadRequestException } from '@nestjs/common';
import { OvertimeWorkflowController } from './overtime-workflow.controller';

describe('OvertimeWorkflowController', () => {
  it('forwards a selected end and rejects a non-string end', async () => {
    const service = {
      getConfirmationDetail: jest.fn(),
      submitConfirmation: jest.fn().mockResolvedValue({ accepted: true }),
    };
    const controller = new OvertimeWorkflowController(service as never);
    const body = {
      actualStartAt: '2026-08-13T11:00:00+08:00',
      actualEndAt: '2026-08-13T13:00:00+08:00',
      actualHours: 1,
      disposition: 'overtime_pay',
    };
    await controller.submitConfirmation(
      'rec_1',
      'signed-ticket',
      'selected-end',
      body,
    );
    expect(service.submitConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ actualEndAt: body.actualEndAt }),
    );
    expect(() =>
      controller.submitConfirmation('rec_1', 'signed-ticket', 'invalid-end', {
        ...body,
        actualEndAt: null,
      }),
    ).toThrow('实际加班结束时间无效');
    expect(service.submitConfirmation).toHaveBeenCalledTimes(1);
  });
  it('forwards the ticket from a header instead of query or URL', async () => {
    const service = {
      getConfirmationDetail: jest.fn().mockResolvedValue({ recordId: 'rec_1' }),
      submitConfirmation: jest.fn(),
    };
    const controller = new OvertimeWorkflowController(service as never);
    await expect(
      controller.getConfirmation('rec_1', 'signed-ticket'),
    ).resolves.toEqual({ recordId: 'rec_1' });
    expect(service.getConfirmationDetail).toHaveBeenCalledWith(
      'rec_1',
      'signed-ticket',
    );
  });

  it('requires a mutation ID and does not perform external synchronization in the controller', async () => {
    const service = {
      getConfirmationDetail: jest.fn(),
      submitConfirmation: jest.fn().mockResolvedValue({
        accepted: true,
        mutationId: 'confirm-1',
      }),
    };
    const controller = new OvertimeWorkflowController(service as never);
    await expect(
      controller.submitConfirmation('rec_1', 'signed-ticket', 'confirm-1', {
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualHours: 6,
        disposition: 'overtime_pay',
      }),
    ).resolves.toEqual({ accepted: true, mutationId: 'confirm-1' });
    expect(() =>
      controller.submitConfirmation('rec_1', 'signed-ticket', '', {
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualHours: 6,
        disposition: 'overtime_pay',
      }),
    ).toThrow(BadRequestException);
  });

  it('forwards a null disposition for a zero-hour cancellation', async () => {
    const service = {
      getConfirmationDetail: jest.fn(),
      submitConfirmation: jest.fn().mockResolvedValue({
        accepted: true,
        mutationId: 'confirm-zero',
      }),
    };
    const controller = new OvertimeWorkflowController(service as never);

    await controller.submitConfirmation(
      'rec_1',
      'signed-ticket',
      'confirm-zero',
      {
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualHours: 0,
        disposition: null,
      },
    );

    expect(service.submitConfirmation).toHaveBeenCalledWith({
      recordId: 'rec_1',
      ticket: 'signed-ticket',
      mutationId: 'confirm-zero',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 0,
      disposition: null,
    });
  });

  it('rejects a null hour value instead of coercing it to zero', () => {
    const service = {
      getConfirmationDetail: jest.fn(),
      submitConfirmation: jest.fn(),
    };
    const controller = new OvertimeWorkflowController(service as never);

    expect(() =>
      controller.submitConfirmation(
        'rec_1',
        'signed-ticket',
        'confirm-null-hours',
        {
          actualStartAt: '2026-08-13T10:00:00+08:00',
          actualHours: null,
          disposition: null,
        },
      ),
    ).toThrow('实际加班工时必须是 0 至 72 的整数');
    expect(service.submitConfirmation).not.toHaveBeenCalled();
  });
});
