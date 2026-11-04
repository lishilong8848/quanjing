const ACTIONS = new Set([
  'approve', 'reject', 'complete', 'return', 'open_reject', 'submit_reject',
  'open_order', 'submit_order', 'open_receipt', 'submit_receipt',
  'return_purchase_list', 'return_receipt_list', 'prepare_receipt_photo', 'prepare_invoice',
  'choose_comprehensive', 'choose_building_self', 'approve_pending_comprehensive',
  'approve_pending_building_self', 'open_item_reject', 'cancel_item_reject', 'submit_item_reject',
  'acknowledged', 'resolved', 'edit', 'list', 'summary', 'submit',
]);
const FORMS = new Set([
  'leave_approve_submit', 'leave_reject_submit', 'leave_substitute_review_submit',
  'leave_substitute_review_update_submit', 'leave_substitute_update_submit',
  'purchase_batch_order_submit', 'purchase_batch_receipt_submit',
  'today_operations_resolve_submit', 'today_operations_follow_up_submit',
  'follow_up_submit', 'follow_up_edit', 'follow_up_list',
]);

/** Closed labels only: never log raw form names, values, IDs or callback capabilities. */
export function cardActionDiagnosticName(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const outer = payload as Record<string, unknown>;
  const event = outer.event && typeof outer.event === 'object' ? outer.event as Record<string, unknown> : outer;
  if (typeof event.action === 'string') return ACTIONS.has(event.action) ? event.action : 'unknown';
  if (!event.action || typeof event.action !== 'object') return 'unknown';
  const action = event.action as Record<string, unknown>;
  const name = typeof action.name === 'string' ? action.name.split(':')[0] : '';
  if (FORMS.has(name)) return name;
  const value = action.value && typeof action.value === 'object' ? action.value as Record<string, unknown> : {};
  return typeof value.action === 'string' && ACTIONS.has(value.action) ? value.action : 'unknown';
}
