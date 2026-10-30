import { useCallback, useEffect, useRef, useState } from 'react';
import type { AliMonthlyReportConfigResponse } from '@shared/api.interface';
import type { AliMonthlyReportEmailSettings, SaveAliMonthlyReportEmailSettings } from '@shared/ali-monthly-report-email-settings';
import { getAliMonthlyReportEmailSettings, MonthlyEmailSettingsError, saveAliMonthlyReportEmailSettings } from '@/api/ali-monthly-report-email-settings';
import { emailSettingsIssue, emailSettingsMutationId, normalizedEmailDraft } from './email-settings.logic';

export function useEmailSettings(open: boolean, identity: string, onSaved: (config: AliMonthlyReportConfigResponse) => void) {
  const [settings, setSettings] = useState<AliMonthlyReportEmailSettings | null>(null);
  const [latest, setLatest] = useState<AliMonthlyReportEmailSettings | null>(null);
  const [senderEmail, setSender] = useState('');
  const [authCode, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [availability, setAvailability] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = useRef({ identity, open, epoch: 0, edited: 0, dirty: false, settings: null as AliMonthlyReportEmailSettings | null,
    available: false, reviewRequired: false, load: null as AbortController | null, save: null as AbortController | null, pending: null as SaveAliMonthlyReportEmailSettings | null });
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const isCurrent = (epoch: number) => state.current.epoch === epoch && state.current.identity === currentIdentity.current;

  const load = useCallback(async () => {
    const current = state.current;
    if (!current.open || current.identity !== currentIdentity.current || current.load || current.save) return;
    const controller = new AbortController(), epoch = current.epoch, edited = current.edited;
    current.load = controller; setLoading(true); setError(null);
    try {
      const data = await getAliMonthlyReportEmailSettings(controller.signal);
      if (!isCurrent(epoch) || controller.signal.aborted) return;
      current.available = data.canSave; setAvailability(data.canSave);
      if (!data.canSave) {
        // Availability is not an identity change. Keep the original revision and retry request intact.
        if (!current.settings) setSettings(data);
        if (!current.settings && edited === current.edited && !current.dirty) setSender(data.senderEmail);
      } else if (current.pending) {
        // A completed-but-unacknowledged write must be retried with its original id and revision.
        setBlocked(false); setLatest(null); setConflict(false);
      } else if (current.settings && (data.revision !== current.settings.revision || current.reviewRequired) && (current.dirty || current.pending)) {
        setLatest(data); setConflict(true);
        setError('配置已更新，当前输入已保留。请核对最新发件邮箱后再保存。');
      } else if (!current.settings || (!current.dirty && !current.pending)) {
        current.settings = data; setSettings(data); setLatest(null);
        if (edited === current.edited && !current.dirty) setSender(data.senderEmail);
        setBlocked(false);
      } else if (data.revision === current.settings.revision) {
        current.settings = data; setSettings(data); setBlocked(false);
      }
    } catch (failure) {
      if (!isCurrent(epoch) || controller.signal.aborted) return;
      setError(failure instanceof MonthlyEmailSettingsError ? failure.message : '邮箱配置读取失败，请重试。');
      if (failure instanceof MonthlyEmailSettingsError && [401, 403].includes(failure.status || 0)) {
        current.pending = null; current.available = false; setAvailability(null); setCode(''); setBlocked(true); setUncertain(false);
      }
    } finally {
      if (isCurrent(epoch) && current.load === controller) { current.load = null; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    const current = state.current;
    if (current.identity !== identity) {
      current.settings = null; current.pending = null; current.dirty = false; current.reviewRequired = false; current.available = false;
      setSettings(null); setLatest(null); setSender(''); setCode(''); setUncertain(false); setConflict(false); setBlocked(false); setError(null);
      setAvailability(null);
      current.load = null; current.save = null; setLoading(false); setSaving(false);
    }
    current.identity = identity;
    return () => {
      current.epoch++; current.load?.abort(); current.save?.abort(); current.pending = null;
      current.load = null; current.save = null;
    };
  }, [identity]);

  useEffect(() => {
    const current = state.current; current.open = open;
    if (open) { void load(); return; }
    current.epoch++; current.load?.abort(); current.load = null; setLoading(false);
    if (current.save) {
      current.save.abort(); current.save = null; setSaving(false); setUncertain(true);
      setError('保存结果暂未确认，请保留当前内容，使用原请求重试。');
    }
  }, [open, identity, load]);

  const edit = (field: 'sender' | 'code', value: string) => {
    const current = state.current;
    if (current.save || uncertain || blocked) return;
    current.edited++; current.dirty = true; current.pending = null;
    field === 'sender' ? setSender(value) : setCode(value);
    setError(null);
  };

  const adoptLatest = () => {
    if (!latest || saving || !state.current.available) return;
    state.current.settings = latest; state.current.pending = null; state.current.reviewRequired = false;
    setSettings(latest); setLatest(null); setConflict(false); setUncertain(false); setBlocked(false); setError(null);
  };

  const save = async (): Promise<boolean> => {
    const current = state.current;
    if (!current.open || !current.available || current.save || current.load || blocked || (conflict && !uncertain) || current.identity !== currentIdentity.current) return false;
    if (!current.pending) {
      const issue = emailSettingsIssue(current.settings, senderEmail, authCode);
      if (issue) { setError(issue); return false; }
      const draft = normalizedEmailDraft(senderEmail, authCode);
      current.pending = { senderEmail: draft.senderEmail, ...(draft.authCode ? { authCode: draft.authCode } : {}),
        expectedRevision: current.settings!.revision, clientMutationId: emailSettingsMutationId() };
    }
    const request = current.pending, controller = new AbortController(), epoch = current.epoch;
    current.save = controller; setSaving(true); setError(null);
    try {
      const result = await saveAliMonthlyReportEmailSettings(request, controller.signal);
      if (!isCurrent(epoch) || controller.signal.aborted) return false;
      current.settings = result.settings; current.pending = null; current.dirty = false; current.reviewRequired = false;
      current.available = result.settings.canSave; setAvailability(result.settings.canSave);
      setSettings(result.settings); setSender(result.settings.senderEmail); setCode(''); setLatest(null);
      setUncertain(false); setConflict(false); setBlocked(false);
      savedCallback.current(result.config);
      return true;
    } catch (failure) {
      if (!isCurrent(epoch) || controller.signal.aborted) return false;
      const known = failure instanceof MonthlyEmailSettingsError ? failure : new MonthlyEmailSettingsError('保存结果暂未确认，请保留当前内容，使用原请求重试。', undefined, true);
      setError(known.message); setUncertain(known.uncertain);
      if (!known.uncertain) current.pending = null;
      if (known.status === 409) { current.reviewRequired = true; setConflict(true); }
      if ([401, 403].includes(known.status || 0)) { current.available = false; setAvailability(null); setCode(''); setBlocked(true); }
      return false;
    } finally {
      if (isCurrent(epoch) && current.save === controller) { current.save = null; setSaving(false); }
    }
  };

  return { settings, latest, senderEmail, authCode, loading, saving, uncertain, conflict, blocked, error, canSave: availability === true, unavailable: availability === false,
    setSenderEmail: (value: string) => edit('sender', value), setAuthCode: (value: string) => edit('code', value),
    load, save, adoptLatest, locked: saving || uncertain || blocked };
}
