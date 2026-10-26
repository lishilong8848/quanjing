import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareChangeAttachmentTempDirectory,
  removeExactChangeAttachmentTempFile,
  type ChangeAttachmentTempFileOperations,
} from '../../server/modules/duty-schedule/change-attachment-temp-directory';

function createOperations(options: {
  canonicalDirectory: string;
  onRemove?: (path: string) => void;
}): ChangeAttachmentTempFileOperations {
  return {
    mkdir: jest.fn(async () => undefined),
    realpath: jest.fn(async () => options.canonicalDirectory),
    rm: jest.fn(async (path: string) => {
      options.onRemove?.(path);
    }),
  };
}

describe('change attachment temp directory', () => {
  it('returns the canonical directory after creating a short-path alias root', async () => {
    const aliasDirectory = join(tmpdir(), 'NANTO~1');
    const canonicalDirectory = join(
      tmpdir(),
      'nantong-change-attachment-staging',
    );
    const operations = createOperations({ canonicalDirectory });

    await expect(
      prepareChangeAttachmentTempDirectory(aliasDirectory, operations),
    ).resolves.toBe(canonicalDirectory);
    expect(operations.mkdir).toHaveBeenCalledWith(aliasDirectory, {
      recursive: true,
    });
    expect(operations.realpath).toHaveBeenCalledWith(aliasDirectory);
  });

  it('cleans only a direct child of the canonical temp directory', async () => {
    const aliasDirectory = join(tmpdir(), 'NANTO~1');
    const canonicalDirectory = join(
      tmpdir(),
      'nantong-change-attachment-staging',
    );
    const filePath = join(canonicalDirectory, 'upload-id');
    const removed: string[] = [];
    const operations = createOperations({
      canonicalDirectory,
      onRemove: (path) => removed.push(path),
    });

    await removeExactChangeAttachmentTempFile(
      filePath,
      aliasDirectory,
      operations,
    );

    expect(removed).toEqual([filePath]);
    await expect(
      removeExactChangeAttachmentTempFile(
        join(tmpdir(), 'outside', 'upload-id'),
        aliasDirectory,
        operations,
      ),
    ).rejects.toThrow('变更附件临时文件路径无效');
    expect(removed).toEqual([filePath]);
  });
});
