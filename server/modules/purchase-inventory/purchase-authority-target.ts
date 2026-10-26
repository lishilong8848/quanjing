import { ServiceUnavailableException } from '@nestjs/common';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { normalizeProfessionalScope, PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from '../../../shared/professional-access';
import type { BuildingAdminBuilding } from '../../../shared/access-control.interface';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';

export interface PurchaseAuthorityTarget { building: BuildingAdminBuilding; specialty?: ProfessionalSpecialty; }
export function purchaseAuthorityTarget(record: Pick<PurchaseWorkflowRecord,'building'|'specialty'>):PurchaseAuthorityTarget|undefined{
  const buildings=normalizedBusinessBuildings(record.building),specialties=normalizeProfessionalScope(record.specialty);
  return buildings.length===1?{building:buildings[0],...(specialties.length===1?{specialty:specialties[0]}:{})}:undefined;
}
export function normalizePurchaseAuthorityTarget(value:unknown):PurchaseAuthorityTarget|undefined{
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ServiceUnavailableException('采购原记录鉴权范围无效');
  const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(','),buildings=normalizedBusinessBuildings(row.building);
  if(!['building','building,specialty'].includes(keys)||buildings.length!==1||row.building!==buildings[0]||row.specialty!==undefined&&!(PROFESSIONAL_SPECIALTIES as readonly unknown[]).includes(row.specialty))throw new ServiceUnavailableException('采购原记录鉴权范围无效');
  return{building:buildings[0],...(row.specialty===undefined?{}:{specialty:row.specialty as ProfessionalSpecialty})};
}
