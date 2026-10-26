import {
  getDailyChecklistTargetStage,
  isDailyChecklistActionable,
} from '../../client/src/pages/ConstructionManagement/daily-progress-actions';

describe('construction daily progress actions', () => {
  it('routes pending checklist items to the matching daily follow-up stage', () => {
    expect(getDailyChecklistTargetStage('人员核查')).toBe('prepare');
    expect(getDailyChecklistTargetStage('作业票校核')).toBe('prepare');
    expect(getDailyChecklistTargetStage('挂牌隔离')).toBe('prepare');
    expect(getDailyChecklistTargetStage('过程照片')).toBe('process');
    expect(getDailyChecklistTargetStage('收尾清单')).toBe('close');
    expect(getDailyChecklistTargetStage('收尾照片')).toBe('close');
    expect(
      getDailyChecklistTargetStage({
        label: '人员核查',
        value: '待核查',
        done: false,
        actionKind: 'personnel',
        stage: 'prepare',
      }),
    ).toBe('prepare');
  });

  it('treats every checklist row as a quick action into daily follow-up', () => {
    expect(
      isDailyChecklistActionable({
        label: '人员核查',
        value: '待核查',
        done: false,
        actionKind: 'personnel',
        stage: 'prepare',
      }),
    ).toBe(true);
    expect(
      isDailyChecklistActionable({
        label: '挂牌隔离',
        value: '需复核',
        done: false,
        issue: true,
        actionKind: 'isolation',
        stage: 'prepare',
      }),
    ).toBe(true);
    expect(
      isDailyChecklistActionable({
        label: '过程照片',
        value: '已上传',
        done: true,
        actionKind: 'processPhoto',
        stage: 'process',
      }),
    ).toBe(true);
    expect(
      isDailyChecklistActionable({
        label: '作业票校核',
        value: '有效',
        done: true,
        actionKind: 'permit',
        stage: 'prepare',
      }),
    ).toBe(true);
  });

  it('keeps disabled checklist rows from opening daily follow-up', () => {
    const disabledPersonnelCheck = {
      label: '人员核查',
      value: '请先确认当天作业类型',
      done: false,
      actionKind: 'personnel',
      stage: 'prepare',
      disabled: true,
    } as Parameters<typeof isDailyChecklistActionable>[0] & {
      disabled: boolean;
    };

    expect(isDailyChecklistActionable(disabledPersonnelCheck)).toBe(false);
    expect(
      isDailyChecklistActionable({
        ...disabledPersonnelCheck,
        disabled: false,
      }),
    ).toBe(true);
  });
});
