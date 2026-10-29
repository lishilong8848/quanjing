export const MIN_COMPARISON_IMAGE_COUNT = 3;
export const MAX_COMPARISON_ATTACHMENT_COUNT = 5;
export const COMPARISON_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function comparisonAttachmentIssue(files: readonly { type: string }[]): string | null {
  if (files.length > MAX_COMPARISON_ATTACHMENT_COUNT) return '三方比价附件最多上传 5 项';
  const images = files.filter(file => (COMPARISON_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)).length;
  return images < MIN_COMPARISON_IMAGE_COUNT ? '三方比价必须上传至少 3 张比价图片（PNG、JPEG 或 WebP），另可选 2 项附件' : null;
}
