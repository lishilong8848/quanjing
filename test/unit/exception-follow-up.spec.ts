import {
  buildExceptionFollowUpDetailedContent,
  buildExceptionFollowUpFields,
  buildExceptionFollowUpMatchKey,
  buildExceptionFollowUpNotification,
  buildExceptionFollowUpUpdateFields,
} from '../../server/modules/duty-schedule/exception-follow-up';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('exception follow-up helpers', () => {
  it('maps schedule risks to the Bitable fields', () => {
    const result = buildExceptionFollowUpFields({
      type: 'schedule',
      abnormalLabel: '风险',
      date: '2026-05-20',
      detail: '张三 夜班后接白班',
      handling: '已安排替班并通知值班长',
    });

    expect(result.fields).toMatchObject({
      日期: new Date('2026-05-20T00:00:00+08:00').getTime(),
      异常项: '风险：张三 夜班后接白班',
      异常说明: '风险：张三 夜班后接白班',
      异常类型: '排班异常',
      来源: '人工登记',
      楼栋: '园区',
      已知悉: true,
      已处理完成: true,
      处理措施: '已安排替班并通知值班长',
    });
    expect(result.fields['异常唯一键']).toMatch(/^manual:[a-f0-9]{64}$/u);
    expect(result.fields).not.toHaveProperty('异常项类型');
    expect(result.fields).not.toHaveProperty('详细内容');
    expect(result.fields).not.toHaveProperty('异常日期');
    expect(result.normalized.typeLabel).toBe('排班异常');
  });

  it('maps conflict reminders to the Bitable fields', () => {
    const result = buildExceptionFollowUpFields({
      type: 'sealing_change',
      abnormalLabel: '冲突',
      date: '2026-05-20',
      detail: '变更 A 与封网窗口冲突',
      handling: '变更延期到封网结束后执行',
    });

    expect(result.fields['异常类型']).toBe('封网&变更');
    expect(result.fields['异常项']).toBe('冲突：变更 A 与封网窗口冲突');
  });

  it('requires detail and handling text', () => {
    expect(() =>
      buildExceptionFollowUpFields({
        type: 'schedule',
        abnormalLabel: '风险',
        date: '2026-05-20',
        detail: '',
        handling: '已处理',
      }),
    ).toThrow('异常项内容不能为空');

    expect(() =>
      buildExceptionFollowUpFields({
        type: 'schedule',
        abnormalLabel: '风险',
        date: '2026-05-20',
        detail: '张三连班',
        handling: '',
      }),
    ).toThrow('处理方式不能为空');
  });

  it('builds a notification with the exception and handling details', () => {
    const { normalized } = buildExceptionFollowUpFields({
      type: 'sealing_change',
      abnormalLabel: '提醒',
      date: '2026-05-20',
      detail: '当日有封网，需关注执行窗口',
      handling: '执行前二次确认封网窗口',
    });

    expect(
      buildExceptionFollowUpNotification(
        normalized,
        'https://example.test/record',
      ),
    ).toContain('异常项：当日有封网，需关注执行窗口');
    expect(buildExceptionFollowUpNotification(normalized)).toContain(
      '处理方式：执行前二次确认封网窗口',
    );
  });

  it('builds a stable follow-up match key from date and detailed content', () => {
    const detailedContent = buildExceptionFollowUpDetailedContent(
      '冲突',
      'EA118 变更 与封网冲突',
    );

    expect(detailedContent).toBe('冲突：EA118 变更 与封网冲突');
    expect(buildExceptionFollowUpMatchKey('2026-05-20', detailedContent)).toBe(
      '2026-05-20|冲突：EA118 变更 与封网冲突',
    );
  });

  it('builds update fields for editing handling text', () => {
    expect(
      buildExceptionFollowUpUpdateFields({
        recordId: 'rec123',
        type: 'sealing_change',
        abnormalLabel: '冲突',
        date: '2026-05-20',
        detail: 'EA118 变更 与封网冲突',
        handling: '延期后重新确认',
      }),
    ).toEqual({
      recordId: 'rec123',
      fields: {
        已知悉: true,
        已处理完成: true,
        处理措施: '延期后重新确认',
        客户端变更ID: expect.stringMatching(/^manual-update:[a-f0-9]{64}$/u),
        处理时间: expect.any(Number),
      },
    });

    expect(() =>
      buildExceptionFollowUpUpdateFields({
        recordId: '',
        type: 'sealing_change',
        abnormalLabel: '冲突',
        date: '2026-05-20',
        detail: 'EA118 变更 与封网冲突',
        handling: '延期后重新确认',
      }),
    ).toThrow('缺少异常跟进记录 ID');
  });

  it('targets the unified follow-up table and does not send manual text notifications', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.service.ts',
      ),
      'utf8',
    );
    expect(source).toContain('tblCGU1ry3tanQ20');
    expect(source).toContain('vewX0MdewN');
    expect(source).toContain("configured.tableId !== 'tblMK8wzLlFKbTlP'");
    expect(source).toContain('异常跟进已保存');
  });
});
