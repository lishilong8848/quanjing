import type { AliMonthlyQualityIssue } from '@shared/risk-inspection.interface';

type ImageTitleIssue = Pick<
  AliMonthlyQualityIssue,
  'building' | 'item' | 'issue' | 'supplemental' | 'responsiblePersons'
>;

export function formatMonthlyQualityImageTitle(issue: ImageTitleIssue): string {
  const item = issue.item.trim() || '现场问题';
  const building = issue.building.trim();
  const rawDescription =
    issue.issue.trim() || issue.supplemental.trim() || '现场问题';
  const description =
    building && rawDescription.startsWith(building)
      ? rawDescription.slice(building.length).trim()
      : rawDescription;
  const people = Array.from(
    new Set(
      issue.responsiblePersons
        .map(({ name }) => name.trim())
        .filter((name) => name && !rawDescription.includes(name)),
    ),
  );

  return `${item}--${building}${people.join('')}${description}`;
}
