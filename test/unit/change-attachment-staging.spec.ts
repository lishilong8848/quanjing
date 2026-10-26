import {
  beginChangeAttachmentUpload,
  completeChangeAttachmentUpload,
  createChangeAttachmentUploadItems,
  failChangeAttachmentUpload,
  getReadyChangeAttachmentDocuments,
  isChangeAttachmentFileAllowedByExtension,
  isChangeAttachmentCollectionReady,
  type ChangeAttachmentFile,
} from '../../client/src/pages/MonthlySchedule/change-attachment-staging';

const MiB = 1024 * 1024;

function file(
  name: string,
  size: number,
  lastModified = 1,
): ChangeAttachmentFile {
  return {
    name,
    size,
    type: 'application/pdf',
    lastModified,
  };
}

describe('change attachment staging lifecycle', () => {
  it('accepts a 200 MiB scheme without reading or copying its payload', () => {
    const source = file('方案.pdf', 200 * MiB);

    const result = createChangeAttachmentUploadItems([], [source], {
      maxCount: 5,
      maxSize: 200 * MiB,
    });

    expect(result.error).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      file: source,
      status: 'queued',
      progress: 0,
    });
    expect(result.items[0].file).toBe(source);
  });

  it('rejects a scheme over 200 MiB and deduplicates the same selection', () => {
    const existing = createChangeAttachmentUploadItems(
      [],
      [file('旧方案.pdf', 10)],
      { maxCount: 5, maxSize: 200 * MiB },
    ).items;

    expect(
      createChangeAttachmentUploadItems(
        existing,
        [file('超限.pdf', 200 * MiB + 1)],
        { maxCount: 5, maxSize: 200 * MiB },
      ),
    ).toMatchObject({ error: '单个附件不能超过 200 MiB', items: existing });

    expect(
      createChangeAttachmentUploadItems(existing, [file('旧方案.pdf', 10)], {
        maxCount: 5,
        maxSize: 200 * MiB,
      }).items,
    ).toHaveLength(1);
  });

  it('accepts an allowed extension when the browser omits MIME type', () => {
    const allowed = {
      '.pdf': ['application/pdf'],
      '.png': ['image/png'],
    } as const;

    expect(
      isChangeAttachmentFileAllowedByExtension(
        { ...file('举证.pdf', 10), type: '' },
        allowed,
      ),
    ).toBe(true);
    expect(
      isChangeAttachmentFileAllowedByExtension(
        { ...file('脚本.exe', 10), type: '' },
        allowed,
      ),
    ).toBe(false);
  });

  it('accepts five schemes and rejects a sixth', () => {
    const firstFive = createChangeAttachmentUploadItems(
      [],
      Array.from({ length: 5 }, (_, index) =>
        file(`方案-${index + 1}.pdf`, 10),
      ),
      { maxCount: 5, maxSize: 200 * MiB },
    );

    expect(firstFive.error).toBeNull();
    expect(firstFive.items).toHaveLength(5);
    expect(
      createChangeAttachmentUploadItems(
        firstFive.items,
        [file('方案-6.pdf', 10)],
        { maxCount: 5, maxSize: 200 * MiB },
      ),
    ).toMatchObject({ error: '最多上传 5 个附件', items: firstFive.items });
  });

  it('ignores stale upload completions and keeps a retryable failure', () => {
    const [queued] = createChangeAttachmentUploadItems(
      [],
      [file('方案.pdf', 10)],
      { maxCount: 5, maxSize: 200 * MiB },
    ).items;
    const first = beginChangeAttachmentUpload([queued], queued.localId);
    const retry = beginChangeAttachmentUpload(
      failChangeAttachmentUpload(
        first.items,
        queued.localId,
        first.attempt,
        '网络中断',
      ),
      queued.localId,
    );

    const stale = completeChangeAttachmentUpload(
      retry.items,
      queued.localId,
      first.attempt,
      {
        name: '方案.pdf',
        size: 10,
        type: 'application/pdf',
        objectStorage: {
          id: 'stale',
          filePath: 'stale.pdf',
          bucketId: 'bucket',
          url: '/api/duty-schedules/change-attachments/stale/download',
        },
      },
    );

    expect(stale).toBe(retry.items);
    expect(stale[0]).toMatchObject({ status: 'uploading', attempt: 2 });
  });

  it('allows submission only after every required attachment is staged', () => {
    const [queued] = createChangeAttachmentUploadItems(
      [],
      [file('方案.pdf', 10)],
      { maxCount: 5, maxSize: 200 * MiB },
    ).items;
    const uploading = beginChangeAttachmentUpload([queued], queued.localId);

    expect(isChangeAttachmentCollectionReady(uploading.items, 1, 5)).toBe(
      false,
    );

    const staged = completeChangeAttachmentUpload(
      uploading.items,
      queued.localId,
      uploading.attempt,
      {
        name: '方案.pdf',
        size: 10,
        type: 'application/pdf',
        objectStorage: {
          id: 'stored-1',
          filePath: '方案.pdf',
          bucketId: 'bucket',
          url: '/api/duty-schedules/change-attachments/stored-1/download',
        },
      },
    );

    expect(isChangeAttachmentCollectionReady(staged, 1, 5)).toBe(true);
    expect(getReadyChangeAttachmentDocuments(staged)).toEqual([
      staged[0].stagedDocument,
    ]);
  });
});
