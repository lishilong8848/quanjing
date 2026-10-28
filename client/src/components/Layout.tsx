import { useIsMobile } from '@/hooks/use-mobile';
import { getDataloom } from '@lark-apaas/client-toolkit/dataloom';
import { useCurrentUserProfile } from '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile';
import { clsx, type ClassValue } from 'clsx';
import {
  LogOut,
  ChevronDown,
  LogIn,
  RefreshCw,
  ArrowRightLeft,
  UserRound,
  Settings,
} from 'lucide-react';
import * as React from 'react';
import { useState } from 'react';
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
import { UserNameAvatar } from '@/components/UserNameAvatar';
import { getAccessRoleLabel, useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { switchAccessToGuest } from '@/access/identity-switch';
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

class PlatformAccountTimeoutError extends Error {}

async function requestPlatformAccountAction(action: 'signOut' | 'navigateToUserProfile') {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const dataloom = await getDataloom();
        // SDK 初始化可能迟到，超时后不再发起账户操作。
        if (!expired) await dataloom.service.session[action]();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new PlatformAccountTimeoutError());
        }, 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// 账户入口统一使用业务会话；平台账号仅在平台环境中单独展示。
export function GlobalUserControl() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    role, purchaseBuilding, buildings, effectiveAuthorization,
    isLoading, isConfirmingIdentity, isChangingIdentity,
    displayName, expiresAt, principalFingerprint, sessionError,
    requestLogin, retrySession, logout,
  } = useAccess();
  const hasIdentity = hasAuthenticatedAccessIdentity({ role, expiresAt, principalFingerprint });
  const confirming = isLoading || isConfirmingIdentity;
  const roleLabel = !hasIdentity ? '游客' : role === 'admin'
    ? getAccessRoleLabel(role, purchaseBuilding, buildings)
    : effectiveAuthorization
      ? effectiveAuthorization.mode === 'independent' ? '独立授权' : '跟随角色'
      : getAccessRoleLabel(role, purchaseBuilding, buildings);
  const identityLabel = confirming ? '正在确认身份' : hasIdentity ? displayName || '已登录用户' : '游客';
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutAlertOpen, setLogoutAlertOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'logout' | 'refresh' | 'platform' | 'profile' | null>(null);
  const actionRef = React.useRef(false);
  const accountTriggerRef = React.useRef<HTMLButtonElement>(null);
  const platformCancelRef = React.useRef<HTMLButtonElement>(null);
  const busy = confirming || isChangingIdentity || pendingAction !== null;
  const { user_id } = useCurrentUserProfile();

  React.useEffect(() => {
    if (logoutAlertOpen && !busy) platformCancelRef.current?.focus({ preventScroll: true });
  }, [logoutAlertOpen, busy]);

  const runAccountAction = async (
    action: NonNullable<typeof pendingAction>,
    operation: () => Promise<void>,
    errorMessage: string,
  ) => {
    if (busy || actionRef.current) return;
    actionRef.current = true;
    setPendingAction(action);
    try {
      await operation();
    } catch (error) {
      toast.error(error instanceof PlatformAccountTimeoutError
        ? '平台响应超时，操作结果未确认，请刷新页面后检查'
        : errorMessage);
    } finally {
      actionRef.current = false;
      setPendingAction(null);
    }
  };

  const handleLogin = () => {
    if (busy || actionRef.current) return;
    setMenuOpen(false);
    requestLogin('请选择登录方式。', location.pathname);
  };

  const exitIdentity = () => runAccountAction('logout', async () => {
    const exited = await switchAccessToGuest({
      logout,
      pathname: location.pathname,
      navigate,
      onSuccess: () => toast.success('已退出当前账号'),
      onError: () => toast.error('退出失败，请重试'),
    });
    if (exited) setMenuOpen(false);
  }, '已退出账号，但页面跳转失败，请返回排班页');

  const handlePlatformLogout = () => runAccountAction('platform', async () => {
    await requestPlatformAccountAction('signOut');
    setLogoutAlertOpen(false);
    window.location.reload();
  }, '退出平台账号失败，请重试');

  return (
    <>
      <AlertDialog open={logoutAlertOpen} onOpenChange={open => {
        if (!actionRef.current) setLogoutAlertOpen(open);
      }}>
        <AlertDialogContent onCloseAutoFocus={event => {
          event.preventDefault();
          accountTriggerRef.current?.focus({ preventScroll: true });
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>确认退出平台账号？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作退出平台账号并重新加载页面；退出本网站请使用“退出当前账号”。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={platformCancelRef} disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={event => {
              event.preventDefault();
              void handlePlatformLogout();
            }}>
              {pendingAction === 'platform' ? '正在退出…' : '退出平台账号'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={accountTriggerRef}
            type="button"
            variant="ghost"
            aria-label="打开账户菜单"
            title={`当前身份：${identityLabel}`}
            aria-busy={busy}
            className="h-11 min-w-11 shrink-0 gap-1 rounded-lg px-1.5 sm:gap-2 sm:px-2"
          >
            <UserNameAvatar name={hasIdentity ? displayName : undefined} isGuest={!hasIdentity}
              isLoading={confirming} className="size-8 text-xs" />
            <span className="hidden max-w-28 truncate text-sm sm:block">{identityLabel}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} collisionPadding={12}
          className="w-64 max-w-[calc(100vw-1.5rem)] rounded-lg [&_[data-slot=dropdown-menu-item]]:min-h-11">
          <DropdownMenuLabel className="p-2 font-normal">
            <div className="flex items-center gap-3 text-sm">
              <UserNameAvatar name={hasIdentity ? displayName : undefined} isGuest={!hasIdentity}
                isLoading={confirming} className="size-10 shrink-0 text-sm" />
              <div className="grid min-w-0 gap-1">
                <span className="truncate font-medium" title={identityLabel}>{identityLabel}</span>
                {!confirming && <span className="text-xs text-muted-foreground">{hasIdentity ? `已登录 · ${roleLabel}` : '尚未登录'}</span>}
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {sessionError && <>
            <DropdownMenuLabel className="break-words text-xs font-normal text-destructive" role="status">
              {sessionError}
            </DropdownMenuLabel>
            <DropdownMenuItem disabled={busy} onSelect={event => {
              event.preventDefault();
              void runAccountAction('refresh', retrySession, '身份确认失败，请重试');
            }}>
              <RefreshCw className={pendingAction === 'refresh' ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'} aria-hidden="true" />
              {pendingAction === 'refresh' ? '正在确认身份…' : '重新确认身份'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>}
          <DropdownMenuItem disabled={busy} onSelect={handleLogin}>
            {hasIdentity ? <ArrowRightLeft className="size-4" aria-hidden="true" /> : <LogIn className="size-4" aria-hidden="true" />}
            {hasIdentity ? '切换账号' : '登录'}
          </DropdownMenuItem>
          {hasIdentity && role === 'admin' && <DropdownMenuItem disabled={busy} onSelect={() => navigate('/system-configuration')}>
            <Settings className="size-4" aria-hidden="true" />系统配置
          </DropdownMenuItem>}
          {hasIdentity && <DropdownMenuItem disabled={busy} variant="destructive" onSelect={event => {
            event.preventDefault();
            void exitIdentity();
          }}>
            <LogOut className="size-4" aria-hidden="true" />
            {pendingAction === 'logout' ? '正在退出…' : '退出当前账号'}
          </DropdownMenuItem>}
          {user_id && <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">平台账号</DropdownMenuLabel>
            <DropdownMenuItem disabled={busy} onSelect={event => {
              event.preventDefault();
              void runAccountAction('profile', async () => {
                await requestPlatformAccountAction('navigateToUserProfile');
                setMenuOpen(false);
              }, '打开个人主页失败，请重试');
            }}>
              <UserRound className="size-4" aria-hidden="true" />
              {pendingAction === 'profile' ? '正在打开…' : '个人主页'}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => {
              setMenuOpen(false);
              setLogoutAlertOpen(true);
            }}>
              <LogOut className="size-4" aria-hidden="true" />退出平台账号
            </DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
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
