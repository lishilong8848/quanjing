import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface SwitchAccessToGuestOptions {
  logout: () => Promise<boolean | void>;
  pathname: string;
  navigate: (pathname: string, options: { replace: boolean }) => void;
  onSuccess: () => void;
  onError: () => void;
}

type SwitchAccessToGuest = (
  options: SwitchAccessToGuestOptions,
) => Promise<boolean>;

const modulePath = resolve('client/src/access/identity-switch.ts');

function loadSwitchAccessToGuest(): SwitchAccessToGuest {
  expect(existsSync(modulePath)).toBe(true);
  const identitySwitchModule = require(modulePath) as {
    switchAccessToGuest?: SwitchAccessToGuest;
  };
  expect(typeof identitySwitchModule.switchAccessToGuest).toBe('function');
  return identitySwitchModule.switchAccessToGuest as SwitchAccessToGuest;
}

describe('switchAccessToGuest', () => {
  it('does not announce or navigate after a superseded logout', async () => {
    const switchAccessToGuest = loadSwitchAccessToGuest();
    const navigate = jest.fn(), onSuccess = jest.fn(), onError = jest.fn();
    expect(await switchAccessToGuest({ logout: async () => false, pathname: '/organization', navigate, onSuccess, onError })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it('logs out before reporting success and redirects a restricted path', async () => {
    const switchAccessToGuest = loadSwitchAccessToGuest();
    const events: string[] = [];
    const navigate = jest.fn(
      (pathname: string, options: { replace: boolean }) => {
        events.push(`navigate:${pathname}:${String(options.replace)}`);
      },
    );

    const result = await switchAccessToGuest({
      logout: async () => {
        await Promise.resolve();
        events.push('logout');
      },
      pathname: '/operations-kb',
      navigate,
      onSuccess: () => events.push('success'),
      onError: () => events.push('error'),
    });

    expect(result).toBe(true);
    expect(events).toEqual([
      'logout',
      'success',
      'navigate:/monthly-schedule:true',
    ]);
    expect(navigate).toHaveBeenCalledWith('/monthly-schedule', {
      replace: true,
    });
  });

  it('reports success without navigating from a guest-readable path', async () => {
    const switchAccessToGuest = loadSwitchAccessToGuest();
    const events: string[] = [];
    const navigate = jest.fn();

    const result = await switchAccessToGuest({
      logout: async () => {
        events.push('logout');
      },
      pathname: '/monthly-schedule',
      navigate,
      onSuccess: () => events.push('success'),
      onError: () => events.push('error'),
    });

    expect(result).toBe(true);
    expect(events).toEqual(['logout', 'success']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reports only the error when logout rejects', async () => {
    const switchAccessToGuest = loadSwitchAccessToGuest();
    const events: string[] = [];
    const navigate = jest.fn(() => events.push('navigate'));

    const result = await switchAccessToGuest({
      logout: async () => {
        events.push('logout');
        throw new Error('logout failed');
      },
      pathname: '/operations-kb',
      navigate,
      onSuccess: () => events.push('success'),
      onError: () => events.push('error'),
    });

    expect(result).toBe(false);
    expect(events).toEqual(['logout', 'error']);
    expect(navigate).not.toHaveBeenCalled();
  });
});
