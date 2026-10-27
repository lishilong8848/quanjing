const LEGACY_NANTONG_PUBLIC_HOST = 'www.sm.sjhl.online';
const CANONICAL_NANTONG_PUBLIC_HOST = 'sm.sjhl.online';

export function canonicalizeNantongPublicUrl(value: string): string {
  const input = value.trim();
  if (!input) return '';

  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() === LEGACY_NANTONG_PUBLIC_HOST) {
      url.hostname = CANONICAL_NANTONG_PUBLIC_HOST;
    }
    return url.toString();
  } catch {
    return input;
  }
}
