// shortcut: 4 KiB per link keeps three links in the card, use a platform link entry point if longer URLs are needed.
const PURCHASE_CARD_LINK_MAX_BYTES = 4096;

export function normalizePurchaseCardLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!/^https:\/\//iu.test(input) || Buffer.byteLength(input, 'utf8') > PURCHASE_CARD_LINK_MAX_BYTES) {
    return null;
  }
  try {
    const url = new URL(input);
    const normalized = url.toString();
    return url.protocol === 'https:' &&
      Buffer.byteLength(JSON.stringify(normalized), 'utf8') <= PURCHASE_CARD_LINK_MAX_BYTES + 2
      ? normalized
      : null;
  } catch {
    return null;
  }
}
