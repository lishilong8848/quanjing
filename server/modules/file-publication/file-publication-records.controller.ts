import { Body, Controller, Header, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { FilePublicationRecordsService } from './file-publication-records.service';

type AccessRequest = Request & { accessPrincipal?: AccessPrincipal };

@Controller('api/file-publication/records')
export class FilePublicationRecordsController {
  constructor(private readonly service: FilePublicationRecordsService) {}

  @Post('query')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  query(@Req() request: AccessRequest, @Body() body: Parameters<FilePublicationRecordsService['query']>[1]) {
    return this.service.query(request.accessPrincipal, body);
  }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  create(@Req() request: AccessRequest, @Body() body: Parameters<FilePublicationRecordsService['create']>[1]) {
    return this.service.create(request.accessPrincipal, body);
  }

  @Patch(':id')
  @Header('Cache-Control', 'private, no-store')
  update(@Req() request: AccessRequest, @Param('id') id: string, @Body() body: Parameters<FilePublicationRecordsService['update']>[2]) {
    return this.service.update(request.accessPrincipal, id, body);
  }

  @Post(':id/delete')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  deleteRecord(@Req() request: AccessRequest, @Param('id') id: string, @Body() body: Parameters<FilePublicationRecordsService['deleteRecord']>[2]) {
    return this.service.deleteRecord(request.accessPrincipal, id, body);
  }
}
