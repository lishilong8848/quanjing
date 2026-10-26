const TELEPHONE_ALLOWED_PATTERN = /^\+?[\d\s()-]+$/;

export function buildTelephoneHref(
  value: string | null | undefined,
): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || !TELEPHONE_ALLOWED_PATTERN.test(raw)) {
    return null;
  }

  const hasInternationalPrefix = raw.startsWith('+');
  if (raw.slice(hasInternationalPrefix ? 1 : 0).includes('+')) {
    return null;
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 20) {
    return null;
  }

  return `tel:${hasInternationalPrefix ? '+' : ''}${digits}`;
}
