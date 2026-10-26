import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonnelHandoverSummary } from '../../client/src/pages/SystemConfiguration/PersonnelHandoverSummary';
import type { HandoverBatchItem, PendingDuty } from '../../shared/personnel-handover.interface';
const item=(index:number):PendingDuty=>({key:`leave:${index}`,module:index%2?'leave':'overtime',recordId:`rec${index}`,title:`合成明细${index}`,dutyRecordId:'recDuty',phase:'approval',status:'pending',stageKey:'supervisor',version:'1',recipients:[{name:'合成人员',openId:'ou_synthetic'}]});
describe('批量交接模块汇总',()=>{
  it('一万条事项默认只渲染模块汇总，不要求逐项确认，也不渲染隐藏明细DOM',()=>{
    const html=renderToStaticMarkup(React.createElement(PersonnelHandoverSummary,{pending:Array.from({length:10000},(_,index)=>item(index))}));
    expect(html).toContain('请休假');expect(html).toContain('加班');expect(html).toContain('5000');expect(html).not.toContain('合成明细');
    expect((html.match(/aria-expanded="false"/g)||[]).length).toBe(2);expect(html.length).toBeLessThan(12000);
  });
  it('模块进度同时显示已完成、待处理和失败数量，明细按需展开',()=>{
    const progress:HandoverBatchItem[]=[{item:item(1),status:'success'},{item:item(3),status:'syncing'},{item:item(5),status:'error',error:'合成失败'}];
    const html=renderToStaticMarkup(React.createElement(PersonnelHandoverSummary,{progress}));expect(html).toContain('已完成 1 项');expect(html).toContain('处理中 1 项');expect(html).toContain('未完成 1 项');expect(html).not.toContain('合成明细');
  });
});
