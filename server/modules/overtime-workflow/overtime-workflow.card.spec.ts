import {
  buildOvertimeApprovalCard,
  buildOvertimeApprovalResolvedCard,
  buildOvertimeConfirmationCard,
  buildOvertimeConfirmationResolvedCard,
  buildOvertimeSourceDeletedCard,
} from './overtime-workflow.card';
import type { OvertimeApplicationSnapshot } from './overtime-workflow.types';

const snapshot: OvertimeApplicationSnapshot = {
  recordId: 'rec_overtime_001',
  applicantName: '示例人员008',
  applicantOpenId: 'ou_zhangsan',
  building: 'A楼',
  position: '运维值班员',
  plannedStartAt: '2026-08-13 18:00',
  plannedEndAt: '2026-08-14 02:00',
  plannedHours: 8,
  reason: '配合设备维护',
};

describe('overtime workflow cards', () => {
  it('首审卡包含完整申请信息以及同意/驳回两个回调动作', () => {
    const card = buildOvertimeApprovalCard(snapshot);
    const serialized = JSON.stringify(card);
    const buttons = collectButtons(card);

    expect(serialized).toContain('示例人员008');
    expect(serialized).toContain('A楼 / 运维值班员');
    expect(serialized).toContain('2026-08-13 18:00');
    expect(serialized).toContain('2026-08-14 02:00');
    expect(serialized).toContain('8 小时');
    expect(serialized).toContain('配合设备维护');
    expect(buttons).toHaveLength(2);
    expect(buttons.map(callbackAction)).toEqual(['approve', 'reject']);
    expect(buttons.map(callbackValue)).toEqual([
      { version: 1, action: 'approve', recordId: 'rec_overtime_001' },
      { version: 1, action: 'reject', recordId: 'rec_overtime_001' },
    ]);
  });

  it('renders approval terminal cards with visible disabled choices and no callback', () => {
    const approved = buildOvertimeApprovalResolvedCard(snapshot, {
      action: 'approve',
      actorName: '示例人员009',
      resolvedAt: '2026-08-12 18:00',
    });
    const rejected = buildOvertimeApprovalResolvedCard(snapshot, {
      action: 'reject',
      actorName: '示例人员009',
      resolvedAt: '2026-08-12 18:00',
    });
    for (const [card, title] of [
      [approved, '加班申请审批通过'],
      [rejected, '加班申请审批驳回'],
    ] as const) {
      const serialized = JSON.stringify(card);
      const buttons = collectButtons(card);

      expect(serialized).toContain(title);
      expect(buttons).toHaveLength(2);
      expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
      expect(buttons.map((button) => button.type)).toEqual([
        'default',
        'default',
      ]);
      expect(buttons.every((button) => !('behaviors' in button))).toBe(true);
      expect(serialized).not.toContain('callback');
    }
  });

  it('renders confirmation terminal cards without stale actions', () => {
    const confirmed = buildOvertimeConfirmationResolvedCard(snapshot, {
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualEndAt: '2026-08-13T16:00:00+08:00',
      actualHours: 6,
      disposition: '加班费',
      confirmedAt: '2026-08-14T09:00:00+08:00',
      confirmedBy: '示例人员009',
    });
    const serialized = JSON.stringify(confirmed);

    expect(confirmed).toMatchObject({
      header: {
        template: 'blue',
        title: { content: '加班信息已确认' },
      },
    });
    expect(cardBodyElements(confirmed)).toHaveLength(4);
    expect(cardBodyElements(confirmed).map((element) => element.tag)).toEqual([
      'div',
      'div',
      'div',
      'div',
    ]);
    expectCompactFields(cardBodyElements(confirmed)[2]);
    expect(collectButtons(confirmed)).toHaveLength(0);
    expect(serialized).toContain('加班信息已确认');
    expect(serialized).toContain(snapshot.applicantName);
    expect(serialized).toContain(snapshot.building);
    expect(serialized).toContain(snapshot.position);
    expect(serialized).toContain(snapshot.reason);
    expect(serialized).toContain('处理人');
    expect(serialized).toContain('示例人员009');
    expect(serialized).toContain('08-13 10:00');
    expect(serialized).toContain('08-13 16:00');
    expect(serialized).toContain('08-14 09:00');
    expect(serialized).toContain('实际时段');
    expect(serialized).toContain('确认工时');
    expect(serialized).toContain('工时处置');
    expect(serialized).not.toMatch(/T\d{2}:\d{2}/u);
    expect(serialized).not.toContain('+08:00');
    expect(serialized).not.toContain('open_url');
    expect(serialized).not.toContain('确认加班信息');
  });

  it('计划和实际时段相同时只展示一次，并突出确认结果', () => {
    const range = {
      plannedStartAt: '2026-09-10T18:00:00+08:00',
      plannedEndAt: '2026-09-11T09:00:00+08:00',
    };
    const confirmed = buildOvertimeConfirmationResolvedCard(
      { ...snapshot, ...range },
      {
        actualStartAt: range.plannedStartAt,
        actualEndAt: range.plannedEndAt,
        actualHours: 15,
        disposition: '加班费',
        confirmedAt: '2026-09-11T09:00:00+08:00',
        confirmedBy: '陈继猛',
      },
    );
    const serialized = JSON.stringify(confirmed);

    expect(countOccurrences(serialized, '09-10 18:00 → 09-11 09:00')).toBe(1);
    expect(serialized).toContain('计划时段');
    expect(serialized).not.toContain('实际时段');
    expect(serialized).toContain('15 小时');
    expect(serialized).toContain('确认工时');
    expect(serialized).toContain('加班费');
    expect(serialized).toContain('工时处置');
  });

  it('终态卡片省略空的楼栋岗位、原因和确认时间，不显示误导占位', () => {
    const confirmed = buildOvertimeConfirmationResolvedCard(
      {
        ...snapshot,
        building: '  ',
        position: '',
        reason: '\u0000\t',
      },
      {
        actualStartAt: '2026-08-13T18:00:00+08:00',
        actualEndAt: '2026-08-14T02:00:00+08:00',
        actualHours: 8,
        disposition: '加班费',
        confirmedAt: '',
        confirmedBy: '陈继猛',
      },
    );
    const serialized = JSON.stringify(confirmed);

    expect(serialized).toContain(snapshot.applicantName);
    expect(serialized).toContain('处理人');
    expect(serialized).not.toContain('未提供');
    expect(serialized).not.toContain('加班原因');
    expect(serialized).not.toContain('确认时间');
  });

  it('正工时确认结果拒绝空处置，避免卡片渲染“未提供”', () => {
    const build = (disposition: string | null) =>
      buildOvertimeConfirmationResolvedCard(snapshot, {
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualEndAt: '2026-08-13T16:00:00+08:00',
        actualHours: 6,
        disposition,
        confirmedAt: '2026-08-14T09:00:00+08:00',
        confirmedBy: '示例人员009',
      });

    expect(() => build(null)).toThrow('加班确认工时处置不能为空');
    expect(() => build('  \u0000\t ')).toThrow('加班确认工时处置不能为空');
  });

  it('确认结果拒绝空或缺失处理人，避免卡片渲染“未提供”', () => {
    const baseResult = {
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualEndAt: '2026-08-13T16:00:00+08:00',
      actualHours: 6,
      disposition: '加班费',
      confirmedAt: '2026-08-14T09:00:00+08:00',
    };

    expect(() =>
      buildOvertimeConfirmationResolvedCard(snapshot, {
        ...baseResult,
        confirmedBy: ' \t ',
      }),
    ).toThrow('加班确认处理人不能为空');
    expect(() =>
      buildOvertimeConfirmationResolvedCard(
        snapshot,
        baseResult as unknown as Parameters<
          typeof buildOvertimeConfirmationResolvedCard
        >[1],
      ),
    ).toThrow('加班确认处理人不能为空');
  });

  it('0 工时确认结果使用灰色“加班已取消”紧凑终态', () => {
    const cancelled = buildOvertimeConfirmationResolvedCard(snapshot, {
      actualStartAt: '2026-08-13T23:00:00+08:00',
      actualEndAt: '2026-08-13T23:00:00+08:00',
      actualHours: 0,
      disposition: null,
      confirmedAt: '2026-08-14T07:04:00+08:00',
      confirmedBy: '周庆庆',
    });
    const serialized = JSON.stringify(cancelled);

    expect(cancelled).toMatchObject({
      header: {
        template: 'grey',
        title: { content: '加班已取消' },
      },
    });
    expect(cardBodyElements(cancelled)).toHaveLength(4);
    expectCompactFields(cardBodyElements(cancelled)[2]);
    expect(collectButtons(cancelled)).toHaveLength(0);
    expect(serialized).toContain('未实际发生');
    expect(serialized).toContain('0 小时');
    expect(serialized).toContain('无需处置');
    expect(serialized).toContain('周庆庆');
    expect(serialized).not.toMatch(/T\d{2}:\d{2}/u);
    expect(serialized).not.toContain('+08:00');
  });

  it('底表记录删除后生成无操作入口的灰色撤销终态', () => {
    const card = buildOvertimeSourceDeletedCard(snapshot);
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({
      header: {
        template: 'grey',
        title: { content: '加班申请已撤销' },
      },
    });
    expect(serialized).toContain('底表记录已删除');
    expect(serialized).toContain('审批和确认已终止');
    expect(serialized).toContain('不再提醒');
    expect(collectButtons(card)).toHaveLength(0);
    expect(serialized).not.toContain('open_url');
    expect(serialized).not.toContain('callback');
  });

  it('事后确认卡严格只有一个打开调用方URL的“确认加班信息”按钮', () => {
    const confirmationUrl =
      'https://example.com:3001/?overtimeConfirmation=rec_overtime_001&token=safe-token';
    const card = buildOvertimeConfirmationCard(
      {
        ...snapshot,
        plannedStartAt: '2026-08-13T18:00:00+08:00',
        plannedEndAt: '2026-08-14T02:00:00+08:00',
      },
      confirmationUrl,
    );
    const serialized = JSON.stringify(card);
    const buttons = collectButtons(card);
    const elements = cardBodyElements(card);

    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({ tag: 'div' });
    expectCompactFields(elements[0]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      tag: 'button',
      text: { tag: 'plain_text', content: '确认加班信息' },
      behaviors: [{ type: 'open_url', default_url: confirmationUrl }],
    });
    expect(serialized).not.toContain('驳回');
    expect(serialized).not.toContain('修正');
    expect(serialized).not.toContain('callback');
    expect(serialized).toContain('08-13 18:00');
    expect(serialized).toContain('08-14 02:00');
    expect(serialized).not.toMatch(/T\d{2}:\d{2}/u);
    expect(serialized).not.toContain('+08:00');
  });

  it('紧凑确认卡转义动态 lark_md 文本并把 UTC 时间转换为上海时间', () => {
    const confirmationUrl =
      'https://example.com:3001/?overtimeConfirmation=rec_overtime_001&token=safe-token';
    const card = buildOvertimeConfirmationCard(
      {
        ...snapshot,
        applicantName: '*示例人员008*',
        building: '<A楼>',
        position: '[值班员]',
        reason: '_维护_<script>',
        plannedStartAt: '2026-08-13T10:00:00.000Z',
        plannedEndAt: '2026-08-13T18:00:00.000Z',
      },
      confirmationUrl,
    );
    const contents = collectLarkMarkdown(card);
    const serialized = contents.join('\n');

    expect(serialized).toContain('\\*示例人员008\\*');
    expect(serialized).toContain('\\<A楼\\>');
    expect(serialized).toContain('\\[值班员\\]');
    expect(serialized).toContain('\\_维护\\_\\<script\\>');
    expect(serialized).not.toContain('<script>');
    expect(serialized).toContain('08-13 18:00');
    expect(serialized).toContain('08-14 02:00');
    expect(serialized).not.toContain('T10:00');
    expect(serialized).not.toContain('.000Z');
  });

  it('业务文本按Unicode字符截断并转义飞书Markdown控制字符', () => {
    const card = buildOvertimeApprovalCard({
      ...snapshot,
      applicantName: '*示例人员008*',
      reason: `${'甲'.repeat(220)}_[危险](https://example.com)<tag>`,
    });
    const contents = collectMarkdown(card);
    const applicant = contents.find((value) => value.includes('申请人'));
    const reason = contents.find((value) => value.includes('加班原因'));

    expect(applicant).toContain('\\*示例人员008\\*');
    expect(reason).not.toContain('[危险]');
    expect(reason).not.toContain('<tag>');
    expect(reason).toContain('…');
    expect(Array.from(reason ?? '').length).toBeLessThanOrEqual(212);
  });
});

function collectButtons(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(value, (entry) => {
    if (entry.tag === 'button') found.push(entry);
  });
  return found;
}

function collectMarkdown(value: unknown): string[] {
  const found: string[] = [];
  walk(value, (entry) => {
    if (entry.tag === 'markdown' && typeof entry.content === 'string') {
      found.push(entry.content);
    }
  });
  return found;
}

function collectLarkMarkdown(value: unknown): string[] {
  const found: string[] = [];
  walk(value, (entry) => {
    if (entry.tag === 'lark_md' && typeof entry.content === 'string') {
      found.push(entry.content);
    }
  });
  return found;
}

function expectCompactFields(element: Record<string, unknown>): void {
  const fields = element.fields;
  expect(Array.isArray(fields)).toBe(true);
  expect((fields as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
  for (const field of fields as Array<Record<string, unknown>>) {
    expect(typeof field.is_short).toBe('boolean');
    expect(field.text).toMatchObject({ tag: 'lark_md' });
  }
}

function cardBodyElements(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const body = (value as Record<string, unknown>).body;
  if (!body || typeof body !== 'object') return [];
  const elements = (body as Record<string, unknown>).elements;
  return Array.isArray(elements)
    ? (elements as Array<Record<string, unknown>>)
    : [];
}

function walk(
  value: unknown,
  visit: (entry: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entry = value as Record<string, unknown>;
  visit(entry);
  Object.values(entry).forEach((child) => walk(child, visit));
}

function callbackValue(button: Record<string, unknown>): unknown {
  const behavior = (button.behaviors as Array<Record<string, unknown>>)[0];
  return behavior?.value;
}

function callbackAction(button: Record<string, unknown>): unknown {
  return (callbackValue(button) as Record<string, unknown>)?.action;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
