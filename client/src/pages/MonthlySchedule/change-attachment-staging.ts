import type { ChangeRequestStagedDocument } from '@shared/change-request';

export interface ChangeAttachmentFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
}

export type ChangeAttachmentUploadStatus =
  | 'queued'
  | 'uploading'
  | 'staged'
  | 'failed'
  | 'deleting';

export interface ChangeAttachmentUploadItem {
  readonly localId: string;
  readonly file: ChangeAttachmentFile;
  readonly attempt: number;
  readonly status: ChangeAttachmentUploadStatus;
  readonly progress: number;
  readonly stagedDocument?: ChangeRequestStagedDocument;
  readonly error?: string;
}

export interface ChangeAttachmentSelectionOptions {
  readonly maxCount: number;
  readonly maxSize: number;
  readonly isAllowed?: (file: ChangeAttachmentFile) => boolean;
}

export interface ChangeAttachmentSelectionResult {
  readonly items: ChangeAttachmentUploadItem[];
  readonly error: string | null;
}

export function isChangeAttachmentFileAllowedByExtension(
  file: ChangeAttachmentFile,
  allowedMimeTypesByExtension: Readonly<Record<string, readonly string[]>>,
): boolean {
  const extension = /\.[^.]+$/.exec(file.name.trim().toLowerCase())?.[0] || '';
  const allowedMimeTypes = allowedMimeTypesByExtension[extension];
  if (!allowedMimeTypes) return false;

  const mimeType = file.type.split(';', 1)[0].trim().toLowerCase();
  return !mimeType || allowedMimeTypes.includes(mimeType);
}

export function createChangeAttachmentUploadItems(
  current: readonly ChangeAttachmentUploadItem[],
  selected: readonly ChangeAttachmentFile[],
  options: ChangeAttachmentSelectionOptions,
): ChangeAttachmentSelectionResult {
  const existingKeys = new Set(current.map((item) => getFileKey(item.file)));
  const uniqueSelected = selected.filter((file) => {
    const key = getFileKey(file);
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (current.length + uniqueSelected.length > options.maxCount) {
    return {
      items: [...current],
      error: `最多上传 ${options.maxCount} 个附件`,
    };
  }
  if (
    uniqueSelected.some(
      (file) =>
        !Number.isFinite(file.size) ||
        file.size < 0 ||
        file.size > options.maxSize,
    )
  ) {
    return {
      items: [...current],
      error: `单个附件不能超过 ${formatMiB(options.maxSize)} MiB`,
    };
  }
  if (
    options.isAllowed &&
    uniqueSelected.some((file) => !options.isAllowed!(file))
  ) {
    return { items: [...current], error: '附件格式不支持' };
  }

  return {
    error: null,
    items: [
      ...current,
      ...uniqueSelected.map((file) => ({
        localId: createLocalId(),
        file,
        attempt: 0,
        status: 'queued' as const,
        progress: 0,
      })),
    ],
  };
}

export function beginChangeAttachmentUpload(
  items: readonly ChangeAttachmentUploadItem[],
  localId: string,
): { items: ChangeAttachmentUploadItem[]; attempt: number } {
  const current = items.find((item) => item.localId === localId);
  if (!current) throw new Error('附件不存在');
  const attempt = current.attempt + 1;
  return {
    attempt,
    items: items.map((item) =>
      item.localId === localId
        ? {
            ...item,
            attempt,
            status: 'uploading',
            progress: 0,
            stagedDocument: undefined,
            error: undefined,
          }
        : item,
    ),
  };
}

export function updateChangeAttachmentUploadProgress(
  items: readonly ChangeAttachmentUploadItem[],
  localId: string,
  attempt: number,
  progress: number,
): ChangeAttachmentUploadItem[] {
  const current = items.find((item) => item.localId === localId);
  if (
    !current ||
    current.attempt !== attempt ||
    current.status !== 'uploading'
  ) {
    return items as ChangeAttachmentUploadItem[];
  }
  const boundedProgress = Math.max(0, Math.min(99, Math.round(progress)));
  if (boundedProgress === current.progress) {
    return items as ChangeAttachmentUploadItem[];
  }
  return items.map((item) =>
    item.localId === localId ? { ...item, progress: boundedProgress } : item,
  );
}

export function completeChangeAttachmentUpload(
  items: readonly ChangeAttachmentUploadItem[],
  localId: string,
  attempt: number,
  stagedDocument: ChangeRequestStagedDocument,
): ChangeAttachmentUploadItem[] {
  const current = items.find((item) => item.localId === localId);
  if (
    !current ||
    current.attempt !== attempt ||
    current.status !== 'uploading'
  ) {
    return items as ChangeAttachmentUploadItem[];
  }
  return items.map((item) =>
    item.localId === localId
      ? {
          ...item,
          status: 'staged',
          progress: 100,
          stagedDocument,
          error: undefined,
        }
      : item,
  );
}

export function failChangeAttachmentUpload(
  items: readonly ChangeAttachmentUploadItem[],
  localId: string,
  attempt: number,
  error: string,
): ChangeAttachmentUploadItem[] {
  const current = items.find((item) => item.localId === localId);
  if (
    !current ||
    current.attempt !== attempt ||
    current.status !== 'uploading'
  ) {
    return items as ChangeAttachmentUploadItem[];
  }
  return items.map((item) =>
    item.localId === localId
      ? {
          ...item,
          status: 'failed',
          progress: 0,
          stagedDocument: undefined,
          error: error.trim() || '上传失败，请重试',
        }
      : item,
  );
}

export function removeChangeAttachmentUploadItem(
  items: readonly ChangeAttachmentUploadItem[],
  localId: string,
): ChangeAttachmentUploadItem[] {
  return items.filter((item) => item.localId !== localId);
}

export function isChangeAttachmentCollectionReady(
  items: readonly ChangeAttachmentUploadItem[],
  minCount: number,
  maxCount: number,
): boolean {
  return (
    items.length >= minCount &&
    items.length <= maxCount &&
    items.every(
      (item) => item.status === 'staged' && Boolean(item.stagedDocument),
    )
  );
}

export function getReadyChangeAttachmentDocuments(
  items: readonly ChangeAttachmentUploadItem[],
): ChangeRequestStagedDocument[] {
  return items.flatMap((item) =>
    item.status === 'staged' && item.stagedDocument
      ? [item.stagedDocument]
      : [],
  );
}

export function createStagedChangeAttachmentUploadItems(
  documents: readonly ChangeRequestStagedDocument[],
): ChangeAttachmentUploadItem[] {
  return documents.map((document) => ({
    localId: document.objectStorage.id,
    file: {
      name: document.name || document.originalname || '附件',
      size: document.size,
      type: document.type || document.mimetype || '',
      lastModified: 0,
    },
    attempt: 1,
    status: 'staged',
    progress: 100,
    stagedDocument: document,
  }));
}

function getFileKey(file: ChangeAttachmentFile): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function formatMiB(bytes: number): string {
  return Number.isInteger(bytes / (1024 * 1024))
    ? String(bytes / (1024 * 1024))
    : (bytes / (1024 * 1024)).toFixed(1);
}

function createLocalId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
