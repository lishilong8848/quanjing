import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';
import { mergeWeeklyFiles, weeklyImagePreview } from './weekly-files';
import './weekly-images.css';

export function WeeklyImagePicker({
  files,
  disabled,
  onChange,
  onError,
}: {
  files: File[];
  disabled: boolean;
  onChange: (files: File[]) => void;
  onError: (error: string) => void;
}) {
  const previews = useMemo(
    () =>
      files.map((file) => ({
        file,
        url: weeklyImagePreview(file) ? URL.createObjectURL(file) : '',
      })),
    [files],
  );
  useEffect(
    () => () =>
      previews.forEach(({ url }) => {
        if (url) URL.revokeObjectURL(url);
      }),
    [previews],
  );
  const add = (incoming: File[]) => {
    try {
      onChange(mergeWeeklyFiles(files, incoming));
    } catch (error) {
      onError((error as Error).message);
    }
  };
  return (
    <section className="weekly-image-picker" aria-label="会议附件">
      <div className="weekly-image-heading">
        <strong>会议附件{files.length ? ` · ${files.length}个` : ''}</strong>
        <label className="weekly-image-file-button">
          选择附件
          <input
            aria-label="选择会议附件"
            type="file"
            multiple
            disabled={disabled}
            onChange={(event) => {
              add([...(event.target.files || [])]);
              event.target.value = '';
            }}
          />
        </label>
      </div>
      <div className="weekly-image-previews">
        {previews.map(({ file, url }, index) => (
          <figure key={`${file.name}:${file.size}:${file.lastModified}`}>
            {url ? (
              <img src={url} alt={file.name} />
            ) : (
              <div className="weekly-file-icon">
                <FileText aria-hidden="true" />
              </div>
            )}
            <figcaption title={file.name}>{file.name}</figcaption>
            <small>
              {file.size < 1024 * 1024
                ? `${Math.ceil(file.size / 1024)}KB`
                : `${(file.size / 1024 / 1024).toFixed(1)}MB`}
            </small>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`移除附件${index + 1}`}
              onClick={() => onChange(files.filter((_file, i) => i !== index))}
            >
              移除
            </Button>
          </figure>
        ))}
      </div>
      <div
        className="weekly-image-paste"
        tabIndex={disabled ? -1 : 0}
        aria-label="粘贴会议截图"
      >
        复制截图后按 Ctrl+V 粘贴 · 支持图片和文件 · 单个最多10MB
      </div>
    </section>
  );
}
