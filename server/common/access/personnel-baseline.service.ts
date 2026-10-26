import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PersonnelBaselineMutation } from '../../../shared/personnel-baseline.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationDirectory, type ConfigurationDirectorySnapshot } from './access-configuration.directory';
import { getAccessConfigurationStore, type ConfigurationState } from './access-configuration.store';
import { requireMutation } from './access-configuration.validation';
import { buildPersonnelBaselinePreview } from './personnel-baseline.policy';
import { PERSONNEL_BASELINE_READER, type PersonnelBaselineReader } from './personnel-baseline.reader';
import { samePersonnelRoute } from './personnel-source.policy';

@Injectable()
export class PersonnelBaselineService {
  constructor(private readonly configuration:AccessConfigurationService,private readonly directory:AccessConfigurationDirectory,@Inject(PERSONNEL_BASELINE_READER) private readonly prior:PersonnelBaselineReader){}
  async preview(actor:AccessPrincipal){
    this.authorize(actor);const directory=await this.directory.read(true);this.authorize(actor);
    const state=getAccessConfigurationStore().read(),evidence=await this.prior.read(directory,state);this.authorize(actor);
    return buildPersonnelBaselinePreview(directory,state,evidence,process.env.FEISHU_APP_ID?.trim()||'');
  }
  async confirm(input:PersonnelBaselineMutation,actor:AccessPrincipal){
    requireMutation(input,['clientMutationId','expectedRevision','expectedFingerprint']);
    if(typeof input.expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedFingerprint))throw new BadRequestException('首次对齐清单无效，请重新核对');
    this.authorize(actor);const store=getAccessConfigurationStore(),state=store.read(),appId=process.env.FEISHU_APP_ID?.trim()||'';
    const fingerprint=createHash('sha256').update(JSON.stringify(['personnel-baseline',appId,actor.accountId||'legacy-admin',input.clientMutationId,input.expectedRevision,input.expectedFingerprint])).digest('hex');
    const existing=state.mutations[input.clientMutationId];
    if(existing){if(existing.fingerprint!==fingerprint)throw new ConflictException('重复请求内容不一致，请重新核对');return this.configuration.snapshot();}
    const directory=await this.directory.read(true);this.authorize(actor);
    const observed=store.read(),evidence=await this.prior.read(directory,observed);this.authorize(actor);
    const preview=buildPersonnelBaselinePreview(directory,observed,evidence,appId);
    if(!preview.canConfirm||preview.previewFingerprint!==input.expectedFingerprint)throw new ConflictException('目录、现行岗位或配置已变化，请重新核对首次清单');
    const id=randomUUID();
    await store.mutate(input.expectedRevision,input.clientMutationId,fingerprint,current=>{
      this.authorize(actor,current);
      if(current.personnelSource)throw new ConflictException('岗位来源已启用过，请使用岗位交接');
      if(Object.keys(current.personnelBaseline?.confirmations||{}).length>=20)throw new ConflictException('首次确认历史较多，请核对已有记录');
      current.personnelBaseline={currentId:id,confirmations:{...current.personnelBaseline?.confirmations,[id]:{id,source:structuredClone(directory.personnelAuthority!.source) as NonNullable<ConfigurationState['personnelBaseline']>['confirmations'][string]['source'],
        directoryVersion:preview.directoryVersion,oldSourceFingerprint:preview.oldSourceFingerprint,previewFingerprint:preview.previewFingerprint,confirmedAt:Date.now(),actorId:actor.accountId||'legacy-admin',actorName:actor.displayName||'管理员',rows:structuredClone(preview.assignments)}}};
      current.audit.push({id:randomUUID(),at:new Date().toISOString(),actorId:actor.accountId||'legacy-admin',actorName:actor.displayName||'管理员',target:'首次岗位基线',action:'确认现行岗位基线',before:observed.personnelBaseline?.currentId||'未确认',after:`${id}，${preview.rows.length}项；尚未启用岗位来源`});
    });
    return this.configuration.snapshot();
  }
  async assertCurrent(directory:ConfigurationDirectorySnapshot,state:ConfigurationState):Promise<void>{
    if(state.personnelSource||!state.personnelBaseline)return;
    const confirmation=state.personnelBaseline.confirmations[state.personnelBaseline.currentId];
    const evidence=await this.prior.read(directory,state),preview=buildPersonnelBaselinePreview(directory,state,evidence,directory.appId);
    if(!confirmation||!preview.canConfirm||preview.oldSourceFingerprint!==confirmation.oldSourceFingerprint||
      Object.keys(preview.assignments).length!==Object.keys(confirmation.rows).length||Object.entries(preview.assignments).some(([id,row])=>!confirmation.rows[id]||!samePersonnelRoute({...row,baselineConfirmationId:confirmation.id},{...confirmation.rows[id],baselineConfirmationId:confirmation.id})))
      throw new ConflictException('现行岗位与首次确认已变化，请重新核对首次清单');
  }
  private authorize(actor:AccessPrincipal,state=getAccessConfigurationStore().read()):void{
    if(actor.role!=='admin'||(actor.accountId?!this.configuration.validateSession(actor.accountId,actor.authorizationVersion,'admin',actor.purchaseBuilding):state.legacySessionsRevoked))throw new UnauthorizedException('管理权限已变化，请重新登录');
  }
}
