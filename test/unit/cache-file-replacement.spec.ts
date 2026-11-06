import { replaceCacheFile } from '../../server/common/feishu/cache-file-replacement';

const locked = () => Object.assign(new Error('synthetic file lock'), { code: 'EPERM' });

describe('atomic local cache replacement', () => {
  it('retries a temporary Windows lock without repeating the source read', async () => {
    const replace = jest.fn().mockRejectedValueOnce(locked()).mockResolvedValue(undefined);
    const wait = jest.fn().mockResolvedValue(undefined), assertCurrentRead = jest.fn();
    await replaceCacheFile('temp', 'cache', { strict: true, platform: 'win32', replace, wait, assertCurrentRead });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(100);
    expect(assertCurrentRead).toHaveBeenCalledTimes(2);
  });

  it('fails after bounded attempts if the permission problem persists', async () => {
    const replace = jest.fn().mockRejectedValue(locked()), wait = jest.fn().mockResolvedValue(undefined);
    await expect(replaceCacheFile('temp', 'cache', { strict: true, platform: 'win32', replace, wait, assertCurrentRead: jest.fn() })).rejects.toMatchObject({ code: 'EPERM' });
    expect(replace).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map(call => call[0])).toEqual([100, 300, 700]);
  });

  it.each([
    ['unrelated disk error', 'win32', true, 'ENOSPC'],
    ['non-Windows error', 'linux', true, 'EPERM'],
    ['ordinary non-strict cache write', 'win32', false, 'EPERM'],
  ] as const)('does not retry %s', async (_label, platform, strict, code) => {
    const replace = jest.fn().mockRejectedValue(Object.assign(new Error('synthetic failure'), { code })), wait = jest.fn();
    await expect(replaceCacheFile('temp', 'cache', { strict, platform, replace, wait, assertCurrentRead: jest.fn() })).rejects.toMatchObject({ code });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops before retry when the source changes while the file is locked', async () => {
    const replace = jest.fn().mockRejectedValue(locked());
    const assertCurrentRead = jest.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('数据在读取期间已变更，请重新读取'); });
    await expect(replaceCacheFile('temp', 'cache', { strict: true, platform: 'win32', replace, wait: async () => undefined, assertCurrentRead })).rejects.toThrow('数据在读取期间已变更');
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
