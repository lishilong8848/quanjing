export interface ClipboardFileItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile: () => File | null;
}

function isImageFile(file: File | null): file is File {
  return Boolean(file?.type.startsWith('image/'));
}

const SCREENSHOT_EXTENSIONS_BY_MIME: Readonly<
  Record<string, readonly string[]>
> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
};

const SCREENSHOT_CANONICAL_EXTENSION_BY_MIME: Readonly<Record<string, string>> =
  {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  };

function hasBackendSafeScreenshotName(
  fileName: string,
  acceptedExtensions: readonly string[],
): boolean {
  const extension = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] ?? '';
  return (
    fileName.length > 0 &&
    fileName.length <= 180 &&
    !/[\u0000-\u001f\u007f/\\]/.test(fileName) &&
    acceptedExtensions.includes(extension)
  );
}

function recreateClipboardImageWithName(
  file: File,
  fileName: string,
  lastModified: number,
): File {
  return new File([file], fileName, {
    type: file.type,
    lastModified,
  });
}

export function getLeaveRequestClipboardImage(
  items: ArrayLike<ClipboardFileItemLike> | null | undefined,
  files?: ArrayLike<File> | null,
): File | null {
  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items?.[index];
    if (!item || item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (isImageFile(file)) return file;
  }

  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    const file = files?.[index] ?? null;
    if (isImageFile(file)) return file;
  }

  return null;
}

export function normalizeLeaveRequestClipboardImage(
  file: File,
  timestamp = Date.now(),
): File {
  const acceptedExtensions = SCREENSHOT_EXTENSIONS_BY_MIME[file.type];
  const canonicalExtension = SCREENSHOT_CANONICAL_EXTENSION_BY_MIME[file.type];
  if (!acceptedExtensions || !canonicalExtension) return file;

  const fileName = file.name.trim();
  if (hasBackendSafeScreenshotName(fileName, acceptedExtensions)) return file;

  return recreateClipboardImageWithName(
    file,
    `leave-screenshot-${Math.max(0, Math.trunc(timestamp))}${canonicalExtension}`,
    file.lastModified || timestamp,
  );
}

export function normalizeRequestClipboardImageWithStableName(
  file: File,
  stableBaseName: string,
): File {
  const canonicalExtension = SCREENSHOT_CANONICAL_EXTENSION_BY_MIME[file.type];
  if (!canonicalExtension) return file;

  const normalizedBaseName = stableBaseName.trim();
  const safeBaseName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(
    normalizedBaseName,
  )
    ? normalizedBaseName
    : 'request-evidence';
  const stableFileName = `${safeBaseName}${canonicalExtension}`;
  if (file.name.trim() === stableFileName) return file;
  return recreateClipboardImageWithName(
    file,
    stableFileName,
    file.lastModified || 0,
  );
}
