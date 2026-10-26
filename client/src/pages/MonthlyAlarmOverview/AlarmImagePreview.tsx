import { useEffect, useRef, useState } from 'react';
import { ImageOff, Maximize2, Minus, Plus, Scan, X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  alarmImageBaseScale,
  alarmImageStripCount,
  alarmImageWheelZoom,
  clampAlarmImageZoom,
  isWideAlarmImage,
} from './image-presentation';

interface PreviewImage {
  url: string;
  title: string;
}

export function AlarmImageThumbnail({
  image,
  onOpen,
}: {
  image: { name: string; url: string };
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const wide = isWideAlarmImage(size.width, size.height);
  const scale = wide ? Math.min(3, Math.max(1, 36 / size.height)) : 1;

  return (
    <button
      type="button"
      className={`mao-issue-image${wide ? ' is-wide' : ''}`}
      onClick={(event) => onOpen(event.currentTarget)}
      aria-label={`查看截图：${image.name}`}
    >
      <img
        src={image.url}
        alt={image.name}
        loading="lazy"
        style={
          wide
            ? { width: size.width * scale, height: size.height * scale }
            : undefined
        }
        onLoad={(event) =>
          setSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
        onError={(event) => {
          event.currentTarget.hidden = true;
          event.currentTarget.nextElementSibling?.removeAttribute('hidden');
        }}
      />
      <span className="mao-image-fallback" hidden>
        <ImageOff aria-hidden="true" />
        截图加载失败
      </span>
      <span className="mao-image-zoom">
        <Maximize2 aria-hidden="true" />
        查看大图
      </span>
    </button>
  );
}

export function AlarmImageDialog({
  preview,
  onClose,
  onRestoreFocus,
}: {
  preview: PreviewImage;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const wheelDeltaRef = useRef(0);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!stage) return;
    const update = () =>
      setViewport({
        width: Math.max(1, stage.clientWidth - 32),
        height: Math.max(1, stage.clientHeight - 32),
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);

  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || event.deltaY === 0) return;
      if (
        (event.deltaY > 0 && zoom <= 0.5) ||
        (event.deltaY < 0 && zoom >= 4)
      ) {
        wheelDeltaRef.current = 0;
        return;
      }
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? stage.clientHeight
            : 1;
      wheelDeltaRef.current += Math.max(
        -240,
        Math.min(240, event.deltaY * unit),
      );
      const steps = Math.floor(Math.abs(wheelDeltaRef.current) / 60);
      if (!steps) return;
      const consumedDelta = Math.sign(wheelDeltaRef.current) * steps * 60;
      wheelDeltaRef.current -= consumedDelta;
      setZoom((value) => alarmImageWheelZoom(value, consumedDelta));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [stage, zoom]);

  const wide = isWideAlarmImage(size.width, size.height);
  const baseScale = alarmImageBaseScale(
    size.width,
    size.height,
    viewport.width,
    viewport.height,
  );
  const scale = baseScale * zoom;
  const renderedWidth = Math.round(size.width * scale);
  const renderedHeight = Math.round(size.height * scale);
  const strips = wide
    ? alarmImageStripCount(size.width, scale, viewport.width)
    : 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="mao-image-dialog"
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <header className="mao-image-dialog-header">
          <DialogTitle>{preview.title}</DialogTitle>
          <DialogClose className="mao-dialog-close" aria-label="关闭截图">
            <X aria-hidden="true" />
          </DialogClose>
        </header>
        <div className="mao-image-toolbar" role="group" aria-label="截图缩放">
          <button
            type="button"
            onClick={() =>
              setZoom((value) => clampAlarmImageZoom(value - 0.25))
            }
            disabled={zoom <= 0.5}
            aria-label="缩小截图"
          >
            <Minus aria-hidden="true" />
          </button>
          <strong>{Math.round(scale * 100)}%</strong>
          <button
            type="button"
            onClick={() =>
              setZoom((value) => clampAlarmImageZoom(value + 0.25))
            }
            disabled={zoom >= 4}
            aria-label="放大截图"
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mao-image-fit"
            onClick={() => setZoom(1)}
          >
            <Scan aria-hidden="true" />
            适应
          </button>
        </div>
        <div
          className={`mao-image-dialog-stage${wide ? ' is-wide' : ''}`}
          ref={setStage}
          role="region"
          aria-label="截图查看区，滚轮缩放"
          tabIndex={0}
        >
          {!failed &&
            size.width > 0 &&
            (wide ? (
              <div className="mao-image-strips">
                {Array.from({ length: strips }, (_, index) => (
                  <div
                    className="mao-image-strip"
                    key={index}
                    style={{ width: viewport.width, height: renderedHeight }}
                  >
                    <img
                      src={preview.url}
                      alt={index === 0 ? preview.title : ''}
                      aria-hidden={index > 0}
                      style={{
                        width: renderedWidth,
                        height: renderedHeight,
                        left: -index * viewport.width,
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="mao-image-canvas"
                style={{
                  width: Math.max(viewport.width, renderedWidth),
                  height: Math.max(viewport.height, renderedHeight),
                }}
              >
                <img
                  src={preview.url}
                  alt={preview.title}
                  style={{ width: renderedWidth, height: renderedHeight }}
                />
              </div>
            ))}
          {!failed && size.width === 0 && (
            <span className="mao-image-loading">正在加载截图…</span>
          )}
          {failed && (
            <span className="mao-image-fallback">
              <ImageOff aria-hidden="true" />
              截图加载失败
            </span>
          )}
          <img
            className="mao-image-probe"
            src={preview.url}
            alt=""
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
