jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }));
import { createLoginNameDirectory, matchLoginNames } from '../../client/src/access/login-name-directory';

describe('login name autocomplete directory', () => {
  it('matches partial names without an input request, limits suggestions and keeps manual entry available', () => {
    expect(matchLoginNames(['王甲', '王乙', '李甲'], ' 王 ')).toEqual(['王甲', '王乙']);
    expect(matchLoginNames(['Wang'], 'ANG')).toEqual(['Wang']);
    expect(matchLoginNames(['王甲'], '未入名单')).toEqual([]);
    expect(matchLoginNames(['王甲'], '')).toEqual([]);
    expect(matchLoginNames(Array.from({ length: 20 }, (_, i) => `王${i}`), '王')).toHaveLength(8);
  });
  it('deduplicates concurrent openings, caches for five minutes and retries only after expiry', async () => {
    let time = 0;
    const read = jest.fn().mockResolvedValue({ names: ['王甲', '王甲'], snapshotAt: 1 });
    const directory = createLoginNameDirectory(read, () => time);
    expect(await Promise.all([directory.load(), directory.load()])).toEqual([{ names: ['王甲'], snapshotAt: 1 }, { names: ['王甲'], snapshotAt: 1 }]);
    await directory.load(); expect(read).toHaveBeenCalledTimes(1);
    time = 300001; await directory.load(); expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed data and allows retry after a failed read', async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ names: [null], snapshotAt: 1 }).mockResolvedValue({ names: ['李甲'], snapshotAt: 2 });
    const directory = createLoginNameDirectory(read);
    await expect(directory.load()).rejects.toThrow('offline');
    await expect(directory.load()).rejects.toThrow('暂不可用');
    expect(await directory.load()).toEqual({ names: ['李甲'], snapshotAt: 2 });
  });
});
