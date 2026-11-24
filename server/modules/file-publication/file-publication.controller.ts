import {
  BadRequestException, Body, Controller, Get, Header, Param, Post, Query, Req, Res,
  StreamableFile, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { FILE_PUBLICATION_LIMITS, FilePublicationService, publicationFilename, type PublicationHistoryQuery } from './file-publication.service';

type AccessRequest = Request & { accessPrincipal?: AccessPrincipal };
const uploadPrefix = 'vnet-file-publication-';

function decodeMultipartJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new BadRequestException('发布资料参数无效');
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestException('发布资料参数无效');
  }
}

@Controller('api/file-publication')
export class FilePublicationController {
  constructor(private readonly service: FilePublicationService) {}

  @Get('options')
  @Header('Cache-Control', 'private, no-store')
  getOptions(@Req() request: AccessRequest) {
    return this.service.getOptions(request.accessPrincipal);
  }

  @Post('parse')
  @Header('Cache-Control', 'private, no-store')
  parse(@Req() request: AccessRequest, @Body() body: { link?: unknown; files?: unknown }) {
    return this.service.parse(request.accessPrincipal, body);
  }

  @Get('batches')
  @Header('Cache-Control', 'private, no-store')
  list(@Req() request: AccessRequest, @Query() query: PublicationHistoryQuery) {
    return this.service.list(request.accessPrincipal, query);
  }

  @Get('submissions/:requestId')
  @Header('Cache-Control', 'private, no-store')
  submission(@Req() request: AccessRequest, @Param('requestId') requestId: string) {
    return this.service.submission(request.accessPrincipal, requestId);
  }

  @Get('batches/:id')
  @Header('Cache-Control', 'private, no-store')
  detail(@Req() request: AccessRequest, @Param('id') batchId: string) {
    return this.service.detail(request.accessPrincipal, batchId);
  }

  @Post('batches')
  @UseInterceptors(FilesInterceptor('files', FILE_PUBLICATION_LIMITS.maxFiles, {
    storage: diskStorage({
      destination: tmpdir(),
      filename: (_request, _file, callback) => callback(null, uploadPrefix + randomUUID()),
    }),
    limits: {
      fileSize: FILE_PUBLICATION_LIMITS.maxFileBytes,
      files: FILE_PUBLICATION_LIMITS.maxFiles,
      fields: 7,
      parts: FILE_PUBLICATION_LIMITS.maxFiles + 8,
      fieldSize: 128 * 1024,
      fieldNameSize: 32,
    },
  }))
  async submit(
    @Req() request: AccessRequest,
    @Body() body: {
      requestId?: unknown; link?: unknown; groupIds?: unknown; metadata?: unknown;
      recipientInputs?: unknown; schemaVersion?: unknown; mode?: unknown;
    },
    @UploadedFiles() uploads: Express.Multer.File[] = [],
  ) {
    try {
      const files = uploads.map(file => ({
        id: randomUUID(),
        name: publicationFilename(file.originalname, true),
        path: file.path,
        size: file.size,
      }));
      return await this.service.submit(request.accessPrincipal, {
        requestId: body?.requestId,
        link: body?.link,
        groupIds: decodeMultipartJson(body?.groupIds),
        metadata: decodeMultipartJson(body?.metadata),
        recipientInputs: body?.recipientInputs === undefined ? undefined : decodeMultipartJson(body.recipientInputs),
        schemaVersion: body?.schemaVersion,
        mode: body?.mode,
      }, files);
    } finally {
      await Promise.allSettled(uploads.map(file => {
        const absolute = resolve(file.path);
        if (dirname(absolute) === resolve(tmpdir()) && basename(absolute).startsWith(uploadPrefix)) {
          return unlink(absolute);
        }
      }));
    }
  }

  @Post('batches/:id/review')
  @Header('Cache-Control', 'private, no-store')
  review(
    @Req() request: AccessRequest,
    @Param('id') batchId: string,
    @Body() body: { decision?: unknown; reason?: unknown },
  ) {
    return this.service.review(request.accessPrincipal, batchId, body);
  }

  @Post('batches/:id/deliveries/retry')
  @Header('Cache-Control', 'private, no-store')
  retryDeliveries(
    @Req() request: AccessRequest,
    @Param('id') batchId: string,
    @Body() body: { requestId?: unknown; recipientIds?: unknown },
  ) {
    return this.service.retryDeliveries(request.accessPrincipal, batchId, body);
  }

  @Get('batches/:id/files/:fileId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @Req() request: AccessRequest,
    @Param('id') batchId: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.service.download(request.accessPrincipal, batchId, fileId);
    response.attachment(file.name);
    response.setHeader('Content-Type', 'application/octet-stream');
    return new StreamableFile(file.stream, { length: file.size });
  }
}
