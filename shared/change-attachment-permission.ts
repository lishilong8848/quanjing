import type { BusinessPermissionContext } from './business-permissions';

/** The client mutation identifies the form, never a permission or a person. */
export function changeAttachmentMutationPermission(
  ownerMutationId: string,
): BusinessPermissionContext | undefined {
  const match =
    /^(change-request|change-adjustment|change-drill-report|change-summary-report)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(
      ownerMutationId,
    );
  if (!match) return undefined;
  if (match[1].toLowerCase() === 'change-request')
    return { module: 'change_requests', action: 'create' };
  return {
    module: 'change_management',
    action:
      match[1].toLowerCase() === 'change-adjustment' ? 'update' : 'create',
  };
}
