import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { AccessConfigurationResponse } from '@shared/access-configuration.interface';
import type { PersonnelBaselineMutation, PersonnelBaselinePreview } from '@shared/personnel-baseline.interface';
import { confirmPersonnelBaseline, previewPersonnelBaseline } from './api';
import { AUTHORITY_DUTY_CATALOG } from '@shared/personnel-authority.interface';

type Phase='idle'|'loading'|'ready'|'submitting'|'success'|'error';
function readDraft(key:string):PersonnelBaselineMutation|undefined{
  try{const raw=sessionStorage.getItem(key);if(!raw)return;const value=JSON.parse(raw);
    if(value&&Object.keys(value).sort().join(',')==='clientMutationId,expectedFingerprint,expectedRevision'&&/^[A-Za-z0-9_-]{12,160}$/.test(value.clientMutationId)&&/^[a-f0-9]{64}$/.test(value.expectedFingerprint)&&Number.isSafeInteger(value.expectedRevision)&&value.expectedRevision>=0)return value;
  }catch{/* A corrupt draft cannot authorize a new confirmation. */}
}
export function PersonnelBaselinePanel({data,accountId,onSaved}:{data:AccessConfigurationResponse;accountId:string;onSaved:(value:AccessConfigurationResponse)=>void}){
  const key=`vnet-personnel-baseline:${accountId}`,sequence=useRef(0),busy=useRef(false),request=useRef(readDraft(key)),latestRevision=useRef(data.revision);latestRevision.current=data.revision;
  const [phase,setPhase]=useState<Phase>('idle'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[preview,setPreview]=useState<PersonnelBaselinePreview>(),[acknowledged,setAcknowledged]=useState(false),[unknown,setUnknown]=useState(!!request.current),[query,setQuery]=useState(''),[visible,setVisible]=useState(50);
  useEffect(()=>{sequence.current++;busy.current=false;request.current=readDraft(key);setUnknown(!!request.current);setPreview(undefined);setAcknowledged(false);setError('');setNotice('');setPhase('idle');return()=>{sequence.current++;};},[key]);
  const rows=useMemo(()=>preview?.rows.filter(row=>!query||`${row.name} ${row.members.join(' ')} ${row.source} ${row.buildings?.join(' ')} ${row.specialties?.join(' ')}`.includes(query))||[],[preview,query]);
  const current=!!preview?.canConfirm&&preview.configurationRevision===data.revision&&Date.now()-preview.checkedAt<=5*60_000;
  async function check(){
    if(busy.current)return;busy.current=true;const token=++sequence.current;setPhase('loading');setError('');setNotice('');setAcknowledged(false);
    try{const value=await previewPersonnelBaseline();if(token===sequence.current){setPreview(value);setVisible(50);setPhase('ready');}}
    catch(failure){if(token===sequence.current){setError((failure as Error).message);setPhase('error');}}
    finally{if(token===sequence.current)busy.current=false;}
  }
  async function confirm(){
    if(busy.current||!request.current&&(!current||!acknowledged))return;
    const input=request.current||{clientMutationId:crypto.randomUUID(),expectedRevision:data.revision,expectedFingerprint:preview!.previewFingerprint};
    busy.current=true;const token=++sequence.current;setPhase('submitting');setError('');setNotice('');
    try{
      try{sessionStorage.setItem(key,JSON.stringify(input));}catch{throw Error('暂时无法保留确认草稿，请稍后重试');}
      request.current=input;const value=await confirmPersonnelBaseline(input);if(token!==sequence.current)return;
      const newer=value.revision<latestRevision.current;if(!newer)onSaved(value);
      request.current=undefined;setUnknown(false);setPreview(undefined);setAcknowledged(false);try{sessionStorage.removeItem(key);}catch{/* Server mutation is durable; an old draft safely replays. */}
      setNotice(newer?'配置已有后续更新，请核对当前状态':value.personnelSource?'基线结果已确认，请查看当前岗位来源状态':'现行岗位基线已确认，尚未启用岗位来源');setPhase('success');
    }catch(failure){if(token!==sequence.current)return;
      if((failure as {status?:number}).status===409){request.current=undefined;setUnknown(false);setPreview(undefined);setAcknowledged(false);try{sessionStorage.removeItem(key);}catch{/* A new confirmation still requires a fresh preview. */}}
      else setUnknown(!!request.current);
      setError((failure as Error).message);setPhase('error');
    }finally{if(token===sequence.current)busy.current=false;}
  }
  return <section aria-label="首次岗位对齐" className="space-y-4"><Card><CardContent className="space-y-4 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><h2 className="flex items-center gap-2 font-semibold"><ClipboardCheck className="size-5 text-primary"/>首次对齐<Badge variant="outline">{data.personnelBaseline?'已确认':'待核对'}</Badge></h2>
      {data.personnelBaseline&&<p className="text-xs text-muted-foreground">{data.personnelBaseline.count}项 · {data.personnelBaseline.actorName} · {new Date(data.personnelBaseline.confirmedAt).toLocaleString('zh-CN',{hour12:false})}</p>}
    </div><Button variant="outline" onClick={()=>void check()} disabled={phase==='loading'||phase==='submitting'}>{phase==='loading'&&<Loader2 className="size-4 animate-spin"/>}{phase==='loading'?'正在核对…':'核对首次岗位'}</Button></div>
    {error&&<p role="alert" className="break-words text-sm text-destructive">{error}</p>}{notice&&<p role="status" className="break-words text-sm text-primary">{notice}</p>}
    {!!preview?.problems.length&&<div role="alert" className="space-y-1 rounded-lg border border-destructive/30 p-3">{preview.problems.map(problem=><p className="break-words text-sm text-destructive" key={problem}>{problem}</p>)}</div>}
    {!!preview?.unmanagedKinds?.length&&<p className="break-words text-xs text-muted-foreground">以下职责尚未接管，继续使用现有配置：{preview.unmanagedKinds.map(kind=>AUTHORITY_DUTY_CATALOG.find(duty=>duty.id===kind)!.label).join('、')}。</p>}
    {preview&&preview.configurationRevision!==data.revision&&<p role="status" className="text-sm text-muted-foreground">配置已变化，请重新核对。</p>}
    {unknown?<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><p className="text-sm">上次确认结果尚未返回，请使用原请求核对。</p><Button disabled={phase==='loading'||phase==='submitting'} onClick={()=>void confirm()}>{phase==='submitting'?'正在确认…':'重试确认结果'}</Button></div>:<div className="flex flex-wrap items-end justify-between gap-4 border-t pt-4"><div className="space-y-2"><label className="flex items-start gap-2 text-sm"><Checkbox checked={acknowledged} onCheckedChange={value=>setAcknowledged(value===true)} aria-label="已核对首次岗位全部人员及范围" disabled={!current||phase==='submitting'}/><span>已核对全部{preview?.rows.length||0}项现行人员及范围</span></label><p className="text-xs text-muted-foreground">确认不启用岗位来源，不调整账号权限或转交事项。</p></div><Button onClick={()=>void confirm()} disabled={!current||!acknowledged||phase==='loading'||phase==='submitting'}>{phase==='submitting'?'正在确认…':'批量确认基线'}</Button></div>}
  </CardContent></Card>
  {preview&&<><input aria-label="搜索首次对齐职责" value={query} maxLength={128} onChange={event=>{setQuery(event.target.value);setVisible(50);}} placeholder="搜索职责、姓名或范围" className="config-select w-full sm:max-w-sm"/>
    <div className="divide-y rounded-lg border bg-card">{rows.slice(0,visible).map(row=><article key={row.dutyRecordId} className="grid gap-2 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"><div className="min-w-0 space-y-1"><p className="break-words text-sm font-medium">{row.name}</p><Badge variant="outline">{row.origin==='personnel_position'?'主表岗位':'额外职责'}</Badge></div><div className="space-y-1 text-sm"><p className="break-words">{row.members.join('、')||'待核对人员'}</p><p className="break-words text-xs text-muted-foreground">{row.source}</p></div><p className="break-words text-sm text-muted-foreground">{row.buildings?.join('、')||'全基地'} · {row.specialties?.join('、')||'全部专业'}</p><Badge variant="outline" className="h-fit w-fit">{row.status==='aligned'?'一致':'待核对'}</Badge>{row.reason&&<p className="break-words text-sm text-destructive md:col-span-4">{row.reason}</p>}</article>)}{!rows.length&&<p className="p-6 text-sm text-muted-foreground" role="status">{query?'没有匹配结果':'尚无可确认职责'}</p>}</div>
    {rows.length>visible&&<Button variant="outline" onClick={()=>setVisible(value=>value+50)}>显示更多（{rows.length-visible}）</Button>}</>}
  </section>;
}
