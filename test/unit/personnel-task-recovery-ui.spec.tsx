import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonnelHandoverPanel } from '../../client/src/pages/SystemConfiguration/PersonnelHandoverPanel';

jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }), { virtual: true });

describe('personnel handover recovery integration', () => {
  it('shows recovery of original tasks in the existing handover page', () => {
    const markup = renderToStaticMarkup(createElement(PersonnelHandoverPanel, { accountId: 'synthetic-admin', onRefresh: jest.fn() }));
    expect(markup).toContain('任务恢复');
    expect(markup).toContain('正在读取恢复任务');
  });
});
