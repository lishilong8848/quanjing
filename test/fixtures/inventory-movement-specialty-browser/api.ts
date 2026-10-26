import axios from 'axios';
export const axiosForBackend = axios.create();
export const logger = {
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
