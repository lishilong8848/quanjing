import type {
  LedgerAsset,
  LedgerQuery,
  LedgerSummary,
  LedgerPoint,
  LedgerFamilyPoint,
  LedgerSystemPoint,
} from '../../../shared/equipment-ledger.interface';
import {
  classifyLedgerAsset,
  ledgerManagement,
} from '../../../shared/equipment-ledger-classification';
import {
  extractDateValue,
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

export function shanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function normalizeLedgerBuilding(value: string): string {
  const match = value.trim().match(/^(?:南通)?([A-Z])(?:楼|机楼)?$/u);
  return match ? `${match[1]}楼` : value.trim() || '未填写';
}

function date(value: unknown): string | null {
  const raw = extractDisplayText(value);
  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/u);
  if (match) {
    const canonical = `${match[1]}-${match[2]}-${match[3]}`;
    const parsed = new Date(`${canonical}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === canonical
      ? canonical
      : null;
  }
  return extractDateValue(value);
}

export function mapLedgerRecords(
  records: readonly BitableRecordItem[],
  today = shanghaiDate(),
): LedgerAsset[] {
  const seen = new Set<string>();
  const texts = new Map<unknown, string>();
  const dates = new Map<unknown, string | null>();
  const display = (value: unknown): string => {
    const cached = texts.get(value);
    if (cached !== undefined) return cached;
    const result = extractDisplayText(value).trim();
    if (value === null || typeof value !== 'object') texts.set(value, result);
    return result;
  };
  const readDate = (value: unknown): string | null => {
    if (dates.has(value)) return dates.get(value)!;
    const result = date(value);
    if (value === null || typeof value !== 'object') dates.set(value, result);
    return result;
  };
  return records.flatMap((record) => {
    const id = getRecordId(record);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const f = record.fields || {};
    const text = (key: string) => display(f[key]);
    const sourceCode = text('设备编号');
    const warrantyUntil = readDate(f['维保截止日期']);
    const warrantySource = text('质保年限来源');
    const nature = text('条目性质');
    const reference = /参考|推定|待确认|未知/u.test(warrantySource);
    const kind =
      /集合/u.test(nature) || /全部|所有/u.test(sourceCode)
        ? 'collection'
        : 'detail';
    const rawBuilding = text('机楼') || text('楼栋标识');
    const building = normalizeLedgerBuilding(rawBuilding);
    return [
      {
        id,
        code: text('编号') || sourceCode || id,
        sourceCode,
        name: text('设备名称') || '未填写',
        building,
        category: text('大设备类型') || text('设备名称') || '未填写',
        specialty: text('系统名称') || text('专业标识') || '未填写',
        brand: text('品牌') || '未填写',
        model: text('型号') || '未填写',
        quantity: extractNumberValue(f['数量']),
        location: text('安装位置'),
        installedAt: readDate(f['安装日期']),
        warrantyUntil,
        warrantyYears: extractNumberValue(f['质保期（年）']),
        warrantySource,
        warranty:
          !warrantyUntil || reference
            ? '待确认'
            : warrantyUntil < today
              ? '过保'
              : '在保',
        kind,
        serial: text('序列号/出厂编号'),
        assetCode: text('资产编号'),
        capacity: text('容量'),
        operatingMode: text('运行方式'),
        parameters: text('产品其它参数'),
        differences: text('盘点差异'),
        collectionAudit: text('集合条目核查'),
      } satisfies LedgerAsset,
    ];
  });
}

function points(
  assets: readonly LedgerAsset[],
  key: 'category' | 'model' | 'brand' | 'warranty',
): LedgerPoint[] {
  const counts = new Map<string, number>();
  for (const asset of assets)
    counts.set(asset[key], (counts.get(asset[key]) || 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

export function summarizeLedger(
  assets: readonly LedgerAsset[],
  building = '全部楼栋',
): LedgerSummary {
  const scoped =
    building === '全部楼栋'
      ? assets
      : assets.filter((asset) => asset.building === building);
  const details = scoped.filter((asset) => asset.kind === 'detail');
  const categories = points(details, 'category');
  const models = points(details, 'model');
  const warranties = points(details, 'warranty');
  const count = (name: string) =>
    warranties.find((point) => point.name === name)?.count || 0;
  const familyMap = new Map<string, LedgerFamilyPoint>();
  const systemMap = new Map<string, { count: number; families: Set<string> }>();
  for (const asset of details) {
    const { family, system } = classifyLedgerAsset(asset);
    const point = familyMap.get(family) || {
      name: family,
      count: 0,
      inWarranty: 0,
      expired: 0,
      pending: 0,
    };
    point.count++;
    point[
      asset.warranty === '在保'
        ? 'inWarranty'
        : asset.warranty === '过保'
          ? 'expired'
          : 'pending'
    ]++;
    familyMap.set(family, point);
    const group = systemMap.get(system) || {
      count: 0,
      families: new Set<string>(),
    };
    group.count++;
    group.families.add(family);
    systemMap.set(system, group);
  }
  const families = [...familyMap.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'),
  );
  const systems: LedgerSystemPoint[] = [...systemMap]
    .map(([name, group]) => ({
      name,
      count: group.count,
      kindCount: group.families.size,
      families: families
        .filter((p) => group.families.has(p.name))
        .map((p) => p.name),
    }))
    .sort(
      (a, b) =>
        b.kindCount - a.kindCount || a.name.localeCompare(b.name, 'zh-CN'),
    );
  return {
    building,
    metrics: {
      total: details.length,
      inWarranty: count('在保'),
      expired: count('过保'),
      pending: count('待确认'),
      categories: categories.filter((point) => point.name !== '未填写').length,
      models: models.filter((point) => point.name !== '未填写').length,
      collections: scoped.length - details.length,
    },
    categories,
    models,
    brands: points(details, 'brand'),
    warranties,
    families,
    systems,
  };
}

export function queryLedger(
  assets: readonly LedgerAsset[],
  query: LedgerQuery,
) {
  const normalizeSearch = (value: string) =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .replace(/[\p{P}\p{Z}\p{S}]/gu, '');
  const terms = (query.search || '')
    .trim()
    .split(/\s+/u)
    .map(normalizeSearch)
    .filter(Boolean);
  const filtered = assets.filter(
    (asset) =>
      asset.kind === (query.kind || 'detail') &&
      (!query.id || asset.id === query.id) &&
      (!query.building || asset.building === query.building) &&
      (!query.category || asset.category === query.category) &&
      (!query.family || classifyLedgerAsset(asset).family === query.family) &&
      (!query.system || classifyLedgerAsset(asset).system === query.system) &&
      (!query.management ||
        ledgerManagement(asset.building) === query.management) &&
      (!query.brand || asset.brand === query.brand) &&
      (!query.model || asset.model === query.model) &&
      (!query.warranty || asset.warranty === query.warranty) &&
      (!terms.length ||
        terms.every((term) =>
          [
            asset.code,
            asset.sourceCode,
            asset.name,
            asset.model,
            asset.brand,
            asset.location,
            asset.serial,
            asset.assetCode,
            asset.building,
            asset.category,
            asset.specialty,
          ].some((value) => normalizeSearch(value).includes(term)),
        )),
  );
  const pageSize = Math.min(
    100,
    Math.max(1, Math.floor(Number(query.pageSize) || 20)),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(
    totalPages,
    Math.max(1, Math.floor(Number(query.page) || 1)),
  );
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
    totalPages,
  };
}
