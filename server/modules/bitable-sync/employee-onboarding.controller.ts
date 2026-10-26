import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { EmployeeOnboardingCreateResponse } from '../../../shared/employee-onboarding';
import { GuestSubmittable } from '../../common/access/unified-access.decorators';
import type { EmployeeOnboardingUploadFile } from './employee-onboarding.gateway';
import {
  EmployeeOnboardingService,
  type EmployeeOnboardingSubmitFiles,
} from './employee-onboarding.service';

const EMPLOYEE_ONBOARDING_PAYLOAD_MAX_BYTES = 128 * 1024;

type EmployeeOnboardingUploadedFiles = {
  photo?: EmployeeOnboardingUploadFile[];
};

type FilterableUploadFile = {
  fieldname: string;
  originalname: string;
  mimetype: string;
};

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function employeeOnboardingFileFilter(
  _request: Request,
  file: FilterableUploadFile,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  const extension =
    /\.[^.]+$/u.exec(file.originalname.toLowerCase())?.[0] ?? '';
  const expectedMime = IMAGE_MIME_BY_EXTENSION[extension];
  if (expectedMime !== file.mimetype) {
    callback(
      new BadRequestException('新员工入职证件照文件类型无效'),
      false,
    );
    return;
  }
  callback(null, true);
}

@Controller('api/bitable')
export class EmployeeOnboardingController {
  constructor(
    private readonly employeeOnboardingService: EmployeeOnboardingService,
  ) {}

  @GuestSubmittable()
  @Post('employee-onboarding')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'photo', maxCount: 1 },
      ],
      {
        limits: {
          files: 1,
          fileSize: 10 * 1024 * 1024,
          fields: 1,
          parts: 10,
          fieldSize: 128 * 1024,
          fieldNameSize: 64,
        },
        fileFilter: employeeOnboardingFileFilter,
      },
    ),
  )
  async createEmployeeOnboarding(
    @Body() body: unknown,
    @UploadedFiles() files: EmployeeOnboardingUploadedFiles = {},
  ): Promise<EmployeeOnboardingCreateResponse> {
    const payload = parseEmployeeOnboardingPayload(body);
    const normalizedFiles = normalizeEmployeeOnboardingFiles(files);
    return this.employeeOnboardingService.create(payload, normalizedFiles);
  }
}

function parseEmployeeOnboardingPayload(
  body: unknown,
): Record<string, unknown> {
  const bodyRecord = asPlainRecord(body);
  if (
    !bodyRecord ||
    Object.keys(bodyRecord).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(bodyRecord, 'payload') ||
    typeof bodyRecord.payload !== 'string' ||
    bodyRecord.payload.trim().length === 0 ||
    Buffer.byteLength(bodyRecord.payload, 'utf8') >
      EMPLOYEE_ONBOARDING_PAYLOAD_MAX_BYTES
  ) {
    throw new BadRequestException('新员工入职 payload 无效');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyRecord.payload);
  } catch {
    throw new BadRequestException('新员工入职 payload 不是有效 JSON');
  }
  const payloadRecord = asPlainRecord(payload);
  if (!payloadRecord) {
    throw new BadRequestException('新员工入职 payload 必须是普通对象');
  }
  return payloadRecord;
}

function normalizeEmployeeOnboardingFiles(
  files: EmployeeOnboardingUploadedFiles | undefined,
): EmployeeOnboardingSubmitFiles {
  const fileRecord = asPlainRecord(files);
  return {
    photo: normalizeFileField(fileRecord?.photo)?.[0],
  };
}

function normalizeFileField(
  value: unknown,
): EmployeeOnboardingUploadFile[] | undefined {
  return Array.isArray(value)
    ? (value as EmployeeOnboardingUploadFile[])
    : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (Object.prototype.toString.call(value) !== '[object Object]') return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}
