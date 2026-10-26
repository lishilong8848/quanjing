import axios from 'axios';
export const axiosForBackend = axios.create();
export const logger = {
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
axiosForBackend.interceptors.request.use((config) => {
  config.headers['X-Fixture-Principal'] = encodeURIComponent(sessionStorage.getItem('ledger-fixture-principal') || 'admin');
  const mode = sessionStorage.getItem('ledger-fixture-mode') || 'normal';
  config.params = { ...config.params, __case: mode };
  if (mode === 'timeout') config.timeout = 150;
  if (mode === 'late') config.signal = undefined;
  return config;
});
