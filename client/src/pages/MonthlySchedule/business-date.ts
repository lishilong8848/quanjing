const SHANGHAI_BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function getShanghaiBusinessDateKey(
  now: Date | number = Date.now(),
): string {
  const parts = SHANGHAI_BUSINESS_DATE_FORMATTER.formatToParts(
    typeof now === 'number' ? new Date(now) : now,
  );
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new RangeError('Unable to resolve the Asia/Shanghai business date');
  }
  return `${year}-${month}-${day}`;
}
