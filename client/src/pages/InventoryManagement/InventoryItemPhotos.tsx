import { useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, ImageIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { InventoryItemImage } from '@shared/inventory-management.interface';
import { isInventoryLedgerPhotoPath } from './inventory-inbound-photos';

export interface InventoryItemPhotoGallery {
  name: string;
  images: InventoryItemImage[];
}

export function InventoryItemPhotoThumbnail({
  name,
  images,
  onOpen,
}: {
  name: string;
  images?: InventoryItemImage[];
  onOpen: (gallery: InventoryItemPhotoGallery) => void;
}) {
  if (!images?.length) {
    return (
      <span className="flex size-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 text-[9px] leading-none text-slate-500">
        <ImageOff className="size-3.5" aria-hidden="true" />
        无图片
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={`查看${name}的物品图片，共 ${images.length} 张`}
      className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-slate-400 outline-offset-2 hover:border-blue-400"
      onClick={() => onOpen({ name, images })}
    >
      <LedgerPhoto key={images[0].url} image={images[0]} thumbnail />
      {images.length > 1 && (
        <span aria-hidden="true" className="absolute right-0 bottom-0 rounded-tl bg-slate-900/75 px-1 text-[10px] font-medium text-white">
          +{images.length - 1}
        </span>
      )}
    </button>
  );
}

export function InventoryItemPhotoPreview({
  gallery,
  onClose,
}: {
  gallery: InventoryItemPhotoGallery;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const { name, images } = gallery;
  const current = images[index];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-blue-100 p-4 sm:max-w-2xl sm:p-6">
        <DialogHeader className="min-w-0 pr-8 text-left">
          <DialogTitle className="truncate" title={name}>{name} · 物品图片</DialogTitle>
          <DialogDescription>{images.length} 张图片</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-32 place-items-center overflow-hidden rounded-xl bg-slate-100 p-2">
          <LedgerPhoto key={current.url} image={current} />
        </div>
        <div className="flex items-center justify-between gap-2">
          {images.length > 1 && (
            <Button type="button" variant="outline" size="icon" aria-label="上一张" disabled={index === 0} onClick={() => setIndex(index - 1)}>
              <ChevronLeft aria-hidden="true" />
            </Button>
          )}
          <p className="min-w-0 flex-1 truncate text-center text-xs text-slate-600" title={current.name} aria-live="polite">
            {index + 1} / {images.length} · {current.name}
          </p>
          {images.length > 1 && (
            <Button type="button" variant="outline" size="icon" aria-label="下一张" disabled={index === images.length - 1} onClick={() => setIndex(index + 1)}>
              <ChevronRight aria-hidden="true" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LedgerPhoto({ image, thumbnail = false }: { image: InventoryItemImage; thumbnail?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed || !isInventoryLedgerPhotoPath(image.url)) {
    return thumbnail
      ? <ImageIcon className="size-4" aria-hidden="true" />
      : <p className="flex items-center gap-2 p-6 text-sm text-slate-500"><ImageOff className="size-4" aria-hidden="true" />图片暂时无法加载</p>;
  }
  return (
    <img
      src={thumbnail ? `${image.url}?variant=thumbnail` : image.url}
      alt={thumbnail ? '' : image.name}
      loading={thumbnail ? 'lazy' : undefined}
      decoding="async"
      onError={() => setFailed(true)}
      className={thumbnail ? 'h-full w-full object-cover' : 'max-h-[62dvh] max-w-full object-contain'}
    />
  );
}
