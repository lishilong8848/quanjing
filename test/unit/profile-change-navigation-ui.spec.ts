import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {permissionRequestLocation} from '../../client/src/pages/SystemConfiguration/permission-request-navigation';
let mockRows:any[]=[];let mockSeeded=false;
const mockReview=jest.fn(),mockSubmit=jest.fn(),mockRecover=jest.fn(),mockCancel=jest.fn();
jest.mock('react',()=>{const actual=jest.requireActual('react');return {...actual,useState:(value:any)=>{
 if(Array.isArray(value)&&value.length===0&&!mockSeeded){mockSeeded=true;return actual.useState(mockRows);}
 return actual.useState(value);
}};});
jest.mock('../../client/src/access/AccessProvider',()=>({useAccess:()=>({role:'admin',accountId:'admin-a',principalFingerprint:'admin-a-v1'})}));
jest.mock('../../client/src/api/profile-changes',()=>({listProfileChanges:jest.fn(),submitProfileChange:(...args:any[])=>mockSubmit(...args),reviewProfileChange:(...args:any[])=>mockReview(...args),cancelProfileChange:(...args:any[])=>mockCancel(...args),recoverProfileChange:(...args:any[])=>mockRecover(...args),isProfileChangeRejected:()=>false,profileChangesUrl:()=>''}));
import {ProfileChanges} from '../../client/src/pages/PersonalCenter/ProfileChanges';
const id='11111111-1111-4111-8111-111111111111';
const row=(index:number,status='pending')=>({id:index===24?id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,clientMutationId:`request-${index}`,version:1,applicantName:`申请人员${index}`,createdAt:'2026-11-11T00:00:00Z',status,changes:{phone:'13800000001'},before:{phone:'13800000000'}});
function render(admin=true,focusRequestId:string|undefined=id){mockSeeded=false;return renderToStaticMarkup(React.createElement(ProfileChanges,{admin,focusRequestId,focusNavigationKey:'card-navigation'}));}
describe('profile change card navigation and rendered queue',()=>{
 beforeEach(()=>{mockRows=Array.from({length:25},(_,i)=>row(i));jest.clearAllMocks();});
 it('accepts exact UUID profile-change routes while preserving permission-request routes',()=>{
  expect(permissionRequestLocation(`?tab=profile-changes&requestId=${id}`)).toEqual({tab:'profile-changes',requestId:id});
  expect(permissionRequestLocation(`?tab=permission-requests&requestId=${id}`)).toEqual({tab:'permission-requests',requestId:id});
  expect(permissionRequestLocation('?tab=profile-changes')).toEqual({tab:'profile-changes'});
 });
 it('ignores duplicate tabs or malformed/duplicate IDs without inventing a target',()=>{
  expect(permissionRequestLocation(`?tab=profile-changes&tab=accounts&requestId=${id}`)).toBeNull();
  for(const query of ['requestId=../../admin',`requestId=${id}&requestId=${id}`,'requestId=%3Cscript%3E'])expect(permissionRequestLocation('?tab=profile-changes&'+query)).toEqual({tab:'profile-changes'});
 });
 it('renders the exact target even when it would ordinarily be on the third page, without writing',()=>{
  const html=render();expect(html).toContain('申请人员24');expect(html).not.toContain('申请人员0');expect(html).toContain('查看全部申请');expect(html).toContain(`data-profile-change-id="${id}"`);
  for(const fn of [mockReview,mockSubmit,mockRecover,mockCancel])expect(fn).not.toHaveBeenCalled();
 });
 it('can locate a completed request and never starts approval automatically',()=>{
  mockRows=[row(24,'completed')];const html=render();expect(html).toContain('已更新');expect(html).toContain('申请人员24');expect(mockReview).not.toHaveBeenCalled();
 });
 it('does not apply administrator link filters to the personal submission page',()=>{
  const html=render(false);expect(html).toContain('申请修改基本资料');expect(html).toContain('资料核对与反馈');expect(html).toContain('申请人员0');expect(html).not.toContain('查看全部申请');
 });
});
