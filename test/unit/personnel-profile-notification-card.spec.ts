import {profileChangeCard} from '../../server/common/access/personnel-profile-notification.card';
import {sanitizeReadonlyCard,isReadonlyDisplayCard} from '../../server/common/feishu-card-copy/readonly-card';
const row:any={id:'11111111-1111-4111-8111-111111111111',version:2,status:'pending',applicantName:'测试申请人',before:{phone:'13800000000',email:'old@example.test',photo:'file_token-secret-before'},changes:{phone:'13900000000',email:'<b>new@example.test</b>',photo:'file_token-secret-after'}};
function actions(card:any){const result:any[]=[];const visit=(node:any)=>{if(Array.isArray(node))node.forEach(visit);else if(node&&typeof node==='object'){if(node.tag==='button'&&node.value)result.push(node);Object.values(node).forEach(visit);}};visit(card);return result;}
describe('profile review card presentation',()=>{
 it('includes safe plain-text before/after values and exact approval/rejection protocol',()=>{
  const card:any=profileChangeCard(row,'https://example.test/system-configuration',false,{actionable:true,beforeImageKey:'img_before',afterImageKey:'img_after'});
  expect(actions(card).map((button:any)=>button.value)).toEqual(['approve','reject'].map(decision=>({workflowType:'profile_change',action:'profile_change_review',requestId:row.id,expectedVersion:2,decision})));
  const text=card.elements.filter((item:any)=>item.text).map((item:any)=>item.text);
  expect(text.every((item:any)=>item.tag==='plain_text')).toBe(true);
  expect(JSON.stringify(card)).toContain('13800000000');expect(JSON.stringify(card)).toContain('13900000000');expect(JSON.stringify(card)).toContain('old@example.test');
  expect(JSON.stringify(card)).not.toContain('file_token-secret');
 });
 it('only renders validated IM keys for both photographs and never raw photo metadata',()=>{
  const card=profileChangeCard(row,'https://example.test',false,{actionable:true,beforeImageKey:'img_v3_before',afterImageKey:'https://secret.example/file_token'});
  expect(JSON.stringify(card)).toContain('img_v3_before');expect(JSON.stringify(card)).toContain('图片暂不可用');expect(JSON.stringify(card)).not.toContain('secret.example');
 });
 it.each([{...row,version:0},{...row,version:NaN},{...row,id:'bad-id'},{...row,status:'completed'},{...row,status:'conflict'}])('does not emit actions for invalid or terminal versions',value=>{
  expect(actions(profileChangeCard(value,'https://example.test',false,{actionable:true}))).toHaveLength(0);
 });
 it('revocation and unverified source remove callback actions',()=>{
  expect(actions(profileChangeCard(row,'https://example.test',true,{actionable:true}))).toHaveLength(0);
  expect(JSON.stringify(profileChangeCard(row,'https://example.test',true,{actionable:true}))).not.toContain('13900000000');
  expect(actions(profileChangeCard(row,'https://example.test'))).toHaveLength(0);
 });
 it('read-only mirrors keep the comparison but remove all approval capabilities',()=>{
  const original=profileChangeCard(row,'https://example.test',false,{actionable:true,beforeImageKey:'img_v3_before',afterImageKey:'img_v3_after'});
  for(const recipient of ['李世龙','刘小杏']){
   const copy=sanitizeReadonlyCard(original).card;expect(isReadonlyDisplayCard(copy)).toBe(true);
   expect(JSON.stringify(copy)).toContain('13900000000');expect(JSON.stringify(copy)).not.toContain('profile_change_review');expect(JSON.stringify(copy)).not.toContain('expectedVersion');expect(JSON.stringify(copy)).not.toContain('https://example.test');
  }
 });
});

it('allows rejection but requires complete photo comparison before card approval',()=>{
 const url='https://example.test';
 expect(actions(profileChangeCard(row,url,false,{actionable:true,afterImageKey:'img_after'})).map((button:any)=>button.value.decision)).toEqual(['reject']);
 expect(actions(profileChangeCard(row,url,false,{actionable:true,afterImageKey:'img_after',beforePhotoAbsent:true})).map((button:any)=>button.value.decision)).toEqual(['approve','reject']);
 expect(JSON.stringify(profileChangeCard(row,url,false,{actionable:true,afterImageKey:'img_after'}))).not.toContain('申请前暂无照片');
});

it('requires an explicit rejection form reason and keeps approval outside the form',()=>{
 const card:any=profileChangeCard(row,'https://example.test',false,{actionable:true,beforeImageKey:'img_before',afterImageKey:'img_after'});
 const form=card.elements.find((item:any)=>item.tag==='form');
 expect(form.name).toBe('profile_change_rejection');
 expect(form.elements.find((item:any)=>item.tag==='input')).toMatchObject({name:'rejection_reason',required:true,max_length:1000});
 const reject=form.elements.find((item:any)=>item.tag==='button');
 expect(reject).toMatchObject({name:'profile_change_reject',action_type:'form_submit',value:{decision:'reject'}});
 expect(form.elements.some((item:any)=>item.value?.decision==='approve')).toBe(false);
 const approve=actions(card).find((item:any)=>item.value.decision==='approve');expect(approve.action_type).toBeUndefined();expect(approve.confirm.title.tag).toBe('plain_text');
});
it('retains disabled operation labels and the recorded reason in the terminal card without callbacks or URLs',()=>{
 const card:any=profileChangeCard({...row,status:'rejected',comment:'手机号填写错误，请重新核实',reviewerName:'审核管理员'},'https://example.test',false,{actionable:true});
 const buttons=card.elements.filter((item:any)=>item.tag==='action').flatMap((item:any)=>item.actions);
 expect(buttons.every((button:any)=>button.disabled===true&&!button.value&&!button.url&&!button.action_type)).toBe(true);
 expect(card.elements.some((item:any)=>item.tag==='form')).toBe(false);expect(JSON.stringify(card)).toContain('手机号填写错误，请重新核实');
});
