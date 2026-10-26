import { canAccessPage } from './access-policy';

interface SwitchAccessToGuestOptions {
  logout: () => Promise<boolean | void>;
  pathname: string;
  navigate: (pathname: string, options: { replace: boolean }) => void;
  onSuccess: () => void;
  onError: () => void;
}

export async function switchAccessToGuest({
  logout,
  pathname,
  navigate,
  onSuccess,
  onError,
}: SwitchAccessToGuestOptions): Promise<boolean> {
  try {
    if (await logout() === false) return false;
  } catch {
    onError();
    return false;
  }

  onSuccess();
  if (!canAccessPage('guest', pathname)) {
    navigate('/monthly-schedule', { replace: true });
  }
  return true;
}
