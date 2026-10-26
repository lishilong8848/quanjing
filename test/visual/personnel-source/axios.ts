export async function axiosForBackend({ url, method, data, timeout }: { url: string; method: string; data?: unknown; timeout?: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 15_000);
  try {
    const response = await fetch(url, { method, signal: controller.signal, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const payload = await response.json();
    if (!response.ok) throw { response: { status: response.status, data: payload } };
    return { status: response.status, data: payload };
  } catch (error) {
    if (controller.signal.aborted) throw { code: 'ECONNABORTED' };
    throw error;
  } finally { clearTimeout(timer); }
}
