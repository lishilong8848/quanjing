import {
  buildManualReviewScope,
  confirmScopedManualReviewBatch,
  selectScopedPendingManualReviews,
  settleScopedManualReviewBatch,
  upsertScopedPendingManualReview,
} from '../../client/src/pages/ConstructionManagement/scoped-manual-review-registry';

interface TestManualReview {
  id: string;
  kind: 'permit' | 'isolation';
  decision: 'valid' | 'invalid';
}

function review(
  id: string,
  kind: TestManualReview['kind'] = 'permit',
): TestManualReview {
  return {
    id,
    kind,
    decision: 'valid',
  };
}

describe('施工管理 scoped manual review registry', () => {
  it('按项目、跟进记录和审核类型隔离，切换或关闭弹窗不会丢失待同步项', () => {
    const projectAPermit = buildManualReviewScope(
      'project-a',
      'followup-a',
      'permit',
    );
    const projectAIsolation = buildManualReviewScope(
      'project-a',
      'followup-a',
      'isolation',
    );
    const projectBPermit = buildManualReviewScope(
      'project-b',
      'followup-b',
      'permit',
    );

    let registry = upsertScopedPendingManualReview(
      [],
      projectAPermit,
      review('permit-a'),
    );
    registry = upsertScopedPendingManualReview(
      registry,
      projectAIsolation,
      review('isolation-a', 'isolation'),
    );
    registry = upsertScopedPendingManualReview(
      registry,
      projectBPermit,
      review('permit-b'),
    );

    expect(
      selectScopedPendingManualReviews(registry, projectAPermit).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['permit-a']);
    expect(
      selectScopedPendingManualReviews(registry, projectAIsolation).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['isolation-a']);
    expect(
      selectScopedPendingManualReviews(registry, projectBPermit).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['permit-b']);

    // 弹窗关闭只会清理局部 UI；页面级 registry 不应被任何 scope 查询改写。
    expect(registry).toHaveLength(3);
  });

  it('部分成功先进入待确认，失败项回并原 scope，普通读取失败时都保留', () => {
    const scope = buildManualReviewScope('project-a', 'followup-a', 'permit');
    const otherScope = buildManualReviewScope(
      'project-b',
      'followup-b',
      'permit',
    );
    let submitted = upsertScopedPendingManualReview(
      [],
      scope,
      review('permit-success'),
    );
    submitted = upsertScopedPendingManualReview(
      submitted,
      scope,
      review('permit-failed'),
    );
    const otherProject = upsertScopedPendingManualReview(
      [],
      otherScope,
      review('permit-other'),
    );

    const settled = settleScopedManualReviewBatch(otherProject, {
      succeeded: [submitted[0]],
      failed: [submitted[1]],
    });

    expect(
      selectScopedPendingManualReviews(settled, scope).map(
        ({ review: item, status }) => [item.id, status],
      ),
    ).toEqual([
      ['permit-success', 'awaiting-confirmation'],
      ['permit-failed', 'pending'],
    ]);
    expect(
      selectScopedPendingManualReviews(settled, otherScope).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['permit-other']);

    const refreshFailed = confirmScopedManualReviewBatch(
      settled,
      [submitted[0]],
      false,
    );
    expect(
      selectScopedPendingManualReviews(refreshFailed, scope).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['permit-success', 'permit-failed']);

    const refreshConfirmed = confirmScopedManualReviewBatch(
      refreshFailed,
      [submitted[0]],
      true,
    );
    expect(
      selectScopedPendingManualReviews(refreshConfirmed, scope).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['permit-failed']);
    expect(
      selectScopedPendingManualReviews(refreshConfirmed, otherScope).map(
        (entry) => entry.review.id,
      ),
    ).toEqual(['permit-other']);
  });

  it('旧请求结算不会覆盖同 scope 同 id 的新人工审核选择', () => {
    const scope = buildManualReviewScope('project-a', 'followup-a', 'permit');
    const original = upsertScopedPendingManualReview(
      [],
      scope,
      review('permit-a'),
    );
    const changedReview = {
      ...original[0].review,
      decision: 'invalid' as const,
    };
    const current = upsertScopedPendingManualReview(
      original,
      scope,
      changedReview,
    );

    const settled = settleScopedManualReviewBatch(current, {
      succeeded: [original[0]],
      failed: [],
    });
    const confirmed = confirmScopedManualReviewBatch(
      settled,
      [original[0]],
      true,
    );

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].revision).toBeGreaterThan(original[0].revision);
    expect(confirmed[0].review.decision).toBe('invalid');
    expect(confirmed[0].status).toBe('pending');
  });
});
