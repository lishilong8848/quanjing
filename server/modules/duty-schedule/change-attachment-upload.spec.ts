import {
  BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE,
  BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES,
  uploadStagedBitableAttachment,
  type StagedBitableAttachment,
} from './change-attachment-upload';

function createAttachment(size: number): StagedBitableAttachment {
  return {
    id: 'storage-object-1',
    name: 'change-plan.pdf',
    mimeType: 'application/pdf',
    size,
  };
}

describe('uploadStagedBitableAttachment', () => {
  it('uses upload_all at the exact 20 MiB boundary', async () => {
    const attachment = createAttachment(
      BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES,
    );
    const body = Buffer.alloc(attachment.size, 1);
    const readAll = jest.fn(async () => body);
    const uploadAll = jest.fn(async () => 'small-file-token');
    const prepare = jest.fn();

    await expect(
      uploadStagedBitableAttachment(attachment, 'app-token', {
        readAll,
        readRange: jest.fn(),
        uploadAll,
        prepare,
        uploadPart: jest.fn(),
        finish: jest.fn(),
      }),
    ).resolves.toBe('small-file-token');

    expect(readAll).toHaveBeenCalledWith(attachment.id);
    expect(uploadAll.mock.calls[0]?.[0]).toBe(attachment);
    expect(uploadAll.mock.calls[0]?.[1]).toBe(body);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('uses multipart upload at 20 MiB plus one byte and sends zero-based parts', async () => {
    const attachment = createAttachment(
      BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES + 1,
    );
    const expectedBlockCount = 6;
    const reusableBlock = Buffer.alloc(BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE, 2);
    const readRange = jest.fn(async (_id: string, start: number, end: number) =>
      reusableBlock.subarray(0, end - start + 1),
    );
    const prepare = jest.fn(async () => ({
      uploadId: 'upload-1',
      blockSize: BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE,
      blockNum: expectedBlockCount,
    }));
    const uploadPart = jest.fn(async () => undefined);
    const finish = jest.fn(async () => 'large-file-token');

    await expect(
      uploadStagedBitableAttachment(attachment, 'app-token', {
        readAll: jest.fn(),
        readRange,
        uploadAll: jest.fn(),
        prepare,
        uploadPart,
        finish,
      }),
    ).resolves.toBe('large-file-token');

    expect(prepare).toHaveBeenCalledWith({
      file_name: attachment.name,
      parent_type: 'bitable_file',
      parent_node: 'app-token',
      size: attachment.size,
      extra: JSON.stringify({ drive_route_token: 'app-token' }),
    });
    expect(readRange).toHaveBeenCalledTimes(expectedBlockCount);
    expect(
      uploadPart.mock.calls.map(([part]) => ({
        uploadId: part.uploadId,
        seq: part.seq,
      })),
    ).toEqual(
      Array.from({ length: expectedBlockCount }, (_, seq) => ({
        uploadId: 'upload-1',
        seq,
      })),
    );
    expect(uploadPart.mock.calls.at(-1)?.[0]).toMatchObject({
      seq: 5,
      size: 1,
    });
    expect(finish).toHaveBeenCalledWith({
      uploadId: 'upload-1',
      blockNum: expectedBlockCount,
    });
  });

  it('uploads a 200 MiB attachment in exactly 50 sequential 4 MiB parts', async () => {
    const attachment = createAttachment(200 * 1024 * 1024);
    const events: string[] = [];
    const reusableBlock = Buffer.alloc(BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE, 3);
    const readRange = jest.fn(async (_id: string, start: number, end: number) => {
      events.push(`read:${start}-${end}`);
      return reusableBlock.subarray(0, end - start + 1);
    });
    const uploadPart = jest.fn(async ({ seq }: { seq: number }) => {
      events.push(`upload:${seq}`);
    });

    await uploadStagedBitableAttachment(attachment, 'app-token', {
      readAll: jest.fn(),
      readRange,
      uploadAll: jest.fn(),
      prepare: jest.fn(async () => ({
        uploadId: 'upload-50',
        blockSize: BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE,
        blockNum: 50,
      })),
      uploadPart,
      finish: jest.fn(async () => 'token-50'),
    });

    expect(readRange).toHaveBeenCalledTimes(50);
    expect(uploadPart).toHaveBeenCalledTimes(50);
    expect(uploadPart.mock.calls.at(-1)?.[0]).toMatchObject({
      seq: 49,
      size: BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE,
    });
    expect(events.slice(0, 4)).toEqual([
      `read:0-${BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE - 1}`,
      'upload:0',
      `read:${BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE}-${BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE * 2 - 1}`,
      'upload:1',
    ]);
  });

  it('stops immediately after a part failure and never finishes', async () => {
    const attachment = createAttachment(
      BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES + 1,
    );
    const finish = jest.fn();
    const reusableBlock = Buffer.alloc(BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE, 4);
    const uploadPart = jest.fn(async ({ seq }: { seq: number }) => {
      if (seq === 2) throw new Error('part 2 rejected');
    });

    await expect(
      uploadStagedBitableAttachment(attachment, 'app-token', {
        readAll: jest.fn(),
        readRange: jest.fn(
          async (_id: string, start: number, end: number) =>
            reusableBlock.subarray(0, end - start + 1),
        ),
        uploadAll: jest.fn(),
        prepare: jest.fn(async () => ({
          uploadId: 'upload-fail',
          blockSize: BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE,
          blockNum: 6,
        })),
        uploadPart,
        finish,
      }),
    ).rejects.toThrow('part 2 rejected');

    expect(uploadPart).toHaveBeenCalledTimes(3);
    expect(finish).not.toHaveBeenCalled();
  });
});
