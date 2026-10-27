import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeInfo } from '../../shared/api.interface';
import { extendChangeInfoWithAdjustmentRecord } from '../../server/modules/duty-schedule/change-adjustment-record';

const readProjectFile = (path: string): string =>
  readFileSync(join(process.cwd(), path), 'utf8');

const controllerSource = readProjectFile(
  'server/modules/duty-schedule/duty-schedule.controller.ts',
);
const serviceSource = readProjectFile(
  'server/modules/duty-schedule/duty-schedule.service.ts',
);
const moduleSource = readProjectFile(
  'server/modules/duty-schedule/duty-schedule.module.ts',
);

function sourceBetween(
  source: string,
  startMarker: string,
  endMarkers: readonly string[],
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const ends = endMarkers
    .map((marker) => source.indexOf(marker, start + startMarker.length))
    .filter((index) => index >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : source.length;
  return source.slice(start, end);
}

describe('change adjustment service and route wiring contract', () => {
  it('enriches every yearly change through the adjustment mapper', async () => {
    const yearlyMethod = sourceBetween(
      serviceSource,
      'private async getYearlyChangeInfoFromFeishu(',
      ['\n  private mapFeishuCalendarChangeRecord('],
    );
    const baseMapIndex = yearlyMethod.indexOf(
      'this.mapFeishuCalendarChangeRecord(record)',
    );
    const adjustmentMapIndex = yearlyMethod.indexOf(
      'extendChangeInfoWithAdjustmentRecord(',
    );

    expect(yearlyMethod).not.toBe('');
    expect(baseMapIndex).toBeGreaterThanOrEqual(0);
    expect(adjustmentMapIndex).toBeGreaterThan(baseMapIndex);
    expect(yearlyMethod).toContain(
      'findByFileTokenForTrustedServer(fileToken)',
    );
    expect(yearlyMethod).toContain('metadata.boundRecordId !== recordId');

    const publicRecord: ChangeInfo = {
      id: 'rec_change_contract',
      bitableRecordId: 'rec_change_contract',
      title: '变更接线契约',
      startDate: '2026-08-10T01:00:00.000Z',
      endDate: '2026-08-10T10:00:00.000Z',
      actualStartDate: null,
      actualEndDate: null,
      plannedDelayStartDate: null,
      plannedDelayEndDate: null,
      level: '二级',
      type: '计划变更',
      progress: '未开始',
      executor: '执行人',
      scheduleStatus: null,
      buildings: ['H楼'],
      riskSummary: null,
      isKey: false,
      recordUrl: null,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    };
    const record = {
      record_id: 'rec_change_contract',
      created_time: Date.parse('2026-08-09T00:00:00.000Z'),
      last_modified_time: Date.parse('2026-08-09T01:00:00.000Z'),
      fields: {
        fld0qzcXDh: [
          {
            file_token: 'boxcn_scheme_contract',
            name: '变更方案.pdf',
            size: 4096,
            type: 'application/pdf',
          },
        ],
        fldQqzl4HN: [
          {
            file_token: 'boxcn_evidence_contract',
            name: '延期举证.png',
            size: 1024,
            type: 'image/png',
          },
        ],
        申请提交人: [{ name: '马进宇', mobile: '13800000000' }],
      },
    };

    const enriched = await extendChangeInfoWithAdjustmentRecord(
      publicRecord,
      record,
    );

    expect(enriched).toMatchObject({
      submitterName: '马进宇',
      planDocuments: [
        {
          fileToken: 'boxcn_scheme_contract',
          url: '/api/duty-schedules/change-records/rec_change_contract/attachments/boxcn_scheme_contract',
        },
      ],
      delayEvidence: [
        {
          fileToken: 'boxcn_evidence_contract',
          url: '/api/duty-schedules/change-records/rec_change_contract/attachments/boxcn_evidence_contract',
        },
      ],
    });
    expect(JSON.stringify(enriched)).not.toContain('13800000000');
  });

  it('routes POST change-adjustment through DutyScheduleService only', () => {
    const route = sourceBetween(
      controllerSource,
      "@Post('duty-schedules/change-adjustment')",
      [
        '\n  @GuestReadable()',
        '\n  @GuestSubmittable()',
        '\n  @Post(',
        '\n  @Get(',
      ],
    );

    expect(route).not.toBe('');
    expect(route).toContain('async createChangeAdjustment(');
    expect(route).toMatch(
      /this\.dutyScheduleService\.createChangeAdjustment\(\s*(?:request|body)\s*\)/,
    );
    expect(route).not.toContain('changeAdjustmentService.execute(');
  });

  it('delegates createChangeAdjustment to the adjustment core with execution ports', () => {
    const method = sourceBetween(
      serviceSource,
      'async createChangeAdjustment(',
      ['\n  async ', '\n  private ', '\n  public '],
    );

    expect(serviceSource.includes("from './change-adjustment.service'")).toBe(
      true,
    );
    expect(method).not.toBe('');
    expect(method).toContain('this.changeAdjustmentService.execute(');
    expect(method).toMatch(/\.execute\(\s*request\s*,/);
  });

  it('requests stable Feishu automatic timestamps for list and strict record reads', () => {
    const listMethod = sourceBetween(
      serviceSource,
      'private async fetchFeishuCalendarChangeRecords(',
      ['\n  private async ', '\n  private '],
    );
    const strictReadMethod = sourceBetween(
      serviceSource,
      'private async fetchBitableRecordById(',
      ['\n  private async ', '\n  private '],
    );

    expect(listMethod).toContain('automaticFields: true');
    expect(strictReadMethod).toContain('automatic_fields: true');
  });

  it('registers ChangeAdjustmentService in DutyScheduleModule', () => {
    expect(
      moduleSource.includes(
        "import { ChangeAdjustmentService } from '@server/modules/duty-schedule/change-adjustment.service';",
      ),
    ).toBe(true);
    expect(moduleSource).toMatch(
      /providers:\s*\[[\s\S]*ChangeAdjustmentService[\s\S]*\]/,
    );
  });

  it('exposes the recordId and fileToken attachment proxy route', () => {
    const route = sourceBetween(
      controllerSource,
      "@Get('duty-schedules/change-records/:recordId/attachments/:fileToken')",
      [
        '\n  @GuestReadable()',
        '\n  @GuestSubmittable()',
        '\n  @Post(',
        '\n  @Get(',
      ],
    );

    expect(route).not.toBe('');
    expect(route).toContain("@Param('recordId') recordId");
    expect(route).toContain("@Param('fileToken') fileToken");
    expect(route).toMatch(
      /this\.dutyScheduleService\.resolveChangeRecordAttachment\(\s*recordId\s*,\s*fileToken\s*,?\s*\)/,
    );
    expect(route).toMatch(/kind\s*===\s*['"]redirect['"]/);
    expect(route).toMatch(/\.redirect\(\s*302\s*,\s*\w+\.url\s*\)/);
    expect(route).toContain("setHeader('Content-Type'");
    expect(route).toMatch(/setHeader\(\s*['"]Content-Disposition['"]/);
    expect(route).toContain(
      "setHeader('Cache-Control', 'private, max-age=300')",
    );
    expect(route).toMatch(/\.send\(\s*\w+\.buffer\s*\)/);
  });

  it('validates Base token ownership before either COS or legacy Feishu access', () => {
    const method = sourceBetween(
      serviceSource,
      'async resolveChangeRecordAttachment(',
      ['\n  async ', '\n  private ', '\n  public '],
    );

    expect(method).not.toBe('');
    const storageLookupIndex = method.indexOf(
      'findByFileTokenForTrustedServer(',
    );
    const legacyDownloadIndex = method.indexOf(
      'downloadConstructionAttachment(',
    );
    const firstAttachmentAccessIndex = Math.min(
      ...[storageLookupIndex, legacyDownloadIndex].filter(
        (index) => index >= 0,
      ),
    );
    const ownershipPhase = method.slice(0, firstAttachmentAccessIndex);

    expect(storageLookupIndex).toBeGreaterThanOrEqual(0);
    expect(legacyDownloadIndex).toBeGreaterThanOrEqual(0);
    expect(ownershipPhase).toMatch(
      /(?:fetchBitableRecordById|read\w*Record\w*Strict|assert\w*Attachment\w*Ownership)/,
    );
    expect(ownershipPhase).toContain('recordId');
    expect(ownershipPhase).toContain('fileToken');
    expect(method).toContain('boundRecordId');
    expect(method).toContain('getSignedDownloadUrlForTrustedServer(');
    expect(method).toMatch(/kind:\s*['"]redirect['"]/);
    expect(method).toMatch(/kind:\s*['"]buffer['"]/);
    expect(storageLookupIndex).toBeGreaterThan(0);
    expect(legacyDownloadIndex).toBeGreaterThan(0);
  });
});
