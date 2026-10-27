import type { HttpService } from '@nestjs/axios';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  buildOvertimeConfirmationUrl,
  issueOvertimeConfirmationTicket,
  OvertimeWorkflowGateway,
  stableOvertimeMessageUuid,
  verifyOvertimeConfirmationTicket,
} from './overtime-workflow.gateway';

describe('OvertimeWorkflowGateway', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_app';
    process.env.FEISHU_APP_SECRET = 'app-secret';
    process.env.FEISHU_MAIN_APP_TOKEN = 'main_app_token';
    process.env.FEISHU_OVERTIME_TABLE_ID = 'tblpCzmTT3EapaUY';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses a stable valid Feishu UUID for each business key', () => {
    const first = stableOvertimeMessageUuid('approval:rec_1:ou_1');
    expect(first).toBe(stableOvertimeMessageUuid('approval:rec_1:ou_1'));
    expect(first).not.toBe(stableOvertimeMessageUuid('approval:rec_1:ou_2'));
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,50}$/);
  });

  it('sends and patches cards and reads/updates overtime Base records', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_card_1' } },
      });
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: { record_id: 'rec_1', fields: { 加班人员姓名: '张三' } },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const gateway = new OvertimeWorkflowGateway(
      { axiosRef: { post, patch, get, put } } as unknown as HttpService,
      jest.fn(),
    );

    await expect(
      gateway.sendInteractiveCard(
        'ou_user_1',
        { schema: '2.0' },
        'approval:rec_1:ou_user_1',
      ),
    ).resolves.toBe('om_card_1');
    expect(post.mock.calls[1][1].uuid).toBe(
      stableOvertimeMessageUuid('approval:rec_1:ou_user_1'),
    );
    await gateway.patchInteractiveCard('om_card_1', { schema: '2.0' });
    await expect(gateway.readOvertimeRecord('rec_1')).resolves.toEqual({
      recordId: 'rec_1',
      fields: { 加班人员姓名: '张三' },
    });
    await gateway.updateOvertimeRecord('rec_1', { 加班流程进展: '已审批' });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/rec_1'),
      { fields: { 加班流程进展: '已审批' } },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('treats only an explicitly missing Base record as absent', async () => {
    const post = jest.fn().mockResolvedValue({
      data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
    });
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 1254043, msg: 'RecordIdNotFound' },
      })
      .mockRejectedValueOnce({
        response: { status: 404, data: { code: 1254043 } },
      })
      .mockResolvedValueOnce({
        data: { code: 1254302, msg: 'Permission denied' },
      });
    const gateway = new OvertimeWorkflowGateway(
      { axiosRef: { post, get } } as unknown as HttpService,
      jest.fn(),
    );

    await expect(
      gateway.readOvertimeRecordIfExists('rec_missing_payload'),
    ).resolves.toBeNull();
    await expect(
      gateway.readOvertimeRecordIfExists('rec_missing_http'),
    ).resolves.toBeNull();
    await expect(
      gateway.readOvertimeRecordIfExists('rec_forbidden'),
    ).rejects.toThrow('读取加班多维记录失败');
  });

  it('sets a finite timeout on every Feishu card and Base request', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_card_1' } },
      });
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: { record: { record_id: 'rec_1', fields: {} } },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const gateway = new OvertimeWorkflowGateway(
      { axiosRef: { post, patch, get, put } } as unknown as HttpService,
      jest.fn(),
    );

    await gateway.sendInteractiveCard(
      'ou_user_1',
      { schema: '2.0' },
      'approval:rec_1:ou_user_1',
    );
    await gateway.patchInteractiveCard('om_card_1', { schema: '2.0' });
    await gateway.readOvertimeRecord('rec_1');
    await gateway.updateOvertimeRecord('rec_1', { 加班流程进展: '已审批' });

    expect(post.mock.calls[1][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(patch.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(get.mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(put.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('maps and locally caches organization routing records', async () => {
    const reader = jest.fn().mockResolvedValue([
      {
        record_id: 'rec_org_1',
        fields: {
          值班账号: [{ id: 'ou_supervisor', name: '施小东' }],
          职位: '设施运维主管',
          '楼栋/专业': ['A楼'],
          主管: [{ id: 'ou_supervisor', name: '施小东' }],
          '主管（文本）': '施小东',
        },
      },
    ]);
    const gateway = new OvertimeWorkflowGateway(
      { axiosRef: {} } as unknown as HttpService,
      reader,
      () => Date.parse('2026-08-12T00:00:00.000Z'),
    );
    const first = await gateway.fetchOrganizationRoutingRecords();
    const second = await gateway.fetchOrganizationRoutingRecords();
    expect(first).toEqual([
      {
        name: '施小东',
        openId: 'ou_supervisor',
        position: '设施运维主管',
        buildings: ['A楼'],
        supervisorNames: ['施小东'],
      },
    ]);
    expect(second).toEqual(first);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        appToken: 'F9lDbA5XKaLmyasoARRcZFpKnZd',
        tableId: 'tblZipVFGY4D65tw',
        viewId: 'vewkJ9WMUS',
        allowStale: true,
      }),
    );
  });
});

describe('overtime confirmation ticket', () => {
  const secret = 'a-long-purpose-separated-secret';

  it('is scoped to one record and rejects tampering', () => {
    const ticket = issueOvertimeConfirmationTicket(
      {
        recordId: 'rec_1',
        approverOpenId: 'ou_approver',
        issuedAt: Date.parse('2026-08-12T00:00:00.000Z'),
      },
      secret,
    );
    expect(
      verifyOvertimeConfirmationTicket(ticket, secret, {
        expectedRecordId: 'rec_1',
        now: Date.parse('2026-08-13T00:00:00.000Z'),
      }),
    ).toEqual(
      expect.objectContaining({
        recordId: 'rec_1',
        approverOpenId: 'ou_approver',
      }),
    );
    expect(() =>
      verifyOvertimeConfirmationTicket(ticket, secret, {
        expectedRecordId: 'rec_2',
        now: Date.now(),
      }),
    ).toThrow(UnauthorizedException);
    expect(() =>
      verifyOvertimeConfirmationTicket(`${ticket}x`, secret, {
        expectedRecordId: 'rec_1',
        now: Date.now(),
      }),
    ).toThrow(UnauthorizedException);
  });

  it('uses a mobile-safe lightweight confirmation route', () => {
    const url = buildOvertimeConfirmationUrl(
      'https://www.sm.sjhl.online:3001/',
      'rec_1',
      'ticket-value',
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/overtime-confirmation');
    expect(parsed.searchParams.get('overtimeConfirmation')).toBe('1');
    expect(parsed.searchParams.get('ticket')).toBe('ticket-value');
    expect(parsed.searchParams.get('recordId')).toBe('rec_1');
    expect(parsed.hash).toBe('');
  });

  it('rejects unsafe public base URLs', () => {
    expect(() =>
      buildOvertimeConfirmationUrl('http://example.com', 'rec_1', 'ticket'),
    ).toThrow(BadRequestException);
  });
});
