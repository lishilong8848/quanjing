import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessRole } from '../../../shared/access-control.interface';
import { GuestSubmittable } from '../../common/access/unified-access.decorators';
import type {
  NantongAssistantChatRequest,
  NantongAssistantChatResponse,
} from '../../../shared/nantong-assistant.interface';
import { NantongAssistantService } from './nantong-assistant.service';

type AssistantRequest = Request & { accessPrincipalFingerprint?: string; accessRole?: AccessRole };

@Controller('api/bitable/nantong-assistant')
export class NantongAssistantController {
  constructor(@Inject(NantongAssistantService) private readonly service: NantongAssistantService) {}

  @Post('chat')
  @GuestSubmittable()
  chat(
    @Body() body: NantongAssistantChatRequest,
    @Req() request: AssistantRequest,
  ): Promise<NantongAssistantChatResponse> {
    const role = request.accessRole || 'guest';
    const principal = request.accessPrincipalFingerprint || `guest:${request.ip || 'unknown'}`;
    return this.service.chat(body, principal, role);
  }
}
