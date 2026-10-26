import { BadRequestException, ConflictException, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PersonnelSourceMutation } from '../../../shared/personnel-source.interface';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { AccessConfigurationService } from './access-configuration.service';
import { getAccessConfigurationStore, type ConfigurationState } from './access-configuration.store';
import { requireMutation } from './access-configuration.validation';
import { inspectPersonnelSource } from './personnel-source.policy';
import { PersonnelBaselineService } from './personnel-baseline.service';

@Injectable()
export class PersonnelSourceService {
  constructor(private readonly configuration: AccessConfigurationService, private readonly directory: AccessConfigurationDirectory,@Optional() private readonly baseline?:PersonnelBaselineService) {}

  async preview(actor: AccessPrincipal) {
    this.authorize(actor);
    const directory = await this.directory.read(true);
    this.authorize(actor);
    const state=getAccessConfigurationStore().read(),result=inspectPersonnelSource(directory,state,process.env.FEISHU_APP_ID?.trim()||'');
    if(!state.personnelSource&&Object.values(result.routes).some(row=>row.baselineConfirmationId)){
      if(!this.baseline)throw new ServiceUnavailableException('首次基线核对服务未配置');await this.baseline.assertCurrent(directory,state);this.authorize(actor);
    }
    return result.preview;
  }

  async change(input: PersonnelSourceMutation, actor: AccessPrincipal) {
    requireMutation(input, ['clientMutationId','expectedRevision','expectedDirectoryVersion','action']);
    if (!['activate','pause'].includes(input.action) || typeof input.expectedDirectoryVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedDirectoryVersion)) throw new BadRequestException('来源操作或核对版本无效');
    this.authorize(actor);
    const store = getAccessConfigurationStore(), before = store.read();
    const fingerprint = createHash('sha256').update(JSON.stringify(['personnel-source',process.env.FEISHU_APP_ID?.trim() || '',actor.accountId || 'legacy-admin',
      input.action,input.expectedRevision,input.expectedDirectoryVersion,input.clientMutationId])).digest('hex');
    const existing = before.mutations[input.clientMutationId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ConflictException('重复请求内容不一致，请重新核对');
      return this.configuration.snapshot();
    }
    const directory = input.action === 'activate' ? await this.directory.read(true) : undefined;
    if(directory&&!before.personnelSource&&Object.values(inspectPersonnelSource(directory,before,process.env.FEISHU_APP_ID?.trim()||'').routes).some(row=>row.baselineConfirmationId)){
      if(!this.baseline)throw new ServiceUnavailableException('首次基线核对服务未配置');await this.baseline.assertCurrent(directory,before);
    }
    this.authorize(actor);
    await store.mutate(input.expectedRevision, input.clientMutationId, fingerprint, state => {
      this.authorize(actor, state);
      const previous = state.personnelSource;
      const previousStatus = previous?.status || '未启用';
      if (input.action === 'pause') {
        if (!previous || previous.directoryVersion !== input.expectedDirectoryVersion) throw new ConflictException('来源状态已变化，请重新核对');
        previous.status = 'paused';
      } else {
        const ready = inspectPersonnelSource(directory!, state, process.env.FEISHU_APP_ID?.trim() || '');
        if (ready.preview.directoryVersion !== input.expectedDirectoryVersion || !ready.preview.canActivate || !ready.source) throw new ConflictException('岗位来源尚未对齐或已变化，请重新核对职责清单');
        const verifiedAt = Date.now();
        state.personnelSource = { status: 'active', source: structuredClone(ready.source), directoryVersion: ready.preview.directoryVersion,
          activatedAt: previous?.activatedAt ?? verifiedAt, lastSuccessAt: verifiedAt, routes: structuredClone(ready.routes), pending: [] };
      }
      state.audit.push({ id: randomUUID(), at: new Date().toISOString(), actorId: actor.accountId || 'legacy-local-admin', actorName: actor.displayName || '管理员',
        target: '统一岗位来源', action: input.action === 'pause' ? '暂停岗位来源' : '启用岗位来源', before: previousStatus, after: state.personnelSource!.status });
    });
    return this.configuration.snapshot();
  }

  private authorize(actor: AccessPrincipal, state = getAccessConfigurationStore().read()): void {
    if (actor.role !== 'admin' || (actor.accountId ? !this.configuration.validateSession(actor.accountId, actor.authorizationVersion, 'admin', actor.purchaseBuilding) : state.legacySessionsRevoked)) throw new UnauthorizedException('管理权限已变化，请重新登录');
  }
}
