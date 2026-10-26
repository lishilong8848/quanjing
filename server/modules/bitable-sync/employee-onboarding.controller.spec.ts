import 'reflect-metadata';

import { HttpException, INestApplication, RequestMethod } from '@nestjs/common';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { Request } from 'express';
import ts = require('typescript');
import type {
  EmployeeOnboardingCreateRequest,
  EmployeeOnboardingCreateResponse,
} from '../../../shared/employee-onboarding';
import { ATTACHED_BANK } from '../../../shared/mbti-attached-bank-model';
import {
  AdminOnlyMetadataKey,
  GuestSubmittableMetadataKey,
  PublicAccessMetadataKey,
} from '../../common/access/unified-access.decorators';
import { UnifiedAccessGuard } from '../../common/access/unified-access.guard';
import { createApiCsrfValidationMiddleware } from '../../main';
import type { EmployeeOnboardingUploadFile } from './employee-onboarding.gateway';
import { EmployeeOnboardingService } from './employee-onboarding.service';

jest.mock('../../app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('../../runtime-env', () => ({}));

const NO_CACHE_VALUE = 'no-store, no-cache, must-revalidate, proxy-revalidate';
const CSRF_TOKEN = 'a'.repeat(43);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;

type ServiceMock = { create: jest.Mock };
type EmployeeOnboardingControllerConstructor =
  typeof import('./employee-onboarding.controller').EmployeeOnboardingController;
type EmployeeOnboardingControllerInstance =
  InstanceType<EmployeeOnboardingControllerConstructor>;
const EmployeeOnboardingController = loadLegacyEmployeeOnboardingController();

describe('EmployeeOnboardingController', () => {
  let service: ServiceMock;
  let moduleRef: TestingModule;
  let controller: EmployeeOnboardingControllerInstance;

  beforeEach(async () => {
    service = { create: jest.fn() };
    moduleRef = await Test.createTestingModule({
      controllers: [EmployeeOnboardingController],
      providers: [{ provide: EmployeeOnboardingService, useValue: service }],
    }).compile();
    controller = moduleRef.get(EmployeeOnboardingController);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('uses the exact route, handler-only guest permission, and multipart boundary', () => {
    const handler =
      EmployeeOnboardingController.prototype.createEmployeeOnboarding;
    const source = readControllerSource();
    const routeStart = source.indexOf("@Post('employee-onboarding')");
    const handlerStart = source.indexOf(
      'async createEmployeeOnboarding(',
      routeStart,
    );
    const decoratorBlock = source.slice(routeStart, handlerStart);
    const fileFields = [
      ...decoratorBlock.matchAll(
        /\{\s*name:\s*'([^']+)',\s*maxCount:\s*(\d+)\s*\}/gu,
      ),
    ].map((match) => ({ name: match[1], maxCount: Number(match[2]) }));

    expect(
      Reflect.getMetadata(PATH_METADATA, EmployeeOnboardingController),
    ).toBe('api/bitable');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'employee-onboarding',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)).toEqual([
      expect.any(Function),
    ]);
    expect(Reflect.getMetadata(GuestSubmittableMetadataKey, handler)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(PublicAccessMetadataKey, handler),
    ).toBeUndefined();
    expect(Reflect.getMetadata(AdminOnlyMetadataKey, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(
        GuestSubmittableMetadataKey,
        EmployeeOnboardingController,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        EmployeeOnboardingController,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(AdminOnlyMetadataKey, EmployeeOnboardingController),
    ).toBeUndefined();

    expect(source).toMatch(
      /@GuestSubmittable\(\)\s+@Post\('employee-onboarding'\)/u,
    );
    expect(fileFields).toEqual([
      { name: 'photo', maxCount: 1 },
    ]);
    expect(decoratorBlock).toMatch(/files:\s*1/gu);
    expect(decoratorBlock).toMatch(/fileSize:\s*10 \* 1024 \* 1024/gu);
    expect(decoratorBlock).toMatch(/fields:\s*1/gu);
    expect(decoratorBlock).toMatch(/parts:\s*10/gu);
    expect(decoratorBlock).toMatch(/fieldSize:\s*128 \* 1024/gu);
    expect(decoratorBlock).toMatch(/fieldNameSize:\s*64/gu);
    expect(decoratorBlock).toMatch(/fileFilter:\s*\w+/gu);
    expect(decoratorBlock).not.toMatch(/diskStorage|destination|dest:/u);
    expect(source).not.toContain('PublicAccess');
    expect(source).not.toMatch(/@Delete\b|cleanup|console\.|logger\./iu);
  });

  it('registers only the required controller, service, and gateway in BitableSyncModule', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.module.ts'),
      'utf8',
    );

    expect(source).toContain(
      "import { EmployeeOnboardingController } from './employee-onboarding.controller';",
    );
    expect(source).toContain(
      "import { EmployeeOnboardingGateway } from './employee-onboarding.gateway';",
    );
    expect(source).toContain(
      "import { EmployeeOnboardingService } from './employee-onboarding.service';",
    );
    expect(source).toMatch(
      /controllers:\s*\[[^\]]*EmployeeOnboardingController[^\]]*\]/su,
    );
    expect(source).toMatch(
      /providers:\s*\[[\s\S]*EmployeeOnboardingGateway[\s\S]*EmployeeOnboardingService[\s\S]*\]/u,
    );
    const exportsBlock = /exports:\s*\[([\s\S]*?)\]\s*,?\s*\}\)/u.exec(
      source,
    )?.[1];
    expect(exportsBlock).not.toContain('EmployeeOnboardingGateway');
    expect(exportsBlock).not.toContain('EmployeeOnboardingService');
  });

  it('parses a direct payload, normalizes the single ID photo, and returns the service response', async () => {
    const payload = createPayload();
    const photo = uploadFile('employee.PNG', 'image/png');
    const response = createResponse();
    service.create.mockResolvedValue(response);

    await expect(
      controller.createEmployeeOnboarding(
        { payload: JSON.stringify(payload) },
        { photo: [photo] },
      ),
    ).resolves.toEqual(response);

    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create).toHaveBeenCalledWith(payload, {
      photo,
    });
  });

  it('accepts a real multipart ID-photo buffer once and sets no-cache headers', async () => {
    const responseBody = createResponse();
    service.create.mockResolvedValue(responseBody);
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const endpoint = employeeOnboardingEndpoint(app);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: multipartForm({
          files: [
            ['photo', 'employee.PNG', 'image/png', Buffer.from('photo')],
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe(NO_CACHE_VALUE);
      expect(response.headers.get('pragma')).toBe('no-cache');
      expect(response.headers.get('expires')).toBe('0');
      await expect(response.json()).resolves.toEqual(responseBody);
      expect(service.create).toHaveBeenCalledTimes(1);
      const [payload, files] = service.create.mock.calls[0] as [
        EmployeeOnboardingCreateRequest,
        {
          photo?: EmployeeOnboardingUploadFile;
        },
      ];
      expect(payload).toEqual(createPayload());
      expect(files.photo).toEqual(
        expect.objectContaining({
          fieldname: 'photo',
          originalname: 'employee.PNG',
          mimetype: 'image/png',
          size: 5,
        }),
      );
      expect(Buffer.isBuffer(files.photo?.buffer)).toBe(true);
      expect(Object.keys(files)).toEqual(['photo']);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['missing body', undefined, '新员工入职 payload 无效'],
    ['missing payload', {}, '新员工入职 payload 无效'],
    ['empty payload', { payload: '' }, '新员工入职 payload 无效'],
    ['whitespace payload', { payload: '   ' }, '新员工入职 payload 无效'],
    ['non-string payload', { payload: {} }, '新员工入职 payload 无效'],
    [
      'duplicate payload value',
      { payload: ['{}', '{}'] },
      '新员工入职 payload 无效',
    ],
    [
      'invalid JSON',
      { payload: '{invalid' },
      '新员工入职 payload 不是有效 JSON',
    ],
    ['JSON null', { payload: 'null' }, '新员工入职 payload 必须是普通对象'],
    ['JSON array', { payload: '[]' }, '新员工入职 payload 必须是普通对象'],
    [
      'JSON string',
      { payload: '"value"' },
      '新员工入职 payload 必须是普通对象',
    ],
    [
      'extra body field',
      { payload: JSON.stringify(createPayload()), open_id: 'ou_private' },
      '新员工入职 payload 无效',
    ],
    [
      'UTF-8 oversized payload',
      { payload: JSON.stringify({ value: '汉'.repeat(MAX_PAYLOAD_BYTES) }) },
      '新员工入职 payload 无效',
    ],
  ])(
    'rejects %s with a fixed safe 400 before service work',
    async (_label, body, expectedMessage) => {
      await expect(
        controller.createEmployeeOnboarding(body, {}),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          statusCode: 400,
          message: expectedMessage,
          error: 'Bad Request',
        },
      });
      expect(service.create).not.toHaveBeenCalled();
    },
  );

  it('rejects real multipart field, count, size, and MIME-extension violations before service work', async () => {
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const endpoint = employeeOnboardingEndpoint(app);
    const cases: Array<{
      label: string;
      form: FormData;
      fixedMessage?: string;
    }> = [
      {
        label: 'extra body field',
        form: multipartForm({ textFields: [['open_id', 'ou_private']] }),
      },
      {
        label: 'duplicate payload field',
        form: multipartForm({
          textFields: [['payload', JSON.stringify(createPayload())]],
        }),
      },
      {
        label: 'unknown file field',
        form: multipartForm({
          files: [['avatar', 'employee.png', 'image/png', Buffer.from('x')]],
        }),
      },
      {
        label: 'two photos',
        form: multipartForm({
          files: [
            ['photo', 'employee-1.png', 'image/png', Buffer.from('1')],
            ['photo', 'employee-2.png', 'image/png', Buffer.from('2')],
          ],
        }),
      },
      {
        label: 'deprecated certificate field',
        form: multipartForm({
          files: [
            [
              'certificates',
              'certificate.png',
              'image/png',
              Buffer.from('x'),
            ],
          ],
        }),
      },
      {
        label: 'oversized file',
        form: multipartForm({
          files: [
            [
              'photo',
              'employee.png',
              'image/png',
              Buffer.alloc(MAX_FILE_BYTES + 1),
            ],
          ],
        }),
      },
      {
        label: 'photo extension and MIME mismatch',
        form: multipartForm({
          files: [
            ['photo', 'employee.jpg', 'image/png', Buffer.from('not-magic')],
          ],
        }),
        fixedMessage: '新员工入职证件照文件类型无效',
      },
      {
        label: 'PDF in photo field',
        form: multipartForm({
          files: [
            [
              'photo',
              'employee.pdf',
              'application/pdf',
              Buffer.from('%PDF-x', 'ascii'),
            ],
          ],
        }),
        fixedMessage: '新员工入职证件照文件类型无效',
      },
    ];

    try {
      for (const testCase of cases) {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: testCase.form,
        });
        expect([400, 413]).toContain(response.status);
        if (testCase.fixedMessage) {
          const body = (await response.json()) as { message?: string };
          expect(body.message).toBe(testCase.fixedMessage);
          expect(JSON.stringify(body)).not.toContain('employee');
        }
      }
      expect(service.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('allows a guarded guest only with matching CSRF cookie and header', async () => {
    const responseBody = createResponse();
    service.create.mockResolvedValue(responseBody);
    const guarded = await createGuardedApplication(service);

    try {
      const missing = await fetch(guarded.endpoint, {
        method: 'POST',
        body: validMultipartForm(),
      });
      expect(missing.status).toBe(403);

      const mismatch = await fetch(guarded.endpoint, {
        method: 'POST',
        headers: csrfHeaders('b'.repeat(43)),
        body: validMultipartForm(),
      });
      expect(mismatch.status).toBe(403);

      const accepted = await fetch(guarded.endpoint, {
        method: 'POST',
        headers: csrfHeaders(CSRF_TOKEN),
        body: validMultipartForm(),
      });
      expect(accepted.status).toBe(201);
      await expect(accepted.json()).resolves.toEqual(responseBody);
      expect(service.create).toHaveBeenCalledTimes(1);
    } finally {
      await guarded.app.close();
      await guarded.moduleRef.close();
    }
  });

  it('returns 429 for a second same-source guest while the first request is unfinished', async () => {
    const entered = deferred<void>();
    const pending = deferred<EmployeeOnboardingCreateResponse>();
    service.create.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const guarded = await createGuardedApplication(service);
    const firstResponsePromise = fetch(guarded.endpoint, {
      method: 'POST',
      headers: csrfHeaders(CSRF_TOKEN),
      body: validMultipartForm(),
    });

    try {
      await entered.promise;
      const secondResponse = await fetch(guarded.endpoint, {
        method: 'POST',
        headers: csrfHeaders(CSRF_TOKEN),
        body: validMultipartForm(),
      });

      expect(secondResponse.status).toBe(429);
      expect(service.create).toHaveBeenCalledTimes(1);

      pending.resolve(createResponse());
      const firstResponse = await firstResponsePromise;
      expect(firstResponse.status).toBe(201);
      await firstResponse.arrayBuffer();
    } finally {
      pending.resolve(createResponse());
      await firstResponsePromise.catch(() => undefined);
      await guarded.app.close();
      await guarded.moduleRef.close();
    }
  });

  it('passes the exact service exception through without wrapping it', async () => {
    const error = new HttpException('上游暂时不可用', 503);
    service.create.mockRejectedValue(error);

    await expect(
      controller.createEmployeeOnboarding(
        { payload: JSON.stringify(createPayload()) },
        { photo: [uploadFile('employee.png', 'image/png')] },
      ),
    ).rejects.toBe(error);
    expect(service.create).toHaveBeenCalledTimes(1);
  });
});

function readControllerSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'server/modules/bitable-sync/employee-onboarding.controller.ts',
    ),
    'utf8',
  );
}

function loadLegacyEmployeeOnboardingController(): EmployeeOnboardingControllerConstructor {
  const controllerPath = join(
    process.cwd(),
    'server/modules/bitable-sync/employee-onboarding.controller.ts',
  );
  const transpiled = ts.transpileModule(readFileSync(controllerPath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      importHelpers: false,
    },
    fileName: controllerPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        )
        .join('; '),
    );
  }

  const dependencies = new Map<string, unknown>([
    ['@nestjs/common', jest.requireActual('@nestjs/common')],
    [
      '@nestjs/platform-express',
      jest.requireActual('@nestjs/platform-express'),
    ],
    [
      '../../common/access/unified-access.decorators',
      jest.requireActual('../../common/access/unified-access.decorators'),
    ],
    ['./employee-onboarding.service', { EmployeeOnboardingService }],
  ]);
  const localRequire = (specifier: string): unknown => {
    if (!dependencies.has(specifier)) {
      throw new Error(`unexpected controller dependency: ${specifier}`);
    }
    return dependencies.get(specifier);
  };
  const moduleRecord: { exports: Record<string, unknown> } = { exports: {} };
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    transpiled.outputText,
  ) as (
    requireModule: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
    filename: string,
    directory: string,
  ) => void;
  evaluate(
    localRequire,
    moduleRecord,
    moduleRecord.exports,
    controllerPath,
    dirname(controllerPath),
  );
  return moduleRecord.exports
    .EmployeeOnboardingController as EmployeeOnboardingControllerConstructor;
}

function createPayload(): EmployeeOnboardingCreateRequest {
  return {
    clientMutationId:
      'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    name: '自动化测试员工',
    companyName: '南通承宏云计算有限公司',
    position: '运维实习生',
    identityNumber: '110101199001010015',
    phone: '13800007889',
    entryDate: '2026-08-15',
    education: '本科',
    graduateSchool: '自动化测试院校',
    major: '自动化测试专业',
    graduationDate: '2026-06-30',
    hobbies: ['阅读', '篮球'],
    vehiclePlate: '苏F12345',
    mbtiAssessment: { participantName: '自动化测试员工', version: 'full', answers: Array(93).fill('A'), sourceSha256: ATTACHED_BANK.sourceSha256 },
  };
}

function createResponse(): EmployeeOnboardingCreateResponse {
  return {
    success: true,
    syncStatus: 'confirmed',
    clientMutationId:
      'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
    recordId: 'rec-employee-onboarding-1',
    createdAt: '2026-08-15T10:00:00.000Z',
  };
}

function uploadFile(
  originalname: string,
  mimetype: string,
): EmployeeOnboardingUploadFile {
  const buffer = Buffer.from('controller-boundary');
  return { buffer, originalname, mimetype, size: buffer.length };
}

type MultipartFile = readonly [
  fieldName: string,
  fileName: string,
  mimeType: string,
  content: Buffer,
];

function multipartForm(
  options: {
    payload?: string | null;
    textFields?: ReadonlyArray<readonly [fieldName: string, value: string]>;
    files?: ReadonlyArray<MultipartFile>;
  } = {},
): FormData {
  const form = new FormData();
  const payload =
    options.payload === undefined
      ? JSON.stringify(createPayload())
      : options.payload;
  if (payload !== null) form.append('payload', payload);
  for (const [fieldName, value] of options.textFields ?? []) {
    form.append(fieldName, value);
  }
  for (const [fieldName, fileName, mimeType, content] of options.files ?? []) {
    form.append(fieldName, new Blob([content], { type: mimeType }), fileName);
  }
  return form;
}

function validMultipartForm(): FormData {
  return multipartForm({
    files: [['photo', 'employee.png', 'image/png', Buffer.from('photo')]],
  });
}

function employeeOnboardingEndpoint(app: INestApplication): string {
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/api/bitable/employee-onboarding`;
}

function csrfHeaders(headerToken: string): Record<string, string> {
  return {
    cookie: `suda-csrf-token=${CSRF_TOKEN}`,
    'x-suda-csrf-token': headerToken,
  };
}

async function createGuardedApplication(service: ServiceMock): Promise<{
  app: INestApplication;
  moduleRef: TestingModule;
  endpoint: string;
}> {
  const guardedModule = await Test.createTestingModule({
    controllers: [EmployeeOnboardingController],
    providers: [
      { provide: EmployeeOnboardingService, useValue: service },
      Reflector,
      {
        provide: UnifiedAccessGuard,
        useFactory: (reflector: Reflector) =>
          new UnifiedAccessGuard(reflector, {
            cookieName: 'vnet_access_session',
            isAccessControlEnabled: () => true,
            renew: () => null,
          } as never),
        inject: [Reflector],
      },
      { provide: APP_GUARD, useExisting: UnifiedAccessGuard },
    ],
  }).compile();
  const app = guardedModule.createNestApplication();
  app.use(testCookieParser);
  app.use('/api', createApiCsrfValidationMiddleware());
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  return {
    app,
    moduleRef: guardedModule,
    endpoint: employeeOnboardingEndpoint(app),
  };
}

function testCookieParser(
  request: Request & { cookies?: Record<string, string> },
  _response: unknown,
  next: () => void,
): void {
  const cookies: Record<string, string> = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(
      part.slice(separator + 1).trim(),
    );
  }
  request.cookies = cookies;
  next();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T extends void ? void | undefined : T) => void;
} {
  let resolve!: (value: T extends void ? void | undefined : T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as typeof resolve;
  });
  return { promise, resolve };
}
