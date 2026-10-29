import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Optional, Post, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { createPermissionCatalog } from '../../../shared/permission-catalog';
import type { CreatePersonnelPermissionRequest } from '../../../shared/personnel-permission-request.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { PersonnelCredentialsService } from './personnel-credentials.service';
import { PersonnelPermissionRequestsService } from './personnel-permission-requests.service';
import { UnifiedAccessService } from './unified-access.service';
import { clearAccessCookie, readAccessCookie } from './unified-access.guard';
import { PublicAccess } from './unified-access.decorators';
import { PersonnelArchiveService } from './personnel-archive.service';

@Controller('api/access/personal')
@PublicAccess()
export class PersonnelAccountController {
  constructor(private readonly access: UnifiedAccessService,
    private readonly configuration: AccessConfigurationService,
    private readonly credentials: PersonnelCredentialsService,
    private readonly requests: PersonnelPermissionRequestsService,
    @Optional() private readonly archiveService?: PersonnelArchiveService) {}

  @Get('archive')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie')
  archive(@Req() request: Request) {
    const principal = this.self(request, true);
    this.noArchiveSelectors(request);
    if (!this.archiveService) throw new ServiceUnavailableException('个人档案暂不可用，请稍后重试');
    return this.archiveService.read(principal);
  }

  @Get('archive/photo')
  async archivePhoto(@Req() request: Request, @Res() response: Response) {
    const principal = this.self(request, true);
    this.noArchiveSelectors(request);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Vary', 'Cookie');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!this.archiveService) throw new ServiceUnavailableException('个人照片暂不可用，请稍后重试');
    const photo = await this.archiveService.photo(principal);
    if (!photo) { response.status(404).send('暂无个人照片'); return; }
    response.setHeader('Content-Type', photo.contentType);
    response.send(photo.buffer);
  }

  private noArchiveSelectors(request: Request): void {
    if (Object.keys(request.query || {}).length) throw new BadRequestException('个人档案仅支持读取当前登录人员');
  }

  @Get('profile')
  @Header('Cache-Control', 'private, no-store')
  async profile(@Req() request: Request) {
    const principal = this.self(request);
    const credential = await this.credentials.profile(principal);
    return { displayName: principal.displayName || '当前账号', accountId: principal.accountId,
      ...credential, canChangePassword: credential.canChangePassword && !principal.impersonation,
      effectiveAuthorization: principal.effectiveAuthorization || null,
      catalog: createPermissionCatalog() };
  }

  @Post('password/change')
  @Header('Cache-Control', 'private, no-store')
  async changePassword(@Req() request: Request, @Res({ passthrough: true }) response: Response,
    @Body() body: { currentPassword: string; newPassword: string; confirmPassword: string; clientMutationId: string }) {
    this.sameOrigin(request);
    credentialBody(body, ['currentPassword', 'newPassword', 'confirmPassword', 'clientMutationId']);
    const principal = this.self(request);
    if (principal.impersonation) throw new ForbiddenException('代登录时不能修改密码');
    await this.credentials.changePassword(principal, body);
    clearAccessCookie(response, request, this.access.cookieName);
    return { success: true };
  }

  @Post('password/reset')
  @Header('Cache-Control', 'private, no-store')
  async resetPassword(@Req() request: Request, @Res({ passthrough: true }) response: Response,
    @Body() body: { employeeName: string; identityNumber: string; newPassword: string; confirmPassword: string; clientMutationId: string }) {
    this.sameOrigin(request);
    credentialBody(body, ['employeeName', 'identityNumber', 'newPassword', 'confirmPassword', 'clientMutationId']);
    const session = this.access.readSessionIdentity(readAccessCookie(request.headers.cookie, this.access, Date.now()).value);
    if (session.principal.impersonation) throw new ForbiddenException('请先退出代登录');
    await this.credentials.resetPassword(body, request.ip || request.socket?.remoteAddress || 'unknown');
    clearAccessCookie(response, request, this.access.cookieName);
    return { success: true };
  }

  @Get('permission-requests')
  @Header('Cache-Control', 'private, no-store')
  list(@Req() request: Request) { return this.requests.listOwn(this.self(request, true)); }

  @Post('permission-requests')
  @Header('Cache-Control', 'private, no-store')
  create(@Req() request: Request, @Body() body: CreatePersonnelPermissionRequest) {
    this.sameOrigin(request);
    return this.requests.create(this.self(request, true), body);
  }

  private self(request: Request, setupComplete = false): AccessPrincipal {
    const session = this.access.readSessionIdentity(readAccessCookie(request.headers.cookie, this.access, Date.now()).value);
    const principal = session.principal;
    if (!session.expiresAt || !session.principalFingerprint || !principal.accountId ||
      !this.configuration.currentPrincipal(principal.accountId, principal.authorizationVersion)) throw new UnauthorizedException('请先登录个人账号');
    if (setupComplete && principal.requiresPasswordChange) throw new ForbiddenException('请先修改初始密码');
    return principal;
  }
  private sameOrigin(request: Request): void {
    const configured = process.env.PUBLIC_BASE_URL?.trim();
    const expected = configured ? new URL(configured).origin : `${request.protocol}://${request.get('host')}`;
    if (request.headers.origin !== expected || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('请从本站页面提交');
  }
}

function credentialBody(body: unknown, allowed: string[]): void {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.getOwnPropertyNames(body).some(key => !allowed.includes(key)) ||
    allowed.some(key => typeof (body as Record<string, unknown>)[key] !== 'string') ||
    allowed.reduce((sum, key) => sum + Buffer.byteLength((body as Record<string, string>)[key]), 0) > 8192) throw new BadRequestException('密码请求格式无效');
}
