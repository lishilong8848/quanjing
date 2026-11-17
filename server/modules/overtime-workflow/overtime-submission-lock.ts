const inFlight = new Map<string, Promise<unknown>>();

/** Serialize submissions for the same roster name in this single server instance. */
export async function withOvertimeSubmissionLock<T>(names: string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(names.map(name => name.replace(/\s+/gu, '')).filter(Boolean))].sort();
  const previous = keys.map(key => inFlight.get(key));
  const pending = Promise.allSettled(previous).then(operation);
  for (const key of keys) inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    for (const key of keys) if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}
