import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type {
  WeatherGuardRegistrationOptions,
  WeatherGuardRegistrationRequest,
  WeatherGuardRegistrationResponse,
  WeatherWarningFullFlowProgressSendRequest,
  WeatherWarningSnapshot,
  WeatherWarningTestPreviewResponse,
  WeatherWarningTestSendRequest,
} from '@shared/api.interface';
import {
  AdminOnly,
  GuestReadable,
  GuestSubmittable,
} from '@server/common/access/unified-access.decorators';
import {
  WeatherWarningNotificationService,
  toPublicWeatherWarningSnapshot,
} from './weather-warning-notification.service';
import { loadWeatherWarningFeatureConfig } from './weather-warning-feature.config';
import type { WeatherWarningRegistrationUploadFile } from './weather-warning-registration.gateway';
import { WeatherWarningRegistrationEnabledGuard } from './weather-warning-registration-enabled.guard';
import {
  WeatherWarningRegistrationService,
  type WeatherWarningRegistrationSubmitFiles,
} from './weather-warning-registration.service';
import { WeatherWarningSnapshotService } from './weather-warning-snapshot.service';

const REGISTRATION_PAYLOAD_MAX_BYTES = 128 * 1024;

type RegistrationUploadedFiles = {
  deviceEvidence?: WeatherWarningRegistrationUploadFile[];
  disasterEvidence?: WeatherWarningRegistrationUploadFile[];
  environmentEvidence?: WeatherWarningRegistrationUploadFile[];
};

function weatherWarningRegistrationAttachmentFileFilter(
  _request: Request,
  file: WeatherWarningRegistrationUploadFile,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  const extension =
    /\.[^.]+$/u.exec(file.originalname.toLowerCase())?.[0] || '';
  const expectedMimeByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  if (expectedMimeByExtension[extension] !== file.mimetype) {
    callback(
      new BadRequestException(
        '登记附件仅支持 PNG、JPG、JPEG、WebP 图片或 PDF 扫描件',
      ),
      false,
    );
    return;
  }
  callback(null, true);
}

@Controller('api/weather-warning')
export class WeatherWarningController {
  constructor(
    private readonly weatherWarningSnapshotService: WeatherWarningSnapshotService,
    private readonly weatherWarningNotificationService: WeatherWarningNotificationService,
    private readonly weatherWarningRegistrationService: WeatherWarningRegistrationService,
  ) {}

  @GuestReadable()
  @Get('snapshot')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getSnapshot(): Promise<WeatherWarningSnapshot> {
    return {
      ...toPublicWeatherWarningSnapshot(
        await this.weatherWarningSnapshotService.getSnapshot(),
      ),
      features: loadWeatherWarningFeatureConfig(),
    };
  }

  @AdminOnly()
  @Get('test-preview')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getTestPreview(): Promise<WeatherWarningTestPreviewResponse> {
    const preview =
      await this.weatherWarningNotificationService.getTestPreview();
    return {
      success: true,
      recipientName: preview.recipientName,
      senderName: '系统机器人',
      canSend: preview.canSend === true,
      snapshot: toPublicWeatherWarningSnapshot(preview.snapshot),
    };
  }

  @AdminOnly()
  @Post('test-send')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async sendTest(@Body() body: WeatherWarningTestSendRequest) {
    return this.weatherWarningNotificationService.sendTest(body);
  }

  @AdminOnly()
  @Post('test-full-flow-send')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async sendFullFlowTest(@Body() body: WeatherWarningTestSendRequest) {
    return this.weatherWarningNotificationService.sendFullFlowTest(body);
  }

  @AdminOnly()
  @Post('test-full-flow-progress-send')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async sendFullFlowProgress(
    @Body() body: WeatherWarningFullFlowProgressSendRequest,
  ) {
    return this.weatherWarningNotificationService.sendFullFlowProgress(body);
  }

  @GuestReadable()
  @Get('registration/options')
  @UseGuards(WeatherWarningRegistrationEnabledGuard)
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getRegistrationOptions(
    @Query('warningId') warningId: string,
    @Req() request: Request,
  ): Promise<WeatherGuardRegistrationOptions> {
    return withRequestAbortSignal(request, (signal) =>
      this.weatherWarningRegistrationService.getOptions(warningId, signal),
    );
  }

  @GuestSubmittable()
  @Post('registration')
  @UseGuards(WeatherWarningRegistrationEnabledGuard)
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'deviceEvidence', maxCount: 1 },
        { name: 'disasterEvidence', maxCount: 1 },
        { name: 'environmentEvidence', maxCount: 1 },
      ],
      {
        limits: {
          files: 3,
          fileSize: 10 * 1024 * 1024,
          fields: 1,
          parts: 5,
          fieldSize: 128 * 1024,
          fieldNameSize: 64,
        },
        fileFilter: weatherWarningRegistrationAttachmentFileFilter,
      },
    ),
  )
  async submitRegistration(
    @Body() body: unknown,
    @UploadedFiles() files: RegistrationUploadedFiles = {},
    @Req() request: Request,
  ): Promise<WeatherGuardRegistrationResponse> {
    const payload = parseRegistrationPayload(body);
    const normalizedFiles = normalizeRegistrationFiles(files);
    return withRequestAbortSignal(request, (signal) =>
      this.weatherWarningRegistrationService.submit(
        { payload, files: normalizedFiles },
        signal,
      ),
    );
  }
}

function parseRegistrationPayload(
  body: unknown,
): WeatherGuardRegistrationRequest {
  const bodyRecord = asPlainRecord(body);
  if (
    !bodyRecord ||
    Object.keys(bodyRecord).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(bodyRecord, 'payload') ||
    typeof bodyRecord.payload !== 'string' ||
    bodyRecord.payload.trim().length === 0 ||
    Buffer.byteLength(bodyRecord.payload, 'utf8') >
      REGISTRATION_PAYLOAD_MAX_BYTES
  ) {
    throw new BadRequestException('登记 payload 无效');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyRecord.payload);
  } catch {
    throw new BadRequestException('登记 payload 不是有效 JSON');
  }
  if (!asPlainRecord(payload)) {
    throw new BadRequestException('登记 payload 必须是普通对象');
  }
  return payload as WeatherGuardRegistrationRequest;
}

function normalizeRegistrationFiles(
  files: RegistrationUploadedFiles | undefined,
): WeatherWarningRegistrationSubmitFiles {
  const fileRecord = asPlainRecord(files);
  return {
    deviceEvidence: normalizeRegistrationFileField(fileRecord?.deviceEvidence),
    disasterEvidence: normalizeRegistrationFileField(
      fileRecord?.disasterEvidence,
    ),
    environmentEvidence: normalizeRegistrationFileField(
      fileRecord?.environmentEvidence,
    ),
  };
}

function normalizeRegistrationFileField(
  value: unknown,
): WeatherWarningRegistrationUploadFile[] | undefined {
  return Array.isArray(value)
    ? (value as WeatherWarningRegistrationUploadFile[])
    : undefined;
}

async function withRequestAbortSignal<T>(
  request: Pick<Request, 'aborted' | 'once' | 'removeListener'>,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  if (request.aborted) abort();
  try {
    return await operation(controller.signal);
  } finally {
    request.removeListener('aborted', abort);
  }
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (Object.prototype.toString.call(value) !== '[object Object]') return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}
