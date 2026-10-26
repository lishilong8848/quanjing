export interface BitableFieldMetaLike {
  field_id: string;
  field_name: string;
}

export interface BitableRecordUpdate {
  record_id: string;
  fields: Record<string, unknown>;
}

export function chunkBitableRecordUpdates<T extends BitableRecordUpdate>(
  updates: T[],
  batchSize = 1000,
): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('批量更新大小必须在 1 到 1000 之间');
  }

  const chunks: T[][] = [];
  for (let index = 0; index < updates.length; index += batchSize) {
    chunks.push(updates.slice(index, index + batchSize));
  }
  return chunks;
}

export function shouldRetryBitableUpdateWithFieldNames(
  responseData: Record<string, unknown>,
  fields: Record<string, unknown>,
): boolean {
  const hasFieldIdKey = Object.keys(fields).some((key) =>
    /^fld[A-Za-z0-9]+$/.test(key),
  );
  if (!hasFieldIdKey) {
    return false;
  }

  const code = responseData.code;
  const message = [
    responseData.msg,
    (responseData.error as { message?: unknown } | undefined)?.message,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    code === 1254045 || /FieldNameNotFound|field_name not found/i.test(message)
  );
}

export function shouldRetryBitableWriteResponse(
  responseData: Record<string, unknown>,
): boolean {
  const message = [
    responseData.msg,
    (responseData.error as { message?: unknown } | undefined)?.message,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    responseData.code === 1254607 ||
    responseData.code === 1254608 ||
    responseData.code === 1254290 ||
    responseData.code === 1254291 ||
    /Data not ready,\s*please try again later/i.test(message)
  );
}

export function getMissingBitableFieldName(
  responseData: Record<string, unknown>,
): string | null {
  const code = responseData.code;
  const message = [
    responseData.msg,
    (responseData.error as { message?: unknown } | undefined)?.message,
  ]
    .filter(Boolean)
    .join(' ');
  if (
    code !== 1254045 &&
    !/FieldNameNotFound|field_name not found/i.test(message)
  ) {
    return null;
  }

  const match =
    /fields\.([^'":]+?)(?:['"]|:\s*Correct|\. Correct|\s+Correct|$)/i.exec(
      message,
    );
  return match?.[1]?.trim().replace(/[.。:：]+$/, '') || null;
}

export function dropMissingOptionalBitableField(
  fields: Record<string, unknown>,
  missingFieldName: string | null,
  optionalFieldNames: readonly string[] = [],
): Record<string, unknown> | null {
  if (
    !missingFieldName ||
    !optionalFieldNames.includes(missingFieldName) ||
    !(missingFieldName in fields)
  ) {
    return null;
  }

  const nextFields = { ...fields };
  delete nextFields[missingFieldName];
  return nextFields;
}

export function toBitableFieldNamePayload(
  fields: Record<string, unknown>,
  fieldMetas: BitableFieldMetaLike[],
): Record<string, unknown> {
  const fieldNamesById = new Map(
    fieldMetas
      .filter((field) => field.field_id && field.field_name)
      .map((field) => [field.field_id, field.field_name]),
  );

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      fieldNamesById.get(key) || key,
      value,
    ]),
  );
}

export function isSameFieldPayload(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in right)
  );
}

export function getBitableApiErrorMessage(
  responseData: Record<string, unknown>,
): string {
  const code = responseData.code;
  const msg = responseData.msg;
  const detail = (responseData.error as { message?: unknown } | undefined)
    ?.message;
  return [msg, code, detail].filter(Boolean).join(': ') || '未知错误';
}

export function getBitableAxiosErrorMessage(error: unknown): string {
  const response = (
    error as {
      response?: {
        status?: number;
        data?: unknown;
      };
    }
  )?.response;
  const data = response?.data;

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return getBitableApiErrorMessage(data as Record<string, unknown>);
  }
  if (typeof data === 'string' && data.trim()) {
    return data.trim();
  }
  if (response?.status) {
    return `HTTP ${response.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}
