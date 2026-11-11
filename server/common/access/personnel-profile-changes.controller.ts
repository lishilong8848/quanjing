import { PROFILE_CHANGE_PHOTO_MAX_BYTES } from '../../../shared/personnel-profile-change.interface';
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Query,
  Header,
  UseInterceptors,
  UploadedFile,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { PublicAccess } from './unified-access.decorators';
import { UnifiedAccessService } from './unified-access.service';
import { readAccessCookie } from './unified-access.guard';
import { PersonnelProfileChangesService } from './personnel-profile-changes.service';
import type {
  ReviewProfileChange,
  CancelProfileChange,
  RecoverProfileChange,
  CreateProfileChange,
} from '../../../shared/personnel-profile-change.interface';
@Controller('api/access')
@PublicAccess()
export class PersonnelProfileChangesController {
  constructor(
    private readonly access: UnifiedAccessService,
    private readonly changes: PersonnelProfileChangesService,
  ) {}
  private principal(req: Request) {
    const session = this.access.readSessionIdentity(
      readAccessCookie(req.headers.cookie, this.access, Date.now()).value,
    );
    if (
      !session.expiresAt ||
      !session.principalFingerprint ||
      !session.principal.accountId
    )
      throw new UnauthorizedException('请先登录');
    return session.principal;
  }
  private origin(req: Request) {
    const expected = process.env.PUBLIC_BASE_URL
      ? new URL(process.env.PUBLIC_BASE_URL).origin
      : `${req.protocol}://${req.get('host')}`;
    if (
      req.headers.origin !== expected ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new ForbiddenException('请从本站提交');
  }
  @Get('personal/profile-changes')
  @Header('Cache-Control', 'private, no-store')
  list(@Req() req: Request) {
    return this.changes.list(this.principal(req));
  }
  @Post('personal/profile-changes')
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: {
        fileSize: PROFILE_CHANGE_PHOTO_MAX_BYTES,
        files: 1,
        fields: 3,
        fieldSize: 1000,
      },
    }),
  )
  create(
    @Req() req: Request,
    @Body() body: CreateProfileChange,
    @UploadedFile() photo?: { buffer: Buffer },
  ) {
    this.origin(req);
    return this.changes.create(this.principal(req), body, photo);
  }
  @Post('personal/profile-changes/cancel')
  @Header('Cache-Control', 'private, no-store')
  cancel(@Req() req: Request, @Body() body: CancelProfileChange) {
    this.origin(req);
    return this.changes.cancel(this.principal(req), body);
  }
  @Post('configuration/profile-changes/recover')
  @Header('Cache-Control', 'private, no-store')
  recover(@Req() req: Request, @Body() body: RecoverProfileChange) {
    this.origin(req);
    return this.changes.recover(this.principal(req), body);
  }
  @Get('configuration/profile-changes')
  @Header('Cache-Control', 'private, no-store')
  listAdmin(@Req() req: Request) {
    return this.changes.list(this.principal(req), true);
  }
  @Post('configuration/profile-changes/review')
  @Header('Cache-Control', 'private, no-store')
  review(@Req() req: Request, @Body() body: ReviewProfileChange) {
    this.origin(req);
    return this.changes.review(this.principal(req), body);
  }
  @Get('personal/profile-changes/photo') async photo(
    @Req() req: Request,
    @Query('id') id: string,
    @Res() res: Response,
  ) {
    return this.sendPhoto(req, id, res, false);
  }
  @Get('configuration/profile-changes/photo') async photoAdmin(
    @Req() req: Request,
    @Query('id') id: string,
    @Res() res: Response,
  ) {
    return this.sendPhoto(req, id, res, true);
  }
  private sendPhoto(req: Request, id: string, res: Response, admin: boolean) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      Object.keys(req.query).some((k) => !['id', 'variant'].includes(k)) ||
      (req.query.variant !== undefined &&
        !['before', 'after'].includes(String(req.query.variant)))
    )
      throw new BadRequestException('照片请求无效');
    const photo = this.changes.photo(
      this.principal(req),
      id,
      admin,
      req.query.variant === 'before',
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(photo.contentType).send(photo.buffer);
  }
}
