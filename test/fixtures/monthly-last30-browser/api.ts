import axios from 'axios';
export const axiosForBackend = axios.create();
export const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
axiosForBackend.interceptors.request.use((config) => {
  const scenario = sessionStorage.getItem('monthly-fixture-case') || 'normal';
  config.params = { ...config.params, __case: scenario };
  if (scenario === 'timeout') config.timeout = 150;
  return config;
});
