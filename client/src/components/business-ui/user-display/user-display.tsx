'use client';

import React from 'react';

import type { IUserProfile } from '@client/src/components/business-ui/user-display/type';
import { UserWithAvatar } from '@client/src/components/business-ui/user-display/user-with-avatar';
import { UserProfile } from '@client/src/components/business-ui/user-profile/user-profile';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';

export interface IUserDisplayProps {
  users: IUserProfile | IUserProfile[];
  size?: 'small' | 'medium' | 'large';
  className?: string;
  style?: React.CSSProperties;
  showLabel?: boolean;
  showUserProfile?: boolean;
}

export const UserDisplay: React.FC<IUserDisplayProps> = ({
  users,
  size,
  className,
  style,
  showLabel = true,
}) => {
  // 统一规范化为 IUserProfile[]
  const normalizedUsers = React.useMemo<IUserProfile[]>(() => {
    if (!users) return [];

    return Array.isArray(users) ? users : [users];
  }, [users]);

  if (!normalizedUsers.length) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap gap-1', className)} style={style}>
      {normalizedUsers.map((user) => (
        <Popover key={user.user_id}>
          <PopoverTrigger asChild>
            <div>
              <UserWithAvatar
                data={user}
                size={size}
                showLabel={showLabel}
                className="cursor-pointer hover:bg-[rgba(31,35,41,0.15)] active:bg-[rgba(31,35,41,0.2)]"
              />
            </div>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={8}
            className="w-[320px] border-0 border-border/50 bg-card p-0 shadow-[0px_8px_24px_8px_rgba(31,35,41,0.04),0px_6px_12px_rgba(31,35,41,0.04),0px_4px_8px_-8px_rgba(31,35,41,0.06)]"
          >
            <UserProfile userId={user.user_id} />
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
};
