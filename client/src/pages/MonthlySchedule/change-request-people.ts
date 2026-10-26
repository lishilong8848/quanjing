import type { ChangeRequestPerson } from '@shared/change-request';

export function normalizeChangeRequestPeopleQuery(query: string): string {
  return query.replace(/\s+/g, '').toLocaleLowerCase();
}

export function searchChangeRequestPeople(
  people: readonly ChangeRequestPerson[],
  query: string,
): ChangeRequestPerson[] {
  const normalized = normalizeChangeRequestPeopleQuery(query);
  if (!normalized) return [];
  return people
    .filter((person) =>
      normalizeChangeRequestPeopleQuery(person.name).includes(normalized),
    )
    .slice(0, 20);
}
