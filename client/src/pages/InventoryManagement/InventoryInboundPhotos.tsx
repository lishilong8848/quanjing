import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Camera, ImageOff, ImagePlus, Loader2, X } from 'lucide-react';

import { uploadInventoryInboundPhotos } from '@/api';
import { Button } from '@/components/ui/button';
import {
  INVENTORY_INBOUND_PHOTO_MAX_BYTES,
  INVENTORY_INBOUND_PHOTO_MAX_COUNT,
  type InventoryInboundStagedPhoto,
  type WarehouseBuilding,
} from '@shared/inventory-management.interface';
import {
  isInventoryInboundPhotoForRequest,
  isInventoryInboundStagedPhotos,
} from './inventory-inbound-photos';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const PHOTO_ACCEPT = PHOTO_TYPES.join(',');

interface SelectedPhoto {
  key: number;
  file: File;
}

export function useInventoryInboundPhotos() {
  const [files, setFiles] = useState<SelectedPhoto[]>([]);
  const [staged, setStaged] = useState<InventoryInboundStagedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const reset = useCallback((photos?: InventoryInboundStagedPhoto[]) => {
    requestRef.current?.abort();
    requestRef.current = null;
    setFiles([]);
    setStaged(photos ?? []);
    setUploading(false);
  }, []);
  useEffect(() => () => requestRef.current?.abort(), []);

  async function prepare(building: WarehouseBuilding, clientMutationId: string) {
    if (requestRef.current) throw new Error('照片正在上传，请稍候');
    const reusable = staged.filter((photo) =>
      isInventoryInboundPhotoForRequest(photo, building, clientMutationId),
    );
    const needRestage = staged.filter((photo) => !reusable.includes(photo));
    if (files.length === 0 && needRestage.length === 0) return reusable;

    const controller = new AbortController();
    requestRef.current = controller;
    setUploading(true);
    try {
      const restored = await Promise.all(needRestage.map(async (photo) => {
        const response = await fetch(photo.url, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('上次上传的照片已不可用，请移除后重新选择');
        const blob = await response.blob();
        return new File([blob], photo.name, { type: blob.type });
      }));
      const response = await uploadInventoryInboundPhotos(
        building, clientMutationId, [...restored, ...files.map(({ file }) => file)], controller.signal,
      );
      const photos = [...reusable, ...(response?.photos ?? [])];
      if (
        !isInventoryInboundStagedPhotos(photos) ||
        photos.length !== staged.length + files.length ||
        !photos.every((photo) => isInventoryInboundPhotoForRequest(photo, building, clientMutationId))
      ) {
        throw new Error('照片上传结果不完整或有重复，请核对照片后重试');
      }
      if (controller.signal.aborted) throw new Error('照片上传已取消');
      setStaged(photos);
      setFiles([]);
      return photos;
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setUploading(false);
      }
    }
  }

  return { files, setFiles, staged, setStaged, uploading, prepare, reset };
}

export function InventoryInboundPhotos({
  photos,
  disabled = false,
}: {
  photos: ReturnType<typeof useInventoryInboundPhotos>;
  disabled?: boolean;
}) {
  const { files, setFiles, staged, setStaged, uploading } = photos;
  const album = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const [error, setError] = useState('');
  const count = files.length + staged.length;
  const atLimit = count >= INVENTORY_INBOUND_PHOTO_MAX_COUNT;
  const locked = disabled || uploading;
  const sizeMiB = INVENTORY_INBOUND_PHOTO_MAX_BYTES / (1024 * 1024);

  function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!chosen.length || locked) return;
    const accepted = chosen.filter((file) =>
      PHOTO_TYPES.includes(file.type) &&
      file.size > 0 && file.size <= INVENTORY_INBOUND_PHOTO_MAX_BYTES,
    );
    const available = INVENTORY_INBOUND_PHOTO_MAX_COUNT - count;
    const messages: string[] = [];
    if (accepted.length !== chosen.length) {
      messages.push(`仅支持 JPEG、PNG、WebP 和 GIF，每张不超过 ${sizeMiB} MB。HEIC 照片请转换成 JPEG 后上传。`);
    }
    if (accepted.length > available) {
      messages.push(`最多可添加 ${INVENTORY_INBOUND_PHOTO_MAX_COUNT} 张照片。`);
    }
    setError(messages.join(' '));
    const selected = accepted.slice(0, available).map((file) => ({ file, key: ++sequence.current }));
    setFiles((current) => [...current, ...selected].slice(0, INVENTORY_INBOUND_PHOTO_MAX_COUNT - staged.length));
  }

  return (
    <section className="rounded-xl border border-blue-100 bg-white p-4" aria-label="物品照片">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">物品照片</h3>
        <span className="text-xs text-slate-500">{count}/{INVENTORY_INBOUND_PHOTO_MAX_COUNT} 张</span>
      </div>
      {!disabled && (
        <>
          <p className="mt-1 text-xs leading-5 text-slate-500">可选，每张不超过 {sizeMiB} MB。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={locked || atLimit} onClick={() => album.current?.click()}>
              <ImagePlus aria-hidden="true" />从相册选择
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={locked || atLimit} onClick={() => camera.current?.click()}>
              <Camera aria-hidden="true" />拍照
            </Button>
            <input ref={album} type="file" accept={PHOTO_ACCEPT} multiple hidden disabled={locked || atLimit} onChange={addPhotos} />
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden disabled={locked || atLimit} onChange={addPhotos} />
          </div>
        </>
      )}
      {count > 0 && (
        <ul className="mt-3 flex flex-wrap gap-3">
          {staged.map((photo) => (
            <InboundPhoto key={photo.id} name={photo.name} url={photo.url} disabled={locked} onRemove={() => {
              setStaged((current) => current.filter((entry) => entry.id !== photo.id));
              setError('');
            }} />
          ))}
          {files.map(({ file, key }) => (
            <InboundPhoto key={key} name={file.name} file={file} disabled={locked} onRemove={() => {
              setFiles((current) => current.filter((photo) => photo.key !== key));
              setError('');
            }} />
          ))}
        </ul>
      )}
      {uploading && (
        <p role="status" className="mt-3 flex items-center gap-2 text-xs text-blue-700">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />正在上传照片…
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
    </section>
  );
}

function InboundPhoto({
  name,
  url,
  file,
  disabled,
  onRemove,
}: {
  name: string;
  url?: string;
  file?: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <li className="relative w-[76px]">
      <div className="flex size-[76px] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
        {failed ? (
          <ImageOff className="size-5 text-slate-400" role="img" aria-label={`无法预览 ${name}`} />
        ) : (
          (url || preview) && <img src={url || preview} alt={name} onError={() => setFailed(true)} className="h-full w-full object-cover text-xs" />
        )}
      </div>
      <p title={name} className="mt-1 truncate text-xs text-slate-500">{name}</p>
      {!disabled && (
        <button type="button" onClick={onRemove} aria-label={`移除照片 ${name}`} className="absolute -top-2 -right-2 grid size-7 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm hover:text-rose-700">
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}
