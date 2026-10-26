import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpService } from '@nestjs/axios';
import { ATTACHED_BANK, scoreAttachedBank, getAttachedBankDisplayType } from '../../../shared/mbti-attached-bank-model';
import { EmployeeOnboardingGateway } from './employee-onboarding.gateway';
import { MbtiAssessmentService } from './mbti-assessment.service';

const ID = '52d87ff0-0e9f-4ae8-a39f-8af1c91d97db';
const SECOND_ID = '987112c2-127f-44f3-b7ab-37778e30a839';
const RECORD = 'recEmployee123';
const answers = Array(ATTACHED_BANK.full.length).fill('A') as Array<'A'>;
const type = getAttachedBankDisplayType(scoreAttachedBank('full', answers));

describe('MbtiAssessmentService', () => {
  let folder: string;
  let service: MbtiAssessmentService;
  let gateway: Pick<EmployeeOnboardingGateway, 'readRecord' | 'updateMbti'>;
  const previousPath = process.env.MBTI_ASSESSMENT_LEDGER_PATH;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'mbti-assessment-'));
    process.env.MBTI_ASSESSMENT_LEDGER_PATH = join(folder, 'ledger.json');
    gateway = { readRecord: jest.fn().mockResolvedValue({ 姓名: '测试员工' }), updateMbti: jest.fn().mockResolvedValue(undefined) };
    service = new MbtiAssessmentService(gateway as EmployeeOnboardingGateway, {} as HttpService);
  });
  afterEach(async () => {
    if (previousPath === undefined) delete process.env.MBTI_ASSESSMENT_LEDGER_PATH;
    else process.env.MBTI_ASSESSMENT_LEDGER_PATH = previousPath;
    await rm(folder, { recursive: true, force: true });
  });

  const payload = () => ({ clientMutationId: ID, audience: 'active', recordId: RECORD, name: '测试员工', version: 'full', answers, sourceSha256: ATTACHED_BANK.sourceSha256 });

  it('persists acceptance before background sync, then confirms Feishu readback', async () => {
    const accepted = await service.submit(payload());
    expect(accepted).toMatchObject({ recordId: RECORD, type, syncState: 'accepted' });
    const ledger = JSON.parse(await readFile(process.env.MBTI_ASSESSMENT_LEDGER_PATH!, 'utf8'));
    expect(ledger.submissions[ID].state).toBe('accepted');
    await waitFor(async () => (await service.status(ID)).syncState === 'success');
    expect(gateway.updateMbti).toHaveBeenCalledWith(RECORD, type);
    expect((await service.submit(payload())).syncState).toBe('success');
    expect(gateway.updateMbti).toHaveBeenCalledTimes(1);
  });

  it('keeps failed submissions and retries the same mutation without duplicating records', async () => {
    (gateway.updateMbti as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await service.submit(payload());
    await waitFor(async () => (await service.status(ID)).syncState === 'error');
    expect((await service.status(ID)).message).toBe('飞书同步暂时失败，请重试');
    expect((await service.submit(payload())).syncState).toBe('accepted');
    await waitFor(async () => (await service.status(ID)).syncState === 'success');
    expect(gateway.updateMbti).toHaveBeenCalledTimes(2);
  });

  it('binds onboarding tickets to one record and rejects modified answers for the same mutation', async () => {
    const ticket = await service.issueOnboardingTicket(RECORD, '测试员工');
    expect(await service.onboardingContext(ticket)).toEqual({ recordId: RECORD, name: '测试员工' });
    const newPayload = { ...payload(), audience: 'new', recordId: undefined, name: undefined, ticket };
    await service.submit(newPayload);
    await waitFor(async () => (await service.status(ID)).syncState === 'success');
    await expect(service.submit({ ...newPayload, answers: answers.map((answer, index) => index === 0 ? 'B' : answer) })).rejects.toThrow('提交标识与已有答案不一致');
  });

  it('resumes an accepted submission from the durable ledger after service restart', async () => {
    await writeFile(process.env.MBTI_ASSESSMENT_LEDGER_PATH!, JSON.stringify({
      version: 1, tickets: {}, submissions: {
        [ID]: { payloadHash: 'saved-hash', recordId: RECORD, name: '测试员工', version: 'full',
          answers, type, state: 'accepted', updatedAt: new Date().toISOString() },
      },
    }));
    const restarted = new MbtiAssessmentService(gateway as EmployeeOnboardingGateway, {} as HttpService);
    await waitFor(async () => (await restarted.status(ID)).syncState === 'success');
    expect(gateway.updateMbti).toHaveBeenCalledWith(RECORD, type);
  });

  it('writes two retests for one employee in submission order', async () => {
    const nextAnswers = Array(60).fill(7);
    const nextType = getAttachedBankDisplayType(scoreAttachedBank('short', nextAnswers));
    await service.submit(payload());
    await service.submit({ ...payload(), clientMutationId: SECOND_ID, version: 'short', answers: nextAnswers });
    await waitFor(async () => (await service.status(SECOND_ID)).syncState === 'success');
    expect((gateway.updateMbti as jest.Mock).mock.calls).toEqual([[RECORD, type], [RECORD, nextType]]);
  });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 80; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('MBTI background status timed out');
}
