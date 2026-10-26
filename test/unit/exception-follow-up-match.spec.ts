import {
  buildExceptionFollowUpTargetKeys,
  getExceptionFollowUpItemKeys,
  indexExceptionFollowUpItems,
  removeExceptionFollowUpItemFromIndex,
  selectExceptionFollowUpByTarget,
  selectExceptionFollowUpsByTarget,
  upsertExceptionFollowUpItemInIndex,
} from '../../shared/exception-follow-up-match';
import type { ExceptionFollowUpItem } from '../../shared/api.interface';

describe('exception follow-up matching', () => {
  const existing: ExceptionFollowUpItem = {
    recordId: 'recvkamt8wU7i3',
    type: 'sealing_change',
    typeLabel: '封网&变更',
    abnormalLabel: '冲突',
    date: '2026-05-20',
    detail: 'EA118机房C楼HVDC蓄电池100%容量放电变更（第十二阶段）：实际 5月20日 00:00 - 5月21日 00:00 执行人 未维护 楼栋 C楼 等级 超低 与封网「2026年618大促云智能封网 - 弱管控1」时间冲突 请确认是否允许执行',
    detailedContent: '冲突：EA118机房C楼HVDC蓄电池100%容量放电变更（第十二阶段）：实际 5月20日 00:00 - 5月21日 00:00 执行人 未维护 楼栋 C楼 等级 超低 与封网「2026年618大促云智能封网 - 弱管控1」时间冲突 请确认是否允许执行',
    handling: '实际未执行\n已调整计划',
    matchKey: '2026-05-20|冲突：EA118机房C楼HVDC蓄电池100%容量放电变更（第十二阶段）：实际 5月20日 00:00 - 5月21日 00:00 执行人 未维护 楼栋 C楼 等级 超低 与封网「2026年618大促云智能封网 - 弱管控1」时间冲突 请确认是否允许执行',
    createdAt: null,
    updatedAt: null,
  };

  it('matches a Bitable record even when punctuation is normalized on readback', () => {
    const frontendDetail = [
      'EA118机房C楼HVDC蓄电池100%容量放电变更（第十二阶段）：实际 5月20日 00:00 - 5月21日 00:00',
      '执行人 未维护',
      '楼栋 C楼',
      '等级 超低',
      '与封网「2026年618大促云智能封网 - 弱管控1」时间冲突，请确认是否允许执行',
    ].join('；');
    const store: Record<string, ExceptionFollowUpItem> = {};
    for (const key of getExceptionFollowUpItemKeys(existing)) {
      store[key] = existing;
    }

    expect(buildExceptionFollowUpTargetKeys('2026-05-20', '冲突', frontendDetail).length).toBeGreaterThan(1);
    expect(selectExceptionFollowUpByTarget(store, '2026-05-20', '冲突', frontendDetail)).toBe(existing);
  });

  it('keeps multiple follow-ups for the same exception and removes only the selected one', () => {
    const second: ExceptionFollowUpItem = {
      ...existing,
      recordId: 'recSecond',
      handling: '二次确认，已同步执行窗口',
      updatedAt: '2026-05-20T10:30:00.000Z',
    };
    const frontendDetail = [
      'EA118机房C楼HVDC蓄电池100%容量放电变更（第十二阶段）：实际 5月20日 00:00 - 5月21日 00:00',
      '执行人 未维护',
      '楼栋 C楼',
      '等级 超低',
      '与封网「2026年618大促云智能封网 - 弱管控1」时间冲突，请确认是否允许执行',
    ].join('；');

    let index = indexExceptionFollowUpItems([existing, second]);
    expect(selectExceptionFollowUpsByTarget(index, '2026-05-20', '冲突', frontendDetail).map((item) => item.recordId)).toEqual([
      'recSecond',
      'recvkamt8wU7i3',
    ]);

    index = removeExceptionFollowUpItemFromIndex(index, second);
    expect(selectExceptionFollowUpsByTarget(index, '2026-05-20', '冲突', frontendDetail).map((item) => item.recordId)).toEqual([
      'recvkamt8wU7i3',
    ]);

    index = removeExceptionFollowUpItemFromIndex(index, existing);
    expect(selectExceptionFollowUpsByTarget(index, '2026-05-20', '冲突', frontendDetail)).toEqual([]);
  });

  it('replaces a specific follow-up by record id without dropping sibling records', () => {
    const sibling: ExceptionFollowUpItem = {
      ...existing,
      recordId: 'recSibling',
      handling: '保留的另一条处理记录',
      updatedAt: '2026-05-20T09:00:00.000Z',
    };
    const updated: ExceptionFollowUpItem = {
      ...existing,
      handling: '更新后的处理记录',
      updatedAt: '2026-05-20T11:00:00.000Z',
    };

    const index = upsertExceptionFollowUpItemInIndex(indexExceptionFollowUpItems([existing, sibling]), updated);
    const selected = selectExceptionFollowUpsByTarget(index, existing.date, existing.abnormalLabel, existing.detail);

    expect(selected).toHaveLength(2);
    expect(selected.find((item) => item.recordId === existing.recordId)?.handling).toBe('更新后的处理记录');
    expect(selected.find((item) => item.recordId === sibling.recordId)?.handling).toBe('保留的另一条处理记录');
  });
});
