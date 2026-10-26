import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  getLeaveRequestClipboardImage,
  normalizeLeaveRequestClipboardImage,
  normalizeRequestClipboardImageWithStableName,
} from './leave-request-screenshot';

const LEAVE_REQUEST_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
const LEAVE_REQUEST_SCREENSHOT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function validateLeaveRequestScreenshot(
  file: File,
  label = '流程截图',
): string | null {
  if (!LEAVE_REQUEST_SCREENSHOT_TYPES.has(file.type)) {
    return `${label}仅支持 PNG、JPG、JPEG、WebP 图片`;
  }
  if (file.size <= 0) {
    return `${label}不能为空`;
  }
  if (file.size > LEAVE_REQUEST_SCREENSHOT_MAX_BYTES) {
    return `${label}不能超过 10MB`;
  }
  return null;
}

interface LeaveRequestScreenshotFieldProps {
  file: File | null;
  disabled: boolean;
  onChange: (file: File) => void;
  onRemove: () => void;
  onError: (message: string) => void;
  inputId?: string;
  label?: string;
  previewAlt?: string;
  active?: boolean;
  stableClipboardName?: string;
}

export function LeaveRequestScreenshotField({
  file,
  disabled,
  onChange,
  onRemove,
  onError,
  inputId = 'leave-screenshot',
  label = '流程截图',
  previewAlt = '流程截图预览',
  active = true,
  stableClipboardName,
}: LeaveRequestScreenshotFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const acceptScreenshot = useCallback(
    (selectedFile: File) => {
      const validationError = validateLeaveRequestScreenshot(
        selectedFile,
        label,
      );
      if (validationError) {
        onError(validationError);
        return;
      }
      onChange(selectedFile);
    },
    [label, onChange, onError],
  );

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => {
    if (!active || disabled) return undefined;

    const handlePaste = (event: ClipboardEvent) => {
      const selectedFile = getLeaveRequestClipboardImage(
        event.clipboardData?.items,
        event.clipboardData?.files,
      );
      if (!selectedFile) return;
      event.preventDefault();
      acceptScreenshot(
        stableClipboardName
          ? normalizeRequestClipboardImageWithStableName(
              selectedFile,
              stableClipboardName,
            )
          : normalizeLeaveRequestClipboardImage(selectedFile),
      );
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [acceptScreenshot, active, disabled, stableClipboardName]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = '';
    if (!selectedFile) return;
    acceptScreenshot(selectedFile);
  };

  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="text-xs font-semibold text-slate-500">
        {label} <span className="text-rose-600">*</span>
      </label>
      {file ? (
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={previewAlt}
              className="h-16 w-20 shrink-0 rounded-md border border-blue-100 bg-white object-cover"
            />
          ) : (
            <div className="flex h-16 w-20 shrink-0 items-center justify-center rounded-md border border-blue-100 bg-white text-blue-500">
              <ImagePlus className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-slate-800">
              {file.name}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {(file.size / 1024 / 1024).toFixed(2)} MB
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={`移除${label}`}
            onClick={() => {
              if (inputRef.current) inputRef.current.value = '';
              onRemove();
            }}
            className="h-8 w-8 shrink-0 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-blue-200 bg-blue-50/40 px-4 py-5 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50"
        >
          <ImagePlus className="h-4 w-4" />
          选择截图或 Ctrl+V 粘贴截图
        </label>
      )}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled}
        onChange={handleFileChange}
        className="sr-only"
      />
      <div className="text-xs text-slate-400">
        支持 PNG、JPG、JPEG、WebP，最大 10MB；可 Ctrl+V 粘贴截图
      </div>
    </div>
  );
}
