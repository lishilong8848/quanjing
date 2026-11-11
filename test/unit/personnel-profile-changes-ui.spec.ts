import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
let mockActor:any={accountId:'person',principalFingerprint:'person-v1'};
jest.mock('../../client/src/access/AccessProvider',()=>({useAccess:()=>mockActor}));
import { ProfileChanges } from '../../client/src/pages/PersonalCenter/ProfileChanges';
describe('profile approval UI boundaries',()=>{
 beforeEach(()=>{mockActor={accountId:'person',principalFingerprint:'person-v1'};});
 it('exposes only the three approved profile fields and the historical feedback guidance',()=>{const html=renderToStaticMarkup(React.createElement(ProfileChanges));expect(html).toContain('手机号');expect(html).toContain('邮箱');expect(html).toContain('照片');expect(html).toContain('资料核对与反馈');expect(html).not.toContain('身份证号');expect(html).not.toContain('修改角色');});
 it('renders no edit or review form under impersonation',()=>{mockActor.impersonation={actorAccountId:'admin'};const html=renderToStaticMarkup(React.createElement(ProfileChanges));expect(html).toContain('代登录期间不能');expect(html).not.toContain('type="checkbox"');expect(html).not.toContain('提交审核');});
 it('keeps the admin queue separate from self-service submission',()=>{const html=renderToStaticMarkup(React.createElement(ProfileChanges,{admin:true}));expect(html).toContain('个人资料变更审批');expect(html).not.toContain('提交审核');});
});
