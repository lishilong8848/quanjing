import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';

import type { ChangeDrillReportCreateRequest } from '../../../shared/change-drill-report';
import {
  ChangeDrillReportService,
  type ChangeDrillReportExecutionPorts,
  type ChangeDrillReportStoredFile,
} from './change-drill-report.service';

const MUTATION_ID = 'change-drill-report-123e4567-e89b-42d3-a456-426614174000';

const request = (
  patch: Partial<ChangeDrillReportCreateRequest> = {},
): ChangeDrillReportCreateRequest => ({
  clientMutationId: MUTATION_ID,
  changeRecordId: 'recChange12345678',
  buildings: ['A楼', 'B楼'],
  reportDocuments: [
    {
      name: '演练报告.pdf',
      type: 'application/pdf',
      size: 1024,
      objectStorage: {
        id: 'storage-report-1',
        filePath: 'change-drill-reports/report.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-drill-reports/report.pdf',
      },
    },
  ],
  ...patch,
});

const storedFile = (): ChangeDrillReportStoredFile => ({
  id: 'storage-report-1',
  filePath: 'change-drill-reports/report.pdf',
  bucketId: 'default-bucket',
  url: 'https://storage.example.test/change-drill-reports/report.pdf',
  name: '演练报告.pdf',
  size: 1024,
  mimeType: 'application/pdf',
  sha256: 'a'.repeat(64),
});

describe('ChangeDrillReportService', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'vnet-change-drill-report-'));
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('creates one linked report, uploads attachments and binds staged storage', async () => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const ports = createPorts();

    const first = await service.execute(request(), ports);
    const second = await service.execute(request(), ports);

    expect(first).toEqual(
      expect.objectContaining({
        success: true,
        clientMutationId: MUTATION_ID,
        changeRecordId: 'recChange12345678',
        reportRecordId: 'recDrillReport123456',
        buildings: ['A楼', 'B楼'],
      }),
    );
    expect(second).toEqual(first);
    expect(ports.readChangeStrict).toHaveBeenCalledTimes(1);
    expect(ports.uploadToBitable).toHaveBeenCalledTimes(1);
    expect(ports.createReport).toHaveBeenCalledTimes(1);
    expect(ports.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        changeRecordId: 'recChange12345678',
        buildings: ['A楼', 'B楼'],
        reportFileTokens: ['file-token-report-1'],
        clientToken: '123e4567-e89b-42d3-a456-426614174000',
      }),
    );
    expect(ports.bindStorageToRecord).toHaveBeenCalledWith({
      id: 'storage-report-1',
      recordId: 'recDrillReport123456',
      fileToken: 'file-token-report-1',
      ownerMutationId: MUTATION_ID,
    });
  });

  it.each([
    { level: '低', lifecycleStatus: 'not-started' as const },
    { level: '高', lifecycleStatus: 'finished' as const },
  ])('rejects an ineligible authoritative target: %o', async (target) => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockResolvedValue({
      recordId: 'recChange12345678',
      buildings: ['A楼'],
      ...target,
    });

    await expect(service.execute(request(), ports)).rejects.toThrow(
      /仅支持中、高风险且未结束的变更/,
    );
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
    expect(ports.createReport).not.toHaveBeenCalled();
  });

  it('does not create a duplicate when post-create storage binding is retried', async () => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const ports = createPorts();
    ports.bindStorageToRecord
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValueOnce(undefined);

    await expect(service.execute(request(), ports)).rejects.toThrow(
      'temporary storage failure',
    );
    await expect(service.execute(request(), ports)).resolves.toEqual(
      expect.objectContaining({ reportRecordId: 'recDrillReport123456' }),
    );
    expect(ports.createReport).toHaveBeenCalledTimes(1);
    expect(ports.uploadToBitable).toHaveBeenCalledTimes(1);
    expect(ports.bindStorageToRecord).toHaveBeenCalledTimes(2);
  });

  it('reconciles a persisted report after local ledger loss without creating a duplicate', async () => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const ports = createPorts();
    ports.findReportByMutationId.mockResolvedValue({
      recordId: 'recDrillReportPersisted',
      clientMutationId: MUTATION_ID,
      fingerprint:
        'adb2b2f6793bfdde48faea3dd627f8d31092242e8e5d95fb4431369a84b412bc',
      changeRecordId: 'recChange12345678',
      buildings: ['A楼', 'B楼'],
      reportFileTokens: ['file-token-report-1'],
    });

    await expect(service.execute(request(), ports)).resolves.toMatchObject({
      reportRecordId: 'recDrillReportPersisted',
    });
    expect(ports.createReport).not.toHaveBeenCalled();
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
    expect(ports.bindStorageToRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps rejecting a persisted report with wrong attachment tokens on a safe retry', async () => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const ports = createPorts();
    let persistedAfterCreate = false;
    ports.findReportByMutationId.mockImplementation(async () =>
      persistedAfterCreate
        ? {
            recordId: 'recDrillReportWrongToken',
            clientMutationId: MUTATION_ID,
            fingerprint:
              'adb2b2f6793bfdde48faea3dd627f8d31092242e8e5d95fb4431369a84b412bc',
            changeRecordId: 'recChange12345678',
            buildings: ['A楼', 'B楼'],
            reportFileTokens: ['wrong-file-token'],
          }
        : null,
    );
    ports.createReport.mockImplementation(async () => {
      persistedAfterCreate = true;
      throw new ServiceUnavailableException('严格回读校验失败');
    });

    await expect(service.execute(request(), ports)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(service.execute(request(), ports)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(ports.createReport).toHaveBeenCalledTimes(1);
    expect(ports.bindStorageToRecord).not.toHaveBeenCalled();
  });

  it('rejects a strict readback when buildings or attachment tokens are incomplete', () => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const validPersisted = {
      recordId: 'recDrillReportPersisted',
      clientMutationId: MUTATION_ID,
      fingerprint:
        'adb2b2f6793bfdde48faea3dd627f8d31092242e8e5d95fb4431369a84b412bc',
      changeRecordId: 'recChange12345678',
      buildings: ['A楼', 'B楼'],
      reportFileTokens: ['file-token-report-1'],
    };

    expect(() =>
      service.assertPersistedReportMatches(
        { ...validPersisted, buildings: ['A楼'] },
        request(),
        validPersisted.fingerprint,
        ['file-token-report-1'],
      ),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      service.assertPersistedReportMatches(
        validPersisted,
        request(),
        validPersisted.fingerprint,
        ['different-file-token'],
      ),
    ).toThrow(/不同的演练报告记录/);
  });

  it('rejects reusing one mutation id for different buildings', async () => {
    const service = new ChangeDrillReportService({ ledgerDir });
    const ports = createPorts();
    await service.execute(request(), ports);

    await expect(
      service.execute(request({ buildings: ['C楼'] }), ports),
    ).rejects.toThrow(/相同 clientMutationId.*不同/);
    expect(ports.createReport).toHaveBeenCalledTimes(1);
  });
});

function createPorts() {
  const ports = {
    readChangeStrict: jest.fn().mockResolvedValue({
      recordId: 'recChange12345678',
      level: '高',
      lifecycleStatus: 'not-started',
      buildings: ['A楼', 'B楼'],
    }),
    findReportByMutationId: jest.fn().mockResolvedValue(null),
    resolveOwnedStorage: jest.fn().mockResolvedValue(storedFile()),
    uploadToBitable: jest.fn().mockResolvedValue('file-token-report-1'),
    createReport: jest.fn().mockResolvedValue('recDrillReport123456'),
    bindStorageToRecord: jest.fn().mockResolvedValue(undefined),
  } satisfies jest.Mocked<ChangeDrillReportExecutionPorts>;
  return ports;
}
