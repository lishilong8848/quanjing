import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

let openCount = 0;
let previousOverflow = '';

export function SourceModal({
  title,
  children,
  onClose,
  trigger,
  variant = 'sheet',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  trigger: HTMLElement | null;
  variant?: 'sheet' | 'record';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const modal = ref.current;
    if (!modal) return;
    if (openCount++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    modal.showModal();
    return () => {
      modal.close();
      if (--openCount === 0) document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`monthly-operations mo-native-modal mo-assessment-${variant}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.stopPropagation();
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="mo-source-modal-header">
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
