export function normalizeAccessDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (
    !name ||
    name.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  ) {
    return undefined;
  }
  return name;
}
