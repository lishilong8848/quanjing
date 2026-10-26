import { ServiceUnavailableException } from '@nestjs/common';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CHANGE_ATTACHMENT_TEMP_DIR = join(
  tmpdir(),
  'nantong-change-attachment-staging',
);

export interface ChangeAttachmentTempFileOperations {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  realpath(path: string): Promise<string>;
  rm(path: string, options: { force: true }): Promise<void>;
}

const defaultOperations: ChangeAttachmentTempFileOperations = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  realpath: async (path) => realpath(path),
  rm: async (path, options) => rm(path, options),
};

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function prepareChangeAttachmentTempDirectory(
  tempDirectory = CHANGE_ATTACHMENT_TEMP_DIR,
  operations: ChangeAttachmentTempFileOperations = defaultOperations,
): Promise<string> {
  await operations.mkdir(tempDirectory, { recursive: true });
  return resolve(await operations.realpath(tempDirectory));
}

export async function removeExactChangeAttachmentTempFile(
  filePath: string,
  tempDirectory = CHANGE_ATTACHMENT_TEMP_DIR,
  operations: ChangeAttachmentTempFileOperations = defaultOperations,
): Promise<void> {
  const exactPath = resolve(filePath);
  const canonicalTempDirectory = await prepareChangeAttachmentTempDirectory(
    tempDirectory,
    operations,
  );
  if (
    comparablePath(dirname(exactPath)) !== comparablePath(canonicalTempDirectory)
  ) {
    throw new ServiceUnavailableException('变更附件临时文件路径无效');
  }
  await operations.rm(exactPath, { force: true });
}
