import type { BusinessPermissionContext, BusinessModule, BusinessAction } from '../../../shared/business-permissions';

const MODULES: readonly [RegExp, BusinessModule][] = [
  [/^\/api\/operations-kb(?:\/|$)/, 'knowledge'],
  [/^\/api\/meeting-management(?:\/|$)/, 'meetings'],
  [/^\/api\/system-monthly-report(?:\/|$)/, 'system_reports'],
  [/^\/api\/ali-monthly-report(?:\/|$)/, 'monthly_reports'],
  [/^\/api\/risk-inspection\/monthly-alarm-overview(?:\/|$)/, 'alarms'],
  [/^\/api\/risk-inspection\/ali-monthly-quality(?:\/|$)/, 'quality'],
  [/^\/api\/risk-inspection(?:\/|$)/, 'risk'],
  [/^\/api\/equipment-ledger(?:\/|$)/, 'equipment_ledger'],
  [/^\/api\/equipment-lifecycle(?:\/|$)/, 'equipment_lifecycle'],
  [/^\/api\/threshold-management(?:\/|$)/, 'thresholds'],
  [/^\/api\/equipment-patrol(?:\/|$)/, 'patrol'],
  [/^\/api\/inventory-management\/stocktake(?:\/|$)/, 'stocktake'],
  [/^\/api\/inventory-management(?:\/|$)/, 'inventory'],
  [/^\/api\/purchase-inventory(?:\/|$)/, 'purchase'],
  [/^\/api\/operations-tools(?:\/|$)/, 'tools'],
  [/^\/api\/contract-management(?:\/|$)/, 'contracts'],
];
const FILE_DOWNLOAD_PATHS = [
  /^\/api\/ali-monthly-report\/files\/[^/]+\/?$/u,
  /^\/api\/system-monthly-report\/(?:archives|packages)\/[^/]+\/download-url\/?$/u,
];
export function businessRequestPermission(path: string, method: string, force = false): BusinessPermissionContext | undefined {
  const module = MODULES.find(([pattern]) => pattern.test(path))?.[1];
  if (!module) return undefined;
  const verb = method.toUpperCase();
  let action: BusinessAction;
  // Refresh flags must not bypass the permission required to download a file.
  if (
    (verb === 'GET' || verb === 'HEAD') &&
    (/\/(?:download|export)(?:\/|$)/u.test(path) ||
      FILE_DOWNLOAD_PATHS.some(pattern => pattern.test(path)))
  ) action = 'export';
  else if (force) action = 'refresh';
  else if (verb === 'GET' || verb === 'HEAD') action = 'read';
  else if (verb === 'DELETE' || /\/(?:delete|deletions|batch-delete|bulk-undo|abandon)(?:\/|$)/u.test(path)) action = 'delete';
  else if (/\/(?:approve|approval|reviews)(?:\/|$)/u.test(path)) action = 'approve';
  else if (/\/order(?:\/|$)/u.test(path)) action = 'order';
  else if (/\/receive(?:\/|$)/u.test(path)) action = 'receive';
  else if (/\/(?:confirm|confirm-batch|bulk-confirm|complete)(?:\/|$)/u.test(path)) action = 'confirm';
  else if (/\/(?:retry|retry-sync|refresh-line|prepare-category)(?:\/|$)/u.test(path)) action = 'update';
  else if (verb === 'POST' && /\/(?:applications|contracts|payment-plans|movements|outbounds|batch|adjustments|submissions|generate|start)(?:\/|$)/u.test(path)) action = 'create';
  else action = 'update';
  return { module, action };
}
