jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { ATTACHED_BANK } from '../../shared/mbti-attached-bank-model';
import {
  createEmployeeOnboarding,
  EmployeeOnboardingApiResponseError,
} from '../../client/src/api';
import {
  EMPLOYEE_ONBOARDING_STORAGE_KEY,
  createEmployeeOnboardingCoordinator,
  validateEmployeeOnboardingDraft,
  type EmployeeOnboardingDraft,
  type EmployeeOnboardingFileSelection,
} from '../../client/src/pages/MonthlySchedule/employee-onboarding-state';

const VALID_IDENTITY_NUMBER = '110101199001010015';
const UUID_V4_PATTERN =
  /^employee-onboarding-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validDraft(
  overrides: Partial<EmployeeOnboardingDraft> = {},
): EmployeeOnboardingDraft {
  const draft: EmployeeOnboardingDraft = {
    name: ' 自动化测试员工 ',
    companyName: '南通承宏云计算有限公司',
    position: '运维实习生',
    identityNumber: ` ${VALID_IDENTITY_NUMBER} `,
    phone: '19900001234',
    entryDate: '2026-08-18',
    education: '本科',
    graduateSchool: ' 测试大学 ',
    major: ' 计算机科学 ',
    graduationDate: '2026-06-30',
    hobbies: ['篮球', '阅读', '篮球'],
    vehiclePlate: ' 苏f12345 ',
    mbtiAssessment: { participantName: '自动化测试员工', version: 'full', answers: Array(93).fill('A'), sourceSha256: ATTACHED_BANK.sourceSha256 },
    ...overrides,
  };
  if (overrides.name !== undefined && overrides.mbtiAssessment === undefined && draft.mbtiAssessment) {
    draft.mbtiAssessment = { ...draft.mbtiAssessment, participantName: draft.name.trim() };
  }
  return draft;
}

function photo(name = 'portrait.png', type = 'image/png', size = 3): File {
  return new File([new Uint8Array(size)], name, { type });
}

function validFiles(
  overrides: Partial<EmployeeOnboardingFileSelection> = {},
): EmployeeOnboardingFileSelection {
  return {
    photo: photo(),
    ...overrides,
  };
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  failRemoves = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('storage read failed');
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('storage write failed');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failRemoves) throw new Error('storage remove failed');
    this.values.delete(key);
  }
}

function responseFor(clientMutationId: string) {
  return {
    success: true as const,
    syncStatus: 'confirmed' as const,
    clientMutationId,
    recordId: 'rec_confirmed',
    createdAt: '2026-08-16T08:00:00.000Z',
  };
}

const originalEmployeeOnboardingFetch = Object.getOwnPropertyDescriptor(
  globalThis,
  'fetch',
);
const originalEmployeeOnboardingWindow = Object.getOwnPropertyDescriptor(
  globalThis,
  'window',
);

function installEmployeeOnboardingFetch(fetchMock: jest.Mock): void {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: fetchMock,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { csrfToken: 'a'.repeat(43) },
  });
}

function restoreEmployeeOnboardingBrowserGlobals(): void {
  for (const [name, descriptor] of [
    ['fetch', originalEmployeeOnboardingFetch],
    ['window', originalEmployeeOnboardingWindow],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

function employeeOnboardingFetchResponse(
  status: number,
  data: unknown,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(data),
  } as unknown as Response;
}

describe('employee onboarding synchronous validation', () => {
  it('blocks submit until a complete assessment belongs to the current name', () => {
    const missing = validateEmployeeOnboardingDraft(validDraft({ mbtiAssessment: null }), validFiles());
    expect(missing).toMatchObject({ status: 'validation', errors: { mbtiAssessment: '请先完成 MBTI 测试' } });
    const changedName = validateEmployeeOnboardingDraft({ ...validDraft(), name: '另一位员工' }, validFiles());
    expect(changedName).toMatchObject({ status: 'validation', errors: { mbtiAssessment: '请先完成 MBTI 测试' } });
  });
  it('normalizes text, identity number, hobbies and optional vehicle plate', () => {
    const result = validateEmployeeOnboardingDraft(validDraft(), validFiles());

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;
    expect(result.values).toMatchObject({
      name: '自动化测试员工',
      identityNumber: VALID_IDENTITY_NUMBER,
      graduateSchool: '测试大学',
      major: '计算机科学',
      hobbies: ['篮球', '阅读'],
      vehiclePlate: '苏F12345',
    });
  });

  it.each([
    ['name', ''],
    ['companyName', ''],
    ['position', ''],
    ['identityNumber', ''],
    ['phone', ''],
    ['entryDate', ''],
    ['education', ''],
    ['graduateSchool', ''],
    ['major', ''],
    ['graduationDate', ''],
  ] as const)('rejects an empty required %s field', (field, value) => {
    const result = validateEmployeeOnboardingDraft(
      validDraft({ [field]: value }),
      validFiles(),
    );
    expect(result).toMatchObject({
      status: 'validation',
      errors: { [field]: expect.any(String) },
    });
  });

  it('rejects invalid enums, duplicate-free empty hobbies and overlong Unicode text', () => {
    const invalidEnum = validateEmployeeOnboardingDraft(
      validDraft({ hobbies: [] }),
      validFiles(),
    );
    expect(invalidEnum).toMatchObject({
      status: 'validation',
      errors: {
        hobbies: expect.any(String),
      },
    });

    const overlong = validateEmployeeOnboardingDraft(
      validDraft({ name: '😀'.repeat(51), vehiclePlate: '🚗'.repeat(21) }),
      validFiles(),
    );
    expect(overlong).toMatchObject({
      status: 'validation',
      errors: {
        name: expect.any(String),
        vehiclePlate: expect.any(String),
      },
    });
  });

  it('rejects bad identity checksum/birthdate, non-mainland mobile and impossible dates', () => {
    const result = validateEmployeeOnboardingDraft(
      validDraft({
        identityNumber: '110101199002300015',
        phone: '12900001234',
        entryDate: '2026-02-29',
        graduationDate: '0999-01-01',
      }),
      validFiles(),
    );
    expect(result).toMatchObject({
      status: 'validation',
      errors: {
        identityNumber: expect.any(String),
        phone: expect.any(String),
        entryDate: expect.any(String),
        graduationDate: expect.any(String),
      },
    });
  });

  it.each([
    ['missing photo', { photo: null }, 'photo'],
    ['empty photo', { photo: photo('portrait.png', 'image/png', 0) }, 'photo'],
    [
      'oversized photo',
      { photo: photo('portrait.png', 'image/png', 10 * 1024 * 1024 + 1) },
      'photo',
    ],
    [
      'photo MIME/extension mismatch',
      { photo: photo('portrait.jpg', 'image/png') },
      'photo',
    ],
  ] as const)('rejects %s', (_label, override, field) => {
    const result = validateEmployeeOnboardingDraft(
      validDraft(),
      validFiles(override as Partial<EmployeeOnboardingFileSelection>),
    );
    expect(result).toMatchObject({
      status: 'validation',
      errors: { [field]: expect.any(String) },
    });
  });

  it('accepts a realm-neutral File brand but rejects an ordinary file-shaped object', () => {
    const backingFile = photo();
    const crossRealmPhoto = {
      [Symbol.toStringTag]: 'File',
      name: backingFile.name,
      type: backingFile.type,
      size: backingFile.size,
      slice: backingFile.slice.bind(backingFile),
      arrayBuffer: backingFile.arrayBuffer.bind(backingFile),
    } as unknown as File;
    expect(
      validateEmployeeOnboardingDraft(
        validDraft(),
        validFiles({ photo: crossRealmPhoto }),
      ).status,
    ).toBe('valid');

    const plainFake = {
      name: 'portrait.png',
      type: 'image/png',
      size: 3,
    } as File;
    expect(
      validateEmployeeOnboardingDraft(
        validDraft(),
        validFiles({ photo: plainFake }),
      ),
    ).toMatchObject({
      status: 'validation',
      errors: { photo: expect.any(String) },
    });
  });
});

describe('employee onboarding submission coordinator', () => {
  it('accepts with a strict UUID v4, immutable snapshots and a PII-free storage ledger', () => {
    const storage = new MemoryStorage();
    const draft = validDraft();
    const files = validFiles();
    const coordinator = createEmployeeOnboardingCoordinator({ storage });

    const result = coordinator.begin(draft, files);

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.request.clientMutationId).toMatch(UUID_V4_PATTERN);
    expect(result.closeImmediately).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.values)).toBe(true);
    expect(Object.isFrozen(result.snapshot.values.hobbies)).toBe(true);
    expect(Object.isFrozen(result.request)).toBe(true);

    draft.name = '被篡改';
    draft.hobbies.push('其他');
    expect(result.request.name).toBe('自动化测试员工');
    expect(result.request.hobbies).toEqual(['篮球', '阅读']);

    const raw = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(raw).not.toContain('自动化测试员工');
    expect(raw).not.toContain(VALID_IDENTITY_NUMBER);
    expect(raw).not.toContain('19900001234');
    expect(raw).not.toContain('portrait.png');
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual([
      'clientMutationId',
      'revision',
      'stage',
      'version',
    ]);
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      clientMutationId: result.request.clientMutationId,
      revision: result.token.revision,
      stage: 'in-flight',
    });
  });

  it('does not accept when session storage cannot be written', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const coordinator = createEmployeeOnboardingCoordinator({ storage });

    expect(coordinator.begin(validDraft(), validFiles())).toEqual({
      status: 'storage-error',
    });
    expect(coordinator.getRecovery()).toBeNull();
  });

  it('does not accept when the initial session storage read fails', () => {
    const storage = new MemoryStorage();
    storage.failReads = true;
    const coordinator = createEmployeeOnboardingCoordinator({ storage });

    expect(coordinator.begin(validDraft(), validFiles())).toEqual({
      status: 'storage-error',
    });
    expect(coordinator.getLedger()).toBeNull();
    expect(coordinator.getRecovery()).toBeNull();
  });

  it('does not accept when an invalid ledger cannot be removed', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      EMPLOYEE_ONBOARDING_STORAGE_KEY,
      JSON.stringify({ version: 1, identityNumber: VALID_IDENTITY_NUMBER }),
    );
    storage.failRemoves = true;
    const coordinator = createEmployeeOnboardingCoordinator({ storage });

    expect(coordinator.begin(validDraft(), validFiles())).toEqual({
      status: 'storage-error',
    });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toContain(
      VALID_IDENTITY_NUMBER,
    );
    expect(coordinator.getRecovery()).toBeNull();
  });

  it('suppresses active double-clicks without creating a second request', () => {
    const coordinator = createEmployeeOnboardingCoordinator({
      storage: new MemoryStorage(),
    });
    const draft = validDraft();
    const files = validFiles();
    const first = coordinator.begin(draft, files);
    const duplicate = coordinator.begin(draft, files);

    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
    if (first.status === 'accepted' && duplicate.status === 'duplicate') {
      expect(duplicate.token).toEqual(first.token);
    }
  });

  it('does not let a coordinator constructed from stale empty storage overwrite a newer ledger', () => {
    const storage = new MemoryStorage();
    const coordinatorA = createEmployeeOnboardingCoordinator({ storage });
    const coordinatorB = createEmployeeOnboardingCoordinator({ storage });
    const acceptedA = coordinatorA.begin(validDraft(), validFiles());
    expect(acceptedA.status).toBe('accepted');
    if (acceptedA.status !== 'accepted') return;
    const rawA = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);

    expect(
      coordinatorB.begin(
        validDraft({ name: '后构造协调器员工' }),
        validFiles(),
      ),
    ).toEqual({ status: 'storage-error' });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(rawA);
    expect(coordinatorA.getLedger()).toEqual(
      JSON.parse(String(rawA)) as Record<string, unknown>,
    );
    expect(coordinatorB.getRecovery()).toBeNull();
  });

  it('restores the complete in-memory snapshot after editable failure and changed retry gets a new ID', () => {
    const coordinator = createEmployeeOnboardingCoordinator({
      storage: new MemoryStorage(),
    });
    const first = coordinator.begin(validDraft(), validFiles());
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;

    const failure = coordinator.resolveFailure(first.token, {
      response: { status: 422 },
    });
    expect(failure).toMatchObject({
      status: 'editable-error',
      recovery: first.snapshot,
    });
    expect(coordinator.getRecovery()).toBe(first.snapshot);

    const changed = coordinator.begin(
      { ...first.snapshot.values, name: '修改后的员工', mbtiAssessment: { ...first.snapshot.values.mbtiAssessment, participantName: '修改后的员工' } },
      {
        photo: first.snapshot.photo,
      },
    );
    expect(changed.status).toBe('accepted');
    if (changed.status === 'accepted') {
      expect(changed.request.clientMutationId).not.toBe(
        first.request.clientMutationId,
      );
      expect(changed.token.revision).toBeGreaterThan(first.token.revision);
    }
  });

  it('keeps the in-flight ledger and snapshot when persisting a failure stage fails', () => {
    const storage = new MemoryStorage();
    const coordinator = createEmployeeOnboardingCoordinator({ storage });
    const begin = coordinator.begin(validDraft(), validFiles());
    expect(begin.status).toBe('accepted');
    if (begin.status !== 'accepted') return;
    const rawInFlight = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);
    storage.failWrites = true;

    expect(
      coordinator.resolveFailure(begin.token, { response: { status: 422 } }),
    ).toEqual({
      status: 'storage-error',
      recovery: begin.snapshot,
    });
    expect(coordinator.getRecovery()).toBe(begin.snapshot);
    expect(coordinator.getLedger()).toEqual({
      version: 1,
      clientMutationId: begin.token.clientMutationId,
      revision: begin.token.revision,
      stage: 'in-flight',
    });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(
      rawInFlight,
    );
    expect(coordinator.begin(validDraft(), validFiles())).toEqual({
      status: 'storage-error',
    });
  });

  it.each([
    [{ response: { status: 400 } }],
    [{ response: { status: 401 } }],
    [{ response: { status: 403 } }],
    [{ response: { status: 413 } }],
    [{ response: { status: 422 } }],
    [{ response: { status: 429 } }],
  ])('classifies explicit non-write HTTP failures as editable', (error) => {
    const coordinator = createEmployeeOnboardingCoordinator({
      storage: new MemoryStorage(),
    });
    const begin = coordinator.begin(validDraft(), validFiles());
    expect(begin.status).toBe('accepted');
    if (begin.status !== 'accepted') return;
    expect(coordinator.resolveFailure(begin.token, error).status).toBe(
      'editable-error',
    );
  });

  it('blocks every retry after an idempotency fingerprint conflict', () => {
    const coordinator = createEmployeeOnboardingCoordinator({
      storage: new MemoryStorage(),
    });
    const first = coordinator.begin(validDraft(), validFiles());
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;

    expect(
      coordinator.resolveFailure(first.token, { response: { status: 409 } }),
    ).toMatchObject({ status: 'conflict', recovery: first.snapshot });
    expect(coordinator.getLedger()?.stage).toBe('conflict');
    expect(
      coordinator.begin(first.snapshot.values, {
        photo: first.snapshot.photo,
      }),
    ).toMatchObject({ status: 'blocked-conflict' });
    expect(
      coordinator.begin(
        { ...first.snapshot.values, name: '冲突后的修改内容' },
        {
          photo: first.snapshot.photo,
        },
      ),
    ).toMatchObject({ status: 'blocked-conflict' });

    expect(coordinator.abandonConflict()).toEqual({ status: 'cleared' });
    const replacement = coordinator.begin(first.snapshot.values, {
      photo: first.snapshot.photo,
    });
    expect(replacement.status).toBe('accepted');
    if (replacement.status === 'accepted') {
      expect(replacement.request.clientMutationId).not.toBe(
        first.request.clientMutationId,
      );
      expect(replacement.token.revision).toBeGreaterThan(first.token.revision);
    }
  });

  it('does not let a stale conflict acknowledgement delete a newer ledger', () => {
    const storage = new MemoryStorage();
    const current = createEmployeeOnboardingCoordinator({ storage });
    const first = current.begin(validDraft(), validFiles());
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;
    current.resolveFailure(first.token, { response: { status: 409 } });

    const stale = createEmployeeOnboardingCoordinator({ storage });
    expect(current.abandonConflict()).toEqual({ status: 'cleared' });
    const replacement = current.begin(validDraft(), validFiles());
    expect(replacement.status).toBe('accepted');
    const replacementLedger = storage.values.get(
      EMPLOYEE_ONBOARDING_STORAGE_KEY,
    );

    expect(stale.abandonConflict()).toEqual({ status: 'stale' });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(
      replacementLedger,
    );
  });

  it.each([
    [{ response: { status: 408 } }],
    [{ response: { status: 425 } }],
    [{ response: { status: 500 } }],
    [{ code: 'ECONNABORTED', message: 'timeout' }],
    [{ name: 'AbortError' }],
    [{ code: 'ERR_NETWORK', request: {} }],
  ])('classifies uncertain transport failures as unknown', (error) => {
    const coordinator = createEmployeeOnboardingCoordinator({
      storage: new MemoryStorage(),
    });
    const begin = coordinator.begin(validDraft(), validFiles());
    expect(begin.status).toBe('accepted');
    if (begin.status !== 'accepted') return;
    expect(coordinator.resolveFailure(begin.token, error).status).toBe(
      'unknown-result',
    );
  });

  it('reuses the mutation ID for an unchanged unknown retry and blocks changed content or files', () => {
    const coordinator = createEmployeeOnboardingCoordinator({
      storage: new MemoryStorage(),
    });
    const originalFiles = validFiles();
    const first = coordinator.begin(validDraft(), originalFiles);
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;
    coordinator.resolveFailure(first.token, { code: 'ETIMEDOUT' });

    expect(
      coordinator.begin(
        { ...first.snapshot.values, name: '另一个员工', mbtiAssessment: { ...first.snapshot.values.mbtiAssessment, participantName: '另一个员工' } },
        {
          photo: first.snapshot.photo,
        },
      ),
    ).toMatchObject({ status: 'blocked-unknown-change' });
    expect(
      coordinator.begin(first.snapshot.values, {
        photo: photo(),
      }),
    ).toMatchObject({ status: 'blocked-unknown-change' });

    const retry = coordinator.begin(first.snapshot.values, {
      photo: first.snapshot.photo,
    });
    expect(retry.status).toBe('accepted');
    if (retry.status === 'accepted') {
      expect(retry.request.clientMutationId).toBe(
        first.request.clientMutationId,
      );
      expect(retry.token.revision).toBeGreaterThan(first.token.revision);
    }
  });

  it('suppresses stale results and only a current confirmed response clears memory and storage', () => {
    const storage = new MemoryStorage();
    const coordinator = createEmployeeOnboardingCoordinator({ storage });
    const first = coordinator.begin(validDraft(), validFiles());
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;
    coordinator.resolveFailure(first.token, { code: 'ETIMEDOUT' });
    const retry = coordinator.begin(first.snapshot.values, {
      photo: first.snapshot.photo,
    });
    expect(retry.status).toBe('accepted');
    if (retry.status !== 'accepted') return;

    expect(
      coordinator.resolveSuccess(
        first.token,
        responseFor(first.request.clientMutationId),
      ),
    ).toEqual({ status: 'stale' });
    expect(coordinator.getRecovery()).toBe(retry.snapshot);
    expect(storage.values.has(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(true);

    expect(
      coordinator.resolveSuccess(
        retry.token,
        responseFor(retry.request.clientMutationId),
      ),
    ).toEqual({
      status: 'confirmed',
      response: responseFor(retry.request.clientMutationId),
    });
    expect(coordinator.getRecovery()).toBeNull();
    expect(storage.values.has(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(false);
  });

  it('keeps the current snapshot and ledger when confirmed cleanup cannot remove storage', () => {
    const storage = new MemoryStorage();
    const coordinator = createEmployeeOnboardingCoordinator({ storage });
    const begin = coordinator.begin(validDraft(), validFiles());
    expect(begin.status).toBe('accepted');
    if (begin.status !== 'accepted') return;
    const rawInFlight = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);
    const confirmedResponse = responseFor(begin.token.clientMutationId);
    storage.failRemoves = true;

    expect(coordinator.resolveSuccess(begin.token, confirmedResponse)).toEqual({
      status: 'storage-error',
      recovery: begin.snapshot,
      confirmedResponse,
    });
    expect(coordinator.getRecovery()).toBe(begin.snapshot);
    expect(coordinator.getLedger()).toEqual({
      version: 1,
      clientMutationId: begin.token.clientMutationId,
      revision: begin.token.revision,
      stage: 'in-flight',
    });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(
      rawInFlight,
    );
  });

  it('ignores a stale failure without changing the current revision, snapshot or raw ledger', () => {
    const storage = new MemoryStorage();
    const coordinator = createEmployeeOnboardingCoordinator({ storage });
    const first = coordinator.begin(validDraft(), validFiles());
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;
    coordinator.resolveFailure(first.token, { code: 'ETIMEDOUT' });
    const retry = coordinator.begin(first.snapshot.values, {
      photo: first.snapshot.photo,
    });
    expect(retry.status).toBe('accepted');
    if (retry.status !== 'accepted') return;
    const currentLedger = coordinator.getLedger();
    const currentSnapshot = coordinator.getRecovery();
    const currentRaw = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);

    expect(
      coordinator.resolveFailure(first.token, { response: { status: 422 } }),
    ).toEqual({ status: 'stale' });
    expect(coordinator.getLedger()).toEqual(currentLedger);
    expect(coordinator.getRecovery()).toBe(currentSnapshot);
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(
      currentRaw,
    );
  });

  it('does not let an old coordinator overwrite or delete a newer coordinator ledger', () => {
    const storage = new MemoryStorage();
    const coordinatorA = createEmployeeOnboardingCoordinator({ storage });
    const acceptedA = coordinatorA.begin(validDraft(), validFiles());
    expect(acceptedA.status).toBe('accepted');
    if (acceptedA.status !== 'accepted') return;
    expect(
      coordinatorA.resolveFailure(acceptedA.token, {
        response: { status: 422 },
      }).status,
    ).toBe('editable-error');

    const coordinatorB = createEmployeeOnboardingCoordinator({ storage });
    const acceptedB = coordinatorB.begin(
      validDraft({ name: '新协调器员工' }),
      validFiles(),
    );
    expect(acceptedB.status).toBe('accepted');
    if (acceptedB.status !== 'accepted') return;
    const rawB = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);
    const ledgerB = coordinatorB.getLedger();
    const snapshotB = coordinatorB.getRecovery();

    expect(
      coordinatorA.resolveFailure(acceptedA.token, {
        response: { status: 422 },
      }),
    ).toEqual({ status: 'stale' });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(rawB);
    expect(coordinatorB.getLedger()).toEqual(ledgerB);
    expect(coordinatorB.getRecovery()).toBe(snapshotB);

    expect(
      coordinatorA.resolveSuccess(
        acceptedA.token,
        responseFor(acceptedA.token.clientMutationId),
      ),
    ).toEqual({ status: 'stale' });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(rawB);
    expect(coordinatorB.getLedger()).toEqual(ledgerB);
    expect(coordinatorB.getRecovery()).toBe(snapshotB);
  });

  it('turns malformed or mismatched current success payloads into unknown result', () => {
    for (const response of [
      { success: true },
      responseFor('employee-onboarding-123e4567-e89b-42d3-a456-426614174000'),
    ]) {
      const coordinator = createEmployeeOnboardingCoordinator({
        storage: new MemoryStorage(),
      });
      const begin = coordinator.begin(validDraft(), validFiles());
      expect(begin.status).toBe('accepted');
      if (begin.status !== 'accepted') continue;
      expect(coordinator.resolveSuccess(begin.token, response)).toMatchObject({
        status: 'unknown-result',
        recovery: begin.snapshot,
      });
      expect(coordinator.getLedger()?.stage).toBe('unknown-result');
    }
  });

  it.each(['unknown-result', 'in-flight'] as const)(
    'safely resumes a persisted %s ledger with the same mutation ID and a new snapshot',
    (stage) => {
      const storage = new MemoryStorage();
      const clientMutationId =
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000';
      storage.setItem(
        EMPLOYEE_ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          clientMutationId,
          revision: 7,
          stage,
        }),
      );
      const coordinator = createEmployeeOnboardingCoordinator({ storage });
      const selectedFiles = validFiles();
      const retry = coordinator.begin(validDraft(), selectedFiles);

      expect(retry.status).toBe('accepted');
      if (retry.status !== 'accepted') return;
      expect(retry.reusedMutationId).toBe(true);
      expect(retry.request.clientMutationId).toBe(clientMutationId);
      expect(retry.token).toEqual({ clientMutationId, revision: 8 });
      expect(retry.snapshot.photo).toBe(selectedFiles.photo);
      expect(coordinator.getRecovery()).toBe(retry.snapshot);
      expect(coordinator.getLedger()).toEqual({
        version: 1,
        clientMutationId,
        revision: 8,
        stage: 'in-flight',
      });
      expect(
        JSON.parse(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY) ?? ''),
      ).toEqual(coordinator.getLedger());
    },
  );

  it('does not let an old refreshed coordinator overwrite a newer CAS retry', () => {
    const storage = new MemoryStorage();
    const clientMutationId =
      'employee-onboarding-123e4567-e89b-42d3-a456-426614174000';
    storage.setItem(
      EMPLOYEE_ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        clientMutationId,
        revision: 7,
        stage: 'unknown-result',
      }),
    );
    const oldCoordinator = createEmployeeOnboardingCoordinator({ storage });
    const currentCoordinator = createEmployeeOnboardingCoordinator({ storage });
    const currentRetry = currentCoordinator.begin(validDraft(), validFiles());
    expect(currentRetry.status).toBe('accepted');
    if (currentRetry.status !== 'accepted') return;
    const currentRaw = storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY);

    expect(
      oldCoordinator.begin(
        validDraft({ name: '旧协调器不得覆盖' }),
        validFiles(),
      ),
    ).toEqual({ status: 'storage-error' });
    expect(storage.values.get(EMPLOYEE_ONBOARDING_STORAGE_KEY)).toBe(
      currentRaw,
    );
    expect(currentCoordinator.getLedger()).toEqual({
      version: 1,
      clientMutationId,
      revision: 8,
      stage: 'in-flight',
    });
    expect(oldCoordinator.getRecovery()).toBeNull();
  });

  it('keeps persisted ledgers isolated across stages before a retry', () => {
    for (const stage of ['unknown-result', 'in-flight'] as const) {
      const storage = new MemoryStorage();
      storage.setItem(
        EMPLOYEE_ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          clientMutationId:
            'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
          revision: 7,
          stage,
        }),
      );
      const coordinator = createEmployeeOnboardingCoordinator({ storage });
      expect(coordinator.getLedger()).toMatchObject({
        revision: 7,
        stage,
      });
      expect(coordinator.getRecovery()).toBeNull();
    }
  });
});

describe('employee onboarding API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreEmployeeOnboardingBrowserGlobals();
  });

  it('bypasses the logging Axios client for sensitive multipart data', async () => {
    const request = {
      ...validDraft(),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };
    const response = responseFor(request.clientMutationId);
    const fetchMock = jest
      .fn()
      .mockResolvedValue(employeeOnboardingFetchResponse(200, response));
    installEmployeeOnboardingFetch(fetchMock);
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: response });

    await expect(
      createEmployeeOnboarding(request, photo()),
    ).resolves.toEqual(response);

    expect(axiosForBackend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bitable/employee-onboarding');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(new Headers(init.headers).get('X-Suda-Csrf-Token')).toBe(
      'a'.repeat(43),
    );
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('sends exactly one multipart request without a manual Content-Type header', async () => {
    const request = {
      ...validDraft({
        name: '自动化测试员工',
        identityNumber: VALID_IDENTITY_NUMBER,
        graduateSchool: '测试大学',
        major: '计算机科学',
        hobbies: ['篮球'],
        vehiclePlate: '苏f12345',
      }),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };
    const selectedPhoto = photo();
    const signal = new AbortController().signal;
    const response = responseFor(request.clientMutationId);
    const fetchMock = jest
      .fn()
      .mockResolvedValue(employeeOnboardingFetchResponse(200, response));
    installEmployeeOnboardingFetch(fetchMock);

    await expect(
      createEmployeeOnboarding(request, selectedPhoto, signal),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axiosForBackend).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bitable/employee-onboarding');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(init.signal).not.toBe(signal);
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(JSON.parse(String(form.get('payload')))).toEqual(request);
    expect(form.getAll('photo')).toEqual([selectedPhoto]);
    expect(form.getAll('certificates')).toEqual([]);
  });

  it('rejects malformed or mutation-mismatched responses with a fixed non-PII error', async () => {
    const request = {
      ...validDraft({
        name: '敏感姓名',
        identityNumber: VALID_IDENTITY_NUMBER,
        phone: '19900001234',
      }),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };

    for (const data of [
      { success: true },
      responseFor('employee-onboarding-223e4567-e89b-42d3-a456-426614174000'),
    ]) {
      installEmployeeOnboardingFetch(
        jest.fn().mockResolvedValue(employeeOnboardingFetchResponse(200, data)),
      );
      const error = await createEmployeeOnboarding(request, photo()).catch(
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(EmployeeOnboardingApiResponseError);
      expect(error.message).toBe('新员工入职结果待确认');
      expect(error.message).not.toContain('敏感姓名');
      expect(error.message).not.toContain(VALID_IDENTITY_NUMBER);
      expect(error.message).not.toContain('19900001234');
    }
    expect(axiosForBackend).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not log or wrap transport failures', async () => {
    const failure = Object.assign(new Error('network failed'), {
      code: 'ERR_NETWORK',
    });
    installEmployeeOnboardingFetch(jest.fn().mockRejectedValueOnce(failure));
    const request = {
      ...validDraft(),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };
    await expect(createEmployeeOnboarding(request, photo())).rejects.toBe(
      failure,
    );
    expect(axiosForBackend).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('preserves only the HTTP status for a rejected response', async () => {
    const responseBodyReader = jest.fn().mockResolvedValue({
      message: 'must not be copied into the client error',
    });
    installEmployeeOnboardingFetch(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: responseBodyReader,
      }),
    );
    const request = {
      ...validDraft(),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };

    const error = await createEmployeeOnboarding(request, photo()).catch(
      (caught) => caught as Error & { response?: unknown },
    );

    expect(error).toMatchObject({
      name: 'EmployeeOnboardingHttpError',
      response: { status: 403 },
    });
    expect(Object.keys(error.response as object)).toEqual(['status']);
    expect(responseBodyReader).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(VALID_IDENTITY_NUMBER);
    expect(axiosForBackend).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('uses a fixed non-PII timeout error after 120 seconds', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn((_url: string, init: RequestInit) => {
      const requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener(
          'abort',
          () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    });
    installEmployeeOnboardingFetch(fetchMock);
    const request = {
      ...validDraft(),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };

    const assertion = expect(
      createEmployeeOnboarding(request, photo()),
    ).rejects.toMatchObject({
      name: 'EmployeeOnboardingTimeoutError',
      code: 'ETIMEDOUT',
    });
    jest.advanceTimersByTime(120_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates external cancellation without exposing the request', async () => {
    const fetchMock = jest.fn((_url: string, init: RequestInit) => {
      const requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener(
          'abort',
          () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    });
    installEmployeeOnboardingFetch(fetchMock);
    const controller = new AbortController();
    const request = {
      ...validDraft(),
      clientMutationId:
        'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    };

    const assertion = expect(
      createEmployeeOnboarding(request, photo(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
