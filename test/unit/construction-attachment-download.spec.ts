import {
  buildFeishuTmpDownloadUrl,
  extractFeishuTmpDownloadUrl,
  normalizeFeishuTmpDownloadApiUrl,
} from '../../server/modules/duty-schedule/construction-attachment-download';

describe('construction attachment download helpers', () => {
  it('builds Feishu tmp download url for a media token', () => {
    expect(buildFeishuTmpDownloadUrl('abc/123')).toBe(
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=abc%2F123',
    );
  });

  it('extracts tmp download urls from Feishu batch response shapes', () => {
    expect(
      extractFeishuTmpDownloadUrl({
        data: {
          tmp_download_urls: [
            {
              file_token: 'file-token',
              tmp_download_url: 'https://tmp.example.com/a.png',
            },
          ],
        },
      }),
    ).toBe('https://tmp.example.com/a.png');

    expect(
      extractFeishuTmpDownloadUrl({
        data: {
          tmp_download_urls: ['https://tmp.example.com/b.pdf'],
        },
      }),
    ).toBe('https://tmp.example.com/b.pdf');

    expect(
      extractFeishuTmpDownloadUrl({
        data: {
          tmp_download_url: 'https://tmp.example.com/c.xlsx',
        },
      }),
    ).toBe('https://tmp.example.com/c.xlsx');
  });

  it('ignores missing or non-http tmp download urls', () => {
    expect(extractFeishuTmpDownloadUrl({ data: {} })).toBeNull();
    expect(
      extractFeishuTmpDownloadUrl({
        data: {
          tmp_download_urls: [{ tmp_download_url: 'ftp://tmp.example.com/a' }],
        },
      }),
    ).toBeNull();
  });

  it('accepts only Feishu tmp download api urls for the same file token', () => {
    expect(
      normalizeFeishuTmpDownloadApiUrl(
        'abc/123',
        'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=abc%2F123&extra=%7B%7D',
      ),
    ).toBe(
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=abc%2F123&extra=%7B%7D',
    );

    expect(
      normalizeFeishuTmpDownloadApiUrl(
        'abc/123',
        'https://example.com/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=abc%2F123',
      ),
    ).toBeNull();
    expect(
      normalizeFeishuTmpDownloadApiUrl(
        'abc/123',
        'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=other',
      ),
    ).toBeNull();
  });
});
