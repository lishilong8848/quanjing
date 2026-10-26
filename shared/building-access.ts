import { BUILDING_ADMIN_BUILDINGS, PURCHASE_ACCESS_BUILDINGS, type AccessPrincipal, type BuildingAdminBuilding } from './access-control.interface';

export function roleBuildingOptions(role: string): readonly BuildingAdminBuilding[] | null {
  if (role === 'building_admin' || role === 'professional_engineer') return BUILDING_ADMIN_BUILDINGS;
  return role === 'inventory_admin' || role === 'purchase_applicant' ? PURCHASE_ACCESS_BUILDINGS : null;
}

export function validBuildingScope(role: string, building: unknown, buildings?: unknown): boolean {
  const options = roleBuildingOptions(role);
  if (!options) return buildings === undefined && building === null;
  if (!options.includes(building as BuildingAdminBuilding)) return false;
  if (buildings === undefined) return true;
  return Array.isArray(buildings) && buildings.length > 0 && buildings.length <= options.length &&
    buildings[0] === building && new Set(buildings).size === buildings.length &&
    buildings.every(value => options.includes(value));
}

// null means an unrestricted role; an invalid restricted scope is always empty.
export function accessBuildings(principal: Pick<AccessPrincipal, 'role' | 'purchaseBuilding' | 'buildings'> & Partial<AccessPrincipal>): readonly BuildingAdminBuilding[] | null {
  if (!roleBuildingOptions(principal.role)) return null;
  if (principal.buildings === undefined && typeof principal.purchaseBuilding === 'string') {
    const match = /^([abcdeh])楼$/i.exec(principal.purchaseBuilding.trim());
    const normalized = match ? `${match[1].toUpperCase()}楼` : principal.purchaseBuilding.trim();
    return validBuildingScope(principal.role, normalized) ? [normalized as BuildingAdminBuilding] : [];
  }
  if (!validBuildingScope(principal.role, principal.purchaseBuilding, principal.buildings)) return [];
  const inherited = principal.buildings ?? [principal.purchaseBuilding as BuildingAdminBuilding];
  if (principal.role !== 'professional_engineer') return inherited;
  const allowed = principal.personalRules?.filter(rule => rule.effect === 'allow' && (!principal.permissionContext || (rule.module === principal.permissionContext.module && rule.actions.includes(principal.permissionContext.action)))) || [];
  return [...new Set([...inherited, ...allowed.flatMap(rule => rule.buildings || BUILDING_ADMIN_BUILDINGS)])];
}

export function canAccessBuilding(principal: Pick<AccessPrincipal, 'role' | 'purchaseBuilding' | 'buildings'> & Partial<AccessPrincipal>, building: unknown): boolean {
  if (typeof building !== 'string') return false;
  const match = /^([abcdeh])楼$/i.exec(building.trim());
  const normalized = match ? `${match[1].toUpperCase()}楼` : building.trim();
  if (!(BUILDING_ADMIN_BUILDINGS as readonly string[]).includes(normalized)) return false;
  const scope = accessBuildings(principal);
  return scope === null || (scope as readonly string[]).includes(normalized);
}

export function buildingScopeKey(principal: Pick<AccessPrincipal, 'role' | 'purchaseBuilding' | 'buildings'>): string {
  return accessBuildings(principal)?.join(',') ?? '';
}
