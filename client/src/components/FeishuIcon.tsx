import feishuLogo from '@/assets/feishu-logo.svg';
import { cn } from '@/lib/utils';

export function FeishuIcon({ className }: { className?: string }) {
  return (
    <img
      src={feishuLogo}
      alt=""
      aria-hidden="true"
      className={cn('size-4 shrink-0 object-contain', className)}
    />
  );
}
