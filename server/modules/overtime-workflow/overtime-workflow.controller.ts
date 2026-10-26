import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { PublicAccess } from '../../common/access/unified-access.decorators';
import {
  OvertimeWorkflowService,
  type OvertimeConfirmationDispositionApi,
} from './overtime-workflow.service';

@Controller('api/overtime-workflow')
export class OvertimeWorkflowController {
  constructor(private readonly service: OvertimeWorkflowService) {}

  @PublicAccess()
  @Get('confirm/:recordId')
  @Header('Cache-Control', 'no-store')
  getConfirmation(
    @Param('recordId') recordId: string,
    @Headers('x-overtime-confirmation-ticket') ticket: string,
  ) {
    return this.service.getConfirmationDetail(
      recordId,
      requireHeaderTicket(ticket),
    );
  }

  @PublicAccess()
  @Post('confirm/:recordId')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  submitConfirmation(
    @Param('recordId') recordId: string,
    @Headers('x-overtime-confirmation-ticket') ticket: string,
    @Headers('x-idempotency-key') mutationId: string,
    @Body()
    body: {
      actualStartAt?: unknown;
      actualEndAt?: unknown;
      actualHours?: unknown;
      disposition?: unknown;
    },
  ) {
    const normalizedMutationId = normalizeHeader(mutationId);
    if (!normalizedMutationId || normalizedMutationId.length > 128) {
      throw new BadRequestException('加班确认幂等标识缺失或无效');
    }
    const actualHours = body?.actualHours;
    if (
      typeof actualHours !== 'number' ||
      !Number.isInteger(actualHours) ||
      actualHours < 0 ||
      actualHours > 72
    ) {
      throw new BadRequestException('实际加班工时必须是 0 至 72 的整数');
    }
    if (
      body?.actualEndAt !== undefined &&
      typeof body.actualEndAt !== 'string'
    ) {
      throw new BadRequestException('实际加班结束时间无效');
    }
    return this.service.submitConfirmation({
      recordId,
      ticket: requireHeaderTicket(ticket),
      mutationId: normalizedMutationId,
      actualStartAt:
        typeof body?.actualStartAt === 'string' ? body.actualStartAt : '',
      ...(body?.actualEndAt !== undefined
        ? { actualEndAt: body.actualEndAt as string }
        : {}),
      actualHours,
      disposition:
        body?.disposition as OvertimeConfirmationDispositionApi | null,
    });
  }
}

function requireHeaderTicket(value: unknown): string {
  const ticket = normalizeHeader(value);
  if (!ticket || ticket.length > 2_048) {
    throw new BadRequestException('加班确认令牌缺失或无效');
  }
  return ticket;
}

function normalizeHeader(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
