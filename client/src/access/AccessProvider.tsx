import { businessModulesForPage, hasBusinessPermissionSomewhere, isProfessionalBusinessPrincipal } from '@shared/business-permissions';
import { defaultCanAccessPage } from '@shared/page-access';
import {
  type AccessCapabilities,
  type AccessLoginAccountType,
  type AccessLoginRequest,
  type AccessRole,
  type AccessSessionResponse,
  type BuildingAdminBuilding,
  type PurchaseAccessBuilding,
} from '@shared/access-control.interface';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  AlertCircle,
  KeyRound,
  Loader2,
  ShieldCheck,
  ChevronRight,
  Eye,
  EyeOff,
} from 'lucide-react';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { getAccessSession, loginAccess, logoutAccess } from '@/api';
import { Button } from '@/components/ui/button';
import { FeishuIcon } from '@/components/FeishuIcon';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoginNameField } from './LoginNameField';
import { ImpersonationBanner } from './ImpersonationBanner';
import { PasswordChangeDialog } from './PasswordChangeDialog';
import { ForgotPasswordDialog } from './ForgotPasswordDialog';
import { requestImpersonation, reloadImpersonationPage, type ImpersonationFailure } from './impersonation';
import { useFeishuLogin } from './use-feishu-login';
import {
  createFeishuSessionConfirmation,
  FEISHU_AUTH_QUERY_KEY,
  getFeishuAuthFeedback,
  getIdentityRequestError,
  removeFeishuAuthStatus,
} from './feishu-auth';
import {
  installUnifiedAccessResponseInterceptor,
  UNIFIED_ACCESS_INVALIDATED_EVENT,
} from './access-events';
import {
  capabilitiesForRole,
  professionalPageCapabilities,
  getAccessRoleLabel,
  getPostLoginPath,
  getReauthenticationLoginDefaults,
  normalizeAccessSession,
  hasAuthenticatedAccessIdentity,
} from './access-policy';
import {
  createSessionCommitCoordinator,
  canApplyPagePermissionSnapshot,
  isConfirmedLoginSession,
} from './session-commit-coordinator';

export { getAccessRoleLabel };

class GuestIdentityNotConfirmedError extends Error {}

interface AccessContextValue extends AccessSessionResponse {
  isLoading: boolean;
  isConfirmingIdentity: boolean;
  isChangingIdentity: boolean;
  isLoginDialogOpen: boolean;
  dismissedLoginPath: string | null;
  sessionError: string | null;
  login: (request: AccessLoginRequest) => Promise<boolean>;
  logout: () => Promise<boolean>;
  passwordChanged: () => void;
  refreshSession: () => Promise<void>;
  retrySession: () => Promise<void>;
  startImpersonation: (accountId: string, clientMutationId: string) => Promise<boolean>;
  stopImpersonation: (clientMutationId: string) => Promise<boolean>;
  readOnlyPage: boolean;
  requestLogin: (
    reason?: string,
    requiredPath?: string,
    preferredAccountType?: AccessLoginAccountType,
    preferredPurchaseBuilding?: PurchaseAccessBuilding | BuildingAdminBuilding,
    automatic?: boolean,
    options?: { method?: 'feishu' | 'employee'; notice?: string },
  ) => void;
}

interface LoginDialogState {
  requestKey: number;
  open: boolean;
  automatic: boolean;
  reason: string;
  requiredPath?: string;
  preferredAccountType?: AccessLoginAccountType;
  preferredPurchaseBuilding?: PurchaseAccessBuilding | BuildingAdminBuilding;
  preferredMethod?: 'feishu' | 'employee';
  notice?: string;
}

const GUEST_SESSION: AccessSessionResponse = normalizeAccessSession({
  role: 'guest',
  purchaseBuilding: null,
  expiresAt: null,
  principalFingerprint: null,
});

const AccessContext = React.createContext<AccessContextValue | null>(null);
const BACKGROUND_SESSION_WARNING_ID = 'access-background-session-warning';

export function AccessProvider({ children }: React.PropsWithChildren) {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] =
    React.useState<AccessSessionResponse>(GUEST_SESSION);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isConfirmingIdentity, setIsConfirmingIdentity] = React.useState(false);
  const [sessionError, setSessionError] = React.useState<string | null>(null);
  const [loginError, setLoginError] = React.useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = React.useState(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const logoutPendingRef = React.useRef(false);
  const impersonationPendingRef = React.useRef(false);
  const [isImpersonating, setIsImpersonating] = React.useState(false);
  const [dismissedLoginPath, setDismissedLoginPath] = React.useState<string | null>(null);
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const sessionErrorRef = React.useRef(sessionError);
  sessionErrorRef.current = sessionError;
  const backgroundSessionWarningRef = React.useRef(false);
  const accessInvalidationVersionRef = React.useRef(0);
  const [dialog, setDialog] = React.useState<LoginDialogState>({
    requestKey: 0,
    open: false,
    automatic: false,
    reason: '请输入访问密码。',
  });
  const loginDialogRef = React.useRef(dialog);
  loginDialogRef.current = dialog;
  const activeLoginRequestKey = React.useRef(0);
  const refreshPromise = React.useRef<Promise<void> | null>(null);
  const [sessionCommitCoordinator] = React.useState(
    createSessionCommitCoordinator,
  );
  const [feishuConfirmation] = React.useState(() =>
    createFeishuSessionConfirmation(getAccessSession, sessionCommitCoordinator),
  );
  const feishuAuthStatus = new URLSearchParams(location.search).get(FEISHU_AUTH_QUERY_KEY);
  // A new history entry can be a new authorization attempt at the same URL.
  const callbackLocation = `${location.key}:${location.pathname}${location.search}${location.hash}`;
  const callbackPending = feishuAuthStatus !== null && !feishuConfirmation.hasConsumedCallback(callbackLocation);
  const requiresFeishuIdentityRef = React.useRef(feishuAuthStatus === 'success');
  const sessionMutationQueue = React.useRef<Promise<void>>(Promise.resolve());
  const reauthenticationPendingRef = React.useRef(false);
  const permissionChangeNoticeRef = React.useRef<string | null>(null);
  const lastReauthenticationLoginRef = React.useRef(
    getReauthenticationLoginDefaults(GUEST_SESSION),
  );

  const rememberReauthenticationLogin = React.useCallback(
    (nextSession: AccessSessionResponse) => {
      if (nextSession.role === 'guest') return;
      lastReauthenticationLoginRef.current =
        getReauthenticationLoginDefaults(nextSession);
    },
    [],
  );

  const clearBackgroundSessionWarning = React.useCallback(() => {
    if (backgroundSessionWarningRef.current) toast.dismiss(BACKGROUND_SESSION_WARNING_ID);
    backgroundSessionWarningRef.current = false;
  }, []);

  const markReauthenticationPending = React.useCallback(() => {
    reauthenticationPendingRef.current = true;
  }, []);

  const enqueueSessionMutation = React.useCallback(
    (
      operation: () => Promise<AccessSessionResponse>,
    ): Promise<AccessSessionResponse> => {
      const queued = sessionMutationQueue.current.then(operation, operation);
      sessionMutationQueue.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [],
  );

  const refreshSession = React.useCallback((silent = false): Promise<void> => {
    if (requiresFeishuIdentityRef.current || feishuConfirmation.isPending() || logoutPendingRef.current || impersonationPendingRef.current) return Promise.resolve();
    if (refreshPromise.current) return refreshPromise.current;

    const refreshToken = sessionCommitCoordinator.captureRefresh();
    const invalidationVersion = accessInvalidationVersionRef.current;
    const previousSession = sessionRef.current;
    const requestKey = activeLoginRequestKey.current;
    if (!silent) setIsLoading(true);
    const pending = getAccessSession()
      .then((nextSession) => {
        if (!sessionCommitCoordinator.canCommit(refreshToken)) return;
        const normalizedSession = normalizeAccessSession(nextSession);
        if (previousSession.principalFingerprint && hasAuthenticatedAccessIdentity(previousSession) &&
          !hasAuthenticatedAccessIdentity(normalizedSession) && permissionChangeNoticeRef.current !== previousSession.principalFingerprint) {
          permissionChangeNoticeRef.current = previousSession.principalFingerprint;
          toast.warning('登录状态或权限已更新，请重新确认身份。', { id:'access-permission-updated' });
        }
        rememberReauthenticationLogin(normalizedSession);
        if (hasAuthenticatedAccessIdentity(normalizedSession)) {
          reauthenticationPendingRef.current = false;
          if (!hasAuthenticatedAccessIdentity(previousSession)) {
            setDismissedLoginPath(null);
            setDialog(current => current.automatic && current.requestKey === requestKey ? { ...current, open: false } : current);
          }
        }
        if ((previousSession.accountId || previousSession.impersonation) &&
          JSON.stringify(previousSession.impersonation || null) !== JSON.stringify(normalizedSession.impersonation || null)) {
          impersonationPendingRef.current = true;
          flushSync(() => { setIsImpersonating(true); setSession(normalizedSession); setSessionError(null); });
          reloadImpersonationPage(normalizedSession, !normalizedSession.impersonation && normalizedSession.role === 'admin');
          return;
        }
        setSession(current => canApplyPagePermissionSnapshot(current, normalizedSession) ? normalizedSession : current);
        setSessionError(null);
        clearBackgroundSessionWarning();
      })
      .catch((error: unknown) => {
        if (!sessionCommitCoordinator.canCommit(refreshToken)) return;
        const failure = error as { code?: string; response?: { status?: number } } | null;
        const status = failure?.response?.status;
        const transientFailure = status !== 401 && status !== 403 && (failure?.code === 'ERR_NETWORK' || failure?.code === 'ECONNABORTED' || failure?.code === 'ETIMEDOUT' ||
          (typeof status === 'number' && status >= 500 && status < 600));
        const current = sessionRef.current;
        if (silent && transientFailure && !sessionErrorRef.current && !reauthenticationPendingRef.current &&
          accessInvalidationVersionRef.current === invalidationVersion && hasAuthenticatedAccessIdentity(current) &&
          current.principalFingerprint && typeof current.expiresAt === 'number' && current.expiresAt > Date.now()) {
          if (!backgroundSessionWarningRef.current) {
            backgroundSessionWarningRef.current = true;
            toast.warning('暂时无法刷新登录状态，当前内容已保留。网络恢复后将自动重试。', { id: BACKGROUND_SESSION_WARNING_ID });
          }
          return;
        }
        clearBackgroundSessionWarning();
        setSessionError(getIdentityRequestError(error));
      })
      .finally(() => {
        if (sessionCommitCoordinator.canCommit(refreshToken)) setIsLoading(false);
        refreshPromise.current = null;
      });
    refreshPromise.current = pending;
    return pending;
  }, [clearBackgroundSessionWarning, feishuConfirmation, rememberReauthenticationLogin, sessionCommitCoordinator]);

  const confirmFeishuSession = React.useCallback(async () => {
    const requestKey = activeLoginRequestKey.current;
    requiresFeishuIdentityRef.current = true;
    setIsConfirmingIdentity(true);
    setIsLoading(true);
    setSessionError(null);
    const result = await feishuConfirmation.run(Promise.all([refreshPromise.current, sessionMutationQueue.current]).then(() => undefined));
    if (result.status === 'superseded' || !sessionCommitCoordinator.canCommit(result.token)) return result;
    if (result.status === 'confirmed') {
      const confirmed = normalizeAccessSession(result.session);
      rememberReauthenticationLogin(confirmed);
      requiresFeishuIdentityRef.current = false;
      reauthenticationPendingRef.current = false;
      setDismissedLoginPath(null);
      clearBackgroundSessionWarning();
      flushSync(() => {
        setSession(confirmed);
        setSessionError(null);
        setLoginError(null);
        setDialog(current => current.requestKey === requestKey ? { ...current, open: false } : current);
        setIsConfirmingIdentity(false);
        setIsLoading(false);
      });
    } else {
      if (result.status === 'unconfirmed') setSession(GUEST_SESSION);
      setSessionError(result.message);
      if (activeLoginRequestKey.current === requestKey) setLoginError(result.message);
      setIsConfirmingIdentity(false);
      setIsLoading(false);
    }
    return result;
  }, [clearBackgroundSessionWarning, feishuConfirmation, rememberReauthenticationLogin, sessionCommitCoordinator]);

  const retrySession = React.useCallback(async () => {
    if (requiresFeishuIdentityRef.current) await confirmFeishuSession();
    else await refreshSession();
  }, [confirmFeishuSession, refreshSession]);

  React.useEffect(() => {
    if (feishuAuthStatus === null || !feishuConfirmation.consumeCallback(callbackLocation)) return;
    navigate({ pathname: location.pathname, search: removeFeishuAuthStatus(location.search), hash: location.hash }, { replace: true });
    const feedback = getFeishuAuthFeedback(feishuAuthStatus);
    if (!feedback) return;
    if (feedback.kind === 'success') {
      void confirmFeishuSession().then(result => {
        if (result.status === 'confirmed' && sessionCommitCoordinator.canCommit(result.token)) toast.success(feedback.message);
      });
    } else {
      requiresFeishuIdentityRef.current = false;
      void refreshSession();
      if (feedback.kind === 'info') toast.info(feedback.message);
      else toast.error(feedback.message);
    }
  }, [callbackLocation, confirmFeishuSession, feishuAuthStatus, feishuConfirmation, location.hash, location.pathname, location.search, navigate, refreshSession, sessionCommitCoordinator]);
  React.useEffect(() => {
    const removeInterceptor =
      installUnifiedAccessResponseInterceptor(axiosForBackend);
    const changingIdentityInterceptor = axiosForBackend.interceptors.request.use(config => {
      const path = new URL(config.url || '', window.location.origin).pathname;
      const base = (process.env.CLIENT_BASE_PATH || '').replace(/\/+$/, '');
      const normalized = base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
      const method = String(config.method || 'GET').toUpperCase();
      const identityRequest = method === 'GET' && normalized === '/api/access/session' || method === 'POST' && ['/api/access/impersonation/start', '/api/access/impersonation/stop'].includes(normalized);
      if (impersonationPendingRef.current && !identityRequest) {
        throw Object.assign(new Error('正在切换登录身份，请稍后重试'), { code: 'ERR_CANCELED' });
      }
      return config;
    });
    const handleInvalidated = () => {
      accessInvalidationVersionRef.current += 1;
      if (reauthenticationPendingRef.current) return;
      markReauthenticationPending();
      void refreshSession();
    };

    window.addEventListener(
      UNIFIED_ACCESS_INVALIDATED_EVENT,
      handleInvalidated,
    );
    void refreshSession();
    let lastCheck = Date.now();
    const checkPermissions = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 5000) return;
      lastCheck = Date.now(); void refreshSession(true);
    };
    const timer = window.setInterval(checkPermissions, 55_000);
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (requiresFeishuIdentityRef.current) void retrySession();
      else void refreshSession(true);
    };
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', checkPermissions);
    document.addEventListener('visibilitychange', checkPermissions);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', checkPermissions);
      document.removeEventListener('visibilitychange', checkPermissions);
      removeInterceptor();
      axiosForBackend.interceptors.request.eject(changingIdentityInterceptor);
      window.removeEventListener(
        UNIFIED_ACCESS_INVALIDATED_EVENT,
        handleInvalidated,
      );
    };
  }, [markReauthenticationPending, refreshSession, retrySession]);

  const requestLogin = React.useCallback(
    (
      reason?: string,
      requiredPath?: string,
      preferredAccountType?: AccessLoginAccountType,
      preferredPurchaseBuilding?: PurchaseAccessBuilding | BuildingAdminBuilding,
      automatic = false,
      options?: { method?: 'feishu' | 'employee'; notice?: string },
    ) => {
      if (impersonationPendingRef.current || automatic && (sessionRef.current.impersonation || loginDialogRef.current.open)) return;
      const rememberedLogin = reauthenticationPendingRef.current
        ? lastReauthenticationLoginRef.current
        : getReauthenticationLoginDefaults(GUEST_SESSION);
      const resolvedAccountType =
        preferredAccountType || rememberedLogin.accountType || undefined;
      const resolvedPurchaseBuilding =
        preferredPurchaseBuilding ||
        (resolvedAccountType === rememberedLogin.accountType
          ? rememberedLogin.purchaseBuilding || undefined
          : undefined);
      const requestKey = activeLoginRequestKey.current + 1;
      activeLoginRequestKey.current = requestKey;
      setLoginError(null);
      const nextDialog: LoginDialogState = {
        requestKey,
        open: true,
        automatic,
        reason: reason || '请输入访问密码。',
        ...(requiredPath ? { requiredPath } : {}),
        ...(resolvedAccountType
          ? { preferredAccountType: resolvedAccountType }
          : {}),
        ...(resolvedPurchaseBuilding
          ? { preferredPurchaseBuilding: resolvedPurchaseBuilding }
          : {}),
        ...(options?.method ? { preferredMethod: options.method } : {}),
        ...(options?.notice ? { notice: options.notice } : {}),
      };
      // Cover already-queued route effects as well as the next render. An
      // automatic gate must never replace an explicit login or its draft.
      loginDialogRef.current = nextDialog;
      setDialog(nextDialog);
    },
    [],
  );

  const markSessionExpired = React.useCallback(() => {
    markReauthenticationPending();
    clearBackgroundSessionWarning();
    setSession(current => current.impersonation ? { ...GUEST_SESSION, impersonation: current.impersonation } : GUEST_SESSION);
  }, [clearBackgroundSessionWarning, markReauthenticationPending]);

  React.useEffect(() => {
    if (dialog.open || !session.expiresAt) return;

    const remainingMs = session.expiresAt - Date.now();
    if (remainingMs <= 0) {
      markSessionExpired();
      return;
    }

    const timeoutId = window.setTimeout(() => {
      markSessionExpired();
    }, remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [dialog.open, markSessionExpired, session.expiresAt, session.role]);

  const login = React.useCallback(
    async (request: AccessLoginRequest): Promise<boolean> => {
      if (logoutPendingRef.current || impersonationPendingRef.current) return false;
      const submittedRequestKey = dialog.requestKey;
      const submittedMutationToken = sessionCommitCoordinator.beginMutation();
      requiresFeishuIdentityRef.current = false;
      setIsConfirmingIdentity(false);
      setIsLoading(false);
      setIsLoggingIn(true);
      setLoginError(null);
      try {
        const nextSession = await enqueueSessionMutation(() =>
          loginAccess(request),
        );
        if (!sessionCommitCoordinator.canCommit(submittedMutationToken)) {
          return false;
        }

        if (activeLoginRequestKey.current !== submittedRequestKey) {
          return false;
        }

        const confirmedSession = await getAccessSession();
        if (
          !sessionCommitCoordinator.canCommit(submittedMutationToken) ||
          activeLoginRequestKey.current !== submittedRequestKey
        ) {
          return false;
        }
        if (!isConfirmedLoginSession(nextSession, confirmedSession)) {
          throw new Error('登录会话确认失败，请重新登录');
        }

        const committedMutationToken = sessionCommitCoordinator.commitMutation(
          submittedMutationToken,
        );
        if (committedMutationToken === null) return false;

        rememberReauthenticationLogin(normalizeAccessSession(confirmedSession));
        reauthenticationPendingRef.current = false;
        setDismissedLoginPath(null);
        clearBackgroundSessionWarning();
        const targetPath = getPostLoginPath(
          confirmedSession.role,
          dialog.requiredPath || location.pathname,
          confirmedSession.pagePaths,
        );
        flushSync(() => {
          setSession((current) =>
            sessionCommitCoordinator.canCommit(committedMutationToken) &&
            activeLoginRequestKey.current === submittedRequestKey
              ? normalizeAccessSession(confirmedSession)
              : current,
          );
          setSessionError((current) =>
            sessionCommitCoordinator.canCommit(committedMutationToken) &&
            activeLoginRequestKey.current === submittedRequestKey
              ? null
              : current,
          );
          setDialog((current) =>
            current.requestKey === submittedRequestKey
              ? { ...current, open: false }
              : current,
          );
        });
        await waitForBrowserPaint();
        if (
          !sessionCommitCoordinator.canCommit(committedMutationToken) ||
          activeLoginRequestKey.current !== submittedRequestKey
        ) {
          return false;
        }

        if (targetPath !== location.pathname) {
          navigate(targetPath, { replace: true });
        }
        return true;
      } catch (error) {
        if (activeLoginRequestKey.current === submittedRequestKey) {
          setLoginError(getAccessErrorMessage(error, '登录失败，请稍后重试'));
        }
        return false;
      } finally {
        setIsLoggingIn(false);
      }
    },
    [
      dialog.requestKey,
      clearBackgroundSessionWarning,
      dialog.requiredPath,
      enqueueSessionMutation,
      location.pathname,
      navigate,
      rememberReauthenticationLogin,
      sessionCommitCoordinator,
    ],
  );

  const logout = React.useCallback(async (): Promise<boolean> => {
    if (logoutPendingRef.current || impersonationPendingRef.current) return false;
    logoutPendingRef.current = true;
    setIsLoggingOut(true);
    const submittedMutationToken = sessionCommitCoordinator.beginMutation();
    requiresFeishuIdentityRef.current = false;
    setIsConfirmingIdentity(false);
    setIsLoading(false);
    try {
      const nextSession = await enqueueSessionMutation(logoutAccess);
      if (!sessionCommitCoordinator.canCommit(submittedMutationToken)) return false;
      if (hasAuthenticatedAccessIdentity(normalizeAccessSession(nextSession))) {
        throw new GuestIdentityNotConfirmedError(
          '未切换，保留当前身份。请联系管理员检查权限设置',
        );
      }
      const committedMutationToken = sessionCommitCoordinator.commitMutation(
        submittedMutationToken,
      );
      if (committedMutationToken === null) return false;
      lastReauthenticationLoginRef.current =
        getReauthenticationLoginDefaults(GUEST_SESSION);
      reauthenticationPendingRef.current = false;
      clearBackgroundSessionWarning();
      setSession((current) =>
        sessionCommitCoordinator.canCommit(committedMutationToken)
          ? normalizeAccessSession(nextSession)
          : current,
      );
      setSessionError((current) =>
        sessionCommitCoordinator.canCommit(committedMutationToken)
          ? null
          : current,
      );
      return true;
    } catch (error) {
      if (!sessionCommitCoordinator.canCommit(submittedMutationToken)) return false;
      setSessionError(
        error instanceof GuestIdentityNotConfirmedError
          ? error.message
          : getAccessErrorMessage(error, '退出权限失败'),
      );
      throw error;
    } finally {
      logoutPendingRef.current = false;
      setIsLoggingOut(false);
    }
  }, [clearBackgroundSessionWarning, enqueueSessionMutation, sessionCommitCoordinator]);

  const changeImpersonation = React.useCallback(async (action: 'start' | 'stop', clientMutationId: string, accountId?: string): Promise<boolean> => {
    if (impersonationPendingRef.current || logoutPendingRef.current || isLoggingIn || feishuConfirmation.isPending()) return false;
    const previous = sessionRef.current;
    const actorAccountId = action === 'start' ? previous.accountId : previous.impersonation?.actorAccountId;
    if (!actorAccountId || action === 'start' && (previous.role !== 'admin' || previous.impersonation)) throw new Error('只有管理员可以开始代登录');
    if (action === 'stop' && !previous.impersonation) throw new Error('当前未处于代登录状态');
    impersonationPendingRef.current = true; setIsImpersonating(true);
    const token = sessionCommitCoordinator.beginMutation();
    let reloading = false;
    try {
      await refreshPromise.current?.catch(() => undefined);
      const confirmed = await enqueueSessionMutation(() => requestImpersonation({ action, actorAccountId, accountId, clientMutationId }));
      const committed = sessionCommitCoordinator.commitMutation(token);
      if (committed === null) return false;
      flushSync(() => { setSession(normalizeAccessSession(confirmed)); setSessionError(null); setDialog(current => ({ ...current, open: false })); });
      reloading = true;
      reloadImpersonationPage(confirmed, action === 'stop');
      return true;
    } catch (error) {
      if (!sessionCommitCoordinator.canCommit(token)) return false;
      const failure = error as ImpersonationFailure;
      if (failure.currentSession) {
        const confirmed = normalizeAccessSession(failure.currentSession);
        setSession(confirmed); setSessionError(null);
        if (confirmed.accountId !== previous.accountId || !!confirmed.impersonation !== !!previous.impersonation) { reloading = true; reloadImpersonationPage(confirmed, false); }
      } else if (failure.outcomeUnknown) setSessionError(failure.message);
      throw error;
    } finally { if (!reloading) { impersonationPendingRef.current = false; setIsImpersonating(false); } }
  }, [enqueueSessionMutation, feishuConfirmation, isLoggingIn, sessionCommitCoordinator]);
  const startImpersonation = React.useCallback((accountId: string, clientMutationId: string) => changeImpersonation('start', clientMutationId, accountId), [changeImpersonation]);
  const stopImpersonation = React.useCallback((clientMutationId: string) => changeImpersonation('stop', clientMutationId), [changeImpersonation]);

  // The password endpoint confirms the write and expires the cookie. Invalidate all
  // in-flight identity reads before showing login, so none can restore the old session.
  const passwordChanged = React.useCallback(() => {
    const token = sessionCommitCoordinator.beginMutation();
    sessionCommitCoordinator.commitMutation(token);
    requiresFeishuIdentityRef.current = false;
    reauthenticationPendingRef.current = false;
    setIsConfirmingIdentity(false); setIsLoading(false); setSessionError(null);
    setSession(GUEST_SESSION);
    clearBackgroundSessionWarning();
    toast.success('密码已更新，请使用新密码重新登录');
    requestLogin('密码已更新，请重新登录。', '/personal-center', undefined, undefined, false,
      { method: 'employee', notice: '密码已更新，请使用新密码重新登录。' });
  }, [sessionCommitCoordinator, clearBackgroundSessionWarning, requestLogin]);
  const mustChangePassword = session.requiresPasswordChange === true && !session.impersonation;

  const value = React.useMemo<AccessContextValue>(
    () => ({
      ...normalizeAccessSession(session),
      readOnlyPage: session.effectiveAuthorization
        ? !professionalPageCapabilities(location.pathname,session).canEdit && !professionalPageCapabilities(location.pathname,session).canDelete
        : !defaultCanAccessPage(session.role, location.pathname) && !businessModulesForPage(location.pathname).some(module => isProfessionalBusinessPrincipal({...session,permissionContext:{module,action:'read'}}) && hasBusinessPermissionSomewhere(session,{module,action:'read'})),
      ...((session.effectiveAuthorization || isProfessionalBusinessPrincipal(session)) && businessModulesForPage(location.pathname).length ? { capabilities: professionalPageCapabilities(location.pathname, session) } : !defaultCanAccessPage(session.role, location.pathname) ? { capabilities: { canEdit: false, canDelete: false, canForceRefresh: false, canAccessContracts: false } } : {}),
      isLoading,
      isConfirmingIdentity: isConfirmingIdentity || callbackPending,
      isChangingIdentity: isLoggingIn || isLoggingOut || isImpersonating,
      isLoginDialogOpen: dialog.open && !mustChangePassword,
      dismissedLoginPath,
      sessionError,
      login,
      logout,
      passwordChanged,
      refreshSession,
      retrySession,
      startImpersonation,
      stopImpersonation,
      requestLogin,
    }),
    [
      isLoading,
      isConfirmingIdentity,
      isLoggingIn,
      isLoggingOut,
      isImpersonating,
      dialog.open,
      dismissedLoginPath,
      callbackPending,
      login,
      logout,
      passwordChanged,
      refreshSession,
      retrySession,
      startImpersonation,
      stopImpersonation,
      requestLogin,
      session,
      sessionError,
      location.pathname,
    ],
  );

  return (
    <AccessContext.Provider value={value}>
      <ImpersonationBanner />
      {mustChangePassword ? <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><p className="text-sm text-muted-foreground">请先设置新的登录密码</p></main> : children}
      {mustChangePassword && <PasswordChangeDialog key={session.accountId} open required onClose={() => undefined} onSuccess={passwordChanged} onLogout={async () => { if (await logout()) requestLogin('请重新登录。'); }} />}
      <AccessLoginDialog
        key={dialog.requestKey}
        open={dialog.open && !mustChangePassword}
        reason={dialog.reason}
        resetKey={dialog.requestKey}
        initialMethod={dialog.preferredMethod}
        notice={dialog.notice}
        error={loginError}
        isSubmitting={isLoggingIn || isLoggingOut}
        onOpenChange={(open) => {
          setDialog((current) => ({ ...current, open }));
          if (!open) setDismissedLoginPath(dialog.requiredPath || location.pathname);
          if (!open) reauthenticationPendingRef.current = false;
          if (!open) setLoginError(null);
        }}
        onSubmit={login}
        onPasswordReset={passwordChanged}
      />
      <Dialog open={isImpersonating}>
        <DialogContent showCloseButton={false} onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
          <DialogHeader><DialogTitle>正在切换身份…</DialogTitle><DialogDescription>请稍候，正在确认登录身份并重新加载页面。</DialogDescription></DialogHeader>
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />当前操作暂不可用</p>
        </DialogContent>
      </Dialog>
    </AccessContext.Provider>
  );
}

export function useAccess(): AccessContextValue {
  const context = React.useContext(AccessContext);
  if (!context) {
    throw new Error('useAccess 必须在 AccessProvider 内使用');
  }
  return context;
}

export function getAccessCapabilities(role: AccessRole): AccessCapabilities {
  return capabilitiesForRole(role);
}

function AccessLoginDialog({
  open,
  reason,
  resetKey,
  initialMethod = 'feishu',
  notice,
  error,
  isSubmitting,
  onOpenChange,
  onSubmit,
  onPasswordReset,
}: {
  open: boolean;
  reason: string;
  resetKey: number;
  initialMethod?: 'feishu' | 'employee';
  notice?: string;
  error: string | null;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: AccessLoginRequest) => Promise<boolean>;
  onPasswordReset: () => void;
}) {
  const [password, setPassword] = React.useState('');
  const [method, setMethod] = React.useState<'feishu' | 'shared' | 'employee'>(initialMethod);
  const [employeeName, setEmployeeName] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [forgotPassword, setForgotPassword] = React.useState(false);
  const [submittedMethod, setSubmittedMethod] = React.useState<string>();
  const feishuLogin = useFeishuLogin(undefined, open, isSubmitting);
  const busy = isSubmitting || feishuLogin.isPending;
  const canSubmit = Boolean(password && (method === 'shared' || (method === 'employee' && employeeName.trim())) && !busy);
  const changeMethod = (next: 'feishu' | 'shared' | 'employee') => {
    setMethod(next); setPassword(''); setShowPassword(false);
  };

  React.useEffect(() => {
    setPassword(''); setEmployeeName(''); setMethod(initialMethod); setShowPassword(false); setSubmittedMethod(undefined); setForgotPassword(false);
  }, [open, resetKey, initialMethod]);

  if (!open) return null;

  if (forgotPassword) return <ForgotPasswordDialog open initialName={employeeName} onClose={() => setForgotPassword(false)} onSuccess={() => { setPassword(''); setForgotPassword(false); onPasswordReset(); }} />;

  const passwordForm = <form className="space-y-4" onSubmit={(event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmittedMethod(method);
    void onSubmit({ password, ...(method === 'employee' ? { employeeName: employeeName.trim() } : {}) });
  }}>
    {method === 'employee' ? <LoginNameField value={employeeName} onChange={setEmployeeName} disabled={busy} /> : <p className="text-sm font-medium">备用密码登录</p>}
    <label className="block space-y-2 text-sm font-medium">
      <span>{method === 'employee' ? '密码' : '访问密码'}</span>
      <span className="relative block">
        <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" maxLength={256} className="h-11 pl-9 pr-11" disabled={busy} autoFocus={method === 'shared'} />
        <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 size-9 -translate-y-1/2 text-muted-foreground" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(value => !value)}>
          {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </span>
    </label>
    {method === 'employee' && <p className="text-xs leading-5 text-muted-foreground">首次登录，默认密码为本人身份证号后 6 位。</p>}
    {method === 'employee' && <div className="flex justify-end"><Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={() => { setPassword(''); setForgotPassword(true); }}>忘记密码？</Button></div>}
    {error && submittedMethod === method ? <p className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></p> : null}
    <DialogFooter><Button type="submit" className="h-11 w-full" disabled={!canSubmit} aria-busy={isSubmitting}>{isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{isSubmitting ? '验证中…' : '登录'}</Button></DialogFooter>
  </form>;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg" aria-describedby="access-login-help">
      <DialogHeader>
        <div className="mb-2 flex size-11 items-center justify-center rounded-lg bg-primary/5 text-primary"><ShieldCheck className="size-6" aria-hidden="true" /></div>
        <DialogTitle>统一登录</DialogTitle>
        <DialogDescription id="access-login-help" className="sr-only">{reason} 选择一种登录方式即可。</DialogDescription>
      </DialogHeader>
      {notice && <p role="status" className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm leading-6 text-primary">{notice}</p>}
      {method !== 'shared' ? <Tabs value={method} onValueChange={value => changeMethod(value as 'feishu' | 'employee')} className="gap-4">
        <p className="text-sm text-muted-foreground">请选择一种方式登录</p>
        <TabsList className="grid h-12 w-full grid-cols-2 border bg-background p-0" aria-label="登录方式">
          <TabsTrigger value="feishu" disabled={busy} className="h-full rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary"><FeishuIcon />飞书授权登录</TabsTrigger>
          <TabsTrigger value="employee" disabled={busy} className="h-full rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary">姓名登录</TabsTrigger>
        </TabsList>
        <p className="text-xs leading-5 text-muted-foreground">智航、互联同事请使用飞书授权登录；<br />其他同事请使用姓名和密码登录。</p>
        <TabsContent value="feishu" className="space-y-5">
          <div className="flex flex-col items-center gap-4 py-6"><div className="flex size-20 items-center justify-center rounded-full bg-primary/5"><FeishuIcon className="size-10" /></div><p className="font-medium">使用飞书账号授权</p></div>
          <Button type="button" className="h-11 w-full" disabled={busy} aria-busy={feishuLogin.isPending} onClick={feishuLogin.start}>{feishuLogin.isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{feishuLogin.isPending ? '正在打开飞书授权…' : '飞书授权登录'}</Button>
          {feishuLogin.error && <p role="alert" className="text-sm text-destructive">{feishuLogin.error}</p>}
        </TabsContent>
        <TabsContent value="employee">{passwordForm}</TabsContent>
      </Tabs> : passwordForm}
      <div className="flex justify-center border-t pt-3"><Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground" disabled={busy} aria-expanded={method === 'shared'} onClick={() => changeMethod(method === 'shared' ? 'employee' : 'shared')}>{method === 'shared' ? '返回姓名登录' : '备用登录'}<ChevronRight className="size-3" aria-hidden="true" /></Button></div>
    </DialogContent>
  </Dialog>;
}

function waitForBrowserPaint(): Promise<void> {
  return new Promise((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      resolve();
    };
    window.setTimeout(finish, 100);
    window.requestAnimationFrame(() => {
      window.setTimeout(finish, 0);
    });
  });
}

function getAccessErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return fallback;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return fallback;
  const message = (data as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (Array.isArray(message)) {
    const joined = message
      .filter((item) => typeof item === 'string')
      .join('；');
    if (joined) return joined;
  }
  return fallback;
}
