import { BadRequestException, Body, Controller, ForbiddenException, Inject, Optional, Post, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { PublicAccess } from '../../common/access/unified-access.decorators';
import { UnifiedAccessService } from '../../common/access/unified-access.service';
import { readAccessCookie } from '../../common/access/unified-access.guard';
import { readEnv } from '../../common/config/external-services.config';
import { PurchaseLifecycleAttachmentAccessRuntime } from './purchase-lifecycle-attachment-access.runtime';
import type { PurchaseLifecycleAttachmentRequest, PurchaseLifecycleAttachmentCurrentRequest } from './purchase-lifecycle-attachment-access.service';
import { PURCHASE_LIFECYCLE_READINESS } from './purchase-application.service';

type AuthenticatedRequest = Request & { accessPrincipal?: AccessPrincipal };

/** Session, current identity, same-origin and record authorization are enforced by this controller and service. */
@Controller('api/purchase-inventory/lifecycle/attachments')
@PublicAccess()
export class PurchaseLifecycleAttachmentAccessController {
  constructor(private readonly service: PurchaseLifecycleAttachmentAccessRuntime, private readonly access: UnifiedAccessService,
    @Optional() @Inject(PURCHASE_LIFECYCLE_READINESS) private readonly readiness?: { isReady(): boolean }) {}

  @Post('ticket')
  async issue(@Req() request: AuthenticatedRequest, @Body() body: PurchaseLifecycleAttachmentRequest): Promise<{ ticket: string }> {
    this.assertReady();
    this.sameOrigin(request);
    return { ticket: await this.service.issue(this.self(request), body) };
  }

  @Post('current-ticket')
  async issueCurrent(@Req() request: AuthenticatedRequest, @Body() body: PurchaseLifecycleAttachmentCurrentRequest): Promise<{ ticket: string }> {
    this.assertReady();
    this.sameOrigin(request);
    return { ticket: await this.service.issueCurrent(this.self(request), body) };
  }

  @Post('download')
  async download(@Req() request: AuthenticatedRequest, @Body() body: { ticket?: unknown }, @Res() response: Response): Promise<void> {
    this.assertReady();
    this.sameOrigin(request);
    if (!body || typeof body.ticket !== 'string' || Object.keys(body).length !== 1) throw new BadRequestException('采购附件查看凭据无效');
    const file = await this.service.read(this.self(request), body.ticket);
    const extensions: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const extension = extensions[file.contentType] || 'bin';
    response.set({ 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="purchase-attachment.${extension}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    response.send(file.data);
  }

  private assertReady(): void {
    try {
      const ready: unknown = this.readiness?.isReady();
      if (ready instanceof Promise) void ready.catch(() => undefined);
      if (ready === true) return;
    } catch { /* fail closed */ }
    throw new ServiceUnavailableException('采购附件暂不可用');
  }

  private self(request: Request): AccessPrincipal {
    const session = this.access.readSessionIdentity(readAccessCookie(request.headers.cookie, this.access, Date.now()).value);
    if (!session.expiresAt || !session.principalFingerprint || !session.principal.accountId || session.principal.requiresPasswordChange || session.principal.impersonation) throw new UnauthorizedException('请先登录个人账号');
    return session.principal;
  }

  private sameOrigin(request: Request): void {
    const base = readEnv('PUBLIC_BASE_URL', ['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']);
    let expected: string;
    try { const parsed = new URL(base); if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error(); expected = parsed.origin; }
    catch { throw new ForbiddenException('采购附件访问地址未配置'); }
    if (request.headers.origin !== expected || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('请从本站页面提交');
  }
}
