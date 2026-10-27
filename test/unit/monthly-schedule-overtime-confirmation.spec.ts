import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  beginOvertimeConfirmationSubmission,
  calculateOvertimeActualEndAt,
  cancelOvertimeConfirmationDraft,
  createOvertimeConfirmationState,
  failOvertimeConfirmationSubmission,
  updateOvertimeConfirmationDraft,
  validateOvertimeConfirmationDraft,
  type OvertimeConfirmationDetail,
} from '../../client/src/pages/MonthlySchedule/overtime-confirmation-state';
import {
  beginOvertimeConfirmationDetailLoad,
  consumeOvertimeConfirmationDeepLink,
  createOvertimeConfirmationDetailLoadState,
  resolveOvertimeConfirmationDetailLoad,
} from '../../client/src/pages/MonthlySchedule/overtime-confirmation-deep-link';
import {
  createOvertimeConfirmationCompletion,
  exitOvertimeConfirmationPage,
} from '../../client/src/pages/MonthlySchedule/overtime-confirmation-completion';

const detail = (
  patch: Partial<OvertimeConfirmationDetail> = {},
): OvertimeConfirmationDetail => ({
  recordId: 'recOvertime12345678',
  staffName: '张三',
  building: 'A楼',
  position: '运维值班员',
  plannedStartAt: '2026-08-11T09:00:00+08:00',
  plannedEndAt: '2026-08-11T18:00:00+08:00',
  plannedHours: 8,
  actualStartAt: null,
  actualHours: null,
  disposition: null,
  ...patch,
});

describe('monthly schedule overtime confirmation', () => {
  it('recalculates hours when editing the end and retains the selected lunch boundary on retry', () => {
    const state = createOvertimeConfirmationState(detail());
    const patch = {
      actualStartAt: '2026-08-11T11:00',
      actualEndAt: '2026-08-11T13:00',
      disposition: 'overtime_pay' as const,
    };
    const edited = updateOvertimeConfirmationDraft(state, patch);
    expect(edited.draft).toEqual(
      expect.objectContaining({
        actualHours: '1',
        actualEndAt: patch.actualEndAt,
      }),
    );
    const submitted = beginOvertimeConfirmationSubmission(edited, detail());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.request.actualEndAt).toBe('2026-08-11T13:00:00+08:00');
    expect(
      failOvertimeConfirmationSubmission(submitted.state, '请求失败').draft,
    ).toEqual(edited.draft);
  });

  it('links a cross-day end to hours and keeps hours-to-end editing available', () => {
    const patch = {
      actualStartAt: '2026-10-02T16:00',
      actualEndAt: '2026-10-03T00:00',
    };
    const edited = updateOvertimeConfirmationDraft(
      createOvertimeConfirmationState(detail()),
      patch,
    );
    expect(edited.draft).toEqual(
      expect.objectContaining({
        actualHours: '8',
        actualEndAt: patch.actualEndAt,
      }),
    );
    expect(
      updateOvertimeConfirmationDraft(edited, { actualHours: '2' }).draft,
    ).toEqual(
      expect.objectContaining({
        actualHours: '2',
        actualEndAt: '2026-10-02T18:00',
      }),
    );
  });

  it.each(['2026-08-11T08:00', '2026-08-11T10:30', '', '2026-09-11T10:00'])(
    'rejects an invalid edited end: %s',
    (actualEndAt) => {
      const patch = { actualEndAt };
      const edited = updateOvertimeConfirmationDraft(
        createOvertimeConfirmationState(detail()),
        patch,
      );
      expect(
        validateOvertimeConfirmationDraft(edited.draft).actualEndAt,
      ).toBeDefined();
      expect(beginOvertimeConfirmationSubmission(edited, detail()).ok).toBe(
        false,
      );
    },
  );

  it('shows a terminal success result for a zero-hour cancellation', () => {
    expect(
      createOvertimeConfirmationCompletion({
        recordId: 'recOvertime12345678',
        actualStartAt: '2026-08-11T09:00:00+08:00',
        actualEndAt: '2026-08-11T09:00:00+08:00',
        actualHours: 0,
        disposition: null,
      }),
    ).toEqual({
      title: '取消加班提交成功',
      message: '取消结果已受理，正在退出…',
      resultLabel: '已取消加班',
      dispositionLabel: '无需处置',
    });
  });

  it('exits the confirmation WebView and falls back to browser history', () => {
    const closedTarget = {
      closed: false,
      close: jest.fn(function close(this: { closed: boolean }) {
        this.closed = true;
      }),
      history: { back: jest.fn() },
    };
    expect(exitOvertimeConfirmationPage(closedTarget)).toBe('closed');
    expect(closedTarget.history.back).not.toHaveBeenCalled();

    const historyTarget = {
      closed: false,
      close: jest.fn(),
      history: { back: jest.fn() },
    };
    expect(exitOvertimeConfirmationPage(historyTarget)).toBe('history');
    expect(historyTarget.close).toHaveBeenCalledTimes(1);
    expect(historyTarget.history.back).toHaveBeenCalledTimes(1);
  });

  it('prefills actual values first and otherwise falls back to planned values', () => {
    expect(createOvertimeConfirmationState(detail()).draft).toEqual({
      actualStartAt: '2026-08-11T09:00',
      actualEndAt: '2026-08-11T18:00',
      actualHours: '8',
      disposition: '',
    });

    expect(
      createOvertimeConfirmationState(
        detail({
          actualStartAt: '2026-08-11T10:00:00+08:00',
          actualHours: 4,
          disposition: 'overtime_pay',
        }),
      ).draft,
    ).toEqual({
      actualStartAt: '2026-08-11T10:00',
      actualEndAt: '2026-08-11T15:00',
      actualHours: '4',
      disposition: 'overtime_pay',
    });

    expect(
      createOvertimeConfirmationState(
        detail({
          actualStartAt: '2026-08-11T10:00:00+08:00',
          actualHours: 0,
          disposition: null,
        }),
      ).draft,
    ).toEqual({
      actualStartAt: '2026-08-11T10:00',
      actualEndAt: '2026-08-11T10:00',
      actualHours: '0',
      disposition: '',
    });
  });

  it('normalizes an explicitly zoned timestamp to Shanghai wall time', () => {
    const state = createOvertimeConfirmationState(
      detail({ plannedStartAt: '2026-08-11T01:00:00.000Z' }),
    );

    expect(state.draft.actualStartAt).toBe('2026-08-11T09:00');
  });

  it('ignores a historical disposition when existing actual hours are zero', () => {
    const state = createOvertimeConfirmationState(
      detail({
        actualHours: 0,
        disposition: 'overtime_pay',
      }),
    );

    expect(state.draft.actualHours).toBe('0');
    expect(state.draft.disposition).toBe('');
  });

  it('calculates the read-only actual end from payable hours and skips lunch', () => {
    expect(calculateOvertimeActualEndAt('2026-08-11T09:00', '8')).toBe(
      '2026-08-11T18:00',
    );
    expect(calculateOvertimeActualEndAt('2026-08-11T10:00', '4')).toBe(
      '2026-08-11T15:00',
    );
    expect(calculateOvertimeActualEndAt('2026-08-11T18:00', '15')).toBe(
      '2026-08-12T09:00',
    );
    expect(calculateOvertimeActualEndAt('2026-08-11T22:00', '5')).toBe(
      '2026-08-12T03:00',
    );
    expect(calculateOvertimeActualEndAt('2026-08-11T22:00', '0')).toBe(
      '2026-08-11T22:00',
    );
    expect(calculateOvertimeActualEndAt('2026-08-11T22:00', '72')).toBe(
      '2026-08-15T01:00',
    );
    expect(calculateOvertimeActualEndAt('invalid', '4')).toBe('');
  });

  it('accepts zero hours without a disposition and requires one for positive hours', () => {
    expect(
      validateOvertimeConfirmationDraft({
        actualStartAt: '2026-08-11T09:00',
        actualHours: '0',
        disposition: '',
      }),
    ).toEqual({});

    expect(
      validateOvertimeConfirmationDraft({
        actualStartAt: '2026-08-11T09:00',
        actualHours: '1',
        disposition: '',
      }),
    ).toEqual({ disposition: '请选择加班工时处置方式' });
  });

  it.each(['-1', '0.5', '73'])(
    'rejects actual hours outside the zero-to-72 integer range: %s',
    (actualHours) => {
      expect(
        validateOvertimeConfirmationDraft({
          actualStartAt: '2026-08-11T09:00',
          actualHours,
          disposition: 'compensatory_leave',
        }),
      ).toEqual({ actualHours: '实际加班工时必须为 0 至 72 的整数' });
    },
  );

  it('still rejects invalid starts and non-finite hours', () => {
    expect(
      validateOvertimeConfirmationDraft({
        actualStartAt: '',
        actualHours: '0',
        disposition: '',
      }),
    ).toEqual({ actualStartAt: '请选择有效的实际开始时间' });

    expect(
      validateOvertimeConfirmationDraft({
        actualStartAt: '2026-08-11T09:00',
        actualHours: 'Infinity',
        disposition: 'compensatory_leave',
      }),
    ).toEqual({ actualHours: '实际加班工时必须为 0 至 72 的整数' });

    expect(
      validateOvertimeConfirmationDraft({
        actualStartAt: '2026-08-11T09:30',
        actualHours: '0.01',
        disposition: 'compensatory_leave',
      }),
    ).toEqual({
      actualStartAt: '请选择有效的实际开始时间',
      actualHours: '实际加班工时必须为 0 至 72 的整数',
    });
  });

  it('reports only the hours error when actual hours are blank', () => {
    expect(
      validateOvertimeConfirmationDraft({
        actualStartAt: '2026-08-11T09:00',
        actualHours: '   ',
        disposition: '',
      }),
    ).toEqual({ actualHours: '实际加班工时必须为 0 至 72 的整数' });
  });

  it('clears disposition after merging a zero-equivalent hours patch', () => {
    const state = createOvertimeConfirmationState(
      detail({
        actualHours: 3,
        disposition: 'compensatory_leave',
      }),
    );

    const updated = updateOvertimeConfirmationDraft(state, {
      actualHours: '00',
      disposition: 'overtime_pay',
    });

    expect(updated.draft).toMatchObject({
      actualHours: '00',
      disposition: '',
    });
  });

  it('switches a draft to the local zero-hour cancellation state without mutating it', () => {
    const original = {
      actualStartAt: '2026-08-11T13:00',
      actualHours: '3',
      disposition: 'compensatory_leave' as const,
    };

    expect(cancelOvertimeConfirmationDraft(original)).toEqual({
      actualStartAt: '2026-08-11T13:00',
      actualEndAt: '2026-08-11T13:00',
      actualHours: '0',
      disposition: '',
    });
    expect(original).toEqual({
      actualStartAt: '2026-08-11T13:00',
      actualHours: '3',
      disposition: 'compensatory_leave',
    });
  });

  it('creates a timezone-explicit immutable submission and blocks duplicate clicks', () => {
    let state = createOvertimeConfirmationState(detail());
    state = updateOvertimeConfirmationDraft(state, {
      actualStartAt: '2026-08-11T22:00',
      actualHours: '5',
      disposition: 'overtime_pay',
    });

    const first = beginOvertimeConfirmationSubmission(state, detail());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected a valid submission');
    expect(first.request).toEqual({
      recordId: 'recOvertime12345678',
      actualStartAt: '2026-08-11T22:00:00+08:00',
      actualEndAt: '2026-08-12T03:00:00+08:00',
      actualHours: 5,
      disposition: 'overtime_pay',
    });
    expect(Object.isFrozen(first.request)).toBe(true);

    const duplicate = beginOvertimeConfirmationSubmission(
      first.state,
      detail(),
    );
    expect(duplicate).toEqual({ ok: false, state: first.state, errors: {} });
  });

  it('submits zero hours as cancellation with equal start/end and null disposition', () => {
    const edited = updateOvertimeConfirmationDraft(
      createOvertimeConfirmationState(detail()),
      {
        actualStartAt: '2026-08-11T13:00',
        actualHours: '0',
        disposition: '',
      },
    );

    const started = beginOvertimeConfirmationSubmission(edited, detail());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected a valid cancellation');
    expect(started.request).toEqual({
      recordId: 'recOvertime12345678',
      actualStartAt: '2026-08-11T13:00:00+08:00',
      actualEndAt: '2026-08-11T13:00:00+08:00',
      actualHours: 0,
      disposition: null,
    });
  });

  it('restores the exact submitted draft after a failed request', () => {
    const edited = updateOvertimeConfirmationDraft(
      createOvertimeConfirmationState(detail()),
      {
        actualStartAt: '2026-08-11T13:00',
        actualHours: '3',
        disposition: 'compensatory_leave',
      },
    );
    const started = beginOvertimeConfirmationSubmission(edited, detail());
    if (!started.ok) throw new Error('expected a valid submission');

    const failed = failOvertimeConfirmationSubmission(
      {
        ...started.state,
        draft: {
          actualStartAt: '2099-01-01T00:00',
          actualHours: '99',
          disposition: 'overtime_pay',
        },
      },
      '网络超时，请重试',
    );

    expect(failed.phase).toBe('editing');
    expect(failed.draft).toEqual(edited.draft);
    expect(failed.error).toBe('网络超时，请重试');
    expect(failed.submissionSnapshot).toBeNull();
  });

  it('restores a zero-hour cancellation draft after a failed request', () => {
    const edited = updateOvertimeConfirmationDraft(
      createOvertimeConfirmationState(detail()),
      {
        actualStartAt: '2026-08-11T13:00',
        actualHours: '0',
        disposition: '',
      },
    );
    const started = beginOvertimeConfirmationSubmission(edited, detail());
    if (!started.ok) throw new Error('expected a valid cancellation');

    const failed = failOvertimeConfirmationSubmission(
      started.state,
      '网络超时，请重试',
    );

    expect(failed.draft).toEqual(edited.draft);
    expect(failed.error).toBe('网络超时，请重试');
  });

  it('renders editable start, hours and end with mobile-safe layout', () => {
    const source = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeConfirmationDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('实际开始时间');
    expect(source).toContain('实际加班工时');
    expect(source).toContain('实际结束时间');
    expect(source).not.toContain('readOnly');
    expect(source).toContain(
      'updateDraft({ actualEndAt: event.target.value })',
    );
    expect(source).toContain('调休');
    expect(source).toContain('加班费');
    expect(source).toContain('取消加班');
    expect(source).toContain('关闭');
    expect(source).toContain('确认取消加班');
    expect(source).toContain('无需处置');
    expect(source).toContain('min="0"');
    expect(source).toContain('cancelOvertimeConfirmationDraft');
    expect(source).toContain('max-sm:max-w-[calc(100%-2rem)]');
    expect(source).toContain("disabled={state.phase === 'submitting'}");
    expect(source).toContain('step={3600}');
    expect(source).toContain('submissionRevisionRef');
    expect(source).toContain(
      'currentRecordIdRef.current !== submittedRecordId',
    );
  });

  it('consumes the signed fragment once and immediately removes credentials from the address bar', () => {
    const replacements: Array<{ state: unknown; url: string }> = [];
    const historyState = { navigation: 'kept' };
    const browser = {
      location: {
        href: 'https://www.sm.sjhl.online:3001/monthly-schedule?from=card#keep=1&overtimeConfirmation=1&recordId=rec_123&ticket=payload.signature',
      },
      history: {
        state: historyState,
        replaceState(state: unknown, _title: string, url: string) {
          replacements.push({ state, url });
        },
      },
    };

    expect(consumeOvertimeConfirmationDeepLink(browser)).toEqual({
      kind: 'ready',
      recordId: 'rec_123',
      ticket: 'payload.signature',
    });
    expect(replacements).toEqual([
      {
        state: historyState,
        url: 'https://www.sm.sjhl.online:3001/monthly-schedule?from=card#keep=1',
      },
    ]);
    expect(replacements[0].url).not.toContain('ticket');
    expect(replacements[0].url).not.toContain('recordId');
  });

  it('consumes a mobile-safe signed query once and preserves unrelated URL state', () => {
    const replacements: Array<{ state: unknown; url: string }> = [];
    const historyState = { navigation: 'kept' };
    const browser = {
      location: {
        href: 'https://www.sm.sjhl.online:3001/overtime-confirmation?keep=1&overtimeConfirmation=1&recordId=rec_123&ticket=payload.signature#anchor=kept',
      },
      history: {
        state: historyState,
        replaceState(state: unknown, _title: string, url: string) {
          replacements.push({ state, url });
        },
      },
    };

    expect(consumeOvertimeConfirmationDeepLink(browser)).toEqual({
      kind: 'ready',
      recordId: 'rec_123',
      ticket: 'payload.signature',
    });
    expect(replacements).toEqual([
      {
        state: historyState,
        url: 'https://www.sm.sjhl.online:3001/overtime-confirmation?keep=1#anchor=kept',
      },
    ]);
  });

  it('registers a standalone confirmation route outside the monthly schedule bundle', () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/app.tsx'),
      'utf8',
    );

    expect(appSource).toContain("import('./pages/OvertimeConfirmation')");
    expect(appSource).toContain('path="/overtime-confirmation"');
    expect(appSource).toContain('element={<OvertimeConfirmationPage />}');
    expect(appSource.indexOf('path="/overtime-confirmation"')).toBeLessThan(
      appSource.indexOf('<Route element={<RouteAccessGuard />}>'),
    );

    const htmlSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client/index.html'),
      'utf8',
    );
    expect(htmlSource).toMatch(
      /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/u,
    );

    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['build:client']).toContain(
      'rspack.overtime-confirmation.config.js',
    );

    const standaloneEntry = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/overtime-confirmation-entry.tsx'),
      'utf8',
    );
    const standaloneConfig = fs.readFileSync(
      path.resolve(process.cwd(), 'rspack.overtime-confirmation.config.js'),
      'utf8',
    );
    const standaloneStyles = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/overtime-confirmation.css'),
      'utf8',
    );
    const standaloneHtml = fs.readFileSync(
      path.resolve(process.cwd(), 'client/overtime-confirmation.html'),
      'utf8',
    );
    expect(standaloneEntry).toContain('OvertimeConfirmationPage');
    expect(standaloneEntry).not.toContain("import './polyfills'");
    expect(standaloneEntry).toContain("import './overtime-confirmation.css'");
    expect(standaloneConfig).not.toContain('fullstack-rspack-preset');
    expect(standaloneConfig).toContain('HtmlRspackPlugin');
    expect(standaloneConfig).toContain('overtime-confirmation.html');
    expect(standaloneStyles).not.toMatch(/fonts\.googleapis|tailwind-theme/u);
    expect(standaloneStyles).toContain('--color-success');
    expect(standaloneHtml).toContain('data-overtime-confirmation-bootstrap');
    expect(standaloneHtml).toContain('正在读取加班记录');
    expect(standaloneEntry).not.toMatch(
      /AccessProvider|RoutesComponent|GlobalAppShell|MonthlySchedule\/index/u,
    );

    const viewSource = fs.readFileSync(
      path.resolve(process.cwd(), 'server/modules/view/view.controller.ts'),
      'utf8',
    );
    expect(viewSource).toContain("@Get('/overtime-confirmation')");
    expect(viewSource).toContain("@Render('overtime-confirmation/index')");
  });

  it('scrubs an invalid confirmation fragment without retaining its ticket', () => {
    const replacements: string[] = [];
    const browser = {
      location: {
        href: 'https://www.sm.sjhl.online:3001/monthly-schedule#overtimeConfirmation=1&recordId=rec_123&ticket=not-a-signed-ticket',
      },
      history: {
        state: null,
        replaceState(_state: unknown, _title: string, url: string) {
          replacements.push(url);
        },
      },
    };

    expect(consumeOvertimeConfirmationDeepLink(browser)).toEqual({
      kind: 'invalid',
      message: '加班确认链接无效，请从最新飞书卡片重新打开',
    });
    expect(replacements).toEqual([
      'https://www.sm.sjhl.online:3001/monthly-schedule',
    ]);
  });

  it('ignores an old detail response after switching to another record', () => {
    const initial = createOvertimeConfirmationDetailLoadState();
    const loadingA = beginOvertimeConfirmationDetailLoad(initial, {
      recordId: 'rec_A',
      ticket: 'payloadA.signatureA',
    });
    const loadingB = beginOvertimeConfirmationDetailLoad(loadingA, {
      recordId: 'rec_B',
      ticket: 'payloadB.signatureB',
    });

    const afterStaleA = resolveOvertimeConfirmationDetailLoad(
      loadingB,
      loadingA.revision,
      'rec_A',
      detail({ recordId: 'rec_A', staffName: '甲' }),
    );
    expect(afterStaleA).toBe(loadingB);

    const afterCurrentB = resolveOvertimeConfirmationDetailLoad(
      afterStaleA,
      loadingB.revision,
      'rec_B',
      detail({ recordId: 'rec_B', staffName: '乙' }),
    );
    expect(afterCurrentB).toMatchObject({
      phase: 'ready',
      revision: loadingB.revision,
      detail: { recordId: 'rec_B', staffName: '乙' },
    });
  });

  it('uses memory-only ticket headers for both detail and submit requests', () => {
    const apiSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/overtime-confirmation-api.ts',
      ),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeConfirmationDeepLinkHost.tsx',
      ),
      'utf8',
    );
    const completionSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'client/src/pages/MonthlySchedule/overtime-confirmation-completion.ts',
      ),
      'utf8',
    );
    const pageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(apiSource).toContain('getOvertimeConfirmationDetail');
    expect(apiSource).toContain('submitOvertimeConfirmation');
    expect(
      apiSource.match(/'X-Overtime-Confirmation-Ticket': ticket/g),
    ).toHaveLength(2);
    expect(apiSource).toContain("'X-Idempotency-Key': idempotencyKey");
    expect(hostSource).toContain("from './overtime-confirmation-api'");
    expect(hostSource).not.toContain("from '@/api'");
    expect(hostSource).toContain('consumeOvertimeConfirmationDeepLink');
    expect(hostSource).toContain("window.addEventListener('hashchange'");
    expect(hostSource).toContain('AbortController');
    expect(hostSource).not.toMatch(/localStorage|sessionStorage|logger\./u);
    expect(pageSource).toContain('<OvertimeConfirmationDeepLinkHost />');
    expect(completionSource).toContain('取消加班提交成功');
    expect(hostSource).toContain('提交成功，即将退出');
    expect(hostSource).toContain('exitOvertimeConfirmationPage(window)');
    expect(hostSource).toContain('完成并退出');
    expect(hostSource).toContain('completion === null');
    expect(hostSource).toContain('max-w-none bg-card');
  });
});
