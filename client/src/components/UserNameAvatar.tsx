import { Avatar, AvatarFallback } from './ui/avatar';

interface UserNameAvatarProps {
  name?: string;
  isGuest?: boolean;
  isLoading?: boolean;
  className?: string;
}

export function UserNameAvatar({
  name,
  isGuest = false,
  isLoading = false,
  className,
}: UserNameAvatarProps) {
  const initials = isLoading
    ? '…'
    : isGuest
      ? '游客'
      : Array.from(name?.trim() || '').slice(-2).join('') || '用户';

  return (
    <Avatar className={className} aria-hidden="true">
      <AvatarFallback
        className={`select-none font-semibold leading-none ${
          isGuest || isLoading
            ? 'bg-muted text-muted-foreground'
            : 'bg-primary text-primary-foreground'
        }`}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
