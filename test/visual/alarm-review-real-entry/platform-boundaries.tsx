// Exact platform/telemetry import boundaries only. No auth or axios exports.
export const logger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
export function getStacktrace() { return undefined; }
export const observable = { log() {}, startSpan() { return undefined; } };
export const slardar = { sendEvent() {}, captureException() {} };
export function useCurrentUserProfile() { return { user: undefined, loading: false }; }
export async function getDataloom(): Promise<never> { throw new Error('External platform profile excluded from isolated fixture'); }
