// Reclassify the captured read-only location evidence without another network read.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node' } });
const { stocktakeWarehouse } = require('../../client/src/pages/InventoryManagement/inventory-stocktake.logic.ts');
const input = path.join(root, 'output/inventory-stocktake-review-check/warehouse-source.json');
const bytes = fs.readFileSync(input);
const source = JSON.parse(bytes);
const groups = new Map();
for (const entry of source.warehouses) {
  const name = stocktakeWarehouse(entry.name);
  if (entry.locations.some(location => stocktakeWarehouse(location) !== name)) throw new Error('Captured group has conflicting warehouse names');
  const key = `${entry.building}:${name}`;
  const current = groups.get(key) || { building: entry.building, name, count: 0 };
  current.count += entry.count; groups.set(key, current);
}
const result = { checkedAt: new Date().toISOString(), status: 'passed', externalWrites: 0, externalReadsThisStep: 0, inventory: source.inventory,
  capturedGroups: source.warehouses.length, groups: [...groups.values()], capturedEvidenceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  inputs: require('../fixtures/inventory-stocktake-evidence.cjs').fingerprintSources(['test/visual/inventory-stocktake-warehouse-check.cjs', 'client/src/pages/InventoryManagement/inventory-stocktake.logic.ts']) };
if (result.groups.reduce((sum, group) => sum + group.count, 0) !== source.inventory) throw new Error('Inventory count mismatch');
fs.writeFileSync(path.join(root, 'output/inventory-stocktake-review-check/warehouse-groups-final.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ inventory: result.inventory, capturedGroups: result.capturedGroups, finalGroups: result.groups.length, externalWrites: 0 }));
