import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import {
  TOOL_BUILDINGS,
  type OperationsTool,
  type OperationsToolFlow,
  type OperationsToolsSnapshot,
  type ToolBuilding,
  type ToolFlowKind,
} from '../../../shared/operations-tools.interface';
import {
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const CHECKS = ['外观完好无破损', '配件齐全', '功能正常', '清洁情况'];
export function toolBuilding(value: unknown): ToolBuilding | null {
  const normalized = extractDisplayText(value)
    .trim()
    .replace(/^南通\s*/, '');
  return (TOOL_BUILDINGS as readonly string[]).includes(normalized)
    ? (normalized as ToolBuilding)
    : null;
}
export function toolLinkIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && /^rec[a-zA-Z0-9]+$/.test(item))
      ids.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      for (const key of [
        'record_ids',
        'link_record_ids',
        'record_id',
        'id',
        'value',
      ])
        if (record[key]) visit(record[key]);
    }
  };
  visit(value);
  return [...new Set(ids)];
}
export function toolDate(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(toolDate).find(Boolean) ?? null;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return toolDate(object.value ?? object.timestamp ?? object.text);
  }
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d{13}$/.test(value))
  ) {
    const date = new Date(Number(value));
    return Number.isFinite(date.getTime())
      ? new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
      : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[T ])/u.exec(
    value.trim(),
  );
  if (!match) return null;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
}
function dueDate(date: string | null, cycle: string): string | null {
  const months: Record<string, number> = {
    每月: 1,
    月度: 1,
    每季度: 3,
    季度: 3,
    半年: 6,
    '0.5年': 6,
    一年: 12,
    '1年': 12,
    两年: 24,
    '2年': 24,
    三年: 36,
    '3年': 36,
    四年: 48,
    '4年': 48,
    五年: 60,
    '5年': 60,
  };
  if (!date || !months[cycle]) return null;
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + months[cycle], 1));
  const maxDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, maxDay));
  return result.toISOString().slice(0, 10);
}
function checks(
  fields: Record<string, unknown>,
): Record<string, boolean | null> {
  return Object.fromEntries(
    CHECKS.map((name) => [
      name,
      typeof fields[name] === 'boolean' ? fields[name] : null,
    ]),
  );
}
export function mapTool(record: BitableRecordItem): OperationsTool | null {
  const f = record.fields ?? {},
    id = getRecordId(record),
    name = extractDisplayText(f['工具名称']);
  if (!id || !name.trim()) return null;
  const maintenanceCycle = extractDisplayText(f['维护周期']),
    inspectionCycle = extractDisplayText(f['送检周期']);
  const maintenanceDate = toolDate(f['当前维护日期']),
    inspectionDate = toolDate(f['当前送检日期']);
  const maintenanceDue = dueDate(maintenanceDate, maintenanceCycle),
    inspectionDue = dueDate(inspectionDate, inspectionCycle);
  const quantity = extractNumberValue(f['区域对应工具数量']),
    unit = extractDisplayText(f['计数单位']);
  const issues: string[] = [];
  if (quantity === null) issues.push('数量未维护');
  if (quantity !== null && quantity < 0) issues.push('数量异常');
  if (!unit) issues.push('单位未维护');
  if (!maintenanceDue) issues.push('维护日期或周期未完善');
  if (!inspectionDue) issues.push('送检要求待核实');
  const scrapStatus = extractDisplayText(f['是否报废']);
  if (scrapStatus) issues.push('报废数量需核对');
  return {
    id,
    name,
    specialty: extractDisplayText(f['专业']),
    code: extractDisplayText(f['物品类别号']),
    building: toolBuilding(f['楼栋']),
    place: extractDisplayText(f['放置区域']),
    brand: extractDisplayText(f['品牌']),
    model: extractDisplayText(f['规格型号']),
    unit,
    quantity,
    borrowed: extractNumberValue(f['当前借用数']),
    category: extractDisplayText(f['二级分类']),
    conclusion: extractDisplayText(f['检查结论']),
    scrapStatus,
    maintenanceCycle,
    maintenanceDate,
    maintenanceDue,
    inspectionCycle,
    inspectionDate,
    inspectionDue,
    issues,
    checks: checks(f),
  };
}
const FLOW_FIELDS: Record<
  ToolFlowKind,
  { link: string; status: string; code: string; date: string; actual: string }
> = {
  maintenance: {
    link: '维护工具',
    status: '审批进度',
    code: '维护档案',
    date: '计划维护日期',
    actual: '实际维护日期',
  },
  inspection: {
    link: '送检工具',
    status: '审批进度',
    code: '维护档案',
    date: '计划检测日期',
    actual: '实际检测日期',
  },
  quality: {
    link: '关联底表（选择）',
    status: '进展反馈',
    code: '自增编号',
    date: '日期',
    actual: '',
  },
  repair: {
    link: '',
    status: '检修流程',
    code: '检修编号',
    date: '转检修时间',
    actual: '',
  },
  scrap: {
    link: '报废工具',
    status: '报废审批流程',
    code: '报废编码',
    date: '报废时间',
    actual: '',
  },
  borrow: {
    link: '借用工具',
    status: '审批结果',
    code: '工具借用编码',
    date: '计划归还日期',
    actual: '实际归还日期',
  },
};
export function mapFlow(
  kind: ToolFlowKind,
  record: BitableRecordItem,
): OperationsToolFlow | null {
  const id = getRecordId(record);
  if (!id) return null;
  const f = record.fields ?? {},
    cfg = FLOW_FIELDS[kind];
  const rawAttachments = f['送检报告'] ?? f['上传报废工具照片'];
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments
        .map((a) =>
          a && typeof a === 'object' ? extractDisplayText(a.name) : '',
        )
        .filter(Boolean)
    : [];
  return {
    id,
    kind,
    code: extractDisplayText(f[cfg.code]),
    toolIds: toolLinkIds(f[cfg.link]),
    name: extractDisplayText(f['检修工具名称'] ?? f['工具名称']),
    building: toolBuilding(f['楼栋'] ?? f['被借用楼栋']),
    status: extractDisplayText(f[cfg.status]) || '待完善',
    date: toolDate(f[cfg.date]),
    actualDate: toolDate(f[cfg.actual]),
    quantity: extractNumberValue(
      f[kind === 'borrow' ? '借用数量' : '报废数量'],
    ),
    reason: extractDisplayText(
      f['借用工具原因'] ??
        f['报废原因'] ??
        f['处理方式'] ??
        f['工具检测是否合格'],
    ),
    checks: checks(f),
    attachments,
  };
}
export function assertToolsPrincipal(
  principal: AccessPrincipal | undefined,
  pageRead = false,
): string | null {
  if (pageRead && principal) {
    const scope = accessBuildings(principal);
    if (scope === null) return null;
    if (!scope.length) throw new ForbiddenException('未配置管理楼栋');
    return scope[0];
  }
  if (
    !principal ||
    (!['admin', 'editor', 'inventory_admin', 'building_admin', 'professional_admin', 'professional_engineer'].includes(principal.role) && !isProfessionalBusinessPrincipal(principal))
  )
    throw new ForbiddenException('无权访问运维工具管理');
  if (principal.role === 'admin' || principal.role === 'editor' || isProfessionalBusinessPrincipal(principal)) return null;
  if (!accessBuildings(principal)?.length)
    throw new ForbiddenException('未配置管理楼栋');
  return principal.purchaseBuilding;
}
export function scopeToolsSnapshot(
  principal: AccessPrincipal,
  snapshot: OperationsToolsSnapshot,
  pageRead = false,
): OperationsToolsSnapshot {
  const building = assertToolsPrincipal(principal, pageRead);
  if (isProfessionalBusinessPrincipal(principal)) {
    const tools = filterProfessionalRecords(principal, snapshot.tools, tool => tool.specialty);
    const ids = new Set(tools.map(tool => tool.id));
    return { ...snapshot, tools, flows: snapshot.flows.filter(flow => flow.toolIds.length > 0 && flow.toolIds.every(id => ids.has(id))), scopedBuilding: null };
  }
  if (!building) return { ...snapshot, scopedBuilding: null };
  const tools = snapshot.tools.filter((t) => canAccessBuilding(principal, t.building)),
    ids = new Set(tools.map((t) => t.id));
  const flows = snapshot.flows.filter((f) => {
    if (f.building && !canAccessBuilding(principal, f.building)) return false;
    // A multi-tool record is visible only if every linked tool belongs to this account's building.
    return f.toolIds.length
      ? f.toolIds.every((id) => ids.has(id))
      : canAccessBuilding(principal, f.building);
  });
  return { ...snapshot, tools, flows, scopedBuilding: accessBuildings(principal)?.length === 1 ? building : null };
}
