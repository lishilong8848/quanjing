import { ForbiddenException } from '@nestjs/common';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction, type BusinessPermissionContext } from '../../../shared/business-permissions';
import { PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';

/** A global job must not turn one building's allowance into a site-wide operation. */
export function assertGlobalBusinessOperation(principal: AccessPrincipal | undefined, context: BusinessPermissionContext): void {
  if (!principal || !BUILDING_ADMIN_BUILDINGS.every(building => PROFESSIONAL_SPECIALTIES.every(specialty =>
    canPerformBusinessAction(principal, { ...context, building, specialty })))) {
    throw new ForbiddenException('该操作覆盖全基地，需要完整楼栋和专业范围的对应操作权限');
  }
}
