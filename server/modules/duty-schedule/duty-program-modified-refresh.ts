export interface DutyProgramModifiedRefreshInput {
  recordId: string;
  plannedStaff: string[];
  leaveStaff: string[];
  substituteStaff: string[];
  vacancySubstituteStaff: string[];
  travelStaff: string[];
}

export interface DutyProgramModifiedRefreshItem {
  recordId: string;
  resetText: string;
  finalText: string;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeNameForCompare(value: string): string {
  return normalizeName(value).replace(/\s+/g, '');
}

function appendUnique(names: string[], value: string): void {
  const normalized = normalizeName(value);
  const comparable = normalizeNameForCompare(normalized);
  if (!comparable) {
    return;
  }
  if (
    names.some(
      (name) => normalizeNameForCompare(name) === comparable,
    )
  ) {
    return;
  }
  names.push(normalized);
}

function normalizeUniqueNames(values: string[]): string[] {
  const names: string[] = [];
  values.forEach((value) => appendUnique(names, value));
  return names;
}

export function buildDutyProgramModifiedRefreshItem(
  input: DutyProgramModifiedRefreshInput,
): DutyProgramModifiedRefreshItem {
  const plannedStaff = normalizeUniqueNames(input.plannedStaff);
  const resetText = plannedStaff.join(' ');
  const leaveNames = new Set(
    input.leaveStaff.map(normalizeNameForCompare).filter(Boolean),
  );
  const substituteStaff = normalizeUniqueNames(input.substituteStaff);
  const nextStaff: string[] = [];
  let substituteIndex = 0;

  plannedStaff.forEach((name) => {
    if (leaveNames.has(normalizeNameForCompare(name))) {
      const substitute = substituteStaff[substituteIndex++];
      if (substitute) {
        appendUnique(nextStaff, substitute);
      }
      return;
    }
    appendUnique(nextStaff, name);
  });

  input.vacancySubstituteStaff.forEach((name) => appendUnique(nextStaff, name));

  const travelNames = new Set(
    input.travelStaff.map(normalizeNameForCompare).filter(Boolean),
  );
  const finalStaff = nextStaff.filter(
    (name) => !travelNames.has(normalizeNameForCompare(name)),
  );

  return {
    recordId: input.recordId,
    resetText,
    finalText: finalStaff.join(' '),
  };
}
