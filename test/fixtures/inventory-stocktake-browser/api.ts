import axios from 'axios';
export const axiosForBackend = axios.create();
export const logger = {
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
axiosForBackend.interceptors.request.use((config) => {
  if (config.data?.note === '测试超时重试') config.timeout = 200;
  return config;
});
