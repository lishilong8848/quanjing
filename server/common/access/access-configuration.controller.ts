import { Body, Controller, Get, Header, Post, Query, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PageRoleMutation, AccountMutation, CardRoleMutation, ConfigurationPerson } from '../../../shared/access-configuration.interface';
import { AdminOnly } from './unified-access.decorators';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { UnifiedAccessService } from './unified-access.service';
import { readAccessCookie } from './unified-access.guard';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { AccessConfigurationCardDirectory } from './access-configuration.card-directory';
import { AccessPersonnelSyncService } from './access-personnel-sync.service';
import { Optional } from '@nestjs/common';
import { PersonnelPreviewService } from './personnel-preview.service';
import type { PersonnelPreviewRequest } from '../../../shared/personnel-preview.interface';
import type { HandoverConfirmation, HandoverPreviewRequest } from '../../../shared/personnel-handover.interface';
import { PersonnelHandoverAdminService } from './personnel-handover.admin.service';
import type {PersonnelRecoveryRequest} from '../../../shared/personnel-task-recovery.interface';
import { PersonnelSourceService } from './personnel-source.service';
import type { PersonnelSourceMutation } from '../../../shared/personnel-source.interface';
import { PersonnelBaselineService } from './personnel-baseline.service';
import type { PersonnelBaselineMutation } from '../../../shared/personnel-baseline.interface';

@Controller('api/access/configuration')
@AdminOnly()
export class AccessConfigurationController {
  constructor(private readonly configuration: AccessConfigurationService, private readonly directory: AccessConfigurationDirectory, private readonly access: UnifiedAccessService, private readonly cards: AccessConfigurationCardDirectory, @Optional() private readonly personnelSync?: AccessPersonnelSyncService, @Optional() private readonly personnelPreview?: PersonnelPreviewService, @Optional() private readonly personnelHandover?: PersonnelHandoverAdminService, @Optional() private readonly personnelSource?: PersonnelSourceService, @Optional() private readonly personnelBaseline?:PersonnelBaselineService) {}
  @Post('personnel-baseline/preview')
  @Header('Cache-Control', 'private, no-store')
  baselinePreview(@Req() request:Request,@Body() body:Record<string,never>){
    this.handoverKeys(body,[]);if(!this.personnelBaseline)throw new ForbiddenException('首次岗位对齐未配置');
    return this.personnelBaseline.preview(this.actor(request,true));
  }
  @Post('personnel-baseline/confirm')
  @Header('Cache-Control', 'private, no-store')
  baselineConfirm(@Req() request:Request,@Body() body:PersonnelBaselineMutation){
    if(!this.personnelBaseline)throw new ForbiddenException('首次岗位对齐未配置');
    return this.personnelBaseline.confirm(body,this.actor(request,true));
  }
  @Post('personnel-source/preview')
  @Header('Cache-Control', 'private, no-store')
  sourcePreview(@Req() request: Request, @Body() body: Record<string, never>) {
    this.handoverKeys(body, []);
    if (!this.personnelSource) throw new ForbiddenException('岗位来源管理未配置');
    return this.personnelSource.preview(this.actor(request, true));
  }
  @Post('personnel-source')
  @Header('Cache-Control', 'private, no-store')
  sourceChange(@Req() request: Request, @Body() body: PersonnelSourceMutation) {
    if (!this.personnelSource) throw new ForbiddenException('岗位来源管理未配置');
    return this.personnelSource.change(body, this.actor(request, true));
  }
  @Post('personnel-handover/preview')
  @Header('Cache-Control','private, no-store')
  handoverPreview(@Req() request:Request,@Body() body:HandoverPreviewRequest){return this.handovers().preview(this.actor(request,true),body);}
  @Post('personnel-handover/confirm')
  @Header('Cache-Control','private, no-store')
  handoverConfirm(@Req() request:Request,@Body() body:HandoverConfirmation){return this.handovers().confirm(this.actor(request,true),body);}
  @Get('personnel-handover')
  @Header('Cache-Control','private, no-store')
  handoverList(@Req() request:Request,@Query('clientMutationId') mutation?:string){return this.handovers().list(this.actor(request),mutation);}
  @Get('personnel-handover/recovery')
  @Header('Cache-Control','private, no-store')
  recoveryTasks(@Req() request:Request){return this.handovers().listRecoveryTasks(this.actor(request));}
  @Post('personnel-handover/recovery/preview')
  @Header('Cache-Control','private, no-store')
  previewRecoveryTask(@Req() request:Request,@Body() body:PersonnelRecoveryRequest){return this.handovers().previewRecoveryTask(this.actor(request,true),body);}
  @Post('personnel-handover/recovery')
  @Header('Cache-Control','private, no-store')
  recoverTask(@Req() request:Request,@Body() body:PersonnelRecoveryRequest){return this.handovers().recoverTask(this.actor(request,true),body);}
  @Post('personnel-handover/progress')
  @Header('Cache-Control','private, no-store')
  handoverProgress(@Req() request:Request,@Body() body:{id:string}){this.handoverKeys(body,['id']);return this.handovers().read(this.actor(request,true),body.id);}
  @Post('personnel-handover/retry')
  @Header('Cache-Control','private, no-store')
  handoverRetry(@Req() request:Request,@Body() body:{id:string;version:number}){this.handoverKeys(body,['id','version']);return this.handovers().retry(this.actor(request,true),body.id,body.version);}
  @Post('personnel-handover/cancel')
  @Header('Cache-Control','private, no-store')
  handoverCancel(@Req() request:Request,@Body() body:{id:string;version:number}){this.handoverKeys(body,['id','version']);return this.handovers().cancel(this.actor(request,true),body.id,body.version);}
  private handoverKeys(body:unknown,keys:string[]){if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==keys.length || Object.keys(body).some(key=>!keys.includes(key))) throw new ForbiddenException('交接请求字段无效');}
  private handovers(){if(!this.personnelHandover)throw new ForbiddenException('岗位交接未配置');return this.personnelHandover;}
  @Post('personnel-preview')
  @Header('Cache-Control', 'private, no-store')
  async preview(@Req() request: Request, @Body() body: PersonnelPreviewRequest) {
    this.actor(request, true);
    if (!this.personnelPreview) throw new ForbiddenException('人员交接预览未配置');
    const preview = await this.personnelPreview.preview(body);
    this.actor(request, true);
    return preview;
  }
  @Post('personnel-sync')
  @Header('Cache-Control', 'private, no-store')
  async synchronize(@Req() request: Request) {
    this.actor(request, true);
    if (!this.personnelSync) throw new ForbiddenException('人员同步未配置');
    return this.personnelSync.run();
  }
  @Get('card-members')
  @Header('Cache-Control', 'private, no-store')
  async cardMembers(@Req() request: Request, @Query('code') code: CardRoleMutation['code'], @Query('building') building?: string) {
    this.actor(request);
    return this.cards.read(code, building || null);
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  read(@Req() request: Request) { this.actor(request); return this.configuration.snapshot(); }
  @Get('people')
  @Header('Cache-Control', 'private, no-store')
  async people(@Req() request: Request) {
    this.actor(request);
    const directory = await this.directory.read();
    const { externalEmployees: _credentials, ...publicDirectory } = directory;
    const configuration = this.configuration.enrichedSnapshot(directory.people);
    return { ...publicDirectory, accounts: configuration.accounts,
      ...(this.personnelPreview && directory.personnelAuthority ? { personnelOverview: this.personnelPreview.overview(directory, configuration) } : {}) };
  }
  @Post('pages')
  @Header('Cache-Control', 'private, no-store')
  pages(@Req() request: Request, @Body() body: PageRoleMutation) { return this.configuration.savePageRole(body, this.actor(request, true)); }
  @Post('accounts')
  @Header('Cache-Control', 'private, no-store')
  async account(@Req() request: Request, @Body() body: AccountMutation) {
    const actor = this.actor(request, true);
    if (typeof body?.openId === 'string' && body.external !== true) {
      const known = this.knownIdentities([body.openId]);
      await this.directory.assertKnown([body.openId], known);
      if (!body.id) {
        const person = (await this.directory.read()).people.find(person => person.openId === body.openId);
        if (person) body.name = person.name;
      }
    }
    return this.configuration.saveAccount(body, actor);
  }
  @Post('card-roles')
  @Header('Cache-Control', 'private, no-store')
  async card(@Req() request: Request, @Body() body: CardRoleMutation) {
    const actor = this.actor(request, true);
    if (Array.isArray(body?.members) && body.members.every(person => person && typeof person.openId === 'string')) {
      const ids = body.members.map(person => person.openId);
      if (!body.restoreDefault) await this.directory.assertKnown(ids, this.knownIdentities(ids));
    }
    return this.configuration.saveCardRule(body, actor);
  }
  private knownIdentities(ids: string[]): Set<string> {
    const state = this.configuration.snapshot();
    const hashes = new Set(state.accounts.filter(account => account.kind === 'feishu' && !account.deleted && account.appId === state.appId).map(account => account.identityHash));
    return new Set(ids.filter(id => hashes.has(feishuIdentityFingerprint(state.appId, id))));
  }
  private actor(request: Request, write = false): AccessPrincipal {
    const cookie = readAccessCookie(request.headers.cookie, this.access);
    const actor = this.access.readSession(cookie.value).principal;
    if (actor.role !== 'admin') throw new UnauthorizedException('需要管理员登录');
    if (write) {
      const origin = request.headers.origin;
      const publicUrl = process.env.PUBLIC_BASE_URL?.trim();
      const expected = publicUrl ? new URL(publicUrl).origin : `${request.protocol}://${request.get('host')}`;
      if (typeof origin !== 'string' || origin !== expected || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('管理配置必须由本站页面提交');
    }
    return actor;
  }
}
