import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readEnv } from '../config/external-services.config';

// Read-only dashboards may use this last successfully resolved Wiki binding to
// locate an exact existing record snapshot while the network is unavailable.
// It is never an authorization source and contains no credentials or records.
export interface DashboardSourceBinding {
  namespace: string;
  appId: string;
  appToken?: string;
  wikiToken?: string;
  tableId: string;
  viewId?: string;
  fieldNames?: readonly string[];
}

export function dashboardSourceBindingKey(source: DashboardSourceBinding): string {
  return JSON.stringify({
    namespace: source.namespace.trim(), appId: source.appId.trim(),
    appToken: source.appToken?.trim() || '', wikiToken: source.wikiToken?.trim() || '',
    tableId: source.tableId.trim(), viewId: source.viewId?.trim() || '',
    fieldNames: [...new Set((source.fieldNames ?? []).map(value => value.trim()).filter(Boolean))].sort(),
  });
}

function bindingPath(sourceKey: string): string {
  const directory = resolve(readEnv('FEISHU_LOCAL_CACHE_DIR') || join(process.cwd(), 'data', 'feishu-bitable-cache'));
  return join(directory, `dashboard-source-${createHash('sha256').update(sourceKey).digest('hex')}.json`);
}

export async function readDashboardSourceBinding(source: DashboardSourceBinding): Promise<string | null> {
  const sourceKey = dashboardSourceBindingKey(source);
  try {
    const value = JSON.parse(await readFile(bindingPath(sourceKey), 'utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    return item.version === 1 && item.sourceKey === sourceKey &&
      typeof item.appToken === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(item.appToken)
      && (!source.appToken?.trim() || source.appToken.trim() === item.appToken)
      ? item.appToken : null;
  } catch { return null; }
}

export async function writeDashboardSourceBinding(source: DashboardSourceBinding, appToken: string): Promise<void> {
  const sourceKey = dashboardSourceBindingKey(source);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(appToken)) throw new Error('Invalid dashboard source binding');
  if (source.appToken?.trim() && source.appToken.trim() !== appToken) throw new Error('Dashboard source binding mismatch');
  const path = bindingPath(sourceKey);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, sourceKey, appToken }), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
