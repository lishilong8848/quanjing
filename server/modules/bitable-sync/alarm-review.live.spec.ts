import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { AlarmReviewGateway } from './alarm-review.gateway';
import { reviewVersion } from './alarm-review.rules';

const live = process.env.ALARM_REVIEW_LIVE_RECORD_IDS ? describe : describe.skip;
live('explicit isolated Feishu alarm-review acceptance', () => {
  it('writes all three outcomes and real person association without changing alarm descriptions', async () => {
    const ids = (process.env.ALARM_REVIEW_LIVE_RECORD_IDS || '').split(',');
    if (ids.length !== 2 || ids.some(id => !/^rec[A-Za-z0-9]+$/.test(id))) throw new Error('Live test IDs not explicitly provided');
    const gateway = new AlarmReviewGateway(new HttpService(axios.create()));
    let phase = 'schema';
    try {
      await gateway.preflight();
      phase = 'responsible-user';
      const userId = await gateway.resolveResponsibleUserId('PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID');
      phase = 'first-result';
      const first = await gateway.syncRecord(ids[0], '人工复核无问题', userId, 'unreviewed');
      expect(first.受理描述).toEqual('TEST原受理描述不得改变');
      expect(first.确认描述).toEqual('TEST原确认描述不得改变');
      phase = 'second-result';
      const second = await gateway.syncRecord(ids[1], '已通知现场跟进', userId, 'unreviewed');
      phase = 'closed-result';
      const third = await gateway.syncRecord(ids[1], '告警已闭环无法处理', userId, reviewVersion(second));
      expect(third.受理描述).toEqual('TEST原受理描述不得改变');
      expect(third.确认描述).toEqual('TEST原确认描述不得改变');
      phase = 'idempotent-retry';
      await gateway.syncRecord(ids[1], '告警已闭环无法处理', userId, reviewVersion(second));
    } catch (error) {
      const message = error instanceof Error && error.constructor.name === 'ServiceUnavailableException' ? error.message : 'gateway or assertion failure';
      throw new Error(`Real Feishu acceptance failed at ${phase}: ${message}`);
    }
  }, 90000);
});
