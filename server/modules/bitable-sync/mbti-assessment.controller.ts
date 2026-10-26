import { Controller, Get, Header, Param, Post, Body, Query, Req } from '@nestjs/common';
import { GuestReadable, GuestSubmittable } from '../../common/access/unified-access.decorators';
import { MbtiAssessmentService } from './mbti-assessment.service';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { bindSelfServiceApplicant } from '@server/common/access/self-service-applicant';

type AssessmentAccessRequest = { accessPrincipal?: AccessPrincipal; accessPrincipalFingerprint?: string };

@Controller('api/bitable/mbti-assessment')
export class MbtiAssessmentController {
  constructor(private readonly assessment: MbtiAssessmentService) {}

  @GuestReadable()
  @Get('me')
  @Header('Cache-Control', 'no-store')
  currentPerson(@Req() request: AssessmentAccessRequest) {
    return this.assessment.currentPerson(request.accessPrincipal, Boolean(request.accessPrincipalFingerprint));
  }

  @GuestReadable()
  @Get('people')
  @Header('Cache-Control', 'no-store')
  searchPeople(@Query('q') query: unknown) { return this.assessment.searchPeople(query); }

  @GuestReadable()
  @Get('onboarding')
  @Header('Cache-Control', 'no-store')
  onboarding(@Query('ticket') ticket: unknown) { return this.assessment.onboardingContext(ticket); }

  @GuestReadable()
  @Get('submissions/:mutationId')
  @Header('Cache-Control', 'no-store')
  status(@Param('mutationId') mutationId: string) { return this.assessment.status(mutationId); }

  @GuestSubmittable()
  @Post('submit')
  @Header('Cache-Control', 'no-store')
  submit(@Body() body: unknown, @Req() request?: AssessmentAccessRequest) {
    if (body && typeof body === 'object' && !Array.isArray(body) && (body as { audience?: unknown }).audience === 'active') {
      const value = body as { name?: unknown };
      value.name = bindSelfServiceApplicant(typeof value.name === 'string' ? value.name : '', request?.accessPrincipal, Boolean(request?.accessPrincipalFingerprint), '提交 MBTI 测试');
    }
    return this.assessment.submit(body, request?.accessPrincipal);
  }
}
