export const CHANGE_REQUEST_DIRECT_PATH = '/monthly-schedule/apply/change';

export function isChangeRequestDirectPath(pathname: string): boolean {
  return (
    String(pathname || '/')
      .toLowerCase()
      .replace(/\/+$/g, '') === CHANGE_REQUEST_DIRECT_PATH
  );
}

export function getChangeRequestDirectHref(): string {
  const base = String(process.env.CLIENT_BASE_PATH || '').replace(
    /^\/+|\/+$/g,
    '',
  );
  return `${base ? `/${base}` : ''}${CHANGE_REQUEST_DIRECT_PATH}`;
}
