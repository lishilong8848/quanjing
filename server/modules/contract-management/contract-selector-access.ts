import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction, type BusinessAction } from '../../../shared/business-permissions';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { businessRecordBuilding, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';

export const CONTRACT_EDIT_SELECTOR_ACTIONS = ['read','update'] as const;
export const CONTRACT_PAYMENT_SELECTOR_ACTIONS = ['read','create','update','confirm'] as const;
export function assertContractSelectorAccess(principal:AccessPrincipal|undefined,record:BitableRecordItem|undefined,actions:readonly BusinessAction[]):void {
  if(!principal) return;
  if(!record?.record_id) throw new ForbiddenException('无法确认当前合同的授权范围');
  const building=businessRecordBuilding(record),specialty=recordProfessionalSpecialty(record);
  if(!actions.some(action=>canPerformBusinessAction(principal,{module:'contracts',action,building,specialty})))
    throw new ForbiddenException('当前合同不在所选操作的授权范围内');
}
