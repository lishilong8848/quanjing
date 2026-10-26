import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { Button } from '@/components/ui/button';

export function PortalImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  return <ImageRequest key={`${props.src}|${props.srcSet}`} {...props} />;
}

function ImageRequest(props: ImgHTMLAttributes<HTMLImageElement>) {
  const image = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [started, setStarted] = useState(props.loading !== 'lazy');
  const [slow, setSlow] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const node = image.current;
    if (!node) return;
    if (node.complete && node.naturalWidth > 0) {
      setStatus('ready');
      return;
    }
    if (props.loading !== 'lazy') {
      setStarted(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setStarted(true);
        observer.disconnect();
      }
    }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [props.loading, attempt]);

  useEffect(() => {
    setSlow(false);
    if (!started || status !== 'loading') return;
    const slowTimer = window.setTimeout(() => setSlow(true), 1000);
    const timeout = window.setTimeout(() => {
      setTimedOut(true);
      setStatus('error');
    }, 15000);
    return () => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeout);
    };
  }, [started, status, attempt]);

  return (
    <>
      <img
        {...props}
        ref={image}
        key={attempt}
        decoding="async"
        onLoad={(event) => { setStatus('ready'); props.onLoad?.(event); }}
        onError={(event) => { setStatus('error'); props.onError?.(event); }}
        data-image-state={started ? status : status === 'loading' ? 'idle' : status}
      />
      {started && status === 'loading' && slow && (
        <div className="portal-image-loading" role="status">图片加载中…</div>
      )}
      {status === 'error' && (
        <div className="portal-image-error" role="status">
          {timedOut ? '图片加载超时' : '图片加载失败'}
          <Button variant="outline" onClick={() => {
            setTimedOut(false);
            setStatus('loading');
            setAttempt((value) => value + 1);
          }}>重新加载</Button>
        </div>
      )}
    </>
  );
}
