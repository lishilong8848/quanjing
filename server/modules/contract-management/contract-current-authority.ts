import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import type { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { businessRecordBuilding, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';

export function assertCurrentContractMutation(
  configuration: AccessConfigurationService,
  principal: AccessPrincipal | undefined,
  action: 'create' | 'update' | 'confirm',
  ...records: BitableRecordItem[]
): void {
  const current = configuration.currentPrincipal(principal?.accountId, principal?.authorizationVersion);
  if (!current || current.role !== principal?.role || !records.length || records.some(record => !canPerformBusinessAction(current, {
    module: 'contracts', action,
    building: businessRecordBuilding(record), specialty: recordProfessionalSpecialty(record),
  }))) throw new ForbiddenException('当前合同操作权限已变化，请重新核对登录和授权');
}
