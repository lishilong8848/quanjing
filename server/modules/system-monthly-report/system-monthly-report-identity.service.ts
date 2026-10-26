import { BadRequestException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { matchesSelfServicePersonnelIdentity, resolveSelfServicePersonnelRecord } from '../../common/access/self-service-applicant';
import { extractDisplayText, pickField } from '../../common/feishu/bitable-direct-read';
import { SystemMonthlyReportGateway } from './system-monthly-report.gateway';
import { createHash } from 'node:crypto';
import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportIdentityOption,
  SystemMonthlyReportPerson,
} from '../../../shared/system-monthly-report.interface';
import type { SystemMonthlyReportAccessSubject } from './system-monthly-report-access';
import { SystemMonthlyReportIdentityStore } from './system-monthly-report-identity.store';

export const SYSTEM_MONTHLY_REPORT_IDENTITY_STORE = Symbol(
  'SYSTEM_MONTHLY_REPORT_IDENTITY_STORE',
);

interface InternalIdentity extends SystemMonthlyReportIdentityOption {
  openId: string;
}

@Injectable()
export class SystemMonthlyReportIdentityService {
  constructor(
    @Inject(SYSTEM_MONTHLY_REPORT_IDENTITY_STORE)
    private readonly store: SystemMonthlyReportIdentityStore,
    @Optional() private readonly gateway?: SystemMonthlyReportGateway,
  ) {}

  async resolvePrincipal(
    principal: AccessPrincipal,
    dashboard: SystemMonthlyReportDashboard,
    previousToken = '',
  ): Promise<Extract<SystemMonthlyReportAccessSubject, { kind: 'person' }>> {
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    let openId = '';
    if (principal.accountId?.startsWith('local-external-')) {
      if (!this.gateway) throw new BadRequestException('登录人员匹配服务暂不可用，请重试');
      const source = await this.gateway.loadLoginPersonnel();
      const record = (() => {
        try { return resolveSelfServicePersonnelRecord(principal, source, source.records); }
        catch (error) {
          if (error instanceof ForbiddenException) throw new BadRequestException(error.message);
          throw error;
        }
      })();
      const field = pickField(record.fields || {}, ['员工姓名', '员工', '人员']);
      const ids = Array.isArray(field) ? field.map(user => user?.id).filter((id): id is string => typeof id === 'string' && Boolean(id)) : [];
      openId = ids.length === 1 ? ids[0] : extractDisplayText(pickField(record.fields || {}, ['飞书 open_id', 'open_id', 'Open ID']), '').trim();
      if (!openId) throw new BadRequestException('登录本人尚未关联月报人员，请联系管理员核对');
    }
    const people = this.internalDirectory(dashboard).filter(person => openId
      ? person.openId === openId
      : matchesSelfServicePersonnelIdentity(principal, { appId, appToken: '', tableId: '', recordId: '', openId: person.openId }));
    if (people.length !== 1 || people[0].name !== principal.displayName?.trim()) {
      throw new BadRequestException('登录本人未唯一匹配到月报人员，请联系管理员核对');
    }
    const person = people[0];
    const previous = previousToken ? this.resolve(previousToken, dashboard) : null;
    if (previous?.person.id === person.id) return previous;
    return { kind: 'person', person,
      principalFingerprint: `smr-person:${createHash('sha256').update(`stable\u001f${person.id}`).digest('hex').slice(0, 32)}`,
      legacyPrincipalFingerprints: [],
    };
  }

  list(dashboard: SystemMonthlyReportDashboard): {
    identities: SystemMonthlyReportIdentityOption[];
  } {
    return {
      identities: this.internalDirectory(dashboard).map(({ id, name }) => ({
        id,
        name,
      })),
    };
  }

  select(
    personId: string,
    dashboard: SystemMonthlyReportDashboard,
    now = Date.now(),
  ): {
    token: string;
    expiresAt: number;
    person: SystemMonthlyReportIdentityOption;
    principalFingerprint: string;
  } {
    const normalizedId = String(personId || '').trim();
    const person = this.internalDirectory(dashboard).find(
      (item) => item.id === normalizedId,
    );
    if (!person) {
      throw new BadRequestException('人员不存在或已移出月报范围');
    }
    const issued = this.store.issue(person.id, now);
    return {
      ...issued,
      person: { id: person.id, name: person.name },
    };
  }

  resolve(
    token: string,
    dashboard: SystemMonthlyReportDashboard,
    now = Date.now(),
  ): Extract<SystemMonthlyReportAccessSubject, { kind: 'person' }> | null {
    const session = this.store.resolve(String(token || '').trim(), now);
    if (!session) return null;
    const person = this.internalDirectory(dashboard).find(
      (item) => item.id === session.personId,
    );
    if (!person) return null;
    return {
      kind: 'person',
      principalFingerprint: session.principalFingerprint,
      legacyPrincipalFingerprints: session.legacyPrincipalFingerprints,
      person,
    };
  }

  revoke(token: string): boolean {
    return this.store.revoke(String(token || '').trim());
  }

  private internalDirectory(
    dashboard: SystemMonthlyReportDashboard,
  ): InternalIdentity[] {
    const byOpenId = new Map<string, InternalIdentity>();
    const add = (person: SystemMonthlyReportPerson | null) => {
      if (!person?.openId || !person.name || byOpenId.has(person.openId))
        return;
      byOpenId.set(person.openId, {
        id: personAlias(person.openId),
        openId: person.openId,
        name: person.name,
      });
    };
    for (const room of dashboard.rooms) {
      room.submitters.forEach(add);
      room.leaders.forEach(add);
    }
    for (const item of dashboard.schedule) add(item.reviewer);
    return Array.from(byOpenId.values()).sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'zh-CN') ||
        left.id.localeCompare(right.id),
    );
  }
}

function personAlias(openId: string): string {
  return `person_${createHash('sha256')
    .update(`system-monthly-report\u001f${openId}`)
    .digest('hex')
    .slice(0, 24)}`;
}
