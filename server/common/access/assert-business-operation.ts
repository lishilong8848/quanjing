import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction, type BusinessPermissionTarget } from '../../../shared/business-permissions';

export function assertBusinessOperation(principal:AccessPrincipal, target:BusinessPermissionTarget):void {
  if (!canPerformBusinessAction(principal,target)) throw new ForbiddenException('当前账号未获此操作权限');
}
