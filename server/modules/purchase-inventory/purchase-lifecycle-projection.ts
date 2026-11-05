import type { PurchaseWorkflowStage } from '../../../shared/purchase-workflow.interface';
import { resolvePurchaseStage } from './purchase-workflow.rules';

/** Stage-specific content is prepared by the server, not supplied by a card callback. */
export interface PurchaseLifecycleStageContent {
  stage: PurchaseWorkflowStage;
  fields: ReadonlyArray<{ label: string; value: string }>;
  images?: ReadonlyArray<{ imageKey: string; alt: string }>;
  attachments?: ReadonlyArray<{ purpose: 'comparison' | 'payment' | 'receipt' | 'invoice'; index: number }>;
}

export interface PurchaseLifecycleItem {
  recordId: string;
  status: string;
  stages: ReadonlyArray<PurchaseLifecycleStageContent>;
  /** Non-sensitive overall progress, independently derived from verified source flags. */
  overallProgress?: PurchaseLifecycleOverallProgress;
}

export type PurchaseLifecycleOverallProgress = 'pending_approval' | 'pending_warehouse' | 'pending_order' | 'ordered' | 'received' | 'inbounded' | 'terminated' | 'unknown';

export type PurchaseLifecycleAction = 'approve' | 'start' | 'order' | 'receive' | 'inbound';

/**
 * The caller must derive these grants from current server-side identity, scope,
 * duties and the record. Never construct them from client-supplied role names.
 * This projection is not an authorization check for a subsequent command.
 */
export interface PurchaseLifecycleItemGrant {
  recordId: string;
  visibleStages: ReadonlyArray<PurchaseWorkflowStage>;
  allowedActions: ReadonlyArray<PurchaseLifecycleAction>;
  showOverallProgress?: boolean;
}

export type PurchaseLifecycleViewer =
  | { kind: 'participant'; grants: ReadonlyArray<PurchaseLifecycleItemGrant> }
  | { kind: 'observer' };

export interface PurchaseLifecycleProjectedItem {
  recordId: string;
  currentStage: PurchaseWorkflowStage | null;
  stages: PurchaseLifecycleStageContent[];
  actions: PurchaseLifecycleAction[];
  overallProgress?: PurchaseLifecycleOverallProgress;
}

const PROGRESS = new Set<PurchaseLifecycleOverallProgress>(['pending_approval', 'pending_warehouse', 'pending_order', 'ordered', 'received', 'inbounded', 'terminated', 'unknown']);

const ACTION_STAGE: Readonly<Record<PurchaseLifecycleAction, PurchaseWorkflowStage>> = {
  approve: 'application',
  start: 'approval',
  order: 'ordering',
  receive: 'receipt',
  inbound: 'inbound',
};

/** The inventory workflow treats this status as awaiting inbound, not completed. */
export function resolvePurchaseLifecycleStage(status: string): PurchaseWorkflowStage {
  return status === '物品签收（待入库）' ? 'inbound' : resolvePurchaseStage(status);
}

/**
 * Returns a least-privilege, detached snapshot suitable for rendering a single
 * recipient's card. Ungranted records/stages are denied; observers never act.
 */
export function projectPurchaseLifecycle(
  items: ReadonlyArray<PurchaseLifecycleItem>,
  viewer: PurchaseLifecycleViewer,
): PurchaseLifecycleProjectedItem[] {
  const grants = new Map<string, PurchaseLifecycleItemGrant>();
  if (viewer.kind === 'participant') {
    for (const grant of viewer.grants) {
      if (!grant.recordId || grants.has(grant.recordId)) {
        throw new Error('Duplicate or empty purchase lifecycle grant');
      }
      grants.set(grant.recordId, grant);
    }
  }

  const seen = new Set<string>();
  const result: PurchaseLifecycleProjectedItem[] = [];
  for (const item of items) {
    if (!item.recordId || seen.has(item.recordId)) {
      throw new Error('Duplicate or empty purchase lifecycle record');
    }
    seen.add(item.recordId);
    const grant = grants.get(item.recordId);
    if (viewer.kind !== 'observer' && !grant) continue;
    const visible = viewer.kind === 'observer' ? null : new Set(grant!.visibleStages);
    const current = resolvePurchaseLifecycleStage(item.status);
    const stageVisible = visible === null || visible.has(current);
    const stages = item.stages
      .filter((stage) => visible === null || visible.has(stage.stage))
      .map((stage) => ({
        stage: stage.stage,
        fields: stage.fields.map(({ label, value }) => ({ label, value })),
        ...(stage.images === undefined ? {} : {
          images: stage.images.map(({ imageKey, alt }) => ({ imageKey, alt })),
        }),
        ...(stage.attachments === undefined ? {} : { attachments: stage.attachments.map(({ purpose, index }) => ({ purpose, index })) }),
      }));
    if (!stageVisible && stages.length === 0) continue;

    const actions = viewer.kind === 'observer' || !stageVisible ? [] :
      [...new Set(grant!.allowedActions)].filter((action) => ACTION_STAGE[action] === current);
    const showProgress = viewer.kind === 'observer' || grant?.showOverallProgress === true;
    if (showProgress && item.overallProgress !== undefined && !PROGRESS.has(item.overallProgress)) throw new Error('Invalid purchase lifecycle progress');
    result.push({ recordId: item.recordId, currentStage: stageVisible ? current : null, stages, actions,
      ...(showProgress && item.overallProgress ? { overallProgress: item.overallProgress } : {}) });
  }
  return result;
}
