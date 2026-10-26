import 'reflect-metadata';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const noOpDecorator = () => () => undefined;
  const methodMetadataDecorator =
    (path: string, method: number) => (value: object) => {
      Reflect.defineMetadata('path', path, value);
      Reflect.defineMetadata('method', method, value);
      return value;
    };
  const setMetadata =
    (key: string, metadataValue: unknown) => (value: object) => {
      Reflect.defineMetadata(key, metadataValue, value);
      return value;
    };

  return {
    ...actual,
    Body: noOpDecorator,
    Controller: noOpDecorator,
    Get: (path: string) =>
      methodMetadataDecorator(path, actual.RequestMethod.GET),
    Injectable: noOpDecorator,
    Param: noOpDecorator,
    Post: (path: string) =>
      methodMetadataDecorator(path, actual.RequestMethod.POST),
    Query: noOpDecorator,
    Res: noOpDecorator,
    SetMetadata: setMetadata,
  };
});

import { BadRequestException, RequestMethod } from '@nestjs/common';
import { PublicAccessMetadataKey } from '../../server/common/access/unified-access.decorators';
import { AliMonthlyReportController } from '../../server/modules/ali-monthly-report/ali-monthly-report.controller';

type DownloadResponse = {
  setHeader: jest.Mock;
  send: jest.Mock;
};

type PublicDownloadController = {
  downloadPublicFile: (
    fileId: string,
    expires: string,
    signature: string,
    response: DownloadResponse,
  ) => Promise<void>;
};

describe('阿里月报公开签名下载控制器', () => {
  it('只把签名下载路由声明为公开 GET', () => {
    const prototype = AliMonthlyReportController.prototype as unknown as {
      downloadPublicFile?: (...args: unknown[]) => Promise<void>;
      downloadFile: (...args: unknown[]) => Promise<void>;
    };

    expect(typeof prototype.downloadPublicFile).toBe('function');
    if (!prototype.downloadPublicFile) return;

    expect(Reflect.getMetadata('path', prototype.downloadPublicFile)).toBe(
      'public-files/:fileId',
    );
    expect(Reflect.getMetadata('method', prototype.downloadPublicFile)).toBe(
      RequestMethod.GET,
    );
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        prototype.downloadPublicFile,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(PublicAccessMetadataKey, prototype.downloadFile),
    ).toBeUndefined();
  });

  it('透传签名参数并分别保持公开与认证下载缓存策略', async () => {
    const file = {
      buffer: Buffer.from('xlsx'),
      fileName: '在职人员.xlsx',
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const readPublicGeneratedFile = jest.fn().mockResolvedValue(file);
    const readGeneratedFile = jest.fn().mockResolvedValue(file);
    const controller = new AliMonthlyReportController({
      readPublicGeneratedFile,
      readGeneratedFile,
    } as never);
    const methods = controller as unknown as PublicDownloadController;
    const publicResponse: DownloadResponse = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };
    const authenticatedResponse: DownloadResponse = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    expect(typeof methods.downloadPublicFile).toBe('function');
    if (typeof methods.downloadPublicFile !== 'function') return;

    await methods.downloadPublicFile.call(
      controller,
      'staff-file',
      '1800000000',
      'signed-value',
      publicResponse,
    );
    await controller.downloadFile('staff-file', authenticatedResponse as never);

    expect(readPublicGeneratedFile).toHaveBeenCalledWith(
      'staff-file',
      '1800000000',
      'signed-value',
    );
    expect(publicResponse.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      file.contentType,
    );
    expect(publicResponse.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    expect(publicResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(publicResponse.send).toHaveBeenCalledWith(file.buffer);
    expect(authenticatedResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=300',
    );
  });

  it('把无效或过期签名转换为 400 且不发送响应体', async () => {
    const controller = new AliMonthlyReportController({
      readPublicGeneratedFile: jest
        .fn()
        .mockRejectedValue(new Error('下载链接无效或已过期')),
    } as never);
    const methods = controller as unknown as PublicDownloadController;
    const response: DownloadResponse = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    expect(typeof methods.downloadPublicFile).toBe('function');
    if (typeof methods.downloadPublicFile !== 'function') return;

    await expect(
      methods.downloadPublicFile.call(
        controller,
        'staff-file',
        '1',
        'invalid',
        response,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });
});
