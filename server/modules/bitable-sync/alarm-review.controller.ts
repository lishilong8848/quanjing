import { Body, Controller, Get, Header, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessRole } from '../../../shared/access-control.interface';
import { AlarmReviewService } from './alarm-review.service';
type ReviewAccessRequest = Request & { accessRole?: AccessRole; accessPrincipalFingerprint?: string };

@Controller('api/bitable/alarm-human-reviews')
export class AlarmReviewController {
  constructor(private readonly reviews: AlarmReviewService) {}
  @Get('people')
  @Header('Cache-Control', 'no-store')
  people(@Req() request: ReviewAccessRequest) { return this.reviews.candidates(request.accessRole || 'guest'); }
  @Post()
  @Header('Cache-Control', 'no-store')
  submit(@Body() body: unknown, @Req() request: ReviewAccessRequest) {
    return this.reviews.submit(body, request.accessRole || 'guest', request.accessPrincipalFingerprint || '');
  }
  @Get('mutation/:clientMutationId')
  @Header('Cache-Control', 'no-store')
  recover(@Param('clientMutationId') id: string, @Req() request: ReviewAccessRequest) {
    return this.reviews.recover(id, request.accessRole || 'guest', request.accessPrincipalFingerprint || '');
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  status(@Param('id') id: string, @Req() request: ReviewAccessRequest) {
    return this.reviews.status(id, request.accessRole || 'guest', request.accessPrincipalFingerprint || '');
  }
  @Post(':id/retry')
  @Header('Cache-Control', 'no-store')
  retry(@Param('id') id: string, @Req() request: ReviewAccessRequest) {
    return this.reviews.retry(id, request.accessRole || 'guest', request.accessPrincipalFingerprint || '');
  }
}
