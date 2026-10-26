import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn() } }),
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
jest.mock(
  '@/api',
  () => ({
    getWeatherGuardRegistrationOptions: jest.fn(),
    submitWeatherGuardRegistration: jest.fn(),
  }),
  { virtual: true },
);
jest.mock('@/components/ui/button', () => ({ Button: () => null }), {
  virtual: true,
});
jest.mock(
  '@/components/ui/dialog',
  () => ({
    Dialog: () => null,
    DialogContent: () => null,
    DialogDescription: () => null,
    DialogFooter: () => null,
    DialogHeader: () => null,
    DialogTitle: () => null,
  }),
  { virtual: true },
);
jest.mock(
  '@/components/ui/alert-dialog',
  () => ({
    AlertDialog: () => null,
    AlertDialogAction: () => null,
    AlertDialogCancel: () => null,
    AlertDialogContent: () => null,
    AlertDialogDescription: () => null,
    AlertDialogFooter: () => null,
    AlertDialogHeader: () => null,
    AlertDialogTitle: () => null,
    AlertDialogTrigger: () => null,
  }),
  { virtual: true },
);
jest.mock('@/components/ui/checkbox', () => ({ Checkbox: () => null }), {
  virtual: true,
});
jest.mock('@/components/ui/input', () => ({ Input: () => null }), {
  virtual: true,
});
jest.mock('@/components/ui/label', () => ({ Label: () => null }), {
  virtual: true,
});
jest.mock(
  '@/components/ui/select',
  () => ({
    Select: () => null,
    SelectContent: () => null,
    SelectItem: () => null,
    SelectTrigger: () => null,
    SelectValue: () => null,
  }),
  { virtual: true },
);
jest.mock('@/components/ui/textarea', () => ({ Textarea: () => null }), {
  virtual: true,
});
jest.mock(
  '@/lib/utils',
  () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }),
  { virtual: true },
);
jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: () => () => null,
      },
    ),
);
import { logger } from '@lark-apaas/client-toolkit/logger';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  getWeatherGuardRegistrationOptions,
  submitWeatherGuardRegistration,
} from '../../client/src/api';
import {
  buildWeatherGuardRegistrationFormData,
  buildWeatherGuardRegistrationPayload,
  clearWeatherGuardRegistrationDraft,
  clearWeatherGuardRegistrationPending,
  clearWeatherGuardRegistrationDeepLink,
  createWeatherGuardRegistrationDraft,
  createWeatherGuardRegistrationSubmissionGate,
  getWeatherGuardRegistrationErrorMessage,
  getWeatherGuardRegistrationDraftStorageKey,
  getWeatherGuardRegistrationPendingStorageKey,
  readWeatherGuardRegistrationDraft,
  readWeatherGuardRegistrationPending,
  readWeatherGuardRegistrationDeepLink,
  saveWeatherGuardRegistrationDraft,
  saveWeatherGuardRegistrationPending,
  isCurrentWeatherGuardRegistrationSubmission,
  validateWeatherGuardRegistrationDraft,
  validateWeatherGuardRegistrationEvidence,
  WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES,
  WeatherGuardRegistrationEvidenceValidationError,
  type WeatherGuardRegistrationDraft,
  type WeatherGuardRegistrationEvidence,
  type WeatherGuardRegistrationDraftStorage,
} from '../../client/src/pages/MonthlySchedule/weather-warning-registration';
import {
  createWeatherGuardRegistrationDialogRequestCoordinator,
  createWeatherGuardRegistrationEvidencePreviewRegistry,
  filterWeatherGuardRegistrationCandidates,
  getSelectedWeatherGuardRegistrationEvidenceIssues,
  runWeatherGuardRegistrationDialogSubmission,
  toggleWeatherGuardRegistrationCandidateKey,
} from '../../client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog';

const MUTATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NEXT_MUTATION_ID = '223e4567-e89b-42d3-a456-426614174001';

describe('monthly schedule weather guard registration', () => {
  describe('error message', () => {
    it('prefers the backend business message from an Axios-style response', () => {
      const error = Object.assign(
        new Error('Request failed with status code 409'),
        {
          response: {
            data: {
              success: false,
              message: '指定预警已过期或不是当前主预警',
            },
          },
        },
      );

      expect(getWeatherGuardRegistrationErrorMessage(error)).toBe(
        '指定预警已过期或不是当前主预警',
      );
    });

    it('falls back to the ordinary Error message when no business message exists', () => {
      expect(
        getWeatherGuardRegistrationErrorMessage(new Error('网络连接失败')),
      ).toBe('网络连接失败');
    });
  });

  describe('deep link', () => {
    it('reads an exact weather registration link from a Feishu card', () => {
      const params = new URLSearchParams(
        'weatherGuardRegistration=1&warningId=warning-42&source=feishu-card',
      );

      expect(readWeatherGuardRegistrationDeepLink(params)).toEqual({
        warningId: 'warning-42',
        source: 'feishu-card',
      });
    });

    it('preserves the Feishu test-card source', () => {
      const params = new URLSearchParams(
        'weatherGuardRegistration=1&warningId=warning-42&source=test-card',
      );

      expect(readWeatherGuardRegistrationDeepLink(params)).toEqual({
        warningId: 'warning-42',
        source: 'test-card',
      });
    });

    it('defaults a missing source to the page but rejects an explicit unknown source', () => {
      expect(
        readWeatherGuardRegistrationDeepLink(
          new URLSearchParams(
            'weatherGuardRegistration=1&warningId=warning-42',
          ),
        ),
      ).toEqual({ warningId: 'warning-42', source: 'page' });
      expect(
        readWeatherGuardRegistrationDeepLink(
          new URLSearchParams(
            'weatherGuardRegistration=1&warningId=warning-42&source=unknown-card',
          ),
        ),
      ).toBeNull();
    });

    it.each([
      ['missing flag', 'warningId=warning-42'],
      ['non-exact flag', 'weatherGuardRegistration=true&warningId=warning-42'],
      ['missing warning ID', 'weatherGuardRegistration=1'],
      ['empty warning ID', 'weatherGuardRegistration=1&warningId='],
      [
        'leading whitespace in the warning ID',
        'weatherGuardRegistration=1&warningId=%20warning-42',
      ],
      [
        'trailing whitespace in the warning ID',
        'weatherGuardRegistration=1&warningId=warning-42%20',
      ],
    ])('rejects a link with %s', (_label, query) => {
      expect(
        readWeatherGuardRegistrationDeepLink(new URLSearchParams(query)),
      ).toBeNull();
    });

    it('clears only registration parameters and preserves unrelated ordering', () => {
      const params = new URLSearchParams(
        'first=1&weatherGuardRegistration=1&keep=a&warningId=warning-42&source=feishu-card&keep=b&last=2',
      );

      expect(clearWeatherGuardRegistrationDeepLink(params).toString()).toBe(
        'first=1&keep=a&keep=b&last=2',
      );
      expect(params.get('warningId')).toBe('warning-42');
    });
  });

  describe('draft', () => {
    it('creates a versioned empty draft with an injected RFC 4122 UUID', () => {
      const randomUUID = jest.fn(() => MUTATION_ID);

      expect(
        createWeatherGuardRegistrationDraft('warning-42', randomUUID),
      ).toEqual({
        version: 2,
        warningId: 'warning-42',
        clientMutationId: MUTATION_ID,
        building: null,
        checkerKeys: [],
        deviceStatus: null,
        deviceAbnormalDescription: '',
        disasterStatus: null,
        disasterAbnormalDescription: '',
        environmentStatus: null,
        environmentAbnormalDescription: '',
        materialsStatus: null,
        materialsAbnormalDescription: '',
        contactsStatus: null,
        contactsAbnormalDescription: '',
      });
      expect(randomUUID).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an empty warning ID', '', MUTATION_ID],
      ['a padded warning ID', ' warning-42', MUTATION_ID],
      ['a non-UUID mutation ID', 'warning-42', 'weather-warning-42'],
    ])('rejects %s', (_label, warningId, mutationId) => {
      expect(() =>
        createWeatherGuardRegistrationDraft(warningId, () => mutationId),
      ).toThrow();
    });
  });

  describe('draft validation', () => {
    it('rejects a stale version, inexact warning ID, or non-UUID mutation', () => {
      const invalidDraft = {
        ...completeDraft(),
        version: 0,
        warningId: ' warning-42',
        clientMutationId: 'bad-id',
      } as unknown as WeatherGuardRegistrationDraft;

      expect(
        validateWeatherGuardRegistrationDraft(invalidDraft, true).map(
          ({ field }) => field,
        ),
      ).toEqual(['version', 'warningId', 'clientMutationId']);
      expect(() =>
        buildWeatherGuardRegistrationPayload(invalidDraft, true),
      ).toThrow();
    });

    it('requires the building, people, and every applicable status', () => {
      const emptyDraft = createWeatherGuardRegistrationDraft(
        'warning-42',
        () => MUTATION_ID,
      );

      expect(
        validateWeatherGuardRegistrationDraft(emptyDraft, true).map(
          ({ field }) => field,
        ),
      ).toEqual([
        'building',
        'checkerKeys',
        'deviceStatus',
        'disasterStatus',
        'environmentStatus',
        'materialsStatus',
        'contactsStatus',
      ]);
      expect(
        validateWeatherGuardRegistrationDraft(emptyDraft, false).map(
          ({ field }) => field,
        ),
      ).not.toContain('environmentStatus');
    });

    it('requires abnormal descriptions only for applicable abnormal statuses', () => {
      const abnormalDraft = completeDraft({
        deviceStatus: '异常',
        disasterStatus: '异常',
        environmentStatus: '异常',
        materialsStatus: '异常',
        contactsStatus: '异常',
      });

      expect(
        validateWeatherGuardRegistrationDraft(abnormalDraft, true).map(
          ({ field }) => field,
        ),
      ).toEqual([
        'deviceAbnormalDescription',
        'disasterAbnormalDescription',
        'environmentAbnormalDescription',
        'materialsAbnormalDescription',
        'contactsAbnormalDescription',
      ]);
      expect(
        validateWeatherGuardRegistrationDraft(
          completeDraft({ environmentStatus: '异常' }),
          false,
        ).map(({ field }) => field),
      ).not.toContain('environmentAbnormalDescription');
    });
  });

  describe('payload', () => {
    it('projects only shared request fields for an applicable environment check', () => {
      const draft = Object.assign(
        completeDraft({
          deviceStatus: '异常',
          deviceAbnormalDescription: '设备漏水',
          environmentStatus: '异常',
          environmentAbnormalDescription: '温度偏高',
        }),
        {
          guardLevel: '一级戒备',
          tag: 'server-owned',
          date: '2026-08-08',
          openId: 'ou-forbidden',
          managerConfirmation: '已确认',
          fileToken: 'file-forbidden',
        },
      );

      expect(buildWeatherGuardRegistrationPayload(draft, true)).toEqual({
        clientMutationId: MUTATION_ID,
        warningId: 'warning-42',
        building: 'A楼',
        checkerKeys: ['checker-1'],
        deviceStatus: '异常',
        deviceAbnormalDescription: '设备漏水',
        disasterStatus: '正常',
        environmentStatus: '异常',
        environmentAbnormalDescription: '温度偏高',
        materialsStatus: '正常',
        contactsStatus: '正常',
      });
    });

    it('omits all environment fields when the server matrix marks it not required', () => {
      const payload = buildWeatherGuardRegistrationPayload(
        completeDraft({
          environmentStatus: '异常',
          environmentAbnormalDescription: '不得发送',
        }),
        false,
      );

      expect(payload).not.toHaveProperty('environmentStatus');
      expect(payload).not.toHaveProperty('environmentAbnormalDescription');
      for (const field of [
        'guardLevel',
        'tag',
        'date',
        'openId',
        'managerConfirmation',
        'fileToken',
      ]) {
        expect(payload).not.toHaveProperty(field);
      }
    });
  });

  describe('evidence validation', () => {
    it('requires exactly one applicable file per evidence category', () => {
      expect(
        validateWeatherGuardRegistrationEvidence(
          {
            deviceEvidence: null,
            disasterEvidence: null,
            environmentEvidence: null,
          },
          true,
        ).map(({ field }) => field),
      ).toEqual(['deviceEvidence', 'disasterEvidence', 'environmentEvidence']);
      expect(
        validateWeatherGuardRegistrationEvidence(
          {
            deviceEvidence: [imageFile('one.png', 'image/png')] as never,
            disasterEvidence: imageFile('disaster.jpg', 'image/jpeg'),
            environmentEvidence: null,
          },
          false,
        ),
      ).toEqual([
        expect.objectContaining({ field: 'deviceEvidence', code: 'count' }),
      ]);
    });

    it.each([
      ['photo.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.JPEG', 'image/jpeg'],
      ['photo.webp', 'image/webp'],
      ['scan.pdf', 'application/pdf'],
    ])('accepts one non-empty %s / %s attachment', (name, type) => {
      const file = imageFile(name, type);
      expect(
        validateWeatherGuardRegistrationEvidence(
          completeEvidence({ deviceEvidence: file }),
          true,
        ),
      ).toEqual([]);
    });

    it.each([
      ['scan.pdf', 'image/png'],
      ['photo.png', 'application/pdf'],
    ])('rejects an attachment MIME mismatch for %s / %s', (name, type) => {
      expect(
        validateWeatherGuardRegistrationEvidence(
          completeEvidence({ deviceEvidence: imageFile(name, type) }),
          true,
        ),
      ).toEqual([
        expect.objectContaining({ field: 'deviceEvidence', code: 'type' }),
      ]);
    });

    it.each([
      ['empty', { name: 'empty.png', type: 'image/png', size: 0 }, 'empty'],
      [
        'oversized',
        {
          name: 'large.png',
          type: 'image/png',
          size: WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES + 1,
        },
        'size',
      ],
      [
        'MIME-extension mismatch',
        { name: 'fake.jpg', type: 'image/png', size: 1 },
        'type',
      ],
      [
        'unsupported format',
        { name: 'photo.gif', type: 'image/gif', size: 1 },
        'type',
      ],
    ])('rejects an %s file', (_label, file, code) => {
      expect(
        validateWeatherGuardRegistrationEvidence(
          completeEvidence({ deviceEvidence: file as File }),
          true,
        ),
      ).toEqual([expect.objectContaining({ field: 'deviceEvidence', code })]);
    });

    it('uses the server-provided image types and byte limit', () => {
      const issues = validateWeatherGuardRegistrationEvidence(
        completeEvidence({
          deviceEvidence: {
            name: 'device.png',
            type: 'image/png',
            size: 1,
          } as File,
          disasterEvidence: {
            name: 'disaster.jpg',
            type: 'image/jpeg',
            size: 2,
          } as File,
          environmentEvidence: imageFile('environment.jpg', 'image/jpeg'),
        }),
        true,
        {
          acceptedImageTypes: ['image/jpeg'],
          maxImageBytes: 1,
        },
      );

      expect(issues).toEqual([
        expect.objectContaining({ field: 'deviceEvidence', code: 'type' }),
        expect.objectContaining({ field: 'disasterEvidence', code: 'size' }),
      ]);
    });
  });

  describe('form data', () => {
    it('appends the JSON payload and exactly one applicable file per field', () => {
      const formData = buildWeatherGuardRegistrationFormData(
        completeDraft(),
        true,
        completeEvidence(),
      );

      expect(Array.from(formData.keys())).toEqual([
        'payload',
        'deviceEvidence',
        'disasterEvidence',
        'environmentEvidence',
      ]);
      expect(formData.getAll('deviceEvidence')).toHaveLength(1);
      expect(formData.getAll('disasterEvidence')).toHaveLength(1);
      expect(formData.getAll('environmentEvidence')).toHaveLength(1);
      expect(JSON.parse(String(formData.get('payload')))).toEqual(
        buildWeatherGuardRegistrationPayload(completeDraft(), true),
      );
    });

    it('appends a PDF scan without changing the multipart field contract', () => {
      const formData = buildWeatherGuardRegistrationFormData(
        completeDraft(),
        true,
        completeEvidence({
          deviceEvidence: imageFile('device-scan.pdf', 'application/pdf'),
        }),
      );

      expect(formData.get('deviceEvidence')).toEqual(
        expect.objectContaining({
          name: 'device-scan.pdf',
          type: 'application/pdf',
        }),
      );
    });

    it('never appends environment evidence when the server matrix excludes it', () => {
      const formData = buildWeatherGuardRegistrationFormData(
        completeDraft(),
        false,
        completeEvidence(),
      );

      expect(Array.from(formData.keys())).toEqual([
        'payload',
        'deviceEvidence',
        'disasterEvidence',
      ]);
      expect(formData.has('environmentEvidence')).toBe(false);
      expect(JSON.parse(String(formData.get('payload')))).not.toHaveProperty(
        'environmentStatus',
      );
    });

    it('does not build multipart data when current server limits reject an existing file', () => {
      expect(() =>
        buildWeatherGuardRegistrationFormData(
          completeDraft(),
          true,
          completeEvidence(),
          {
            acceptedImageTypes: ['image/jpeg'],
            maxImageBytes: WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES,
          },
        ),
      ).toThrow(WeatherGuardRegistrationEvidenceValidationError);
    });
  });

  describe('session draft persistence', () => {
    it('stores only versioned text and selections and flags evidence for reselection', () => {
      const storage = memoryStorage();
      const draftWithRuntimeFile = Object.assign(completeDraft(), {
        deviceEvidence: imageFile('must-not-persist.png', 'image/png'),
      });

      expect(
        saveWeatherGuardRegistrationDraft(draftWithRuntimeFile, storage),
      ).toBe(true);
      const key = getWeatherGuardRegistrationDraftStorageKey('warning-42');
      expect(key).toContain(':v2:warning-42');
      const raw = storage.getItem(key)!;
      expect(raw).not.toContain('deviceEvidence');
      expect(raw).not.toContain('must-not-persist.png');
      expect(readWeatherGuardRegistrationDraft('warning-42', storage)).toEqual({
        draft: completeDraft(),
        evidenceMustBeReselected: true,
      });
    });

    it.each([
      ['corrupt JSON', '{'],
      ['a non-object value', '[]'],
      ['an old version', JSON.stringify({ ...completeDraft(), version: 0 })],
      [
        'another warning',
        JSON.stringify({ ...completeDraft(), warningId: 'warning-other' }),
      ],
      [
        'an invalid mutation UUID',
        JSON.stringify({ ...completeDraft(), clientMutationId: 'bad-id' }),
      ],
      [
        'corrupt selections',
        JSON.stringify({ ...completeDraft(), checkerKeys: 'checker-1' }),
      ],
    ])('returns null for %s', (_label, raw) => {
      const storage = memoryStorage();
      storage.setItem(
        getWeatherGuardRegistrationDraftStorageKey('warning-42'),
        raw,
      );

      expect(
        readWeatherGuardRegistrationDraft('warning-42', storage),
      ).toBeNull();
    });

    it('retains one mutation UUID across failure retries and rotates only after clear', () => {
      const storage = memoryStorage();
      const randomUUID = jest
        .fn<ReturnType<() => string>, Parameters<() => string>>()
        .mockReturnValueOnce(MUTATION_ID)
        .mockReturnValueOnce(NEXT_MUTATION_ID);
      const failedDraft = {
        ...completeDraft(),
        clientMutationId: createWeatherGuardRegistrationDraft(
          'warning-42',
          randomUUID,
        ).clientMutationId,
      };
      saveWeatherGuardRegistrationDraft(failedDraft, storage);

      const retryDraft = readWeatherGuardRegistrationDraft(
        'warning-42',
        storage,
      )!.draft;
      expect(
        buildWeatherGuardRegistrationPayload(retryDraft, true).clientMutationId,
      ).toBe(MUTATION_ID);
      expect(
        readWeatherGuardRegistrationDraft('warning-42', storage),
      ).not.toBeNull();

      expect(clearWeatherGuardRegistrationDraft('warning-42', storage)).toBe(
        true,
      );
      expect(
        readWeatherGuardRegistrationDraft('warning-42', storage),
      ).toBeNull();
      expect(
        createWeatherGuardRegistrationDraft('warning-42', randomUUID)
          .clientMutationId,
      ).toBe(NEXT_MUTATION_ID);
    });

    it('persists an accepted mutation lock until the confirmed submission clears it', () => {
      const storage = memoryStorage();
      const draft = completeDraft();

      expect(saveWeatherGuardRegistrationPending(draft, storage)).toBe(true);
      expect(
        storage.getItem(
          getWeatherGuardRegistrationPendingStorageKey('warning-42'),
        ),
      ).toBe(MUTATION_ID);
      expect(readWeatherGuardRegistrationPending('warning-42', storage)).toBe(
        MUTATION_ID,
      );

      expect(clearWeatherGuardRegistrationPending('warning-42', storage)).toBe(
        true,
      );
      expect(
        readWeatherGuardRegistrationPending('warning-42', storage),
      ).toBeNull();
    });

    it('fails closed when accepted mutation lock storage is unavailable or malformed', () => {
      const unavailableStorage: WeatherGuardRegistrationDraftStorage = {
        getItem: () => {
          throw new Error('storage unavailable');
        },
        setItem: () => {
          throw new Error('storage unavailable');
        },
        removeItem: () => {
          throw new Error('storage unavailable');
        },
      };
      const malformedStorage = memoryStorage();
      malformedStorage.setItem(
        getWeatherGuardRegistrationPendingStorageKey('warning-42'),
        'not-a-uuid',
      );

      expect(
        saveWeatherGuardRegistrationPending(
          completeDraft(),
          unavailableStorage,
        ),
      ).toBe(false);
      expect(
        readWeatherGuardRegistrationPending('warning-42', unavailableStorage),
      ).toBeNull();
      expect(
        clearWeatherGuardRegistrationPending('warning-42', unavailableStorage),
      ).toBe(false);
      expect(
        readWeatherGuardRegistrationPending('warning-42', malformedStorage),
      ).toBeNull();
    });
  });

  describe('submission coordination', () => {
    it('rejects duplicate submission while the same draft mutation is active', () => {
      const gate = createWeatherGuardRegistrationSubmissionGate();
      const draft = completeDraft();
      const first = gate.tryStart(draft, 3);

      expect(first).toEqual({ clientMutationId: MUTATION_ID, revision: 3 });
      expect(gate.tryStart(draft, 3)).toBeNull();
      gate.finish(first!);
      expect(gate.tryStart(draft, 3)).toEqual(first);
    });

    it('rejects responses from an old revision or mutation', () => {
      const gate = createWeatherGuardRegistrationSubmissionGate();
      const token = gate.tryStart(completeDraft(), 4)!;

      expect(
        isCurrentWeatherGuardRegistrationSubmission(token, completeDraft(), 4),
      ).toBe(true);
      expect(
        isCurrentWeatherGuardRegistrationSubmission(token, completeDraft(), 5),
      ).toBe(false);
      expect(
        isCurrentWeatherGuardRegistrationSubmission(
          token,
          completeDraft({ clientMutationId: NEXT_MUTATION_ID }),
          4,
        ),
      ).toBe(false);
    });

    it('requires the active gate-issued token identity', () => {
      const gate = createWeatherGuardRegistrationSubmissionGate();
      const draft = completeDraft();
      const token = gate.tryStart(draft, 5)!;

      expect(
        isCurrentWeatherGuardRegistrationSubmission({ ...token }, draft, 5),
      ).toBe(false);
    });

    it('keeps a restarted identical attempt active when the first attempt finishes late', () => {
      const gate = createWeatherGuardRegistrationSubmissionGate();
      const draft = completeDraft();
      const first = gate.tryStart(draft, 6)!;

      expect(isCurrentWeatherGuardRegistrationSubmission(first, draft, 6)).toBe(
        true,
      );
      gate.finish(first);
      const second = gate.tryStart(draft, 6)!;

      expect(isCurrentWeatherGuardRegistrationSubmission(first, draft, 6)).toBe(
        false,
      );
      gate.finish(first);
      expect(gate.tryStart(draft, 6)).toBeNull();
      expect(
        isCurrentWeatherGuardRegistrationSubmission(second, draft, 6),
      ).toBe(true);
    });
  });

  describe('client API contract', () => {
    beforeEach(() => jest.clearAllMocks());

    it('executes the options request with the exact transport configuration', async () => {
      const signal = new AbortController().signal;
      const response = { warning: { id: 'warning-42' } };
      (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: response });

      await expect(
        getWeatherGuardRegistrationOptions('warning-42', signal),
      ).resolves.toBe(response);
      expect(axiosForBackend).toHaveBeenCalledWith({
        url: '/api/weather-warning/registration/options',
        method: 'GET',
        params: { warningId: 'warning-42' },
        timeout: 20_000,
        signal,
      });
      expect(
        (axiosForBackend as jest.Mock).mock.calls[0][0],
      ).not.toHaveProperty('headers');
    });

    it('executes the multipart submission with the exact transport configuration', async () => {
      const signal = new AbortController().signal;
      const formData = new FormData();
      const response = { success: true, recordId: 'rec-42' };
      (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: response });

      await expect(
        submitWeatherGuardRegistration(formData, signal),
      ).resolves.toBe(response);
      expect(axiosForBackend).toHaveBeenCalledWith({
        url: '/api/weather-warning/registration',
        method: 'POST',
        data: formData,
        timeout: 60_000,
        signal,
      });
      expect(
        (axiosForBackend as jest.Mock).mock.calls[0][0],
      ).not.toHaveProperty('headers');
    });

    it('rejects a toolkit-fulfilled 403 with its status and response body', async () => {
      const response = {
        status: 403,
        data: {
          success: false,
          message: '当前访问身份无权提交戒备登记',
        },
      };
      (axiosForBackend as jest.Mock).mockResolvedValueOnce(response);

      await expect(
        submitWeatherGuardRegistration(new FormData()),
      ).rejects.toMatchObject({
        message: 'HTTP 403',
        response,
      });
      expect(axiosForBackend).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'options',
        (signal: AbortSignal) =>
          getWeatherGuardRegistrationOptions('warning-42', signal),
      ],
      [
        'submission',
        (signal: AbortSignal) =>
          submitWeatherGuardRegistration(new FormData(), signal),
      ],
    ])(
      'does not log an already-aborted %s cancellation',
      async (_label, run) => {
        const controller = new AbortController();
        controller.abort();
        const cancellation = Object.assign(new Error('canceled'), {
          name: 'CanceledError',
          code: 'ERR_CANCELED',
        });
        (axiosForBackend as jest.Mock).mockRejectedValueOnce(cancellation);

        await expect(run(controller.signal)).rejects.toBe(cancellation);
        expect(logger.error).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'options',
        (signal: AbortSignal) =>
          getWeatherGuardRegistrationOptions('warning-42', signal),
        '获取天气重保登记选项失败',
      ],
      [
        'submission',
        (signal: AbortSignal) =>
          submitWeatherGuardRegistration(new FormData(), signal),
        '提交天气重保登记失败',
      ],
    ])(
      'logs an ordinary %s failure and rethrows it',
      async (_label, run, message) => {
        const error = new Error('ordinary failure');
        (axiosForBackend as jest.Mock).mockRejectedValueOnce(error);

        await expect(run(new AbortController().signal)).rejects.toBe(error);
        expect(logger.error).toHaveBeenCalledWith(message, error);
      },
    );
  });

  describe('registration dialog', () => {
    it('disables shared dialog overlay and content motion when reduced motion is requested', () => {
      const source = readFileSync(
        join(process.cwd(), 'client/src/components/ui/dialog.tsx'),
        'utf8',
      );

      expect(source.match(/motion-reduce:!animate-none/gu) || []).toHaveLength(
        2,
      );
    });

    it('shows the server-confirmed data update time in the dialog header', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(source).toContain('数据更新');
      expect(source).toContain('options.dataUpdatedAt');
    });

    it('labels the Feishu test card separately from production cards and the page', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(source).toContain('来自飞书测试卡片');
      expect(source).toContain('来自飞书卡片');
      expect(source).toContain('来自排班页');
    });

    it('renders every required business section in a compact scrolling shell', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      for (const label of [
        '基本信息',
        '检查人与楼栋',
        '设备安全',
        '灾害专项',
        '环境安全',
        '重保物资清单',
        '重保联络清单',
      ]) {
        expect(source).toContain(label);
      }
      expect(source).toContain('min-h-0 flex-1 overflow-y-auto');
      const dialogContent = source.match(/<DialogContent[\s\S]*?>/u)?.[0] ?? '';
      expect(dialogContent).toContain('overscroll-contain');
      expect(source).toContain(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain',
      );
      expect(source).toContain('sticky bottom-0');
      expect(source).toContain('max-h-[min(92dvh,52rem)]');
      expect(source).not.toMatch(
        /(?:^|[\s"'`])h-\[min\(92dvh,52rem\)\](?:[\s"'`]|$)/u,
      );
    });

    it('aborts stale option or submit work and rejects old revisions', () => {
      const coordinator =
        createWeatherGuardRegistrationDialogRequestCoordinator();
      const first = coordinator.begin();
      const second = coordinator.begin();

      expect(first.signal.aborted).toBe(true);
      expect(coordinator.isCurrent(first)).toBe(false);
      expect(second.signal.aborted).toBe(false);
      expect(coordinator.isCurrent(second)).toBe(true);

      coordinator.invalidate();
      expect(second.signal.aborted).toBe(true);
      expect(coordinator.isCurrent(second)).toBe(false);
    });

    it('searches every cached active person by name, position, or building while storing opaque keys', () => {
      const candidates = [
        {
          key: 'candidate-checker-a',
          name: '示例人员008',
          position: '设施运维工程师',
          buildings: ['A楼' as const],
        },
        {
          key: 'candidate-checker-b',
          name: '李进宇',
          position: '值班长',
          buildings: ['B楼' as const, 'H楼' as const],
        },
        {
          key: 'candidate-checker-no-building',
          name: '王小满',
          position: '暖通工程师',
          buildings: [],
        },
      ];

      expect(
        filterWeatherGuardRegistrationCandidates(candidates, '工程师', 'A楼'),
      ).toEqual([candidates[0], candidates[2]]);
      expect(
        filterWeatherGuardRegistrationCandidates(candidates, '进', 'B楼'),
      ).toEqual([candidates[1]]);
      expect(
        filterWeatherGuardRegistrationCandidates(candidates, '', 'C楼'),
      ).toEqual(candidates);
      expect(
        filterWeatherGuardRegistrationCandidates(candidates, 'H楼', 'A楼'),
      ).toEqual([candidates[1]]);
      expect(
        filterWeatherGuardRegistrationCandidates(
          candidates,
          '未标注机楼',
          null,
        ),
      ).toEqual([candidates[2]]);
      expect(
        toggleWeatherGuardRegistrationCandidateKey(
          [],
          'candidate-checker-a',
          filterWeatherGuardRegistrationCandidates(candidates, '', 'B楼'),
        ),
      ).toEqual(['candidate-checker-a']);
      expect(
        toggleWeatherGuardRegistrationCandidateKey([], 'ou_forged', candidates),
      ).toEqual([]);
    });

    it('submits once, blocks a duplicate, clears the draft, and calls success once', async () => {
      const submissionGate = createWeatherGuardRegistrationSubmissionGate();
      const requestCoordinator =
        createWeatherGuardRegistrationDialogRequestCoordinator();
      const deferred = createDeferred<{
        success: true;
        recordId: string;
        createdAt: string;
        building: 'A楼';
        guardLevel: '三级戒备';
      }>();
      const submit = jest.fn(() => deferred.promise);
      const clearDraft = jest.fn();
      const onSubmitted = jest.fn();
      const onAccepted = jest.fn();
      const input = {
        draft: completeDraft(),
        environmentRequired: true,
        evidence: completeEvidence(),
        revision: 7,
        submissionGate,
        requestCoordinator,
        submit,
        clearDraft,
        onSubmitted,
        onAccepted,
      } as Parameters<typeof runWeatherGuardRegistrationDialogSubmission>[0] & {
        onAccepted: (input: { clientMutationId: string }) => void;
      };

      const first = runWeatherGuardRegistrationDialogSubmission(input);
      expect(onAccepted).toHaveBeenCalledTimes(1);
      expect(onAccepted).toHaveBeenCalledWith({
        clientMutationId: MUTATION_ID,
      });
      expect(clearDraft).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
      const duplicate =
        await runWeatherGuardRegistrationDialogSubmission(input);
      expect(duplicate).toEqual({ kind: 'duplicate' });
      expect(submit).toHaveBeenCalledTimes(1);

      const response = {
        success: true as const,
        clientMutationId: MUTATION_ID,
        syncStatus: 'confirmed' as const,
        recordId: 'rec_registration_1',
        createdAt: '2026-08-08T18:00:00+08:00',
        building: 'A楼' as const,
        guardLevel: '三级戒备' as const,
      };
      deferred.resolve(response);

      await expect(first).resolves.toEqual({
        kind: 'succeeded',
        result: response,
      });
      expect(clearDraft).toHaveBeenCalledTimes(1);
      expect(onSubmitted).toHaveBeenCalledTimes(1);
      expect(onSubmitted).toHaveBeenCalledWith(response);
    });

    it.each([
      [
        'success=false',
        {
          success: false,
          recordId: 'rec_unconfirmed',
          createdAt: '2026-08-08T18:05:00+08:00',
          building: 'A妤?',
          guardLevel: '涓夌骇鎴掑',
        },
      ],
      [
        'empty recordId',
        {
          success: true,
          recordId: '',
          createdAt: '2026-08-08T18:05:00+08:00',
          building: 'A妤?',
          guardLevel: '涓夌骇鎴掑',
        },
      ],
      [
        'blank recordId',
        {
          success: true,
          recordId: '   ',
          createdAt: '2026-08-08T18:05:00+08:00',
          building: 'A妤?',
          guardLevel: '涓夌骇鎴掑',
        },
      ],
    ])(
      'keeps the draft and evidence retryable after HTTP 2xx with %s',
      async (_label, unconfirmedResponse) => {
        jest.clearAllMocks();
        const confirmedResponse = {
          success: true as const,
          clientMutationId: MUTATION_ID,
          syncStatus: 'confirmed' as const,
          recordId: 'rec_confirmed_retry',
          createdAt: '2026-08-08T18:10:00+08:00',
          building: 'A楼' as const,
          guardLevel: '三级戒备' as const,
        };
        (axiosForBackend as jest.Mock)
          .mockReset()
          .mockResolvedValueOnce({ status: 200, data: unconfirmedResponse })
          .mockResolvedValueOnce({ status: 201, data: confirmedResponse });
        const evidence = completeEvidence();
        const evidenceSnapshot = { ...evidence };
        const clearDraft = jest.fn();
        const onSubmitted = jest.fn();
        const input = {
          draft: completeDraft(),
          environmentRequired: true,
          evidence,
          revision: 8,
          submissionGate: createWeatherGuardRegistrationSubmissionGate(),
          requestCoordinator:
            createWeatherGuardRegistrationDialogRequestCoordinator(),
          submit: submitWeatherGuardRegistration,
          clearDraft,
          onSubmitted,
        };

        await expect(
          runWeatherGuardRegistrationDialogSubmission(input),
        ).resolves.toMatchObject({
          kind: 'failed',
          error: expect.objectContaining({
            message: '服务端未确认本次戒备登记及楼栋写入结果',
          }),
        });
        expect(clearDraft).not.toHaveBeenCalled();
        expect(onSubmitted).not.toHaveBeenCalled();
        expect(evidence).toEqual(evidenceSnapshot);
        expect(evidence.deviceEvidence).toBe(evidenceSnapshot.deviceEvidence);
        expect(evidence.disasterEvidence).toBe(
          evidenceSnapshot.disasterEvidence,
        );
        expect(evidence.environmentEvidence).toBe(
          evidenceSnapshot.environmentEvidence,
        );

        await expect(
          runWeatherGuardRegistrationDialogSubmission(input),
        ).resolves.toEqual({
          kind: 'succeeded',
          result: confirmedResponse,
        });
        expect(axiosForBackend).toHaveBeenCalledTimes(2);
        const submittedForms = (axiosForBackend as jest.Mock).mock.calls.map(
          ([request]) => request.data as FormData,
        );
        for (const formData of submittedForms) {
          expect(
            JSON.parse(String(formData.get('payload'))).clientMutationId,
          ).toBe(MUTATION_ID);
          expect(formData.get('deviceEvidence')).toEqual(
            expect.objectContaining({ name: 'device.png' }),
          );
          expect(formData.get('disasterEvidence')).toEqual(
            expect.objectContaining({ name: 'disaster.jpg' }),
          );
          expect(formData.get('environmentEvidence')).toEqual(
            expect.objectContaining({ name: 'environment.webp' }),
          );
        }
        expect(clearDraft).toHaveBeenCalledTimes(1);
        expect(onSubmitted).toHaveBeenCalledTimes(1);
        expect(onSubmitted).toHaveBeenCalledWith(confirmedResponse);
      },
    );

    it('blocks a submission before the request when current options reject an existing file', async () => {
      const submit = jest.fn();
      const outcome = await runWeatherGuardRegistrationDialogSubmission({
        draft: completeDraft(),
        environmentRequired: true,
        evidence: completeEvidence(),
        evidenceConstraints: {
          acceptedImageTypes: ['image/jpeg'],
          maxImageBytes: WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES,
        },
        revision: 1,
        submissionGate: createWeatherGuardRegistrationSubmissionGate(),
        requestCoordinator:
          createWeatherGuardRegistrationDialogRequestCoordinator(),
        submit,
        clearDraft: jest.fn(),
        onSubmitted: jest.fn(),
      });

      expect(outcome).toMatchObject({ kind: 'failed' });
      expect(submit).not.toHaveBeenCalled();
    });

    it('revalidates selected files against refreshed options without pre-reporting unselected fields', () => {
      expect(
        getSelectedWeatherGuardRegistrationEvidenceIssues(
          completeEvidence({
            disasterEvidence: null,
            environmentEvidence: null,
          }),
          true,
          {
            acceptedImageTypes: ['image/jpeg'],
            maxImageBytes: WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES,
          },
        ),
      ).toEqual([
        expect.objectContaining({ field: 'deviceEvidence', code: 'type' }),
      ]);
    });

    it('loads options after the shell opens and renders only server-backed conditional choices', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(source).toContain('getWeatherGuardRegistrationOptions');
      expect(source).toContain('正在读取当前预警与戒备信息');
      expect(source).toContain('environmentRequired');
      expect(source).toContain('personnelSyncedAt');
      expect(source).toContain('personnelStale');
      expect(source.match(/<fieldset/gu) || []).toHaveLength(1);
      expect(source.match(/<legend/gu) || []).toHaveLength(1);
      expect(source).not.toContain('role="listbox"');
      expect(source).not.toContain('role="option"');
      expect(source).not.toContain('role="radiogroup"');
      expect(source).not.toContain('role="radio"');
      expect(source).not.toContain('type="radio"');
      expect(source).not.toContain('name="weather-guard-manager"');
      expect(source).not.toContain('managerKey');
      expect(source).toContain('全部在职人员');
      expect(source).toContain('未标注机楼');
      expect(source).not.toContain('当前楼栋暂无可选在职检查人');
      expect(source).not.toContain('请先选择楼栋');
      expect(source).not.toContain(
        'disabled={controlsDisabled || !draft.building}',
      );
      expect(source).not.toContain('candidate.buildings.length > 0');
      expect(source).not.toContain('UserSelect');
      expect(source).not.toContain('shrcneofD8Ahc8650YU6hIuPpTe');
    });

    it('keeps selected checkers when the building changes and hides registration time', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      const buildingChangeBlock =
        source.match(
          /onValueChange=\{\(value\) => \{[\s\S]*?\n\s*\}\}\n\s*>/u,
        )?.[0] ?? '';

      expect(buildingChangeBlock).not.toContain('checkerKeys');
      expect(source).not.toContain('登记时间');
      expect(source).not.toContain('提交时由服务端记录');
      expect(source).not.toContain('服务端戒备等级');
      expect(source).toContain('戒备等级');
      expect(source).not.toContain('name="weather-guard-manager"');
      expect(source).not.toContain('managerKey');
    });

    it('drives selection, refreshed-file, and submission validation from loaded upload options', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      const optionsAssertion =
        source.match(
          /function assertRegistrationOptions[\s\S]*?(?=function isCanonicalIsoTimestamp)/u,
        )?.[0] ?? '';

      expect(source).not.toContain('const IMAGE_ACCEPT =');
      expect(source).toContain(
        'acceptedImageTypes={options.acceptedImageTypes}',
      );
      expect(source).toContain("accept={acceptedImageTypes.join(',')}");
      expect(source).toContain("'application/pdf': 'PDF'");
      expect(source).toContain('检查附件');
      expect(source).toContain(
        'getSelectedWeatherGuardRegistrationEvidenceIssues(',
      );
      expect(source).toContain('服务端附件要求已更新');
      expect(source).toMatch(
        /validateWeatherGuardRegistrationEvidence\([\s\S]*?acceptedImageTypes: options\.acceptedImageTypes[\s\S]*?maxImageBytes: options\.maxImageBytes/u,
      );
      expect(source).toMatch(
        /evidenceConstraints:\s*\{[\s\S]*?acceptedImageTypes: options\.acceptedImageTypes[\s\S]*?maxImageBytes: options\.maxImageBytes/u,
      );
      expect(optionsAssertion).toContain('options.acceptedImageTypes');
      expect(optionsAssertion).toContain('options.maxImageBytes');
    });

    it('associates stable labels and names with every searchable, abnormal, and file control', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      const buildingSelect = source.match(/<Select[\s\S]*?>/u)?.[0] ?? '';

      expect(buildingSelect).toContain('name="weather-guard-building"');
      expect(source).toContain(
        '<Label htmlFor="weather-guard-building">楼栋</Label>',
      );
      expect(source).toContain('id="weather-guard-checker-search"');
      expect(source).toContain('name="weather-guard-checker-search"');
      expect(source).not.toContain('id="weather-guard-manager-search"');
      expect(source).not.toContain('name="weather-guard-manager-search"');
      expect(source.match(/autoComplete="off"/gu) || []).toHaveLength(2);
      expect(source).toContain('const descriptionId =');
      expect(source).toContain('htmlFor={descriptionId}');
      expect(source).toContain('id={descriptionId}');
      expect(source).toContain('name={descriptionId}');
      expect(source).toContain('const evidenceInputId =');
      expect(source).toContain('htmlFor={evidenceInputId}');
      expect(source).toContain('id={evidenceInputId}');
      expect(source).toContain('name={definition.evidenceField}');
      expect(source).toContain(
        'aria-label={`选择${definition.title}检查附件`}',
      );
      expect(source).toContain('focus-within:ring-2');
    });

    it('focuses the actual first invalid control and respects reduced motion', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      const focusBlock =
        source.match(
          /function focusRegistrationField[\s\S]*?(?=function formatFileSize)/u,
        )?.[0] ?? '';

      expect(focusBlock).toContain('`[data-registration-control="${field}"]`');
      expect(focusBlock).not.toContain('data-registration-field');
      expect(focusBlock).toContain(
        "matchMedia('(prefers-reduced-motion: reduce)')",
      );
      expect(focusBlock).toContain('target.focus({ preventScroll: true })');
      expect(focusBlock).toContain("reducedMotion ? 'auto' : 'smooth'");
      expect(source).toContain('data-registration-control="building"');
      expect(source).toContain('data-registration-control="checkerKeys"');
      expect(source).not.toContain('data-registration-control="managerKey"');
      expect(source).toContain(
        'data-registration-control={definition.abnormalDescriptionField}',
      );
      expect(source).toContain(
        'data-registration-control={definition.evidenceField}',
      );
    });

    it('uses reduced-motion fallbacks and typographic ellipses for pending controls', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(
        source.match(/animate-spin motion-reduce:animate-none/gu) || [],
      ).toHaveLength(1);
      expect(
        source.match(/motion-reduce:transition-none/gu) || [],
      ).not.toHaveLength(0);
      expect(source).toContain('placeholder="搜索检查人…"');
      expect(source).not.toContain('placeholder="搜索机房经理…"');
      expect(source).toContain('placeholder="说明异常位置、现象与已采取措施…"');
      expect(source).toContain('正在读取当前预警与戒备信息…');
      expect(source).not.toContain("? '正在提交…'");
    });

    it('reserves preview image space and safely wraps long warning and person text', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      const previewImage = source.match(/<img[\s\S]*?\/>/u)?.[0] ?? '';

      expect(previewImage).toContain('width={56}');
      expect(previewImage).toContain('height={56}');
      expect(previewImage).toContain('loading="lazy"');
      expect(previewImage).toContain('alt={`${definition.title}检查图片预览`}');
      expect(source).toContain(
        'font-medium text-slate-900 break-words [overflow-wrap:anywhere]',
      );
      expect(
        source.match(/min-w-0 break-words \[overflow-wrap:anywhere\]/gu) || [],
      ).not.toHaveLength(0);
    });

    it('reports browser draft persistence failures and protects selected files on leave', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(source).toContain(
        'const draftSaved = saveWeatherGuardRegistrationDraft(nextDraft)',
      );
      expect(source).toContain('if (!draftSaved)');
      expect(source).toContain('草稿仅保留在当前页面');
      expect(source).toContain(
        'const draftCleared = clearWeatherGuardRegistrationDraft',
      );
      expect(source).toContain('未能清理浏览器草稿');
      expect(source).toContain("window.addEventListener('beforeunload'");
      expect(source).toContain("window.removeEventListener('beforeunload'");
      expect(source).toContain('event.preventDefault()');
      expect(source).toContain("event.returnValue = ''");
      expect(source).toContain("phase === 'succeeded'");
      expect(source).toContain('EVIDENCE_FIELDS.some');
    });

    it('optimistically hides the dialog and reports background sync instead of blocking in place', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      expect(source).toContain("import { flushSync } from 'react-dom'");
      expect(source).toContain('open={open && !optimisticallyClosed}');
      expect(source).toContain('戒备登记已受理，正在后台同步');
      expect(source).toContain('onBackgroundSyncChange?.(true)');
      expect(source).toContain('onBackgroundSyncChange?.(false)');
      expect(source).not.toContain('服务端确认前请保持本窗口打开');
      expect(source).not.toContain("? '正在提交…'");
    });

    it('locks an accepted draft against edits and clearing until the same mutation is confirmed', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(source).toContain('const [submissionLocked, setSubmissionLocked]');
      expect(source).toContain(
        'saveWeatherGuardRegistrationPending(currentDraft)',
      );
      expect(source).toContain(
        'readWeatherGuardRegistrationPending(warningId)',
      );
      expect(source).toContain(
        'clearWeatherGuardRegistrationPending(submissionWarningId)',
      );
      expect(source).toContain(
        "isSubmitting || phase === 'succeeded' || submissionLocked",
      );
      expect(source).toContain('setSubmissionLocked(true)');
      expect(source).toContain('setSubmissionLocked(false)');
      expect(source).toContain(
        'const [submissionLockConflict, setSubmissionLockConflict]',
      );
      expect(source).toContain(
        'const [recoveringLockedEvidence, setRecoveringLockedEvidence]',
      );
      expect(source).toContain('evidenceDisabled={evidenceControlsDisabled}');
      expect(source).toContain(
        '!submissionIsLocked && !nextOptions.environmentRequired',
      );
      expect(source).toContain(
        'draftCleared\n          ? clearWeatherGuardRegistrationPending(submissionWarningId)',
      );
    });

    it('revokes object URLs when evidence is replaced, removed, or cleared', () => {
      const createObjectUrl = jest
        .fn()
        .mockReturnValueOnce('blob:device-1')
        .mockReturnValueOnce('blob:device-2')
        .mockReturnValueOnce('blob:disaster-1');
      const revokeObjectUrl = jest.fn();
      const previews = createWeatherGuardRegistrationEvidencePreviewRegistry(
        createObjectUrl,
        revokeObjectUrl,
      );

      expect(
        previews.replace(
          'deviceEvidence',
          imageFile('device-1.png', 'image/png'),
        ),
      ).toBe('blob:device-1');
      expect(
        previews.replace(
          'deviceEvidence',
          imageFile('device-2.png', 'image/png'),
        ),
      ).toBe('blob:device-2');
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:device-1');

      previews.remove('deviceEvidence');
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:device-2');
      previews.replace(
        'disasterEvidence',
        imageFile('disaster.png', 'image/png'),
      );
      previews.clear();
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:disaster-1');
      expect(revokeObjectUrl).toHaveBeenCalledTimes(3);
    });

    it('does not create an image preview URL for a PDF scan', () => {
      const createObjectUrl = jest.fn(() => 'blob:pdf');
      const previews = createWeatherGuardRegistrationEvidencePreviewRegistry(
        createObjectUrl,
        jest.fn(),
      );

      expect(
        previews.replace(
          'deviceEvidence',
          imageFile('device.pdf', 'application/pdf'),
        ),
      ).toBeNull();
      expect(createObjectUrl).not.toHaveBeenCalled();
    });

    it('keeps preview replacement usable when URL revocation itself fails', () => {
      const previews = createWeatherGuardRegistrationEvidencePreviewRegistry(
        jest
          .fn()
          .mockReturnValueOnce('blob:first')
          .mockReturnValueOnce('blob:second'),
        jest.fn(() => {
          throw new Error('revocation unavailable');
        }),
      );
      previews.replace('deviceEvidence', imageFile('first.png', 'image/png'));

      expect(() =>
        previews.replace(
          'deviceEvidence',
          imageFile('second.png', 'image/png'),
        ),
      ).not.toThrow();
      expect(previews.get('deviceEvidence')).toBe('blob:second');
      expect(() => previews.clear()).not.toThrow();
    });

    it('retains one mutation UUID after failure and clears only after a confirmed retry', async () => {
      const submissionGate = createWeatherGuardRegistrationSubmissionGate();
      const requestCoordinator =
        createWeatherGuardRegistrationDialogRequestCoordinator();
      const response = {
        success: true as const,
        clientMutationId: MUTATION_ID,
        syncStatus: 'confirmed' as const,
        recordId: 'rec_registration_retry',
        createdAt: '2026-08-08T19:00:00+08:00',
        building: 'A楼' as const,
        guardLevel: '三级戒备' as const,
      };
      const submit = jest
        .fn()
        .mockRejectedValueOnce(new Error('网络超时'))
        .mockResolvedValueOnce(response);
      const clearDraft = jest.fn();
      const onSubmitted = jest.fn();
      const input = {
        draft: completeDraft(),
        environmentRequired: true,
        evidence: completeEvidence(),
        revision: 9,
        submissionGate,
        requestCoordinator,
        submit,
        clearDraft,
        onSubmitted,
      };

      await expect(
        runWeatherGuardRegistrationDialogSubmission(input),
      ).resolves.toMatchObject({ kind: 'failed' });
      expect(clearDraft).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();

      await expect(
        runWeatherGuardRegistrationDialogSubmission(input),
      ).resolves.toEqual({ kind: 'succeeded', result: response });
      const payloads = submit.mock.calls.map(([formData]) =>
        JSON.parse(String((formData as FormData).get('payload'))),
      );
      expect(payloads).toHaveLength(2);
      expect(payloads[0].clientMutationId).toBe(MUTATION_ID);
      expect(payloads[1].clientMutationId).toBe(MUTATION_ID);
      expect(clearDraft).toHaveBeenCalledTimes(1);
      expect(onSubmitted).toHaveBeenCalledTimes(1);
    });

    it('ignores a submission response after its request revision is invalidated', async () => {
      const submissionGate = createWeatherGuardRegistrationSubmissionGate();
      const requestCoordinator =
        createWeatherGuardRegistrationDialogRequestCoordinator();
      const deferred = createDeferred<{
        success: true;
        recordId: string;
        createdAt: string;
        building: 'A楼';
        guardLevel: '三级戒备';
      }>();
      const clearDraft = jest.fn();
      const onSubmitted = jest.fn();
      const submission = runWeatherGuardRegistrationDialogSubmission({
        draft: completeDraft(),
        environmentRequired: true,
        evidence: completeEvidence(),
        revision: 10,
        submissionGate,
        requestCoordinator,
        submit: () => deferred.promise,
        clearDraft,
        onSubmitted,
      });

      requestCoordinator.invalidate();
      deferred.resolve({
        success: true,
        recordId: 'rec_stale',
        createdAt: '2026-08-08T19:10:00+08:00',
        building: 'A楼',
        guardLevel: '三级戒备',
      });

      await expect(submission).resolves.toEqual({ kind: 'stale' });
      expect(clearDraft).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('separates option loading from background submission and never clears on an ordinary close', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );
      const closeBlock =
        source.match(
          /const handleOpenChange = useCallback\([\s\S]*?(?=const handleStatusChange)/u,
        )?.[0] ?? '';

      expect(source).toContain('optionsRequestCoordinatorRef');
      expect(source).toContain('submissionRequestCoordinatorRef');
      expect(source).toContain('optimisticallyClosed');
      expect(closeBlock).toContain(
        'optionsRequestCoordinatorRef.current.invalidate()',
      );
      expect(closeBlock).not.toContain(
        'submissionRequestCoordinatorRef.current.invalidate()',
      );
      expect(source).not.toContain(
        'submissionRequestCoordinatorRef.current.invalidate()',
      );
      expect(closeBlock).not.toContain('if (!nextOpen && isSubmitting) return');
      expect(closeBlock).toContain('releasePreviewUrls');
      expect(closeBlock).not.toContain('clearWeatherGuardRegistrationDraft');
    });

    it('uses the shared alert dialog instead of browser confirm when clearing a draft', () => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/pages/MonthlySchedule/WeatherWarningGuardRegistrationDialog.tsx',
        ),
        'utf8',
      );

      expect(source).not.toContain('window.confirm');
      expect(source).toContain('<AlertDialog>');
      expect(source).toContain(
        '<AlertDialogAction onClick={handleClearDraft}>',
      );
    });
  });
});

function completeDraft(
  overrides: Partial<WeatherGuardRegistrationDraft> = {},
): WeatherGuardRegistrationDraft {
  return {
    ...createWeatherGuardRegistrationDraft('warning-42', () => MUTATION_ID),
    building: 'A楼',
    checkerKeys: ['checker-1'],
    deviceStatus: '正常',
    disasterStatus: '正常',
    environmentStatus: '正常',
    materialsStatus: '正常',
    contactsStatus: '正常',
    ...overrides,
  };
}

function completeEvidence(
  overrides: Partial<WeatherGuardRegistrationEvidence> = {},
): WeatherGuardRegistrationEvidence {
  return {
    deviceEvidence: imageFile('device.png', 'image/png'),
    disasterEvidence: imageFile('disaster.jpg', 'image/jpeg'),
    environmentEvidence: imageFile('environment.webp', 'image/webp'),
    ...overrides,
  };
}

function imageFile(name: string, type: string): File {
  return new File([new Uint8Array([1])], name, { type });
}

function memoryStorage(): WeatherGuardRegistrationDraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
