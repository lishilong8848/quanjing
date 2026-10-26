import { createFeishuLoginNavigation } from '../../client/src/access/feishu-auth';

describe('Feishu login navigation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('blocks OAuth while a cookie-changing mutation is pending, including a queued navigation', () => {
    let allowed = false;
    const navigate = jest.fn(), setPending = jest.fn(), onError = jest.fn();
    const navigation = createFeishuLoginNavigation({ navigate, setPending, onError, canNavigate: () => allowed });
    expect(navigation.start('/authorize')).toBe(false);
    allowed = true;
    expect(navigation.start('/authorize')).toBe(true);
    allowed = false;
    jest.advanceTimersByTime(0);
    expect(navigate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(setPending).toHaveBeenLastCalledWith(false);
    allowed = true;
    expect(navigation.start('/authorize')).toBe(true);
    jest.advanceTimersByTime(0);
    expect(navigate).toHaveBeenCalledTimes(1);
    navigation.reset();
  });

  function setup(navigate = jest.fn()) {
    const setPending = jest.fn();
    const onError = jest.fn();
    return {
      navigate,
      setPending,
      onError,
      navigation: createFeishuLoginNavigation({
        navigate,
        setPending,
        onError,
      }),
    };
  }

  it('reports pending before navigation and prevents repeated clicks', () => {
    const { navigation, navigate, setPending } = setup();
    expect(navigation.start('/api/access/feishu/authorize')).toBe(true);
    expect(setPending).toHaveBeenCalledWith(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(navigation.start('/duplicate')).toBe(false);
    jest.advanceTimersByTime(0);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/api/access/feishu/authorize');
    navigation.reset();
  });

  it('restores retry after a rejected browser navigation', () => {
    const { navigation, setPending, onError } = setup(
      jest.fn(() => {
        throw new Error('navigation blocked');
      }),
    );
    navigation.start('/authorize');
    jest.advanceTimersByTime(0);
    expect(setPending).toHaveBeenLastCalledWith(false);
    expect(onError).toHaveBeenCalledWith('飞书登录跳转失败，请重试');
    expect(navigation.start('/retry')).toBe(true);
    navigation.reset();
  });

  it('does not leave a blocked navigation permanently pending', () => {
    const { navigation, setPending, onError } = setup();
    navigation.start('/authorize');
    jest.advanceTimersByTime(10_000);
    expect(setPending).toHaveBeenLastCalledWith(false);
    expect(onError).toHaveBeenCalledWith('飞书登录页面未打开，请重试');
    expect(navigation.start('/retry')).toBe(true);
    navigation.reset();
  });

  it('cancels pending navigation when closing the login or returning with browser back', () => {
    const { navigation, navigate, onError } = setup();
    navigation.start('/authorize');
    navigation.reset();
    jest.runAllTimers();
    expect(navigate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(navigation.start('/retry')).toBe(true);
    navigation.reset();
  });
});
