import type { AliRiskIssue } from '@shared/risk-inspection.interface';
import { filterAliMetricIssues } from './model';

export type IssueListFilters = Partial<Record<'building' | 'owner' | 'specialty' | 'status', string>>;
export type IssueListGroup = 'none' | 'building' | 'owner' | 'specialty' | 'status';
export function issueOwners(value: string): string[] {
  return value.split(/[、,，;；\n]/u).map(name => name.trim()).filter(Boolean);
}
export function filterIssueList(issues: readonly AliRiskIssue[], filters: IssueListFilters, query: string) {
  return filterAliMetricIssues(issues, query).filter(issue =>
    Object.entries(filters).every(([key, value]) => !value ||
      (key === 'owner' ? issueOwners(issue.owner).includes(value) : issue[key as keyof IssueListFilters] === value)));
}
export function groupIssueList(issues: readonly AliRiskIssue[], group: IssueListGroup) {
  if (group === 'none') return [{label: '', issues: [...issues]}];
  const groups = new Map<string, AliRiskIssue[]>();
  for (const issue of issues) {
    const label = (group === 'status' ? issue.statusLabel : issue[group]).trim() || '未填写';
    const items = groups.get(label) || [];
    items.push(issue);
    groups.set(label, items);
  }
  return [...groups].map(([label, items]) => ({label, issues: items}))
    .sort((a,b) => b.issues.length-a.issues.length || a.label.localeCompare(b.label,'zh-CN'));
}
