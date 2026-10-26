import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { AccessConfigurationService } from './access-configuration.service';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';

export function assertFeishuBusinessIdentity(configuration: Pick<AccessConfigurationService, 'canUseFeishuBusinessIdentity'> | undefined, openId: string): void {
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (!appId || !configuration || typeof configuration.canUseFeishuBusinessIdentity !== 'function') throw new ServiceUnavailableException('人员权限状态未就绪');
  if (!openId || !configuration.canUseFeishuBusinessIdentity(`feishu-${feishuIdentityFingerprint(appId, openId)}`, appId)) throw new ForbiddenException('当前人员不可办理');
}
