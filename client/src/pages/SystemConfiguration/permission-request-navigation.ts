/** Navigation only; data and actions still require the existing administrator checks. */
export function permissionRequestLocation(search: string): { tab: 'permission-requests'; requestId?: string } | null {
  const params = new URLSearchParams(search);
  if (params.getAll('tab').length !== 1 || params.get('tab') !== 'permission-requests') return null;
  const ids = params.getAll('requestId');
  if (ids.length === 0) return { tab: 'permission-requests' };
  if (ids.length !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ids[0])) return { tab: 'permission-requests' };
  return { tab: 'permission-requests', requestId: ids[0] };
}
