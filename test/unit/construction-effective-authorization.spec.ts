import type {
  AccessPrincipal,
  AccessRole,
} from '../../shared/access-control.interface';
import type { BusinessAction } from '../../shared/business-permissions';
import {
  isConstructionAttachmentReplacementAllowed,
  isConstructionManualReviewAutoApprovalRole,
} from '../../shared/construction-manual-review-policy';
import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import {
  CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
  CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS,
} from '../../server/modules/duty-schedule/construction-management';

function principal(
  role: AccessRole = 'editor',
  denied: BusinessAction[] = [],
): AccessPrincipal {
  return {
    role,
    purchaseBuilding: null,
    accountId: 'synthetic-construction-reviewer',
    authorizationVersion: 1,
    effectiveAuthorization: {
      mode: 'independent',
      baseline: {
        nativeRole: null,
        pages: [],
        rules: [
          {
            id: 'synthetic-construction',
            module: 'construction',
            actions: ['create', 'update', 'delete', 'confirm'],
            effect: 'allow',
            buildings: null,
            specialties: null,
          },
        ],
      },
      overrides: {
        allowPages: [],
        denyPages: [],
        rules: denied.length
          ? [
              {
                id: 'synthetic-deny',
                module: 'construction',
                actions: denied,
                effect: 'deny',
                buildings: null,
                specialties: null,
              },
            ]
          : [],
      },
    },
  };
}

function service(): any {
  return Object.assign(Object.create(DutyScheduleService.prototype), {
    logger: { warn: jest.fn(), log: jest.fn() },
    constructionFollowupConfig: {
      tableId: 'synthetic-table',
      tableName: 'synthetic-followup',
    },
    isConstructionAiAuditEnabled: jest.fn(() => false),
    buildConstructionPermitManualReviewClearFields: jest.fn(() => ({})),
    buildInheritedDailyPermitFields: jest.fn(() => ({})),
    buildDailyPermitManualReviewAutoApprovalFieldsFromRecords: jest.fn(
      () => ({}),
    ),
    fetchBitableFieldMetas: jest.fn(async () => [
      { field_name: '挂牌隔离审核状态', type: 1 },
    ]),
    updateBitableRecordFields: jest.fn(async () => undefined),
    buildDailyPersonnelChecklistUploadFile: jest.fn(async () => null),
    syncConstructionFollowupPostSaveSideEffects: jest.fn(async () => undefined),
  });
}

const permitKey = Object.keys(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS)[0];
const permitConfig = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[permitKey];
const permitField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[permitKey];

function backfillInput(
  actor: AccessPrincipal,
  uploaded: Record<string, unknown> = {},
) {
  return {
    accessRole: actor.role,
    professionalPrincipal: actor,
    uploadedFollowupAttachmentFields: uploaded,
    existingFollowupRecord: { record_id: 'recSynthetic', fields: {} },
    existingFollowupFieldsForAttachments: {
      [permitField]: [{ file_token: 'synthetic-old' }],
    },
    retainedFollowupAttachmentFields: { [permitField]: [] },
    hasRetainedFollowupAttachmentFields: true,
    changedPermitFileKeys: [permitKey],
    permitValidFromByFileKey: {},
    permitValidUntilByFileKey: { [permitKey]: '2030-01-01' },
    inheritanceBlockedPermitFileKeys: [],
    relatedProjectFollowupRecords: [],
    targetRecordId: 'recSynthetic',
    referenceDate: new Date('2026-10-27T00:00:00Z'),
    savedFields: {},
  };
}

describe('construction automatic review keeps both role and effective action gates', () => {
  it('preserves legacy roles but respects effective confirm denial', () => {
    expect(isConstructionManualReviewAutoApprovalRole('editor')).toBe(true);
    expect(
      isConstructionManualReviewAutoApprovalRole('editor', {
        role: 'editor',
        purchaseBuilding: null,
      }),
    ).toBe(true);
    expect(
      isConstructionManualReviewAutoApprovalRole('editor', principal()),
    ).toBe(true);
    expect(
      isConstructionManualReviewAutoApprovalRole(
        'editor',
        principal('editor', ['confirm']),
      ),
    ).toBe(false);
    expect(
      isConstructionManualReviewAutoApprovalRole('guest', principal('guest')),
    ).toBe(false);
    expect(
      isConstructionManualReviewAutoApprovalRole(
        'professional_admin',
        principal('professional_admin'),
      ),
    ).toBe(false);
  });

  it('does not stamp a newly uploaded permit when confirmation is denied', () => {
    const instance = service();
    const fields = instance.buildConstructionFollowupAttachmentBackfillFields(
      backfillInput(principal('editor', ['confirm']), {
        [permitField]: [{ file_token: 'synthetic-new' }],
      }),
    );
    expect(fields[permitConfig.reviewField]).toBeUndefined();
    expect(fields[permitField]).toEqual([
      { file_token: 'synthetic-old' },
      { file_token: 'synthetic-new' },
    ]);
  });

  it('still stamps a permitted replacement with its actual validity date', () => {
    const fields = service().buildConstructionFollowupAttachmentBackfillFields(
      backfillInput(principal(), {
        [permitField]: [{ file_token: 'synthetic-new' }],
      }),
    );
    expect(fields[permitConfig.reviewField]).toBe('通过');
    expect(fields[permitConfig.fingerprintField]).toContain('2030-01-01');
    expect(fields[permitField]).toEqual([{ file_token: 'synthetic-new' }]);
  });

  it('refuses isolation auto-review before reading metadata when confirm is denied', async () => {
    const instance = service();
    await expect(
      instance.buildConstructionIsolationManualReviewAutoApprovalFields({
        accessRole: 'editor',
        professionalPrincipal: principal('editor', ['confirm']),
        fields: {
          [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
            { file_token: 'synthetic-photo' },
          ],
        },
        followupAppToken: 'synthetic-app',
        tenantAccessToken: 'synthetic-token',
      }),
    ).resolves.toEqual({});
    expect(instance.fetchBitableFieldMetas).not.toHaveBeenCalled();
    expect(instance.updateBitableRecordFields).not.toHaveBeenCalled();
  });

  it('allows the same isolation branch with an authorized original reviewer role', async () => {
    const instance = service();
    const fields =
      await instance.buildConstructionIsolationManualReviewAutoApprovalFields({
        accessRole: 'editor',
        professionalPrincipal: principal(),
        fields: {
          [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
            { file_token: 'synthetic-photo' },
          ],
        },
        followupAppToken: 'synthetic-app',
        tenantAccessToken: 'synthetic-token',
      });
    expect(fields).toEqual({ 挂牌隔离审核状态: '通过' });
    expect(instance.fetchBitableFieldMetas).toHaveBeenCalledTimes(1);
  });

  it.each(['update', 'delete'] as const)(
    'retains existing files when %s is explicitly denied',
    (action) => {
      const actor = principal('professional_admin', [action]);
      expect(
        isConstructionAttachmentReplacementAllowed(actor.role, actor),
      ).toBe(false);
      const fields =
        service().buildConstructionFollowupAttachmentBackfillFields(
          backfillInput(actor, {
            [permitField]: [{ file_token: 'synthetic-new' }],
          }),
        );
      expect(fields[permitField]).toEqual([
        { file_token: 'synthetic-old' },
        { file_token: 'synthetic-new' },
      ]);
      expect(
        isConstructionAttachmentReplacementAllowed(
          'editor',
          principal('editor', [action]),
          true,
        ),
      ).toBe(false);
    },
  );

  it('does not perform no-upload post-save automatic review under a denied confirmation', async () => {
    const instance = service();
    await instance.runConstructionFollowupPostSaveSync({
      accessRole: 'editor',
      professionalPrincipal: principal('editor', ['confirm']),
      normalized: {
        permitOnlyUpload: false,
        permitValidUntilByFileKey: { [permitKey]: '2030-01-01' },
      },
      savedFields: { [permitField]: [{ file_token: 'synthetic-old' }] },
      existingFields: {},
      existingFieldsForAttachments: {},
      changedNormalizedFiles: [],
      normalizedFiles: [],
      generatedChecklistFile: null,
      changedPermitFileKeys: [permitKey],
    });
    expect(instance.fetchBitableFieldMetas).not.toHaveBeenCalled();
    expect(instance.updateBitableRecordFields).not.toHaveBeenCalled();
    expect(
      instance.syncConstructionFollowupPostSaveSideEffects,
    ).toHaveBeenCalledTimes(1);
  });

  it('freezes the whole accepted authorization for queued work without sharing mutable policy objects', async () => {
    const instance = service(),
      actor = principal('editor', ['confirm']);
    instance.ensureQueuedConstructionFollowupSyncTask = jest.fn();
    instance.persistQueuedConstructionFollowupSubmitTask = jest.fn(
      async () => undefined,
    );
    instance.scheduleQueuedConstructionFollowupSubmitRetry = jest.fn();
    await instance.enqueueConstructionFollowupSubmitTask(
      { constructionRecordId: 'recSynthetic' },
      [],
      'editor',
      '',
      actor,
    );
    const queued =
      instance.persistQueuedConstructionFollowupSubmitTask.mock.calls[0][0];
    actor.effectiveAuthorization!.overrides.rules = [];
    expect(queued.professionalPrincipal).not.toBe(actor);
    expect(queued.professionalPrincipal.effectiveAuthorization).not.toBe(
      actor.effectiveAuthorization,
    );
    expect(
      isConstructionManualReviewAutoApprovalRole(
        'editor',
        queued.professionalPrincipal,
      ),
    ).toBe(false);
    expect(isConstructionManualReviewAutoApprovalRole('editor', actor)).toBe(
      true,
    );
  });
});
