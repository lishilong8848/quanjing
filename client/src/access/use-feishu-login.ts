import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation } from 'react-router-dom';

import {
  buildFeishuAuthorizationUrl,
  createFeishuLoginNavigation,
} from './feishu-auth';

export function useFeishuLogin(
  onError?: (message: string) => void,
  active = true,
  blocked = false,
) {
  const location = useLocation();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [navigation] = useState(() =>
    createFeishuLoginNavigation({
      navigate: (url) => window.location.assign(url),
      canNavigate: () => !blockedRef.current,
      setPending: (pending) => setIsPending(pending),
      onError: (message) => {
        setError(message);
        onErrorRef.current?.(message);
      },
    }),
  );

  useEffect(() => {
    if (!active || blocked) {
      navigation.reset();
      return;
    }
    window.addEventListener('pageshow', navigation.reset);
    window.addEventListener('pagehide', navigation.reset);
    return () => {
      window.removeEventListener('pageshow', navigation.reset);
      window.removeEventListener('pagehide', navigation.reset);
      navigation.reset();
    };
  }, [active, blocked, navigation]);

  const start = useCallback(() => {
    setError(null);
    flushSync(() => {
      navigation.start(
        buildFeishuAuthorizationUrl(
          location.pathname,
          location.search,
          location.hash,
        ),
      );
    });
  }, [location.hash, location.pathname, location.search, navigation]);

  return { start, isPending, error };
}
