import {
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { FileText, Loader2, RotateCcw, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ChangeRequestStagedDocument } from '@shared/change-request';
import {
  beginChangeAttachmentUpload,
  completeChangeAttachmentUpload,
  createChangeAttachmentUploadItems,
  failChangeAttachmentUpload,
  removeChangeAttachmentUploadItem,
  updateChangeAttachmentUploadProgress,
  type ChangeAttachmentFile,
  type ChangeAttachmentUploadItem,
} from './change-attachment-staging';

export type StageChangeAttachment = (
  file: File,
  ownerMutationId: string,
  onProgress: (progress: number) => void,
) => Promise<ChangeRequestStagedDocument>;

export type DeleteChangeAttachment = (
  id: string,
  ownerMutationId: string,
) => Promise<void>;

interface ChangeAttachmentFieldProps {
  id: string;
  title: string;
  help: string;
  accept: string;
  ownerMutationId: string;
  items: ChangeAttachmentUploadItem[];
  setItems: Dispatch<SetStateAction<ChangeAttachmentUploadItem[]>>;
  minCount: number;
  maxCount: number;
  maxSize: number;
  disabled?: boolean;
  required?: boolean;
  error?: string | null;
  isAllowed?: (file: ChangeAttachmentFile) => boolean;
  stageAttachment: StageChangeAttachment;
  deleteAttachment: DeleteChangeAttachment;
  onChanged?: () => void;
}

export function ChangeAttachmentField({
  id,
  title,
  help,
  accept,
  ownerMutationId,
  items,
  setItems,
  minCount,
  maxCount,
  maxSize,
  disabled = false,
  required = false,
  error,
  isAllowed,
  stageAttachment,
  deleteAttachment,
  onChanged,
}: ChangeAttachmentFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const removedWhileUploadingRef = useRef(new Set<string>());
  const uploadingLocalIdsRef = useRef(new Set<string>());
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const uploadItem = async (item: ChangeAttachmentUploadItem) => {
    if (uploadingLocalIdsRef.current.has(item.localId)) return;
    uploadingLocalIdsRef.current.add(item.localId);
    const attempt = item.attempt + 1;
    setItems(
      (current) => beginChangeAttachmentUpload(current, item.localId).items,
    );
    try {
      const staged = await stageAttachment(
        item.file as File,
        ownerMutationId,
        (progress) => {
          setItems((current) =>
            updateChangeAttachmentUploadProgress(
              current,
              item.localId,
              attempt,
              progress,
            ),
          );
        },
      );
      if (removedWhileUploadingRef.current.delete(item.localId)) {
        await deleteAttachment(staged.objectStorage.id, ownerMutationId).catch(
          () => undefined,
        );
        return;
      }
      setItems((current) =>
        completeChangeAttachmentUpload(current, item.localId, attempt, staged),
      );
    } catch (uploadError) {
      const message = getErrorMessage(uploadError, '上传失败，请重试');
      setItems((current) =>
        failChangeAttachmentUpload(current, item.localId, attempt, message),
      );
    } finally {
      uploadingLocalIdsRef.current.delete(item.localId);
      removedWhileUploadingRef.current.delete(item.localId);
    }
  };

  const handleFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (!selected.length) return;

    const result = createChangeAttachmentUploadItems(items, selected, {
      maxCount,
      maxSize,
      isAllowed,
    });
    if (result.error) {
      setSelectionError(result.error);
      return;
    }
    setSelectionError(null);
    const existingIds = new Set(items.map((item) => item.localId));
    const added = result.items.filter((item) => !existingIds.has(item.localId));
    setItems(result.items);
    onChanged?.();
    added.forEach((item) => void uploadItem(item));
  };

  const removeItem = (item: ChangeAttachmentUploadItem) => {
    if (item.status === 'uploading') {
      removedWhileUploadingRef.current.add(item.localId);
    }
    setItems((current) =>
      removeChangeAttachmentUploadItem(current, item.localId),
    );
    setSelectionError(null);
    onChanged?.();
    const storedId = item.stagedDocument?.objectStorage.id;
    if (storedId) {
      void deleteAttachment(storedId, ownerMutationId).catch(() => undefined);
    }
  };

  const selectionDisabled =
    disabled || !ownerMutationId || items.length >= maxCount;
  const visibleError =
    selectionError ||
    error ||
    (items.length < minCount ? `至少上传 ${minCount} 个附件` : '');

  return (
    <div className="rounded-lg border border-dashed bg-muted/25 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">
            {title}{' '}
            {required ? <span className="text-destructive">*</span> : null}
          </p>
          <p id={`${id}-help`} className="mt-1 text-xs text-muted-foreground">
            {help}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={selectionDisabled}
          aria-controls={id}
          onClick={() => inputRef.current?.click()}
        >
          <Upload aria-hidden="true" />
          选择附件
        </Button>
        <input
          ref={inputRef}
          id={id}
          className="sr-only"
          type="file"
          multiple
          accept={accept}
          disabled={selectionDisabled}
          aria-invalid={Boolean(visibleError)}
          aria-describedby={`${id}-help ${id}-error`}
          onChange={handleFilesSelected}
        />
      </div>

      {items.length > 0 ? (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <li
              key={item.localId}
              className="flex min-w-0 items-center gap-3 rounded-md border bg-card px-3 py-2"
            >
              {item.status === 'uploading' ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              ) : (
                <FileText className="size-4 shrink-0 text-primary" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {item.file.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatBytes(item.file.size)} · {getStatusLabel(item)}
                </span>
                {item.status === 'uploading' ? (
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary transition-[width]"
                      style={{ width: `${item.progress}%` }}
                    />
                  </span>
                ) : null}
                {item.error ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {item.error}
                  </span>
                ) : null}
              </span>
              {item.status === 'failed' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`重试上传 ${item.file.name}`}
                  onClick={() => void uploadItem(item)}
                >
                  <RotateCcw aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`移除附件 ${item.file.name}`}
                onClick={() => removeItem(item)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <p
        id={`${id}-error`}
        role={visibleError ? 'alert' : undefined}
        className="mt-2 text-xs text-destructive"
      >
        {visibleError}
      </p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function getStatusLabel(item: ChangeAttachmentUploadItem): string {
  switch (item.status) {
    case 'queued':
      return '等待上传';
    case 'uploading':
      return `上传中 ${item.progress}%`;
    case 'staged':
      return '上传完成';
    case 'deleting':
      return '删除中';
    default:
      return '上传失败';
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { data?: unknown } }).response;
    const data = response?.data;
    if (typeof data === 'object' && data !== null) {
      const message = (
        data as { message?: unknown; error?: { message?: unknown } }
      ).message;
      const nested = (data as { error?: { message?: unknown } }).error?.message;
      if (typeof message === 'string' && message.trim()) return message.trim();
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}
