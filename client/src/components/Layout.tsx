import { useIsMobile } from '@/hooks/use-mobile';
import { getDataloom } from '@lark-apaas/client-toolkit/dataloom';
import { useCurrentUserProfile } from '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { clsx, type ClassValue } from 'clsx';
import {
  LogOut,
  ShieldCheck,
  UserRound,
  Settings,
} from 'lucide-react';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { twMerge } from 'tailwind-merge';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FeishuIcon } from '@/components/FeishuIcon';
import { UserNameAvatar } from '@/components/UserNameAvatar';
import { getAccessRoleLabel, useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { switchAccessToGuest } from '@/access/identity-switch';
import { useFeishuLogin } from '@/access/use-feishu-login';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 页面壳层仅保留沉浸式页面的内边距判断；全局入口由 PAGE_REGISTRY 统一提供。
function normalizeManagementPath(pathname: string): string {
  const normalizedPathname = pathname.toLowerCase().replace(/\/+$/, '');
  return normalizedPathname || '/';
}

function isImmersiveManagementRoute(pathname: string): boolean {
  pathname = normalizeManagementPath(pathname);
  return (
    pathname === '/nantong-base' ||
    pathname === '/construction-management' ||
    pathname === '/equipment-patrol-dashboard' ||
    pathname === '/purchase-inventory-management' ||
    pathname === '/inventory-management' ||
    pathname === '/threshold-management' ||
    pathname === '/meeting-management' ||
    pathname.startsWith('/meeting-management/') ||
    pathname === '/operations-tools-management' ||
    pathname === '/contract-management' ||
    pathname.startsWith('/contract-management/')
  );
}

// 用户控制组件（右侧）
export function GlobalUserControl() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    role,
    purchaseBuilding, buildings,
    isLoading,
    displayName,
    expiresAt,
    principalFingerprint,
    sessionError,
    isChangingIdentity,
    requestLogin,
    logout,
  } = useAccess();
  const roleLabel = getAccessRoleLabel(role, purchaseBuilding, buildings);
  const hasIdentity = hasAuthenticatedAccessIdentity({ role, expiresAt, principalFingerprint });
  const identityLabel = isLoading ? '正在确认身份' : displayName || roleLabel;
  const feishuLogin = useFeishuLogin((message) => toast.error(message), true, isChangingIdentity);
  const [isExiting, setIsExiting] = useState(false);
  const exitingRef = React.useRef(false);
  const [logoutAlertOpen, setLogoutAlertOpen] = useState(false);
  const userProfile = useCurrentUserProfile();

  const { user_id } = userProfile;

  const jumpToUserPage = async () => {
    const dataloom = await getDataloom();
    await dataloom.service.session.navigateToUserProfile();
  };

  const handleLogin = () => {
    requestLogin('请输入访问密码。', location.pathname);
  };

  const exitIdentity = async () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setIsExiting(true);
    try {
      await switchAccessToGuest({
        logout,
        pathname: location.pathname,
        navigate,
        onSuccess: () => toast.success('已退出当前身份，切换为游客'),
        onError: () => toast.error('退出失败，请重试'),
      });
    } catch {
      toast.error('已切换为游客，但页面跳转失败，请返回排班页');
    } finally {
      exitingRef.current = false;
      setIsExiting(false);
    }
  };

  const handleLogout = async () => {
    try {
      const dataloom = await getDataloom();
      const result = await dataloom.service.session.signOut();
      logger.info('退出登录', { result });
      toast.success('退出登录成功');
      window.location.reload();
    } catch (error) {
      logger.error('退出登录失败', { error });
    }
  };

  return (
    <>
      <AlertDialog open={logoutAlertOpen} onOpenChange={setLogoutAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认退出登录“{identityLabel}”吗？</AlertDialogTitle>
            <AlertDialogDescription>
              退出登录后，你将无法收到该账号通知
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="destructive" onClick={handleLogout}>
              退出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="打开用户菜单"
            title={`当前身份：${identityLabel}`}
            aria-busy={isExiting || isLoading}
            className="size-9 shrink-0 rounded-lg p-0"
          >
            <UserNameAvatar
              name={displayName}
              isGuest={!hasIdentity}
              isLoading={isLoading}
              className="size-8 text-xs"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          align="end"
          sideOffset={4}
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <UserNameAvatar
                name={displayName}
                isGuest={!hasIdentity}
                isLoading={isLoading}
                className="size-10 text-sm"
              />
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium" title={identityLabel}>{identityLabel}</span>
                {hasIdentity && displayName ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {roleLabel}
                  </span>
                ) : null}
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {role === 'admin' && !isLoading && expiresAt ? (
            <DropdownMenuItem onSelect={() => navigate('/system-configuration')}>
              <Settings className="size-4" aria-hidden="true" />
              配置
            </DropdownMenuItem>
          ) : null}
          {sessionError ? (
            <DropdownMenuLabel
              className="text-xs font-normal text-destructive"
              role="status"
            >
              {sessionError}
            </DropdownMenuLabel>
          ) : null}
          <DropdownMenuItem
            disabled={isLoading || isExiting || isChangingIdentity || feishuLogin.isPending}
            onSelect={(event) => {
              event.preventDefault();
              feishuLogin.start();
            }}
            aria-busy={feishuLogin.isPending}
          >
            <FeishuIcon />
            {feishuLogin.isPending ? '正在打开飞书登录…' : '飞书登录'}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isLoading || isExiting || isChangingIdentity}
            onSelect={(event) => {
              if (hasIdentity) {
                event.preventDefault();
                void exitIdentity();
              } else handleLogin();
            }}
            className="text-foreground"
          >
            <LogOut className="size-4" aria-hidden="true" />
            {isExiting
              ? '正在退出…'
              : !hasIdentity
                ? '登录'
                : '退出当前身份，切换游客'}
          </DropdownMenuItem>
          {user_id ? (
            <DropdownMenuItem
              aria-label="打开个人主页"
              onClick={() => void jumpToUserPage()}
            >
              <UserRound className="size-4" aria-hidden="true" />
              个人主页
            </DropdownMenuItem>
          ) : null}
          {user_id ? (
            <DropdownMenuItem onClick={() => setLogoutAlertOpen(true)}>
              <LogOut className="size-4" aria-hidden="true" />
              退出平台账号
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function UnifiedAccessControl({
  compact = false,
  tone = 'default',
}: {
  compact?: boolean;
  tone?: 'default' | 'inverse';
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    role,
    purchaseBuilding, buildings,
    sessionError,
    isChangingIdentity,
    requestLogin,
    logout,
    displayName,
    expiresAt,
    principalFingerprint,
  } = useAccess();
  const roleLabel = getAccessRoleLabel(role, purchaseBuilding, buildings);
  const hasIdentity = hasAuthenticatedAccessIdentity({ role, expiresAt, principalFingerprint });
  const identityLabel = displayName || roleLabel;
  const feishuLogin = useFeishuLogin(message => toast.error(message), true, isChangingIdentity);

  const openRoleLogin = () => {
    requestLogin('请输入访问密码。', location.pathname);
  };

  const switchToGuest = () => {
    void switchAccessToGuest({
      logout,
      pathname: location.pathname,
      navigate,
      onSuccess: () => toast.success('已切换为游客'),
      onError: () => toast.error('切换游客失败，请稍后重试'),
    }).catch(() =>
      toast.error('已切换为游客，但页面跳转失败，请手动返回排班页'),
    );
  };

  return (
    <div
      className={cn('inline-flex items-center', compact ? 'gap-0.5' : 'gap-1')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={compact ? 'icon-sm' : 'sm'}
            title={sessionError || '当前身份：' + identityLabel}
            aria-label={'当前身份：' + identityLabel + '，打开身份切换菜单'}
            className={cn(
              tone === 'inverse' &&
                'border-white/25 bg-white/10 text-white hover:border-white/40 hover:bg-white/20 hover:text-white',
            )}
          >
            <ShieldCheck
              className={cn(
                'size-4',
                tone === 'inverse' ? 'text-white' : 'text-blue-600',
              )}
              aria-hidden="true"
            />
            {compact ? null : <span className="max-w-40 truncate">{identityLabel}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel className="max-w-64 truncate" title={identityLabel}>当前身份：{identityLabel}</DropdownMenuLabel>
          {displayName ? <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{roleLabel}</DropdownMenuLabel> : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            切换身份
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={openRoleLogin}>
            <ShieldCheck className="size-4" aria-hidden="true" />
            输入密码切换身份
          </DropdownMenuItem>
          {hasIdentity ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={isChangingIdentity} onClick={switchToGuest}>
                <LogOut className="size-4" aria-hidden="true" />
                切换为游客
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="使用飞书授权登录"
        title="使用飞书授权登录"
        aria-busy={feishuLogin.isPending}
        disabled={feishuLogin.isPending || isChangingIdentity}
        onClick={feishuLogin.start}
        className={cn(
          'shrink-0 opacity-75 transition-colors hover:opacity-100 focus-visible:ring-2',
          tone === 'inverse'
            ? 'text-white/60 hover:bg-white/10 hover:text-white focus-visible:ring-white/70'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-blue-500/60',
        )}
      >
        <FeishuIcon className="size-4" />
      </Button>
    </div>
  );
}

function Layout2Desktop() {
  const location = useLocation();
  const isImmersiveManagementPage = isImmersiveManagementRoute(
    location.pathname,
  );

  return (
    <div className="flex min-h-[calc(100dvh-var(--global-navigation-height))] flex-col bg-background">
      <main
        className={cn(
          'bg-background overflow-x-auto',
          isImmersiveManagementPage ? 'px-0 py-0' : 'px-6 py-4',
        )}
      >
        {/* 在此处渲染的内容需要注意自适应宽度，如果超宽则需要使用 overflow scroll 或类似行为 */}
        <Outlet />
      </main>
    </div>
  );
}

function Layout2Mobile() {
  const location = useLocation();
  const isImmersiveManagementPage = isImmersiveManagementRoute(
    location.pathname,
  );

  return (
    <div className="min-h-[calc(100dvh-var(--global-navigation-height))] bg-background">
      <main
        id="rootContainer"
        className={cn(
          'min-h-[calc(100dvh-var(--global-navigation-height))] overflow-x-auto bg-background',
          isImmersiveManagementPage ? 'px-0 py-0' : 'px-3 py-3 sm:px-6 sm:py-4',
        )}
      >
        {/* 在此处渲染的内容需要注意自适应宽度，如果超宽则需要使用 overflow scroll 或类似行为 */}
        <Outlet />
      </main>
    </div>
  );
}

export default function Layout2() {
  const isMobile = useIsMobile();
  if (!isMobile) {
    return <Layout2Desktop />;
  }
  return <Layout2Mobile />;
}
