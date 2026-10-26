import type { AlarmReviewPerson } from '@shared/today-operations-alarm-review.interface';

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}
export function alarmReviewBuildingLabel(building: string): string {
  if (/^[A-EH]$/i.test(building)) return `${building.toUpperCase()}楼`;
  return building === '110' ? '110站' : building;
}
function partialName(name: string, query: string): boolean {
  let index = 0;
  for (const character of name) if (character === query[index]) index++;
  return index === query.length;
}
export function filterAlarmReviewPeople(people: AlarmReviewPerson[], query: string): AlarmReviewPerson[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map(normalize);
  if (!tokens.length) return people;
  return people.filter(person => {
    const name = normalize(person.name);
    const details = normalize(`${person.buildings.map(alarmReviewBuildingLabel).join('/')} ${person.position}`);
    return tokens.every(token => name.includes(token) || details.includes(token) || partialName(name, token));
  });
}
