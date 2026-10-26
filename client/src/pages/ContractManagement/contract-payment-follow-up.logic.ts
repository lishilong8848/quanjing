import type {
  ContractPaymentFollowUpReason,
  ContractPaymentPlanOption,
} from '@shared/contract-management.interface';

export type ContractPaymentDialogAction = 'create' | 'adjust' | 'confirm';

export function availablePaymentActions(plans: ContractPaymentPlanOption[]) {
  return {
    create: true,
    adjust: plans.length > 0,
    confirm: plans.some((plan) => plan.status !== '已付款'),
    noPaymentRequired: plans.length === 0,
  };
}

export function initialPaymentAction(
  reason: ContractPaymentFollowUpReason,
  plans: ContractPaymentPlanOption[],
): ContractPaymentDialogAction {
  if (reason === 'missing_plan' || plans.length === 0) return 'create';
  return plans.some((plan) => plan.status !== '已付款') ? 'confirm' : 'adjust';
}

export function pendingPlanAmount(plan: ContractPaymentPlanOption): number {
  return Math.max(0, plan.plannedAmount - plan.actualAmount);
}
