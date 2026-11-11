/** Navigation only; data and actions still require the existing administrator checks. */
export function permissionRequestLocation(search: string): { tab: 'permission-requests' | 'profile-changes'; requestId?: string } | null {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  if (params.getAll('tab').length !== 1 || (tab !== 'permission-requests' && tab !== 'profile-changes')) return null;
  const ids = params.getAll('requestId');
  if (ids.length === 0) return { tab };
  if (ids.length !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ids[0])) return { tab };
  return { tab, requestId: ids[0] };
}
