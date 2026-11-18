/** A narrative field preserves punctuation, repeated text and rich-text boundaries. */
export function qualitySupplementalText(value: unknown): string {
  return supplementalFragment(value).replace(/\r\n?/gu, '\n').trim();
}

function supplementalFragment(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(supplementalFragment).join('');
  if (value && typeof value === 'object') {
    const field = value as { text?: unknown; value?: unknown };
    return supplementalFragment(field.text ?? field.value);
  }
  return '';
}
