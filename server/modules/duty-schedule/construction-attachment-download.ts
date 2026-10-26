const FEISHU_MEDIA_BASE_URL =
  'https://open.feishu.cn/open-apis/drive/v1/medias';

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function buildFeishuDirectDownloadUrl(fileToken: string): string {
  return `${FEISHU_MEDIA_BASE_URL}/${encodeURIComponent(fileToken)}/download`;
}

export function buildFeishuTmpDownloadUrl(fileToken: string): string {
  return `${FEISHU_MEDIA_BASE_URL}/batch_get_tmp_download_url?file_tokens=${encodeURIComponent(
    fileToken,
  )}`;
}

export function normalizeFeishuTmpDownloadApiUrl(
  fileToken: string,
  value: string | null | undefined,
): string | null {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    !['open.feishu.cn', 'open.larksuite.com'].includes(
      url.hostname.toLowerCase(),
    ) ||
    url.pathname !== '/open-apis/drive/v1/medias/batch_get_tmp_download_url'
  ) {
    return null;
  }

  const fileTokens = url.searchParams
    .getAll('file_tokens')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return fileTokens.includes(fileToken) ? url.toString() : null;
}

export function extractFeishuTmpDownloadUrl(responseData: unknown): string | null {
  const root =
    typeof responseData === 'object' && responseData !== null
      ? (responseData as Record<string, unknown>)
      : {};
  const data =
    typeof root.data === 'object' && root.data !== null
      ? (root.data as Record<string, unknown>)
      : root;

  const tmpDownloadUrls = data.tmp_download_urls;
  if (Array.isArray(tmpDownloadUrls)) {
    for (const item of tmpDownloadUrls) {
      if (isHttpUrl(item)) {
        return item;
      }
      if (typeof item === 'object' && item !== null) {
        const itemRecord = item as Record<string, unknown>;
        const url =
          itemRecord.tmp_download_url ||
          itemRecord.tmpDownloadUrl ||
          itemRecord.url;
        if (isHttpUrl(url)) {
          return url;
        }
      }
    }
  }

  return isHttpUrl(data.tmp_download_url) ? data.tmp_download_url : null;
}
