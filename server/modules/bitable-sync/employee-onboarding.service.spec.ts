import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  EmployeeOnboardingCreateRequest,
  EmployeeOnboardingCreateResponse,
} from '../../../shared/employee-onboarding';
import {
  EmployeeOnboardingClientTokenConflictError,
  EmployeeOnboardingCreateIndeterminateError,
  type EmployeeOnboardingGateway,
  type EmployeeOnboardingUploadFile,
} from './employee-onboarding.gateway';
import { buildEmployeeOnboardingFields } from './employee-onboarding.rules';
import { ATTACHED_BANK } from '../../../shared/mbti-attached-bank-model';
import {
  EmployeeOnboardingService,
  type EmployeeOnboardingSubmitFiles,
} from './employee-onboarding.service';

const MUTATION_ID = 'employee-onboarding-123e4567-e89b-42d3-a456-426614174000';

function request(
  overrides: Partial<EmployeeOnboardingCreateRequest> = {},
): EmployeeOnboardingCreateRequest {
  const payload: EmployeeOnboardingCreateRequest = {
    clientMutationId: MUTATION_ID,
    name: '自动化测试员工',
    companyName: '南通承宏云计算有限公司',
    position: '运维实习生',
    identityNumber: '110101199001010015',
    phone: '19900001234',
    entryDate: '2026-08-15',
    education: '本科',
    graduateSchool: '自动化测试院校',
    major: '自动化测试专业',
    graduationDate: '2026-06-30',
    hobbies: ['阅读', '篮球', '阅读'],
    vehiclePlate: '苏F12345',
    mbtiAssessment: { participantName: '自动化测试员工', version: 'full', answers: Array(93).fill('A'), sourceSha256: ATTACHED_BANK.sourceSha256 },
    ...overrides,
  };
  if (overrides.name !== undefined && overrides.mbtiAssessment === undefined) {
    payload.mbtiAssessment = { ...payload.mbtiAssessment, participantName: payload.name.trim() };
  }
  return payload;
}

function png(
  name = 'employee.png',
  suffix = 'photo',
): EmployeeOnboardingUploadFile {
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(suffix),
  ]);
  return {
    buffer,
    originalname: name,
    mimetype: 'image/png',
    size: buffer.length,
  };
}

function webp(name = 'certificate.webp'): EmployeeOnboardingUploadFile {
  const buffer = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x08, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.from('data'),
  ]);
  return {
    buffer,
    originalname: name,
    mimetype: 'image/webp',
    size: buffer.length,
  };
}

function fieldsWithTokens(
  payload: EmployeeOnboardingCreateRequest,
  photoToken = 'boxPhotoToken',
): Record<string, unknown> {
  return {
    ...buildEmployeeOnboardingFields(payload),
    照片: [{ file_token: photoToken }],
  };
}

interface GatewayMock {
  fetchFieldMetas: jest.Mock;
  uploadAttachment: jest.Mock;
  createRecord: jest.Mock;
  readRecord: jest.Mock;
  invalidateTargetCache: jest.Mock;
}

function gatewayMock(): GatewayMock {
  let createdFields: Record<string, unknown> = {};
  let uploadIndex = 0;
  return {
    fetchFieldMetas: jest.fn().mockResolvedValue([]),
    uploadAttachment: jest.fn().mockImplementation(async () => {
      uploadIndex += 1;
      return `boxToken${uploadIndex}`;
    }),
    createRecord: jest.fn().mockImplementation(async (fields) => {
      createdFields = fields;
      return 'recEmployee123';
    }),
    readRecord: jest.fn().mockImplementation(async () => ({
      ...createdFields,
      系统公式字段: '允许存在',
    })),
    invalidateTargetCache: jest.fn(),
  };
}

function serviceWith(gateway = gatewayMock()) {
  return {
    gateway,
    service: new EmployeeOnboardingService(
      gateway as unknown as EmployeeOnboardingGateway,
    ),
  };
}

async function withRetryTimers<T>(operation: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    const settled = operation().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await jest.runAllTimersAsync();
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    jest.useRealTimers();
  }
}

function serialiseError(error: unknown): string {
  const candidate = error as { stack?: unknown; response?: unknown };
  return [
    String(error),
    JSON.stringify(error),
    String(candidate?.stack || ''),
    JSON.stringify(candidate?.response),
  ].join('\n');
}

function httpStatus(error: unknown): number {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getStatus();
}

describe('EmployeeOnboardingService', () => {
  it('maps all business fields and the required ID photo, confirms exact readback, and returns only the minimal response', async () => {
    const gateway = gatewayMock();
    gateway.uploadAttachment
      .mockResolvedValueOnce('boxPhotoToken');
    const { service } = serviceWith(gateway);
    const payload = request();

    const result = await service.create(payload, {
      photo: png(),
    });

    expect(gateway.fetchFieldMetas).toHaveBeenCalledTimes(1);
    expect(gateway.fetchFieldMetas.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.uploadAttachment.mock.invocationCallOrder[0],
    );
    expect(gateway.createRecord).toHaveBeenCalledWith(
      fieldsWithTokens(payload, 'boxPhotoToken'),
      MUTATION_ID,
    );
    expect(gateway.readRecord).toHaveBeenCalledWith('recEmployee123');
    expect(gateway.invalidateTargetCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      syncStatus: 'confirmed',
      clientMutationId: MUTATION_ID,
      recordId: 'recEmployee123',
      createdAt: expect.any(String),
    });
    expect(Object.keys(result)).toEqual([
      'success',
      'syncStatus',
      'clientMutationId',
      'recordId',
      'createdAt',
    ]);
    expect(JSON.stringify(result)).not.toContain(payload.identityNumber);
    expect(JSON.stringify(result)).not.toContain(payload.phone);
    expect(JSON.stringify(result)).not.toContain('boxPhotoToken');
  });

  it('requires a completed assessment before uploading or creating a record', async () => {
    const { gateway, service } = serviceWith();
    await expect(service.create({ ...request(), mbtiAssessment: null }, { photo: png() })).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['missing photo', {}, '证件照必须上传且只能上传一份'],
    ['empty photo array', { photo: [] }, '证件照必须上传且只能上传一份'],
    [
      'multiple photos',
      { photo: [png('a.png'), png('b.png')] },
      '证件照必须上传且只能上传一份',
    ],
    [
      'deprecated certificate field',
      {
        photo: png(),
        certificates: [png('certificate.png')],
      },
      '新员工入职附件参数无效',
    ],
  ] as const)(
    'rejects %s before external work',
    async (_label, files, message) => {
      const { service, gateway } = serviceWith();

      await expect(
        service.create(request(), files as EmployeeOnboardingSubmitFiles),
      ).rejects.toThrow(message);
      expect(gateway.fetchFieldMetas).not.toHaveBeenCalled();
      expect(gateway.uploadAttachment).not.toHaveBeenCalled();
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['size mismatch', { ...png(), size: 1 }],
    [
      'empty file',
      {
        buffer: Buffer.alloc(0),
        originalname: 'empty.png',
        mimetype: 'image/png',
        size: 0,
      },
    ],
    [
      'too large',
      {
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
        originalname: 'large.png',
        mimetype: 'image/png',
        size: 10 * 1024 * 1024 + 1,
      },
    ],
    ['bad photo MIME', { ...png(), mimetype: 'application/pdf' }],
    ['MIME extension mismatch', { ...png('employee.jpg') }],
    [
      'fake PNG signature',
      {
        buffer: Buffer.from('not-png'),
        originalname: 'employee.png',
        mimetype: 'image/png',
        size: 7,
      },
    ],
  ] as const)(
    'rejects an invalid photo (%s) with zero external calls',
    async (_label, file) => {
      const { service, gateway } = serviceWith();

      await expect(service.create(request(), { photo: file })).rejects.toThrow(
        '证件照文件无效',
      );
      expect(gateway.fetchFieldMetas).not.toHaveBeenCalled();
      expect(gateway.uploadAttachment).not.toHaveBeenCalled();
    },
  );

  it('accepts a supported ID-photo signature with a matching extension', async () => {
    const { service, gateway } = serviceWith();

    await service.create(request(), {
      photo: webp('photo.WEBP'),
    });

    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it('coalesces two concurrent equal submissions into one field fetch, upload, create and readback', async () => {
    const gateway = gatewayMock();
    let releaseUpload!: (token: string) => void;
    gateway.uploadAttachment.mockImplementationOnce(
      () => new Promise<string>((resolve) => (releaseUpload = resolve)),
    );
    const { service } = serviceWith(gateway);
    const payload = request();
    const files = { photo: png() };

    const first = service.create(payload, files);
    const concurrent = service.create({ ...payload }, { photo: png() });
    await Promise.resolve();
    releaseUpload('boxSharedPhoto');

    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    expect(concurrentResult).toBe(firstResult);
    expect(gateway.fetchFieldMetas).toHaveBeenCalledTimes(1);
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.readRecord).toHaveBeenCalledTimes(1);
  });

  it('reuses a completed response inside TTL without any external work', async () => {
    const { service, gateway } = serviceWith();
    const payload = request();
    const files = { photo: png() };
    const first = await service.create(payload, files);
    jest.clearAllMocks();

    const repeated = await service.create({ ...payload }, { photo: png() });

    expect(repeated).toBe(first);
    expect(gateway.fetchFieldMetas).not.toHaveBeenCalled();
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects the same mutation ID with a different request or file fingerprint', async () => {
    const { service, gateway } = serviceWith();
    await service.create(request(), { photo: png() });
    jest.clearAllMocks();

    await expect(
      service.create(request({ name: '另一位员工' }), { photo: png() }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.create(request(), { photo: png('employee.png', 'different') }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.fetchFieldMetas).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a permanent upload response failure',
      new BadGatewayException('上传新员工入职附件失败'),
      502,
    ],
    [
      'a temporary upload network failure',
      new ServiceUnavailableException('上传新员工入职附件暂时失败'),
      503,
    ],
  ])(
    'preserves the safe HTTP status for %s',
    async (_label, failure, status) => {
      const gateway = gatewayMock();
      gateway.uploadAttachment.mockRejectedValueOnce(failure);
      const { service } = serviceWith(gateway);

      const error = await service
        .create(request(), { photo: png() })
        .catch((reason) => reason);

      expect(error).toBe(failure);
      expect(httpStatus(error)).toBe(status);
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('stops before all uploads and record writes when field metadata validation fails', async () => {
    const gateway = gatewayMock();
    gateway.fetchFieldMetas.mockRejectedValueOnce(
      new Error('private remote response'),
    );
    const { service } = serviceWith(gateway);

    const error = await service
      .create(request(), { photo: png() })
      .catch((reason) => reason);

    expect(httpStatus(error)).toBe(503);
    expect(String(error)).toContain('校验新员工入职字段暂时失败');
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('preserves a permanent field-contract failure as HTTP 502', async () => {
    const failure = new BadGatewayException('新员工入职字段配置异常');
    const gateway = gatewayMock();
    gateway.fetchFieldMetas.mockRejectedValueOnce(failure);
    const { service } = serviceWith(gateway);

    const error = await service
      .create(request(), { photo: png() })
      .catch((reason) => reason);

    expect(error).toBe(failure);
    expect(httpStatus(error)).toBe(502);
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
  });

  it('preserves a Feishu client-token conflict as HTTP 409', async () => {
    const conflict = new EmployeeOnboardingClientTokenConflictError();
    const gateway = gatewayMock();
    gateway.createRecord.mockRejectedValueOnce(conflict);
    const { service } = serviceWith(gateway);

    const error = await service
      .create(request(), { photo: png() })
      .catch((reason) => reason);

    expect(error).toBe(conflict);
    expect(httpStatus(error)).toBe(409);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(serialiseError(error)).not.toContain(MUTATION_ID);
  });

  it('reuses uploaded tokens after an indeterminate create and retries the exact mutation', async () => {
    const gateway = gatewayMock();
    gateway.createRecord
      .mockRejectedValueOnce(
        new EmployeeOnboardingCreateIndeterminateError(MUTATION_ID),
      )
      .mockImplementationOnce(async (fields) => {
        gateway.readRecord.mockResolvedValueOnce({ ...fields });
        return 'recRecovered123';
      });
    const { service } = serviceWith(gateway);
    const files = { photo: png() };

    const indeterminate = await service
      .create(request(), files)
      .catch((reason) => reason);
    expect(indeterminate).toBeInstanceOf(
      EmployeeOnboardingCreateIndeterminateError,
    );
    expect(httpStatus(indeterminate)).toBe(503);
    await service.create(request(), files);

    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(2);
    expect(gateway.createRecord.mock.calls[1]).toEqual(
      gateway.createRecord.mock.calls[0],
    );
  });

  it('preserves a permanent create failure as HTTP 502', async () => {
    const failure = new BadGatewayException('新增新员工入职记录失败');
    const gateway = gatewayMock();
    gateway.createRecord.mockRejectedValueOnce(failure);
    const { service } = serviceWith(gateway);

    const error = await service
      .create(request(), { photo: png() })
      .catch((reason) => reason);

    expect(error).toBe(failure);
    expect(httpStatus(error)).toBe(502);
  });

  it('maps an unknown create failure to a redacted HTTP 502 fallback', async () => {
    const secret = 'private-create-response boxPrivateToken 19900001234';
    const gateway = gatewayMock();
    gateway.createRecord.mockRejectedValueOnce(new Error(secret));
    const { service } = serviceWith(gateway);

    const error = await service
      .create(request(), { photo: png() })
      .catch((reason) => reason);

    expect(httpStatus(error)).toBe(502);
    expect(String(error)).toContain('写入新员工入职记录失败');
    expect(serialiseError(error)).not.toContain(secret);
    expect(serialiseError(error)).not.toContain('boxPrivateToken');
    expect(serialiseError(error)).not.toContain('19900001234');
  });

  it('keeps the saved record ID when post-readback cache invalidation fails', async () => {
    const gateway = gatewayMock();
    gateway.invalidateTargetCache.mockImplementationOnce(() => {
      throw new Error('private cache detail');
    });
    const { service } = serviceWith(gateway);

    await expect(service.create(request(), { photo: png() })).rejects.toThrow(
      '刷新新员工入职缓存暂时失败',
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.readRecord).toHaveBeenCalledTimes(1);

    await service.create(request(), { photo: png() });

    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.readRecord).toHaveBeenCalledTimes(2);
    expect(gateway.invalidateTargetCache).toHaveBeenCalledTimes(2);
  });

  it('uploads an immutable snapshot when the caller mutates its Buffer during field validation', async () => {
    const gateway = gatewayMock();
    let releaseFields!: () => void;
    gateway.fetchFieldMetas.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseFields = resolve)),
    );
    let uploadedBuffer: Buffer | undefined;
    gateway.uploadAttachment.mockImplementationOnce(
      async (file: EmployeeOnboardingUploadFile) => {
        uploadedBuffer = file.buffer;
        return 'boxSnapshotPhoto';
      },
    );
    const { service } = serviceWith(gateway);
    const photo = png('snapshot.png', 'immutable-source');
    const expectedSnapshot = Buffer.from(photo.buffer);

    const submission = service.create(request(), { photo });
    photo.buffer.fill(0);
    releaseFields();
    await submission;

    expect(uploadedBuffer).toBeDefined();
    expect(uploadedBuffer).not.toBe(photo.buffer);
    expect(uploadedBuffer).toEqual(expectedSnapshot);
  });

  it('retries a null readback and confirms when the exact record becomes visible', async () => {
    const gateway = gatewayMock();
    let createdFields: Record<string, unknown> = {};
    gateway.createRecord.mockImplementationOnce(async (fields) => {
      createdFields = fields;
      return 'recEventuallyVisible123';
    });
    gateway.readRecord
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => ({ ...createdFields }));
    const { service } = serviceWith(gateway);

    await expect(
      withRetryTimers(() => service.create(request(), { photo: png() })),
    ).resolves.toEqual(
      expect.objectContaining({ recordId: 'recEventuallyVisible123' }),
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.readRecord).toHaveBeenCalledTimes(2);
  });

  it('retries a temporary read error and confirms only after an exact response', async () => {
    const gateway = gatewayMock();
    let createdFields: Record<string, unknown> = {};
    gateway.createRecord.mockImplementationOnce(async (fields) => {
      createdFields = fields;
      return 'recReadErrorRecovered123';
    });
    gateway.readRecord
      .mockRejectedValueOnce(new Error('private read response'))
      .mockImplementationOnce(async () => ({ ...createdFields }));
    const { service } = serviceWith(gateway);

    await expect(
      withRetryTimers(() => service.create(request(), { photo: png() })),
    ).resolves.toEqual(
      expect.objectContaining({ recordId: 'recReadErrorRecovered123' }),
    );
    expect(gateway.readRecord).toHaveBeenCalledTimes(2);
  });

  it('preserves the last HTTP 503 when every readback attempt fails', async () => {
    const failure = new ServiceUnavailableException(
      '读取新员工入职记录暂时失败',
    );
    const gateway = gatewayMock();
    gateway.readRecord.mockRejectedValue(failure);
    const { service } = serviceWith(gateway);

    const error = await withRetryTimers(() =>
      service.create(request(), { photo: png() }),
    ).catch((reason) => reason);

    expect(error).toBe(failure);
    expect(httpStatus(error)).toBe(503);
    expect(gateway.readRecord).toHaveBeenCalledTimes(3);
  });

  it('maps continuous unknown readback failures to a redacted HTTP 503 fallback', async () => {
    const secret = 'private-read-response boxPrivateToken 19900001234';
    const gateway = gatewayMock();
    gateway.readRecord.mockRejectedValue(new Error(secret));
    const { service } = serviceWith(gateway);

    const error = await withRetryTimers(() =>
      service.create(request(), { photo: png() }),
    ).catch((reason) => reason);

    expect(httpStatus(error)).toBe(503);
    expect(String(error)).toContain('读取新员工入职记录暂时失败');
    expect(serialiseError(error)).not.toContain(secret);
    expect(serialiseError(error)).not.toContain('boxPrivateToken');
    expect(serialiseError(error)).not.toContain('19900001234');
  });

  it('returns HTTP 502 after any successful but unconfirmed readback, even if later reads fail temporarily', async () => {
    const gateway = gatewayMock();
    gateway.readRecord
      .mockResolvedValueOnce(null)
      .mockRejectedValue(
        new ServiceUnavailableException('读取新员工入职记录暂时失败'),
      );
    const { service } = serviceWith(gateway);

    const error = await withRetryTimers(() =>
      service.create(request(), { photo: png() }),
    ).catch((reason) => reason);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(httpStatus(error)).toBe(502);
    expect(String(error)).toContain('新员工入职记录读回未确认');
    expect(gateway.readRecord).toHaveBeenCalledTimes(3);
  });

  it('fails after three mismatched readbacks, then retries from the saved record ID without creating again', async () => {
    const gateway = gatewayMock();
    let createdFields: Record<string, unknown> = {};
    gateway.createRecord.mockImplementationOnce(async (fields) => {
      createdFields = fields;
      return 'recReadbackResume123';
    });
    gateway.readRecord.mockResolvedValue({ 姓名: '不一致' });
    const { service } = serviceWith(gateway);

    const mismatch = await withRetryTimers(() =>
      service.create(request(), { photo: png() }),
    ).catch((reason) => reason);
    expect(mismatch).toBeInstanceOf(BadGatewayException);
    expect(httpStatus(mismatch)).toBe(502);
    expect(String(mismatch)).toContain('新员工入职记录读回未确认');
    expect(gateway.readRecord).toHaveBeenCalledTimes(3);
    gateway.readRecord.mockResolvedValueOnce({ ...createdFields });

    await service.create(request(), { photo: png() });

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.readRecord).toHaveBeenLastCalledWith('recReadbackResume123');
  });

  it('does not confirm a new employee record when the MBTI field reads back differently', async () => {
    const gateway = gatewayMock();
    let createdFields: Record<string, unknown> = {};
    gateway.createRecord.mockImplementationOnce(async (fields) => {
      createdFields = fields;
      return 'recMbtiMismatch123';
    });
    gateway.readRecord.mockImplementation(async () => ({ ...createdFields, MBTI: 'ISTJ' }));
    const { service } = serviceWith(gateway);

    await expect(withRetryTimers(() => service.create(request(), { photo: png() }))).rejects.toBeInstanceOf(BadGatewayException);
    expect(gateway.readRecord).toHaveBeenCalledTimes(3);
    expect(gateway.invalidateTargetCache).not.toHaveBeenCalled();
  });

  it.each([
    ['token mismatch', [{ file_token: 'boxWrong' }]],
    [
      'count mismatch',
      [{ file_token: 'boxPhoto' }, { file_token: 'boxExtra' }],
    ],
  ] as const)(
    'rejects ID photo %s during strict readback',
    async (_label, actualPhoto) => {
      const gateway = gatewayMock();
      gateway.uploadAttachment.mockResolvedValueOnce('boxPhoto');
      let createdFields: Record<string, unknown> = {};
      gateway.createRecord.mockImplementationOnce(async (fields) => {
        createdFields = fields;
        return 'recAttachmentMismatch123';
      });
      gateway.readRecord.mockImplementation(async () => ({
        ...createdFields,
        照片: actualPhoto,
      }));
      const { service } = serviceWith(gateway);

      await expect(
        withRetryTimers(() =>
          service.create(request(), { photo: png() }),
        ),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(gateway.readRecord).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    [
      'a missing required business field',
      (fields: Record<string, unknown>) => {
        const changed = { ...fields };
        delete changed.岗位;
        return changed;
      },
    ],
    [
      'a date represented as text',
      (fields: Record<string, unknown>) => ({
        ...fields,
        入职日期: String(fields.入职日期),
      }),
    ],
    [
      'a changed hobby order',
      (fields: Record<string, unknown>) => ({
        ...fields,
        兴趣爱好: ['篮球', '阅读'],
      }),
    ],
  ])(
    'rejects %s during strict business-field readback',
    async (_label, change) => {
      const gateway = gatewayMock();
      let createdFields: Record<string, unknown> = {};
      gateway.createRecord.mockImplementationOnce(async (fields) => {
        createdFields = fields;
        return 'recBusinessMismatch123';
      });
      gateway.readRecord.mockImplementation(async () => change(createdFields));
      const { service } = serviceWith(gateway);

      await expect(
        withRetryTimers(() => service.create(request(), { photo: png() })),
      ).rejects.toThrow('新员工入职记录读回未确认');
      expect(gateway.readRecord).toHaveBeenCalledTimes(3);
    },
  );

  it('does not confirm an unexpected non-empty vehicle plate when none was submitted', async () => {
    const gateway = gatewayMock();
    let createdFields: Record<string, unknown> = {};
    gateway.createRecord.mockImplementationOnce(async (fields) => {
      createdFields = fields;
      return 'recUnexpectedPlate123';
    });
    gateway.readRecord.mockImplementation(async () => ({
      ...createdFields,
      车牌号: '苏F99999',
    }));
    const { service } = serviceWith(gateway);

    await expect(
      withRetryTimers(() =>
        service.create(request({ vehiclePlate: undefined }), { photo: png() }),
      ),
    ).rejects.toThrow('新员工入职记录读回未确认');
    expect(gateway.readRecord).toHaveBeenCalledTimes(3);
    expect(gateway.invalidateTargetCache).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])(
    'accepts an empty optional vehicle plate readback value: %p',
    async (vehiclePlate) => {
      const gateway = gatewayMock();
      let createdFields: Record<string, unknown> = {};
      gateway.createRecord.mockImplementationOnce(async (fields) => {
        createdFields = fields;
        return 'recEmptyPlate123';
      });
      gateway.readRecord.mockImplementation(async () => ({
        ...createdFields,
        ...(vehiclePlate !== undefined ? { 车牌号: vehiclePlate } : {}),
      }));
      const { service } = serviceWith(gateway);

      await expect(
        service.create(request({ vehiclePlate: undefined }), { photo: png() }),
      ).resolves.toEqual(
        expect.objectContaining({ recordId: 'recEmptyPlate123' }),
      );
    },
  );

  it('bounds completed and recoverable attempt maps at 256 entries and expires both after ten minutes', async () => {
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const gateway = gatewayMock();
    const { service } = serviceWith(gateway);
    const internals = service as unknown as {
      completedByMutation: Map<string, unknown>;
      attemptsByMutation: Map<string, unknown>;
      pruneState(): void;
      rememberCompletedResult(
        mutationId: string,
        fingerprint: string,
        result: EmployeeOnboardingCreateResponse,
      ): void;
      rememberAttempt(mutationId: string, fingerprint: string): unknown;
    };
    try {
      for (let index = 0; index < 257; index += 1) {
        const id = `employee-onboarding-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        internals.rememberAttempt(id, `attempt-${index}`);
        internals.rememberCompletedResult(id, `completed-${index}`, {
          success: true,
          syncStatus: 'confirmed',
          clientMutationId: id,
          recordId: `rec${index}`,
          createdAt: new Date(now).toISOString(),
        });
      }
      expect(internals.completedByMutation.size).toBe(256);
      expect(internals.attemptsByMutation.size).toBe(256);

      nowSpy.mockReturnValue(now + 10 * 60 * 1000 + 1);
      internals.pruneState();
      expect(internals.completedByMutation.size).toBe(0);
      expect(internals.attemptsByMutation.size).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('never exposes PII, file names, file tokens, file content, or remote details in service errors', async () => {
    const secrets = [
      request().identityNumber,
      request().phone,
      'private-employee.png',
      'boxPrivateToken',
      'private-file-content',
      'private-remote-detail',
    ];
    const invalidFile = {
      buffer: Buffer.from('private-file-content'),
      originalname: 'private-employee.png',
      mimetype: 'image/png',
      size: Buffer.byteLength('private-file-content'),
    };
    const validationError = await serviceWith()
      .service.create(request(), { photo: invalidFile })
      .catch((error) => error);
    const gateway = gatewayMock();
    gateway.uploadAttachment.mockRejectedValueOnce(
      new Error('private-remote-detail boxPrivateToken'),
    );
    const uploadError = await serviceWith(gateway)
      .service.create(request(), { photo: png() })
      .catch((error) => error);

    expect(validationError).toBeInstanceOf(BadRequestException);
    expect(uploadError).not.toBeInstanceOf(BadRequestException);
    for (const error of [validationError, uploadError]) {
      const serialised = serialiseError(error);
      for (const secret of secrets) expect(serialised).not.toContain(secret);
    }
  });

  it('rejects unknown file keys without echoing their names and without external work', async () => {
    const gateway = gatewayMock();
    const { service } = serviceWith(gateway);
    const maliciousKey = '身份证号-19900001234';

    const error = await service
      .create(request(), { photo: png(), [maliciousKey]: png('unknown.png') } as never)
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(serialiseError(error)).not.toContain(maliciousKey);
    expect(serialiseError(error)).not.toContain('19900001234');
    expect(gateway.fetchFieldMetas).not.toHaveBeenCalled();
  });
});
