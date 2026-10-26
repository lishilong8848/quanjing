export function isBuildingSelfPurchaseAllowed(building: string): boolean {
  return (
    building.normalize('NFKC').replace(/\s+/gu, '').toUpperCase() !== 'H楼'
  );
}

export function procurementMethodOptionsLabel(building: string): string {
  return isBuildingSelfPurchaseAllowed(building)
    ? '综合采购 / 楼内自采'
    : '综合采购';
}
