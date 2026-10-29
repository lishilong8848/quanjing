import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccessPrincipal } from '@shared/access-control.interface';
import type { PersonalArchiveResponse } from '@shared/personnel-archive.interface';
import { getPersonalArchive, getPersonalArchivePhoto } from '@/api/personal-access';

export function personalArchiveIdentity(principal: AccessPrincipal & { principalFingerprint?: string | null }): string {
  return JSON.stringify([principal.accountId, principal.authorizationVersion, principal.principalFingerprint, principal.impersonation?.actorAccountId]);
}

interface ArchiveState { identity: string; response?: PersonalArchiveResponse; loading: boolean; error: string }
interface PhotoState { key: string; url: string | null; loading: boolean; error: string }
const emptyPhoto = (key: string): PhotoState => ({ key, url: null, loading: false, error: '' });

/** Keep successful data only for the same identity; never persist personnel data in browser storage. */
export function usePersonalArchive(identity: string) {
  const [state, setState] = useState<ArchiveState>({ identity, loading: true, error: '' });
  const alive = useRef(true), sequence = useRef(0);
  const pending = useRef<{ identity: string; controller: AbortController; promise: Promise<void> } | undefined>(undefined);
  const refresh = useCallback(() => {
    if (pending.current?.identity === identity) return pending.current.promise;
    pending.current?.controller.abort();
    const controller = new AbortController(), generation = ++sequence.current;
    setState(previous => ({ ...(previous.identity === identity ? previous : { identity }), loading: true, error: '' }));
    const promise = getPersonalArchive(controller.signal).then(response => {
      if (alive.current && !controller.signal.aborted && generation === sequence.current) setState({ identity, response, loading: false, error: '' });
    }).catch(failure => {
      if (alive.current && !controller.signal.aborted && generation === sequence.current) setState(previous => ({
        ...(previous.identity === identity ? previous : { identity }), loading: false, error: failure instanceof Error ? failure.message : '档案读取失败，请重试',
      }));
    }).finally(() => { if (generation === sequence.current) pending.current = undefined; });
    pending.current = { identity, controller, promise };
    return promise;
  }, [identity]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; sequence.current++; pending.current?.controller.abort(); pending.current = undefined; };
  }, [refresh]);

  // Filtering during render also prevents one frame of the previous user's data.
  const current: ArchiveState = state.identity === identity ? state : { identity, loading: true, error: '' };
  const response = current.response, profile = response?.status === 'ready' ? response.profile : null;
  const [photoAttempt, setPhotoAttempt] = useState(0);
  const photoKey = JSON.stringify([identity, response?.snapshotAt, profile?.photoUrl, photoAttempt]);
  const [photoState, setPhotoState] = useState<PhotoState>(() => emptyPhoto(photoKey));
  useEffect(() => {
    let active = true, objectUrl: string | null = null;
    const controller = new AbortController();
    if (!profile?.photoUrl) { setPhotoState(emptyPhoto(photoKey)); return () => { active = false; controller.abort(); }; }
    if (profile.photoUrl !== '/api/access/personal/archive/photo') {
      setPhotoState({ ...emptyPhoto(photoKey), error: '照片暂不可用' });
      return () => { active = false; controller.abort(); };
    }
    setPhotoState({ ...emptyPhoto(photoKey), loading: true });
    void getPersonalArchivePhoto(controller.signal).then(blob => {
      if (!active || controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPhotoState({ key: photoKey, url: objectUrl, loading: false, error: '' });
    }).catch(() => {
      if (active && !controller.signal.aborted) setPhotoState({ ...emptyPhoto(photoKey), error: '照片读取失败' });
    });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photoKey, profile?.photoUrl]);
  const photo = photoState.key === photoKey ? photoState : emptyPhoto(photoKey);
  const retryPhoto = useCallback(() => setPhotoAttempt(attempt => attempt + 1), []);
  const photoFailed = useCallback(() => {
    setPhotoState(previous => {
      if (previous.key !== photoKey) return previous;
      if (previous.url) URL.revokeObjectURL(previous.url);
      return { ...emptyPhoto(photoKey), error: '照片无法显示' };
    });
  }, [photoKey]);
  return { ...current, response, profile, refresh, photo, retryPhoto, photoFailed };
}
