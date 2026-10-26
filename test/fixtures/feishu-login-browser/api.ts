import axios from 'axios';
export const axiosForBackend = axios.create();
export const logger = { info() {}, error() {}, warn() {} };
export function useCurrentUserProfile() {
  return { name: '', avatar: '', user_id: '' };
}
export async function getDataloom() {
  throw new Error('The fixture has no platform session');
}
async function session(path: string, method = 'GET', body?: unknown) {
  const response = await axiosForBackend({ url: `/api/access/${path}`, method, data: body, timeout: 10000 });
  const status = response.headers['x-access-session-cookie'];
  return { ...response.data, ...(typeof status === 'string' && ['absent', 'duplicate', 'malformed', 'rejected', 'valid', 'disabled'].includes(status) ? { sessionCookieStatus: status } : {}) };
}
export const getAccessSession = () => session('session');
export const loginAccess = (request: unknown) =>
  session('login', 'POST', request);
export const logoutAccess = () => session('logout', 'POST');
