jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

jest.mock('../../client/src/access/access-events', () => ({
  dispatchAccessInvalidated: jest.fn(),
}));

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  getPersonProfileDetails,
  getPersonProfiles,
  getYearlyChangeInfo,
} from '../../client/src/api';

const READ_TIMEOUT_MS = 15_000;

describe('monthly schedule person and change reads', () => {
  beforeEach(() => {
    (axiosForBackend as jest.Mock).mockReset();
  });

  it('bounds and cancels the yearly change request with the caller signal', async () => {
    const controller = new AbortController();
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({
      data: { changes: [] },
    });

    await getYearlyChangeInfo(2026, true, controller.signal);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/change-info/2026',
      method: 'GET',
      params: { refresh: '1' },
      timeout: READ_TIMEOUT_MS,
      signal: controller.signal,
    });
  });

  it.each([
    ['public', getPersonProfiles, '/api/bitable/person-profiles'],
    ['private', getPersonProfileDetails, '/api/bitable/person-profile-details'],
  ] as const)(
    'bounds and cancels the %s personnel request with the caller signal',
    async (_label, read, url) => {
      const controller = new AbortController();
      (axiosForBackend as jest.Mock).mockResolvedValueOnce({
        data: { organizations: [], changeRequestSubmitters: [] },
      });

      await read(true, 'leave', controller.signal);

      expect(axiosForBackend).toHaveBeenCalledWith({
        url,
        method: 'GET',
        params: { scope: 'leave', forceRefresh: '1' },
        timeout: READ_TIMEOUT_MS,
        signal: controller.signal,
      });
    },
  );

  it('allows an in-flight personnel read to be aborted instead of hanging', async () => {
    const controller = new AbortController();
    (axiosForBackend as jest.Mock).mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('request cancelled')),
            { once: true },
          );
        }),
    );

    const pending = getPersonProfiles(false, 'leave', controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow('request cancelled');
  });
});
