import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  AliMonthlyReportBundleRequest,
  AliMonthlyReportConfigResponse,
  AliMonthlyReportEmailRequest,
  AliMonthlyReportEmailResponse,
  AliMonthlyReportFileActionResponse,
  AliMonthlyReportGenerateRequest,
  AliMonthlyReportGenerateResponse,
} from '@shared/api.interface';
import {
  AdminOnly,
  PublicAccess,
} from '../../common/access/unified-access.decorators';
import { AliMonthlyReportService } from './ali-monthly-report.service';

type GeneratedFileDownload = {
  buffer: Buffer;
  fileName: string;
  contentType: string;
};

@Controller('api/ali-monthly-report')
export class AliMonthlyReportController {
  constructor(private readonly service: AliMonthlyReportService) {}

  @Get('config')
  async getConfig(): Promise<AliMonthlyReportConfigResponse> {
    return this.service.getConfig();
  }

  @Post('generate')
  async generate(
    @Body() body: AliMonthlyReportGenerateRequest,
  ): Promise<AliMonthlyReportGenerateResponse> {
    try {
      return await this.service.generate(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Post('bundle-four-items')
  async bundleFourItems(
    @Body() body: AliMonthlyReportBundleRequest,
  ): Promise<AliMonthlyReportGenerateResponse> {
    try {
      return await this.service.bundleFourItems(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Post('send-email')
  async sendEmail(
    @Body() body: AliMonthlyReportEmailRequest,
  ): Promise<AliMonthlyReportEmailResponse> {
    try {
      return await this.service.sendEmail(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @AdminOnly()
  @Post('files/:fileId/open')
  async openGeneratedFile(
    @Param('fileId') fileId: string,
  ): Promise<AliMonthlyReportFileActionResponse> {
    try {
      return await this.service.performGeneratedFileAction(fileId, 'open');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @AdminOnly()
  @Post('files/:fileId/reveal')
  async revealGeneratedFile(
    @Param('fileId') fileId: string,
  ): Promise<AliMonthlyReportFileActionResponse> {
    try {
      return await this.service.performGeneratedFileAction(fileId, 'reveal');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Get('files/:fileId')
  async downloadFile(
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const file = await this.service.readGeneratedFile(fileId);
      this.sendDownload(res, file, 'private, max-age=300');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @PublicAccess()
  @Get('public-files/:fileId')
  async downloadPublicFile(
    @Param('fileId') fileId: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const file = await this.service.readPublicGeneratedFile(
        fileId,
        expires,
        signature,
      );
      this.sendDownload(res, file, 'private, no-store');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private sendDownload(
    res: Response,
    file: GeneratedFileDownload,
    cacheControl: string,
  ): void {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Cache-Control', cacheControl);
    res.send(file.buffer);
  }
}
