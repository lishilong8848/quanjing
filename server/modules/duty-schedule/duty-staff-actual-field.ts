export interface BitableFieldMeta {
  field_id: string;
  field_name: string;
  type?: number;
}

export const DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES: string[] = [
  '值班人员（实际）程序修改',
  '值班人员(实际)程序修改',
  '值班人员程序修改',
  '值班人员（实际）手动修改',
];

export const DUTY_STAFF_ACTUAL_LEGACY_FIELD_CANDIDATES: string[] = [
  'fldgeSx7S1',
  '值班人员（实际）',
  '值班人员(实际)',
  '值班人员实际',
  '值班人员',
];

export const DUTY_STAFF_ACTUAL_FIELD_CANDIDATES: string[] = [
  ...DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES,
  ...DUTY_STAFF_ACTUAL_LEGACY_FIELD_CANDIDATES,
];

const FIELD_NAME_BY_KEY: Record<string, string> = {
  fldgeSx7S1: '值班人员（实际）',
};

export function pickDutyStaffActualField(
  fields: Record<string, unknown>,
): unknown {
  for (const field of DUTY_STAFF_ACTUAL_FIELD_CANDIDATES) {
    const value = fields[field];
    if (isPresent(value)) {
      return value;
    }
  }
  return undefined;
}

export function findDutyStaffActualBitableField(
  fields: BitableFieldMeta[],
): BitableFieldMeta | undefined {
  for (const candidate of DUTY_STAFF_ACTUAL_FIELD_CANDIDATES) {
    const field = fields.find(
      (item) => item.field_id === candidate || item.field_name === candidate,
    );
    if (field) {
      return field;
    }
  }
  return undefined;
}

export function findWritableDutyProgramModifiedBitableField(
  fields: BitableFieldMeta[],
): BitableFieldMeta | undefined {
  for (const candidate of DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES) {
    const field = fields.find(
      (item) => item.field_id === candidate || item.field_name === candidate,
    );
    if (field) {
      return field;
    }
  }
  return undefined;
}

export function inferDutyStaffActualFieldMetaFromRecordFieldNames(
  fieldNames: Set<string>,
): BitableFieldMeta | undefined {
  const fieldKey = DUTY_STAFF_ACTUAL_FIELD_CANDIDATES.find((candidate) =>
    fieldNames.has(candidate),
  );
  if (!fieldKey) {
    return undefined;
  }

  return {
    field_id: fieldKey,
    field_name: FIELD_NAME_BY_KEY[fieldKey] || fieldKey,
  };
}

export function inferWritableDutyProgramModifiedFieldMetaFromRecordFieldNames(
  fieldNames: Set<string>,
): BitableFieldMeta | undefined {
  const fieldKey = DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES.find(
    (candidate) => fieldNames.has(candidate),
  );
  if (!fieldKey) {
    return undefined;
  }

  return {
    field_id: fieldKey,
    field_name: FIELD_NAME_BY_KEY[fieldKey] || fieldKey,
  };
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}
