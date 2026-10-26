import { getCurrentCsrfToken } from '../../api/csrf-token';

const configuredBasePath = typeof process === 'undefined' ? '' : String(process.env.CLIENT_BASE_PATH || '');
const normalizedBasePath = configuredBasePath.replace(/^\/+|\/+$/gu, '');
const endpoint = `${normalizedBasePath ? `/${normalizedBasePath}` : ''}/api/bitable/mbti-assessment`;

async function jsonResponse<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(value.message || `请求失败（${response.status}）`);
  return value;
}

export async function searchMbtiActivePeople(query: string, signal?: AbortSignal) {
  return jsonResponse<{ people: Array<{ recordId: string; name: string; position: string; buildings: string[] }>; stale: boolean }>(
    await fetch(`${endpoint}/people?q=${encodeURIComponent(query)}`, { signal, credentials: 'same-origin' }),
  );
}

export async function getMbtiCurrentPerson(signal?: AbortSignal) {
  return jsonResponse<{ recordId: string; name: string; position: string; buildings: string[] }>(
    await fetch(`${endpoint}/me`, { signal, credentials: 'same-origin' }),
  );
}

export async function getMbtiOnboardingContext(ticket: string) {
  return jsonResponse<{ recordId: string; name: string }>(
    await fetch(`${endpoint}/onboarding?ticket=${encodeURIComponent(ticket)}`, { credentials: 'same-origin' }),
  );
}

export async function syncMbtiResult(payload: {
  clientMutationId: string;
  audience: 'active' | 'new';
  recordId?: string;
  name: string;
  ticket?: string;
  version: 'short' | 'full';
  answers: Array<number | 'A' | 'B' | null>;
  sourceSha256: string;
}): Promise<{ recordId: string; type: string; syncState: 'success' }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const token = getCurrentCsrfToken();
    const accepted = await jsonResponse<{ recordId: string; type: string; syncState: 'accepted' | 'success' | 'error'; message?: string }>(
      await fetch(`${endpoint}/submit`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Suda-Csrf-Token': token } : {}) },
        body: JSON.stringify(payload), signal: controller.signal,
      }),
    );
    if (accepted.syncState === 'success') return { ...accepted, syncState: 'success' };
    if (accepted.syncState === 'error') throw new Error(accepted.message || '飞书同步失败，请重试');
    while (!controller.signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 650);
        controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(new Error('同步仍在后台进行，请稍后重试')); }, { once: true });
      });
      const state = await jsonResponse<{ recordId: string; type: string; syncState: 'accepted' | 'success' | 'error'; message?: string }>(
        await fetch(`${endpoint}/submissions/${encodeURIComponent(payload.clientMutationId)}`, { credentials: 'same-origin', signal: controller.signal }),
      );
      if (state.recordId !== accepted.recordId || state.type !== accepted.type) throw new Error('同步结果与本次测试不一致');
      if (state.syncState === 'success') return { ...state, syncState: 'success' };
      if (state.syncState === 'error') throw new Error(state.message || '飞书同步失败，请重试');
    }
    throw new Error('同步仍在后台进行，请稍后重试');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('同步仍在后台进行，请稍后重试');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
