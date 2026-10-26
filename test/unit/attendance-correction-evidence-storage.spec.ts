import {
  AttendanceCorrectionEvidenceStorageService,
  type AttendanceCorrectionEvidenceCosClient,
} from '../../server/modules/duty-schedule/attendance-correction-evidence-storage.service';

class MemoryCos implements AttendanceCorrectionEvidenceCosClient {
  readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; acl: string }
  >();
  readonly putObject = jest.fn(async (params: Record<string, unknown>) => {
    this.objects.set(String(params.Key), {
      body: Buffer.from(params.Body as Buffer),
      contentType: String(params.ContentType),
      acl: String(params.ACL || ''),
    });
    return {};
  });
  readonly headObject = jest.fn(async (params: Record<string, unknown>) => {
    const object = this.objects.get(String(params.Key));
    if (!object) {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    }
    return {
      headers: {
        'content-length': String(object.body.length),
        'content-type': object.contentType,
      },
    };
  });
  readonly getObjectUrl = jest.fn((params: Record<string, unknown>) => {
    return `https://cos.example/${String(params.Key)}?signed=1`;
  });
}

describe('AttendanceCorrectionEvidenceStorageService', () => {
  it('archives one private COS object once and returns a short-lived signed URL', async () => {
    const cos = new MemoryCos();
    const service = new AttendanceCorrectionEvidenceStorageService({
      cos,
      env: {
        COS_ATTENDANCE_BUCKET: 'attendance-1234567890',
        COS_ATTENDANCE_REGION: 'ap-shanghai',
        COS_ATTENDANCE_PREFIX: 'attendance/evidence/v1',
      },
      now: () => new Date('2026-09-20T02:00:00.000Z'),
    });
    const load = jest.fn(async () => ({
      buffer: Buffer.from('jpeg-content'),
      contentType: 'image/jpeg',
    }));

    const [first, second] = await Promise.all([
      service.ensureStored({ processInstanceId: 'process-1', index: 0 }, load),
      service.ensureStored({ processInstanceId: 'process-1', index: 0 }, load),
    ]);

    expect(first).toEqual(second);
    expect(first.url).toContain('?signed=1');
    expect(first.expiresAt).toBe('2026-09-20T02:05:00.000Z');
    expect(load).toHaveBeenCalledTimes(1);
    expect(cos.putObject).toHaveBeenCalledTimes(1);
    expect(cos.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        CacheControl: 'private, max-age=300',
        ContentType: 'image/jpeg',
      }),
    );
    expect(cos.putObject.mock.calls[0]?.[0]).not.toHaveProperty('ACL');
    expect(cos.getObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Sign: true,
        Method: 'GET',
        Expires: 300,
      }),
    );
  });

  it('reuses an existing COS object without calling the Feishu/DingTalk loader', async () => {
    const cos = new MemoryCos();
    const service = new AttendanceCorrectionEvidenceStorageService({
      cos,
      env: {
        COS_ATTENDANCE_BUCKET: 'attendance-1234567890',
        COS_ATTENDANCE_REGION: 'ap-shanghai',
      },
    });
    const ref = { processInstanceId: 'process-existing', index: 1 };
    const firstLoad = jest.fn(async () => ({
      buffer: Buffer.from('png-content'),
      contentType: 'image/png',
    }));
    await service.ensureStored(ref, firstLoad);
    const secondLoad = jest.fn(async () => {
      throw new Error('external source must not be called');
    });

    await expect(service.ensureStored(ref, secondLoad)).resolves.toMatchObject({
      contentType: 'image/png',
    });
    expect(secondLoad).not.toHaveBeenCalled();
    expect(cos.putObject).toHaveBeenCalledTimes(1);
  });
});
