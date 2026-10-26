import {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

const LazyNewEmployeeOnboardingDialog = lazy(
  () => import('./NewEmployeeOnboardingDialog'),
);

export interface NewEmployeeOnboardingDialogHandle {
  open(opener?: HTMLElement | null): void;
}

export const NewEmployeeOnboardingDialogHost =
  forwardRef<NewEmployeeOnboardingDialogHandle>(
    function NewEmployeeOnboardingDialogHost(_props, ref) {
      const [shouldMount, setShouldMount] = useState(false);
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLElement | null>(null);

      const restoreOpenerFocus = useCallback(() => {
        const opener = openerRef.current;
        window.requestAnimationFrame(() => {
          if (opener?.isConnected) opener.focus();
        });
      }, []);

      const handleOpenChange = useCallback(
        (nextOpen: boolean) => {
          setOpen(nextOpen);
          if (!nextOpen) restoreOpenerFocus();
        },
        [restoreOpenerFocus],
      );

      useImperativeHandle(
        ref,
        () => ({
          open(opener?: HTMLElement | null) {
            const fallbackOpener =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            openerRef.current = opener?.isConnected ? opener : fallbackOpener;
            setShouldMount(true);
            setOpen(true);
          },
        }),
        [],
      );

      if (!shouldMount) return null;

      return (
        <Suspense
          fallback={
            <EmployeeOnboardingDialogFallback
              open={open}
              onOpenChange={handleOpenChange}
            />
          }
        >
          <LazyNewEmployeeOnboardingDialog
            open={open}
            onOpenChange={handleOpenChange}
          />
        </Suspense>
      );
    },
  );

NewEmployeeOnboardingDialogHost.displayName = 'NewEmployeeOnboardingDialogHost';

function EmployeeOnboardingDialogFallback({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UserPlus className="size-4" aria-hidden="true" />
            </span>
            新员工入职
          </DialogTitle>
          <DialogDescription>正在加载入职表单，请稍候</DialogDescription>
        </DialogHeader>
        <div
          className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Spinner aria-label="正在加载新员工入职表单" />
          正在加载
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewEmployeeOnboardingDialogHost;
