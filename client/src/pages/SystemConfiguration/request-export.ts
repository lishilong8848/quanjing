import type { PersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';
import { PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS, type PersonnelArchiveCorrection } from '@shared/personnel-archive-correction.interface';
import { BUSINESS_ACTION_LABELS, businessModuleDefinition } from '@shared/business-permissions';
import { PAGE_ACCESS_CATALOG } from '@shared/page-access';

const displayText = (value: string | undefined) => (value || '').replace(/\b(?:ou_|cli_|rec|tbl)[A-Za-z0-9_-]{8,}\b/g, '[已隐藏标识]').replace(/\b[a-f0-9]{32,}\b/gi, '[已隐藏标识]').replace(/\b\d{17}[\dXx]\b/g, '[已隐藏证件号]');
export function permissionRequestExport(rows: PersonnelPermissionRequest[]) {
  return rows.map(row => ({ applicant: displayText(row.applicantName), createdAt: row.createdAt, updatedAt: row.updatedAt,
    status: ({ pending: '待审核', approved: '已授权', rejected: '已驳回', cancelled: '已撤回' })[row.status],
    permissions: row.permissions.map(permission => permission.kind === 'page' ? PAGE_ACCESS_CATALOG.find(page => page.path === permission.path)?.label || '页面读取' : `${businessModuleDefinition(permission.module).label} · ${BUSINESS_ACTION_LABELS[permission.action]} · ${permission.buildings?.join('、') || '全部楼栋'} · ${permission.specialties?.join('、') || '全部专业'}`),
    reason: displayText(row.reason), reviewer: displayText(row.reviewerName), comment: displayText(row.comment) }));
}
export function archiveCorrectionExport(rows: PersonnelArchiveCorrection[]) {
  return rows.map(row => ({ applicant: displayText(row.applicantName), createdAt: row.createdAt, updatedAt: row.updatedAt,
    status: ({ pending: '待处理', resolved: '已处理', rejected: '已驳回', cancelled: '已撤回' })[row.status],
    fields: row.fields.map(field => PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS[field]), description: displayText(row.description), reviewer: displayText(row.reviewerName), comment: displayText(row.comment) }));
}
export function downloadDisplayRecords(name: string, records: ReturnType<typeof permissionRequestExport> | ReturnType<typeof archiveCorrectionExport>) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
