export const BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE = 4 * 1024 * 1024;

export interface StagedBitableAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface BitableMultipartPreparePayload {
  file_name: string;
  parent_type: 'bitable_file';
  parent_node: string;
  size: number;
  extra: string;
}

export interface BitableMultipartPrepareResult {
  uploadId: string;
  blockSize: number;
  blockNum: number;
}

export interface BitableMultipartPart {
  uploadId: string;
  seq: number;
  size: number;
  file: Buffer;
}

export interface BitableMultipartFinishPayload {
  uploadId: string;
  blockNum: number;
}

export interface StagedBitableAttachmentUploadDependencies {
  readAll(id: string): Promise<Buffer>;
  readRange(id: string, start: number, end: number): Promise<Buffer>;
  uploadAll(
    attachment: StagedBitableAttachment,
    contents: Buffer,
  ): Promise<string>;
  prepare(
    payload: BitableMultipartPreparePayload,
  ): Promise<BitableMultipartPrepareResult>;
  uploadPart(part: BitableMultipartPart): Promise<void>;
  finish(payload: BitableMultipartFinishPayload): Promise<string>;
}

export async function uploadStagedBitableAttachment(
  attachment: StagedBitableAttachment,
  appToken: string,
  dependencies: StagedBitableAttachmentUploadDependencies,
): Promise<string> {
  if (
    !attachment.id ||
    !attachment.name ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size <= 0
  ) {
    throw new Error('变更附件元数据无效');
  }

  if (attachment.size <= BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES) {
    const contents = await dependencies.readAll(attachment.id);
    if (contents.length !== attachment.size) {
      throw new Error('变更附件整体读取结果不完整');
    }
    return dependencies.uploadAll(attachment, contents);
  }

  const expectedBlockNum = Math.ceil(
    attachment.size / BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE,
  );
  const prepared = await dependencies.prepare({
    file_name: attachment.name,
    parent_type: 'bitable_file',
    parent_node: appToken,
    size: attachment.size,
    extra: JSON.stringify({ drive_route_token: appToken }),
  });
  if (
    !prepared.uploadId ||
    prepared.blockSize !== BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE ||
    prepared.blockNum !== expectedBlockNum
  ) {
    throw new Error('飞书附件分片准备结果无效');
  }

  for (let seq = 0; seq < expectedBlockNum; seq += 1) {
    const start = seq * BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE;
    const end = Math.min(
      attachment.size - 1,
      start + BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE - 1,
    );
    const file = await dependencies.readRange(attachment.id, start, end);
    const expectedSize = end - start + 1;
    if (file.length !== expectedSize) {
      throw new Error(`变更附件第 ${seq + 1} 片读取结果不完整`);
    }
    await dependencies.uploadPart({
      uploadId: prepared.uploadId,
      seq,
      size: expectedSize,
      file,
    });
  }

  return dependencies.finish({
    uploadId: prepared.uploadId,
    blockNum: expectedBlockNum,
  });
}
