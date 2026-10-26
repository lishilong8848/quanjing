export function createCalendarDaySummaryCache<T>(
  calculate: (dateKey: string) => T,
) {
  const summaries = new Map<string, T>();
  return (dateKey: string): T => {
    if (summaries.has(dateKey)) return summaries.get(dateKey) as T;
    const summary = calculate(dateKey);
    // Two six-week views can coexist; evicted dates remain queryable.
    if (summaries.size >= 84) summaries.delete(summaries.keys().next().value!);
    summaries.set(dateKey, summary);
    return summary;
  };
}

export function reuseSameDateValue(current: Date, next: Date): Date {
  return current.getTime() === next.getTime() ? current : next;
}
