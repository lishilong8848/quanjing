import { readEnv } from './external-services.config';

export function readPublicApplicationUrl(fallbackNames: string[]): string {
  const publicUrl = readEnv('PUBLIC_BASE_URL');
  if (!publicUrl) {
    for (const name of fallbackNames) {
      const fallback = readEnv(name);
      if (fallback) return fallback;
    }
    return '';
  }

  const clientPath = readEnv('CLIENT_BASE_PATH');
  if (!clientPath || clientPath === '/') return publicUrl;
  const rawUrl = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/iu.exec(publicUrl);
  if (!rawUrl || /[\\\u0000-\u001f\u007f]/u.test(publicUrl) || !safePath(rawUrl[1] || '') ||
      clientPath.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(clientPath) ||
      !safePath(clientPath)) throw invalidConfiguration();

  let url: URL;
  try { url = new URL(publicUrl); } catch { throw invalidConfiguration(); }
  if (url.username || url.password || url.search || url.hash) throw invalidConfiguration();
  const origin = url.origin;
  const prefix = clientPath.replace(/\/+$/u, '');
  // PUBLIC_BASE_URL is the public mount; legacy module URLs already include their complete mount.
  url.pathname = url.pathname.replace(/\/+$/u, '') + (prefix.startsWith('/') ? prefix : `/${prefix}`);
  if (url.origin !== origin) throw invalidConfiguration();
  return url.toString();
}

function safePath(path: string): boolean {
  return path.split('/').every((segment) => {
    let decoded = segment;
    for (let depth = 0; depth <= 2; depth += 1) {
      if (decoded === '.' || decoded === '..' || /[\/\\?#\u0000-\u001f\u007f]/u.test(decoded) ||
          /%(?![a-f\d]{2})/iu.test(decoded)) return false;
      if (!decoded.includes('%')) return true;
      if (depth === 2) return false;
      try { decoded = decodeURIComponent(decoded); } catch { return false; }
    }
    return false;
  });
}

function invalidConfiguration(): Error {
  return new Error('PUBLIC_BASE_URL 或 CLIENT_BASE_PATH 配置无效');
}
