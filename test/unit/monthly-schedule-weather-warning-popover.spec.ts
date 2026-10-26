import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeatherWarningSnapshot } from '../../shared/api.interface';
import * as weatherWarningPresentation from '../../client/src/pages/MonthlySchedule/weather-warning-presentation';
import {
  getWeatherWarningDetailScope,
  getWeatherWarningDecisionPresentation,
  getWeatherWarningColorPresentation,
  getWeatherWarningGuardLevelPresentation,
  getWeatherWarningRelationLabel,
  getWeatherWarningSummaryPresentation,
  getWeatherWarningTimePresentation,
  getWeatherWarningTriggerPresentation,
} from '../../client/src/pages/MonthlySchedule/weather-warning-presentation';

function createSnapshot(
  overrides: Partial<WeatherWarningSnapshot> = {},
): WeatherWarningSnapshot {
  return {
    status: 'clear',
    sourceState: 'fresh',
    snapshotAt: '2026-08-06T08:00:00+08:00',
    guardLevel: null,
    matchedWarnings: [],
    unmatchedWarnings: [],
    actions: [],
    weather: null,
    checkSummary: {
      device: 'not_started',
      environment: 'not_started',
      disaster: 'not_started',
      materials: 'not_started',
      contacts: 'not_started',
      managerConfirmation: 'not_started',
      abnormalSummaries: [],
    },
    canSendTest: false,
    ...overrides,
  };
}

const matchedWarning = {
  id: 'matched-1',
  title: '南通市气象台发布台风橙色预警',
  type: '台风',
  color: 'orange' as const,
  guardLevel: '二级戒备' as const,
};

const unmatchedWarning = {
  id: 'unmatched-1',
  title: '南通市气象台发布大雾蓝色预警',
  type: '大雾',
  color: 'blue' as const,
  guardLevel: null,
};

const secondaryMatchedWarning = {
  id: 'matched-2',
  title: '南通市气象台发布暴雨黄色预警',
  type: '暴雨',
  color: 'yellow' as const,
  guardLevel: '三级戒备' as const,
};

const blueMatchedWarning = {
  id: 'matched-blue',
  title: '南通市气象台发布暴雨蓝色预警',
  type: '暴雨',
  color: 'blue' as const,
  guardLevel: '三级戒备' as const,
};

type CheckProgressPresentation = {
  kind: 'available' | 'unavailable';
  message?: string;
  items: Array<{
    key: string;
    label: string;
    stateLabel: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
    incompleteBuildings: string[];
    detail: string | null;
  }>;
  missingRegistrationText: string | null;
};

function getCheckProgressPresentation(
  snapshot: WeatherWarningSnapshot,
): CheckProgressPresentation | null {
  const factory = (
    weatherWarningPresentation as unknown as {
      getWeatherWarningCheckProgressPresentation?: (
        value: WeatherWarningSnapshot,
      ) => CheckProgressPresentation;
    }
  ).getWeatherWarningCheckProgressPresentation;

  expect(factory).toBeDefined();
  return factory ? factory(snapshot) : null;
}

describe('getWeatherWarningCheckProgressPresentation', () => {
  it('shows not-required checks without counting or naming incomplete buildings', () => {
    const result = getCheckProgressPresentation(
      createSnapshot({
        status: 'active',
        guardLevel: '三级戒备',
        checkSyncState: 'fresh',
        checkSummary: {
          device: 'pending',
          environment: 'not_required',
          disaster: 'completed',
          materials: 'completed',
          contacts: 'completed',
          managerConfirmation: 'completed',
          abnormalSummaries: [],
        },
        buildingProgress: {
          available: true,
          buildings: [],
          missingRegistrationBuildings: [],
          unassignedRecordCount: 0,
          incompleteItems: [
            {
              building: 'H楼',
              key: 'device',
              label: '设备安全',
              state: 'pending',
            },
            {
              building: 'A楼',
              key: 'device',
              label: '设备安全',
              state: 'abnormal',
            },
            {
              building: 'A楼',
              key: 'environment',
              label: '环境安全',
              state: 'pending',
            },
          ],
        },
      }),
    );

    expect(result?.kind).toBe('available');
    expect(result?.items.find(({ key }) => key === 'device')).toMatchObject({
      stateLabel: '待检查',
      incompleteBuildings: ['A楼', 'H楼'],
      detail: '未完成：A楼、H楼',
    });
    expect(
      result?.items.find(({ key }) => key === 'environment'),
    ).toMatchObject({
      stateLabel: '无需检查',
      tone: 'success',
      incompleteBuildings: [],
      detail: null,
    });
  });

  it('keeps buildings without a registration in a separate compact message', () => {
    const result = getCheckProgressPresentation(
      createSnapshot({
        status: 'active',
        guardLevel: '三级戒备',
        checkSyncState: 'fresh',
        buildingProgress: {
          available: true,
          buildings: [],
          missingRegistrationBuildings: ['B楼', 'E楼'],
          unassignedRecordCount: 0,
          incompleteItems: [
            {
              building: 'B楼',
              key: 'registration',
              label: '未提交戒备登记',
              state: 'missing_registration',
            },
            {
              building: 'E楼',
              key: 'registration',
              label: '未提交戒备登记',
              state: 'missing_registration',
            },
          ],
        },
      }),
    );

    expect(result?.missingRegistrationText).toBe('未登记：B楼、E楼');
    expect(
      result?.items.every(({ detail }) => detail !== '未完成：B楼、E楼'),
    ).toBe(true);
  });

  it('states that building progress is unavailable instead of presenting zero progress', () => {
    const result = getCheckProgressPresentation(
      createSnapshot({
        status: 'active',
        guardLevel: '三级戒备',
        checkSyncState: 'unavailable',
        buildingProgress: {
          available: false,
          buildings: [],
          missingRegistrationBuildings: [],
          unassignedRecordCount: 0,
          incompleteItems: [],
        },
      }),
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      message: '重保检查进度不可用，戒备登记仍可继续提交。',
      items: [],
      missingRegistrationText: null,
    });
  });
});

function expectTriggerPresentation(
  input: Omit<
    Parameters<typeof getWeatherWarningTriggerPresentation>[0],
    'warningFailureKind'
  > & {
    warningFailureKind?: Parameters<
      typeof getWeatherWarningTriggerPresentation
    >[0]['warningFailureKind'];
  },
  expected: Pick<
    ReturnType<typeof getWeatherWarningTriggerPresentation>,
    'label' | 'tone'
  >,
  ariaKeyword: string,
) {
  const presentation = getWeatherWarningTriggerPresentation({
    ...input,
    warningFailureKind: input.warningFailureKind ?? null,
  });

  expect(presentation).toMatchObject(expected);
  expect(presentation.ariaLabel.trim()).not.toBe('');
  expect(presentation.ariaLabel).toContain(ariaKeyword);
  return presentation;
}

describe('getWeatherWarningDetailScope', () => {
  const input = {
    warningSnapshot: createSnapshot({
      status: 'active',
      guardLevel: '二级戒备',
      matchedWarnings: [matchedWarning, secondaryMatchedWarning],
      unmatchedWarnings: [unmatchedWarning],
    }),
    warningStatus: 'ready' as const,
    warningError: null,
    warningFailureKind: null,
  };

  it('keeps global guard progress and registration on the primary matched warning', () => {
    expect(
      getWeatherWarningDetailScope(input, matchedWarning.id, true),
    ).toEqual({
      warnings: [{ warning: matchedWarning, matched: true }],
      description: `${matchedWarning.title}：二级戒备 · 需戒备`,
      showGuardDetails: true,
      canRegisterGuard: true,
      isSecondaryGuardWarning: false,
    });
  });

  it('scopes an unmatched warning without exposing guard progress or registration', () => {
    expect(
      getWeatherWarningDetailScope(input, unmatchedWarning.id, false),
    ).toEqual({
      warnings: [{ warning: unmatchedWarning, matched: false }],
      description: `${unmatchedWarning.title}：无需戒备`,
      showGuardDetails: false,
      canRegisterGuard: false,
      isSecondaryGuardWarning: false,
    });
  });

  it('marks a secondary matched warning without borrowing the primary progress', () => {
    expect(
      getWeatherWarningDetailScope(input, secondaryMatchedWarning.id, true),
    ).toEqual({
      warnings: [{ warning: secondaryMatchedWarning, matched: true }],
      description: `${secondaryMatchedWarning.title}：三级戒备 · 需戒备`,
      showGuardDetails: false,
      canRegisterGuard: false,
      isSecondaryGuardWarning: true,
    });
  });

  it('uses matched identity to select an unmatched warning when ids collide', () => {
    const collidingUnmatchedWarning = {
      ...unmatchedWarning,
      id: matchedWarning.id,
      title: '与戒备预警同 ID 的大雾蓝色预警',
    };
    const collisionInput = {
      ...input,
      warningSnapshot: createSnapshot({
        status: 'active',
        guardLevel: '二级戒备',
        matchedWarnings: [matchedWarning],
        unmatchedWarnings: [collidingUnmatchedWarning],
      }),
    };

    expect(
      getWeatherWarningDetailScope(
        collisionInput,
        collidingUnmatchedWarning.id,
        false,
      ),
    ).toEqual({
      warnings: [{ warning: collidingUnmatchedWarning, matched: false }],
      description: `${collidingUnmatchedWarning.title}：无需戒备`,
      showGuardDetails: false,
      canRegisterGuard: false,
      isSecondaryGuardWarning: false,
    });
  });

  it('keeps the full overview when no warning is selected', () => {
    expect(getWeatherWarningDetailScope(input)).toEqual({
      warnings: [
        { warning: matchedWarning, matched: true },
        { warning: secondaryMatchedWarning, matched: true },
        { warning: unmatchedWarning, matched: false },
      ],
      description: '已匹配 2 条戒备规则，请完成重保检查和登记',
      showGuardDetails: true,
      canRegisterGuard: true,
      isSecondaryGuardWarning: false,
    });
  });
});

describe('getWeatherWarningTriggerPresentation', () => {
  it.each([
    ['red', 'danger', 'border-red-200 bg-red-50 text-red-800'],
    ['orange', 'orange', 'border-orange-200 bg-orange-50 text-orange-800'],
    ['yellow', 'warning', 'border-amber-200 bg-amber-50 text-amber-900'],
    ['blue', 'info', 'border-blue-200 bg-blue-50 text-blue-800'],
  ] as const)(
    'follows the %s warning color for guard badges, summaries and triggers',
    (color, tone, badgeClassName) => {
      const warning = {
        ...blueMatchedWarning,
        id: `matched-${color}`,
        color,
      };
      const snapshot = createSnapshot({
        status: 'active',
        guardLevel: '三级戒备',
        matchedWarnings: [warning],
      });

      expect(getWeatherWarningColorPresentation(color)).toMatchObject({
        tone,
        badgeClassName,
      });
      expect(
        getWeatherWarningDecisionPresentation({
          warningSnapshot: snapshot,
          warning,
          matched: true,
        }),
      ).toMatchObject({
        kind: 'guard_required',
        tone,
        badgeClassName,
      });
      expect(
        getWeatherWarningSummaryPresentation({
          warningSnapshot: snapshot,
          warningStatus: 'ready',
          warningError: null,
          warningFailureKind: null,
        }),
      ).toMatchObject({ kind: 'guard_required', tone });
      expectTriggerPresentation(
        {
          warningSnapshot: snapshot,
          warningStatus: 'ready',
          warningError: null,
        },
        { label: '三级戒备 · 1', tone },
        '三级戒备',
      );
    },
  );

  it('shows completion only on the primary matched warning and keeps it separate from the guard level', () => {
    const snapshot = createSnapshot({
      status: 'active',
      guardLevel: '三级戒备',
      matchedWarnings: [blueMatchedWarning, secondaryMatchedWarning],
      guardCompletion: {
        state: 'completed',
        completedBuildingCount: 7,
        totalBuildingCount: 7,
      },
    });

    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: snapshot,
        warning: blueMatchedWarning,
        matched: true,
      }),
    ).toMatchObject({
      kind: 'guard_required',
      label: '三级戒备',
      tone: 'info',
      badgeClassName: 'border-blue-200 bg-blue-50 text-blue-800',
      guardCompleted: true,
    });
    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: snapshot,
        warning: secondaryMatchedWarning,
        matched: true,
      }),
    ).toMatchObject({
      kind: 'guard_required',
      label: '三级戒备 · 需戒备',
      tone: 'warning',
      guardCompleted: false,
    });
    expectTriggerPresentation(
      {
        warningSnapshot: snapshot,
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '三级戒备 · 2 · 戒备完成', tone: 'info' },
      '戒备完成',
    );
  });

  it('uses one exhaustive guard-level palette for trigger and detail badges', () => {
    expect(getWeatherWarningGuardLevelPresentation('一级戒备')).toEqual({
      tone: 'danger',
      badgeClassName: 'border-red-200 bg-red-50 text-red-800',
    });
    expect(getWeatherWarningGuardLevelPresentation('二级戒备')).toEqual({
      tone: 'orange',
      badgeClassName: 'border-orange-200 bg-orange-50 text-orange-800',
    });
    expect(getWeatherWarningGuardLevelPresentation('三级戒备')).toEqual({
      tone: 'warning',
      badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
    });
  });

  it('shows sync and typed non-danger failure states without inventing a clear snapshot', () => {
    expectTriggerPresentation(
      {
        warningSnapshot: null,
        warningStatus: 'loading',
        warningError: null,
      },
      { label: '预警同步中', tone: 'info' },
      '同步',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: null,
        warningStatus: 'loading',
        warningError: '当前账号无权读取天气预警快照',
      },
      { label: '预警重试中', tone: 'warning' },
      '重试',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: null,
        warningStatus: 'error',
        warningError: '天气预警服务配置暂不可用',
        warningFailureKind: 'configuration',
      },
      { label: '预警待配置', tone: 'warning' },
      '配置',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: null,
        warningStatus: 'error',
        warningError: '当前账号无权读取天气预警快照',
        warningFailureKind: 'permission',
      },
      { label: '预警信息受限', tone: 'warning' },
      '无权',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: null,
        warningStatus: 'error',
        warningError: '天气预警快照获取超时',
        warningFailureKind: 'timeout',
      },
      { label: '预警待同步', tone: 'warning' },
      '超时',
    );
  });

  it('counts matched and unmatched warnings in an active guard level', () => {
    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({
          status: 'active',
          guardLevel: '一级戒备',
          matchedWarnings: [matchedWarning],
          unmatchedWarnings: [unmatchedWarning],
        }),
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '一级戒备 · 2', tone: 'orange' },
      '一级戒备',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({
          status: 'active',
          guardLevel: '二级戒备',
          matchedWarnings: [matchedWarning],
        }),
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '二级戒备 · 1', tone: 'orange' },
      '二级戒备',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({
          status: 'active',
          guardLevel: '三级戒备',
          matchedWarnings: [matchedWarning],
        }),
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '三级戒备 · 1', tone: 'orange' },
      '三级戒备',
    );
  });

  it('renders a complete warning validity range without placeholders', () => {
    expect(
      getWeatherWarningTimePresentation({
        ...matchedWarning,
        startTime: '2026-08-06T08:00:00+08:00',
        endTime: '2026-08-07T08:00:00+08:00',
      }),
    ).toEqual({ label: '有效期 8/6 08:00 至 8/7 08:00' });
  });

  it('uses the available warning boundary instead of inventing a missing one', () => {
    expect(
      getWeatherWarningTimePresentation({
        ...matchedWarning,
        pubTime: '2026-08-06T08:00:00+08:00',
      }),
    ).toEqual({ label: '发布于 8/6 08:00' });
    expect(
      getWeatherWarningTimePresentation({
        ...matchedWarning,
        startTime: '2026-08-06T08:00:00+08:00',
      }),
    ).toEqual({ label: '生效于 8/6 08:00' });
    expect(
      getWeatherWarningTimePresentation({
        ...matchedWarning,
        endTime: '2026-08-07T08:00:00+08:00',
      }),
    ).toEqual({ label: '截至 8/7 08:00' });
  });

  it('omits warning time text when no valid boundary is available', () => {
    expect(getWeatherWarningTimePresentation(matchedWarning)).toEqual({
      label: '',
    });
  });

  it('marks a complete fresh unmatched warning as explicitly no-guard', () => {
    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({
          unmatchedWarnings: [unmatchedWarning],
        }),
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '天气预警 · 1 · 无需戒备', tone: 'success' },
      '无需戒备',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot(),
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '当前无重保预警', tone: 'success' },
      '无重保预警',
    );
  });

  it('derives per-warning guard, no-guard, pending, manual-review and stale decisions', () => {
    const activeSnapshot = createSnapshot({
      status: 'active',
      guardLevel: '二级戒备',
      matchedWarnings: [matchedWarning],
      unmatchedWarnings: [unmatchedWarning],
    });

    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: activeSnapshot,
        warning: matchedWarning,
        matched: true,
      }),
    ).toMatchObject({
      kind: 'guard_required',
      label: '二级戒备 · 需戒备',
      tone: 'orange',
    });
    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: activeSnapshot,
        warning: unmatchedWarning,
        matched: false,
      }),
    ).toMatchObject({
      kind: 'no_guard_required',
      label: '无需戒备',
      tone: 'success',
    });

    const pendingSnapshot = createSnapshot({
      status: 'degraded',
      sourceState: 'degraded',
      unmatchedWarnings: [unmatchedWarning],
      sourceError: '天气预警已获取，重保规则暂未同步',
    });
    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: pendingSnapshot,
        warning: unmatchedWarning,
        matched: false,
      }),
    ).toMatchObject({
      kind: 'decision_pending',
      label: '戒备判定待同步',
      tone: 'warning',
    });

    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: createSnapshot({
          unmatchedWarnings: [{ ...unmatchedWarning, type: null, color: null }],
        }),
        warning: { ...unmatchedWarning, type: null, color: null },
        matched: false,
      }),
    ).toMatchObject({
      kind: 'manual_review',
      label: '需人工复核',
      tone: 'warning',
    });

    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: createSnapshot({
          status: 'stale',
          unmatchedWarnings: [unmatchedWarning],
        }),
        warning: unmatchedWarning,
        matched: false,
      }),
    ).toMatchObject({
      kind: 'stale',
      label: '判定待更新',
      tone: 'warning',
    });
  });

  it('keeps relation labels aligned with the current decision state', () => {
    const activeSnapshot = createSnapshot({
      status: 'active',
      guardLevel: '二级戒备',
      matchedWarnings: [matchedWarning],
      unmatchedWarnings: [unmatchedWarning],
    });
    const guardDecision = getWeatherWarningDecisionPresentation({
      warningSnapshot: activeSnapshot,
      warning: matchedWarning,
      matched: true,
    });
    const noGuardDecision = getWeatherWarningDecisionPresentation({
      warningSnapshot: activeSnapshot,
      warning: unmatchedWarning,
      matched: false,
    });

    expect(
      getWeatherWarningRelationLabel({
        decision: guardDecision,
        guardLevel: matchedWarning.guardLevel,
      }),
    ).toBe('重保类型：二级戒备');
    expect(
      getWeatherWarningRelationLabel({
        decision: noGuardDecision,
        guardLevel: unmatchedWarning.guardLevel,
      }),
    ).toBe('不触发重保');

    const staleDecision = getWeatherWarningDecisionPresentation({
      warningSnapshot: createSnapshot({
        status: 'stale',
        sourceState: 'degraded',
        guardDecisionState: 'stale',
        guardLevel: '二级戒备',
        matchedWarnings: [matchedWarning],
      }),
      warning: matchedWarning,
      matched: true,
    });
    expect(
      getWeatherWarningRelationLabel({
        decision: staleDecision,
        guardLevel: matchedWarning.guardLevel,
      }),
    ).toBe('判定待更新');

    const missingPerWarningLevel = { ...matchedWarning, guardLevel: null };
    const fallbackDecision = getWeatherWarningDecisionPresentation({
      warningSnapshot: createSnapshot({
        status: 'active',
        guardLevel: '二级戒备',
        matchedWarnings: [missingPerWarningLevel],
      }),
      warning: missingPerWarningLevel,
      matched: true,
    });
    expect(
      getWeatherWarningRelationLabel({
        decision: fallbackDecision,
        guardLevel: missingPerWarningLevel.guardLevel,
      }),
    ).toBe('戒备等级待确认');
  });

  it('derives summary actionability without exposing registration for uncertain states', () => {
    expect(
      getWeatherWarningSummaryPresentation({
        warningSnapshot: createSnapshot({
          status: 'active',
          guardLevel: '二级戒备',
          matchedWarnings: [matchedWarning],
        }),
        warningStatus: 'ready',
        warningError: null,
        warningFailureKind: null,
      }),
    ).toMatchObject({
      kind: 'guard_required',
      title: '二级戒备',
      canRegisterGuard: true,
      warningCount: 1,
    });

    const checkSyncDegradedSnapshot = createSnapshot({
      status: 'degraded',
      sourceState: 'degraded',
      guardDecisionState: 'fresh',
      checkSyncState: 'unavailable',
      guardLevel: '二级戒备',
      matchedWarnings: [matchedWarning],
      sourceError: '天气预警与戒备已判定，重保检查进度暂未同步',
    });
    expect(
      getWeatherWarningSummaryPresentation({
        warningSnapshot: checkSyncDegradedSnapshot,
        warningStatus: 'ready',
        warningError: null,
        warningFailureKind: null,
      }),
    ).toMatchObject({
      kind: 'guard_required',
      title: '二级戒备',
      canRegisterGuard: true,
      warningCount: 1,
    });
    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: checkSyncDegradedSnapshot,
        warning: matchedWarning,
        matched: true,
      }),
    ).toMatchObject({
      kind: 'guard_required',
      label: '二级戒备 · 需戒备',
      tone: 'orange',
    });
    expectTriggerPresentation(
      {
        warningSnapshot: checkSyncDegradedSnapshot,
        warningStatus: 'ready',
        warningError: null,
      },
      { label: '二级戒备 · 1 · 检查待同步', tone: 'orange' },
      '检查待同步',
    );

    const degradedGuardSnapshot = createSnapshot({
      status: 'degraded',
      sourceState: 'degraded',
      guardDecisionState: 'stale',
      guardLevel: '二级戒备',
      matchedWarnings: [matchedWarning],
      sourceError: '天气预警快照暂时不可用',
    });
    expect(
      getWeatherWarningSummaryPresentation({
        warningSnapshot: degradedGuardSnapshot,
        warningStatus: 'error',
        warningError: '天气预警快照暂时不可用',
        warningFailureKind: 'unavailable',
      }),
    ).toMatchObject({
      kind: 'stale',
      title: '二级戒备 · 判定待更新',
      canRegisterGuard: false,
      warningCount: 1,
    });
    expect(
      getWeatherWarningDecisionPresentation({
        warningSnapshot: degradedGuardSnapshot,
        warning: matchedWarning,
        matched: true,
      }),
    ).toMatchObject({
      kind: 'stale',
      label: '判定待更新',
      tone: 'warning',
    });

    for (const presentation of [
      getWeatherWarningSummaryPresentation({
        warningSnapshot: createSnapshot({
          unmatchedWarnings: [unmatchedWarning],
        }),
        warningStatus: 'ready',
        warningError: null,
        warningFailureKind: null,
      }),
      getWeatherWarningSummaryPresentation({
        warningSnapshot: createSnapshot({
          status: 'degraded',
          sourceState: 'degraded',
          unmatchedWarnings: [unmatchedWarning],
          sourceError: '天气预警已获取，重保规则暂未同步',
        }),
        warningStatus: 'ready',
        warningError: null,
        warningFailureKind: null,
      }),
      getWeatherWarningSummaryPresentation({
        warningSnapshot: createSnapshot({ status: 'stale' }),
        warningStatus: 'error',
        warningError: '获取失败',
        warningFailureKind: 'unavailable',
      }),
      getWeatherWarningSummaryPresentation({
        warningSnapshot: null,
        warningStatus: 'error',
        warningError: '获取失败',
        warningFailureKind: 'unavailable',
      }),
    ]) {
      expect(presentation.canRegisterGuard).toBe(false);
    }
  });

  it('does not ask for registration or progress tracking when both weather guard features are paused', () => {
    const presentation = getWeatherWarningSummaryPresentation({
      warningSnapshot: createSnapshot({
        status: 'active',
        guardLevel: '三级戒备',
        matchedWarnings: [secondaryMatchedWarning],
        features: {
          registrationEnabled: false,
          progressNotificationsEnabled: false,
        },
      }),
      warningStatus: 'ready',
      warningError: null,
      warningFailureKind: null,
    });

    expect(presentation).toMatchObject({
      kind: 'guard_required',
      title: '三级戒备',
      description: '已匹配 1 条戒备规则，请按戒备要求执行',
    });
    expect(presentation.description).not.toContain('登记');
    expect(presentation.description).not.toContain('进度');
  });

  it('keeps degraded and stale snapshots visibly non-clear without borrowing the level-one danger tone', () => {
    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({
          status: 'degraded',
          guardDecisionState: 'stale',
          guardLevel: '一级戒备',
          matchedWarnings: [matchedWarning],
        }),
        warningStatus: 'error',
        warningError: '天气预警快照暂时不可用',
      },
      { label: '一级戒备 · 数据待更新', tone: 'warning' },
      '待更新',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({ status: 'stale' }),
        warningStatus: 'error',
        warningError: '天气预警快照暂时不可用',
      },
      { label: '预警数据待更新', tone: 'warning' },
      '待更新',
    );

    expectTriggerPresentation(
      {
        warningSnapshot: createSnapshot({
          status: 'degraded',
          sourceState: 'degraded',
          unmatchedWarnings: [unmatchedWarning],
          sourceError: '天气预警已获取，重保规则暂未同步',
        }),
        warningStatus: 'ready',
        warningError: null,
      },
      {
        label: '天气预警 · 1 · 戒备判定待同步',
        tone: 'warning',
      },
      '戒备判定待同步',
    );
  });

  it('does not repeat the trigger status badge inside the popover header', () => {
    const source = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      ),
      'utf8',
    );

    expect(source.match(/presentation\.label/g) || []).toHaveLength(1);
    expect(source).not.toContain('预警不可用');
  });

  it('keeps the compact entry in the trend-card header and adds one persistent summary', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).not.toContain('WeatherWarningCompactStatus');
    expect(source.match(/<WeatherWarningInfoPopover/g) || []).toHaveLength(3);
    expect(source.match(/<WeatherWarningSnapshotSummary/g) || []).toHaveLength(
      1,
    );
  });

  it('keeps the persistent summary focused on centered warnings and moves detailed actions out of it', () => {
    const summarySource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );
    const popoverSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      ),
      'utf8',
    );

    expect(summarySource).not.toContain('具体预警信息');
    expect(summarySource).not.toContain('<aside');
    expect(summarySource).not.toContain('summary.canRegisterGuard &&');
    expect(summarySource).not.toContain('提交戒备登记');
    expect(summarySource).toContain('<WeatherWarningGuardRelationDialog');
    expect(summarySource).toContain("kind === 'no_guard_required'");
    expect(summarySource).toContain('<ShieldCheck');
    expect(summarySource).toContain('warnings.slice(0, 2)');

    expect(popoverSource).toContain('summary.canRegisterGuard &&');
    expect(popoverSource).toContain(
      'getWeatherWarningCheckProgressPresentation',
    );
    expect(popoverSource).toContain('checkProgress.missingRegistrationText');
    expect(popoverSource).toContain('重保检查进度不可用');
    expect(popoverSource).not.toContain('重保检查进度待同步');
    expect(popoverSource).toContain('提交戒备登记');
  });

  it('keeps the persistent warning list centered and compact without restoring the removed decision column', () => {
    const summarySource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );
    const pageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(summarySource).not.toContain('min-h-[17rem]');
    expect(summarySource).not.toContain('mt-auto grid');
    expect(summarySource).not.toContain('lg:grid-cols-');
    expect(summarySource).toContain(
      'flex flex-1 items-center justify-center p-3',
    );
    expect(summarySource).toContain('mx-auto w-full max-w-lg');
    expect(summarySource).toContain('aria-label="天气预警信息"');
    expect(summarySource).toContain('grid gap-2 xl:grid-cols-2');
    expect(summarySource).toContain('xl:col-span-2');
    expect(summarySource).toContain(
      'mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1',
    );
    expect(summarySource).not.toContain('<div className="space-y-2">');
    expect(pageSource).toContain(
      'flex h-full min-w-0 self-stretch flex-col gap-3',
    );
  });

  it('supports a selected cached warning and scopes guard-only detail sections', () => {
    const popoverSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      ),
      'utf8',
    );

    expect(popoverSource).toMatch(/trigger\?:\s*ReactElement/u);
    expect(popoverSource).toMatch(
      /trigger\?:\s*ReactElement<\s*ComponentPropsWithRef<'button'>,\s*'button'\s*>/u,
    );
    expect(popoverSource).toMatch(/selectedWarningId\?:\s*string/u);
    expect(popoverSource).toMatch(/selectedWarningMatched\?:\s*boolean/u);
    expect(popoverSource).toMatch(
      /onRegisterGuard\?:\s*\(\s*warningId:\s*string,\s*returnFocusTarget\?:\s*HTMLButtonElement \| null,?\s*\)\s*=>\s*void/u,
    );
    expect(popoverSource).toContain(
      'selectedWarningId ?? warningSnapshot?.matchedWarnings[0]?.id',
    );
    expect(popoverSource).toContain(
      'if (!registrationWarningId || !onRegisterGuard) return',
    );
    expect(popoverSource).toMatch(
      /onRegisterGuard\(\s*registrationWarningId,\s*weatherWarningTriggerRef\.current,?\s*\)/u,
    );
    expect(popoverSource).not.toContain('WEATHER_WARNING_REGISTRATION_URL');
    expect(popoverSource).toContain('getWeatherWarningDetailScope(');
    expect(popoverSource).toContain('selectedWarningMatched,');
    expect(popoverSource).toContain('detailScope.warnings');
    expect(popoverSource).toContain('detailScope.description');
    expect(popoverSource).toContain('detailScope.showGuardDetails');
    expect(popoverSource).toContain('detailScope.canRegisterGuard');
    expect(popoverSource).toContain('detailScope.isSecondaryGuardWarning');
    expect(popoverSource).toContain('预警详情与戒备进展');
    expect(popoverSource).toContain('当前预警');
    expect(popoverSource).toContain('戒备进展归属于主预警');
    expect(popoverSource).toContain('const defaultTrigger = (');
    expect(popoverSource).toContain(
      'const resolvedTrigger = cloneElement(trigger ?? defaultTrigger',
    );
    expect(popoverSource).toContain('{resolvedTrigger}');
    expect(popoverSource).not.toContain('{...trigger?.props}');
    expect(popoverSource).not.toMatch(/\bfetch\s*\(/u);
    expect(popoverSource).not.toContain('useEffect');
  });

  it('opens each summary warning card through an accessible custom button trigger', () => {
    const summarySource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );

    expect(summarySource).toContain('<WeatherWarningInfoPopover');
    expect(summarySource).toMatch(/trigger=\{\s*<button/u);
    expect(summarySource).toContain('selectedWarningId={warning.id}');
    expect(summarySource).toContain('selectedWarningMatched={matched}');
    expect(summarySource).toContain('onRegisterGuard={onRegisterGuard}');
    expect(summarySource.match(/<button/gu) || []).toHaveLength(1);
    expect(summarySource).toContain('type="button"');
    expect(summarySource).toContain(
      'aria-label={`查看天气预警详情：${warning.title}`}',
    );
    expect(summarySource).toContain('w-full');
    expect(summarySource).toContain('text-left');
    expect(summarySource).toContain('hover:');
    expect(summarySource).toContain('active:');
    expect(summarySource).toContain('focus-visible:');
    expect(summarySource).not.toContain('<article');
    expect(summarySource).not.toMatch(/\bfetch\s*\(/u);
    expect(summarySource).not.toContain('useEffect');
  });

  it('announces only the compact asynchronous summary status politely', () => {
    const summarySource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );
    const liveRegion =
      summarySource.match(/<span[\s\S]*?role="status"[\s\S]*?<\/span>/u)?.[0] ??
      '';
    const warningButton =
      summarySource.match(/<button[\s\S]*?<\/button>/u)?.[0] ?? '';

    expect(liveRegion).toContain('aria-live="polite"');
    expect(liveRegion).toContain('aria-atomic="true"');
    expect(liveRegion).toContain('className="sr-only"');
    expect(liveRegion).toContain('{summary.title}');
    expect(liveRegion).toContain('{summary.description}');
    expect(warningButton).not.toContain('aria-live');
    expect(warningButton).not.toContain('role="status"');
  });

  it('disables summary spinner and transform motion when reduced motion is requested', () => {
    const summarySource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );
    const warningButton =
      summarySource.match(/<button[\s\S]*?<\/button>/u)?.[0] ?? '';

    expect(summarySource).toContain(
      "cn(className, 'animate-spin motion-reduce:animate-none')",
    );
    expect(warningButton).toContain('motion-reduce:transform-none');
    expect(warningButton).toContain('motion-reduce:transition-none');
  });

  it('disables popover control transitions when reduced motion is requested', () => {
    const popoverSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      ),
      'utf8',
    );

    expect(popoverSource.match(/transition-colors/gu) || []).toHaveLength(3);
    expect(
      popoverSource.match(/motion-reduce:transition-none/gu) || [],
    ).toHaveLength(3);
  });

  it('opens an accessible cached relation dialog from the summary header without fetching again', () => {
    const dialogPath = path.resolve(
      process.cwd(),
      'client/src/pages/MonthlySchedule/WeatherWarningGuardRelationDialog.tsx',
    );

    expect(fs.existsSync(dialogPath)).toBe(true);
    const dialogSource = fs.readFileSync(dialogPath, 'utf8');

    expect(dialogSource).toContain('<dialog');
    expect(dialogSource).toContain('.showModal()');
    expect(dialogSource).toContain('onClose={handleDialogClose}');
    expect(dialogSource).toContain('triggerRef.current?.focus()');
    expect(dialogSource).toContain('查看重保与戒备对应关系');
    expect(dialogSource).toContain('重保与戒备对应关系');
    expect(dialogSource).toContain('warning.guardLevel');
    expect(dialogSource).toContain('warningSnapshot.guardLevel');
    expect(dialogSource).toContain('warningSnapshot.actions');
    expect(dialogSource).toContain('getWeatherWarningRelationLabel');
    expect(dialogSource).toContain('<details');
    expect(dialogSource).toContain('tabIndex={0}');
    expect(dialogSource).toContain('aria-label="重保与戒备对应关系内容"');
    expect(dialogSource).toContain('backdrop:bg-slate-950/50');
    expect(dialogSource).not.toMatch(/\bfetch\s*\(/u);
    expect(dialogSource).not.toContain('useEffect');
  });
});
