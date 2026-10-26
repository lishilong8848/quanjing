import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { GlobalUserControl } from '../../client/src/components/Layout';

let mockSession: Record<string, unknown>;
jest.mock('../../client/src/components/FeishuIcon', () => ({ FeishuIcon: () => null }));
jest.mock('../../client/src/access/AccessProvider', () => ({
  useAccess: () => mockSession,
  getAccessRoleLabel: () => '游客',
}));
jest.mock('@lark-apaas/client-toolkit/hooks/useCurrentUserProfile', () => ({ useCurrentUserProfile: () => ({ user_id: '' }) }));
jest.mock('@lark-apaas/client-toolkit/dataloom', () => ({ getDataloom: jest.fn() }));
jest.mock('@lark-apaas/client-toolkit/logger', () => ({ logger: {} }));

describe('signed guest avatar', () => {
  beforeEach(() => {
    mockSession = { role: 'guest', purchaseBuilding: null, displayName: '测试访客', expiresAt: Date.now() + 60000, principalFingerprint: 'f'.repeat(43), isLoading: false, sessionError: null };
  });
  const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GlobalUserControl)));
  it('shows the last two characters of the authenticated guest name', () => {
    expect(render()).toContain('>访客</span>');
    expect(render()).toContain('当前身份：测试访客');
  });
  it('uses generic guest initials after logout', () => {
    mockSession = { ...mockSession, displayName: undefined, expiresAt: null, principalFingerprint: null };
    expect(render()).toContain('>游客</span>');
    expect(render()).not.toContain('测试访客');
  });
});
