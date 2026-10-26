import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { PersonnelOverview } from '@shared/personnel-preview.interface';
import type { HandoverBatch, HandoverPermissionOwnership, PersonnelHandoverPreview } from '@shared/personnel-handover.interface';
import { PersonnelRecordSelect } from './PersonnelRecordSelect';
import { PermissionComparison } from './PersonnelPreviewPanel';
import { PersonnelHandoverSummary } from './PersonnelHandoverSummary';
import { completeHandoverOwnership, PersonnelHandoverOwnership } from './PersonnelHandoverOwnership';
import { cancelHandover, confirmHandover, loadHandoverBatch, loadHandoverBatches, loadHandoverPreview, retryHandover } from './api';
import { personnelHandoverScopeProblem } from '@shared/personnel-handover-scope';
import { PersonnelTaskRecoveryPanel } from './PersonnelTaskRecoveryPanel';

const statusLabels:Record<HandoverBatch['status'],string>={accepted:'已受理',syncing:'同步中',success:'已完成',error:'未完成',cancelled:'已取消'};
type Phase='idle'|'loading'|'ready'|'submitting'|'accepted'|'success'|'error';

export function PersonnelHandoverPanel({overview,accountId,onRefresh}:{overview?:PersonnelOverview;accountId:string;onRefresh:()=>void}) {
  const [from,setFrom]=useState(''),[to,setTo]=useState(''),[duties,setDuties]=useState<string[]>([]);
  const [phase,setPhase]=useState<Phase>('idle'),[error,setError]=useState(''),[preview,setPreview]=useState<PersonnelHandoverPreview>();
  const [batch,setBatch]=useState<HandoverBatch>(),[batches,setBatches]=useState<HandoverBatch[]>([]),[confirmed,setConfirmed]=useState(false);
  const [ownership,setOwnership]=useState<HandoverPermissionOwnership[]>([]),[ownershipStale,setOwnershipStale]=useState(false);
  const [recordsPhase,setRecordsPhase]=useState<'loading'|'ready'|'error'>('loading'),[recordsError,setRecordsError]=useState('');
  const recordsSequence=useRef(0),recordsBusy=useRef(false);
  const sequence=useRef(0),busy=useRef(false),mutation=useRef<string|undefined>(undefined),polls=useRef(0),uncertain=useRef(false);
  const storageKey=`personnel-handover-request:${accountId}`;
  const people=useMemo(()=>overview?.people.map(row=>row.person) || [],[overview]);
  const possible=useMemo(()=>overview?.duties.filter(duty=>duty.personnelIds.includes(from)||duty.personnelIds.includes(to)) || [],[overview,from,to]);
  const eligible=useMemo(()=>possible.filter(duty=>!personnelHandoverScopeProblem(duty)&&duty.enabled).map(duty=>duty.recordId),[possible]);
  const adopt=(value:HandoverBatch)=>{uncertain.current=false;setBatch(value);setBatches(values=>[value,...values.filter(previous=>previous.id!==value.id)].sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt)).slice(0,100));setPhase(value.status==='success'||value.status==='cancelled'?'success':value.status==='error'?'error':'accepted');};
  async function perform(operation:()=>Promise<void>,state:Phase='loading'){
    if(busy.current)return;busy.current=true;const token=++sequence.current;setPhase(state);setError('');
    try{await operation();}catch(failure){if(token===sequence.current){setError((failure as Error).message);setPhase('error');}}
    finally{if(token===sequence.current)busy.current=false;}
  }
  const mergeRecords=(values:HandoverBatch[])=>setBatches(previous=>[...values.map(value=>{const current=previous.find(record=>record.id===value.id);return current&&current.version>value.version?current:value;}),...previous.filter(record=>!values.some(value=>value.id===record.id))].sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt)).slice(0,100));
  async function updateRecords(){
    if(recordsBusy.current)return;recordsBusy.current=true;const token=++recordsSequence.current;setRecordsPhase('loading');setRecordsError('');
    try{const values=await loadHandoverBatches();if(token===recordsSequence.current){mergeRecords(values);setRecordsPhase('ready');}}
    catch(failure){if(token===recordsSequence.current){setRecordsError((failure as Error).message);setRecordsPhase('error');}}
    finally{if(token===recordsSequence.current)recordsBusy.current=false;}
  }
  useEffect(()=>{
    const token=++sequence.current,recordsToken=++recordsSequence.current;let live=true;
    try{mutation.current=sessionStorage.getItem(storageKey)||undefined;}catch{mutation.current=undefined;}
    recordsBusy.current=true;setRecordsPhase('loading');setRecordsError('');
    void loadHandoverBatches().then(values=>{if(live&&recordsToken===recordsSequence.current){mergeRecords(values);setRecordsPhase('ready');if(token===sequence.current){const existing=values.find(value=>value.clientMutationId===mutation.current);if(existing)adopt(existing);}}},failure=>{if(live&&recordsToken===recordsSequence.current){setRecordsError((failure as Error).message);setRecordsPhase('error');}}).finally(()=>{if(live&&recordsToken===recordsSequence.current)recordsBusy.current=false;});
    return ()=>{live=false;sequence.current++;recordsSequence.current++;recordsBusy.current=false;};
  },[storageKey]);
  useEffect(()=>{
    if(!batch || phase!=='accepted' || polls.current>=10)return;
    const token=sequence.current,timer=setTimeout(()=>{
      polls.current++;
      void loadHandoverBatch(batch.id).then(value=>{if(token===sequence.current)adopt(value);},failure=>{if(token===sequence.current){setError((failure as Error).message);setPhase('error');}});
    },3000);return ()=>clearTimeout(timer);
  },[batch,phase]);
  const reset=()=>{if(busy.current||uncertain.current)return;sequence.current++;mutation.current=undefined;try{sessionStorage.removeItem(storageKey);}catch{}setPreview(undefined);setOwnership([]);setOwnershipStale(false);setBatch(undefined);setConfirmed(false);setPhase('idle');setError('');polls.current=0;};
  const selectionChanged=(action:()=>void)=>{if(busy.current||uncertain.current)return;reset();action();};
  const makePreview=(clearOwnership=false)=>perform(async()=>{if(uncertain.current)return;mutation.current=undefined;try{sessionStorage.removeItem(storageKey);}catch{}const token=sequence.current;const value=await loadHandoverPreview({fromPersonId:from,toPersonId:to,dutyRecordIds:duties,mode:people.find(person=>person.id===from)?.active?'rotation':'offboarding',...(!clearOwnership&&ownership.length?{ownership}:{})});if(token===sequence.current){setPreview(value);if(clearOwnership)setOwnership([]);setOwnershipStale(false);setPhase('ready');setConfirmed(false);}});
  const submit=()=>perform(async()=>{
    if(!preview)return;const token=sequence.current;
    mutation.current ||= crypto.randomUUID();try{sessionStorage.setItem(storageKey,mutation.current);}catch{}
    try{const value=await confirmHandover({request:preview.requested,expectedFingerprint:preview.fingerprint,clientMutationId:mutation.current});if(token===sequence.current){polls.current=0;adopt(value);}}
    catch(failure){
      const status=(failure as {status?:number}).status;
      if(status && status>=400&&status<500){uncertain.current=false;throw failure;}
      uncertain.current=true;
      const matches=await loadHandoverBatches(mutation.current);if(token!==sequence.current)return;
      if(matches.length===1){polls.current=0;adopt(matches[0]);}else{uncertain.current=true;throw failure;}
    }
  },'submitting');
  const checkProgress=()=>perform(async()=>{if(!batch)return;const token=sequence.current,value=await loadHandoverBatch(batch.id);if(token===sequence.current){polls.current=0;adopt(value);}});
  const retry=()=>perform(async()=>{if(!batch)return;const token=sequence.current,value=await retryHandover(batch.id,batch.version);if(token===sequence.current){setBatch(value);polls.current=0;setPhase(value.status==='success'?'success':'accepted');}},'submitting');
  const cancel=()=>perform(async()=>{if(!batch)return;const token=sequence.current,value=await cancelHandover(batch.id,batch.version);if(token===sequence.current)adopt(value);},'submitting');
  const disabled=phase==='loading'||phase==='submitting';
  return <section className="space-y-4">
    <Card><CardContent className="space-y-4 p-4">
      <p className="font-medium">岗位交接</p>
      <p className="text-xs text-muted-foreground">一次核对岗位权限及相关待办；其他任职所需权限保留。</p>
      {batch?<div className="flex flex-wrap items-center justify-between gap-3"><p className="break-words text-sm">{batch.preview.from.name} → {batch.preview.to.name}</p><Button variant="outline" disabled={disabled} onClick={reset}>新建交接</Button></div>:<>
        <fieldset disabled={disabled||uncertain.current} className="space-y-4"><div className="grid gap-4 md:grid-cols-2">
          <PersonnelRecordSelect label="前任人员" people={people} value={from} onChange={id=>selectionChanged(()=>{setFrom(id);setDuties([]);})} />
          <PersonnelRecordSelect label="接任人员" people={people.filter(person=>person.active)} value={to} onChange={id=>selectionChanged(()=>{setTo(id);setDuties([]);})} />
        </div><fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">交接职责</legend>
          {eligible.length>0&&<div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={()=>selectionChanged(()=>setDuties([...eligible]))}>选择全部可交接职责</Button>{duties.length>0&&<Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={()=>selectionChanged(()=>setDuties([]))}>清空选择</Button>}</div>}
          {possible.map(duty=>{const problem=personnelHandoverScopeProblem(duty),allowed=!problem&&duty.enabled;return <label key={duty.recordId} className="flex items-start gap-3 rounded-lg border p-3 text-sm"><Checkbox disabled={!allowed||disabled} checked={duties.includes(duty.recordId)} onCheckedChange={checked=>selectionChanged(()=>setDuties(values=>checked===true?[...values,duty.recordId]:values.filter(id=>id!==duty.recordId)))} /><span className="min-w-0 break-words">{duty.name} · {duty.buildings?.join('、')||'全基地'}{duty.specialties&&` · ${duty.specialties.join('、')}`}{!allowed&&<span className="block text-xs text-muted-foreground">{!duty.enabled?'职责已停用':problem}</span>}</span></label>;})}
          {!possible.length&&<p className="text-sm text-muted-foreground">请选择人员；没有明确职责时不能提交交接。</p>}
        </fieldset></fieldset>
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={disabled} onClick={onRefresh}>更新人员资料</Button><Button disabled={disabled||uncertain.current||!from||!to||from===to||!duties.length||!completeHandoverOwnership(preview,ownership)} onClick={()=>void makePreview()}>{phase==='loading'?'正在核对…':'核对交接清单'}</Button></div>
      </>}
      {error&&<p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    </CardContent></Card>
    {!batch&&preview&&<>
      <p className="break-words font-medium">{preview.from.name} → {preview.to.name}</p>
      <PersonnelHandoverOwnership preview={preview} value={ownership} disabled={disabled||uncertain.current} dutyNames={new Map(possible.map(duty=>[duty.recordId,duty.name]))} onReload={()=>void makePreview(true)} onChange={values=>{if(busy.current||uncertain.current)return;setOwnership(values);setOwnershipStale(true);setConfirmed(false);mutation.current=undefined;try{sessionStorage.removeItem(storageKey);}catch{}}} />
      {ownershipStale&&<p role="status" className="text-sm text-muted-foreground">归属选择已修改，请重新核对交接清单。</p>}
      {preview.conflicts.map(message=><p key={message} role="alert" className="text-sm text-destructive">{message}</p>)}
      {preview.warnings.map(message=><p key={message} className="text-sm text-muted-foreground">{message}</p>)}
      {preview.permissions.map(value=><PermissionComparison key={value.targetAccountId} value={{...value,source:value.transfer||value.source}} />)}
      <Card><CardContent className="space-y-3 p-4"><p className="font-medium">待交接事项 · {preview.pending.length}</p>
        <PersonnelHandoverSummary pending={preview.pending} />
        {!preview.pending.length&&<p className="text-sm text-muted-foreground">所选职责没有待交接事项。</p>}
        <p className="text-xs text-muted-foreground">已完成历史和已合法受理的处理保留；结果不明确的事项需先核对。</p>
        <label className="flex items-start gap-3 text-sm"><Checkbox checked={confirmed} disabled={disabled} onCheckedChange={value=>setConfirmed(value===true)} /><span>已核对权限及汇总清单，确认一次转交给{preview.to.name}</span></label>
        <Button disabled={disabled||!confirmed||ownershipStale||!completeHandoverOwnership(preview,ownership)||!!preview.conflicts.length||preview.permissions.some(value=>value.conflicts.length>0)} onClick={()=>void submit()}>{phase==='submitting'?'正在提交…':'确认交接'}</Button>
      </CardContent></Card>
    </>}
    {batch&&<Card><CardContent className="space-y-3 p-4"><p className="font-medium" role="status">{statusLabels[batch.status]}</p>
      <p className="text-sm">权限继承：{batch.permissionStatus==='success'?'已完成':batch.permissionStatus==='error'?'未完成，请核对人员和权限变化':'未生效'}</p>
      <PersonnelHandoverSummary progress={batch.items} />
      {batch.status==='error'&&batch.permissionStatus==='success'&&<p className="text-xs text-muted-foreground">权限已生效，部分待办尚未完成；重试只恢复未完成步骤。</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled} onClick={()=>void checkProgress()}>核对进度</Button>{batch.status==='error'&&<Button disabled={disabled} onClick={()=>void retry()}>恢复未完成步骤</Button>}{!['success','cancelled'].includes(batch.status)&&batch.permissionStatus!=='success'&&batch.items.every(item=>!item.receipt)&&<Button variant="outline" disabled={disabled} onClick={()=>void cancel()}>取消未生效交接</Button>}</div>
    </CardContent></Card>}
    <Card><CardContent className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">交接记录</p><Button variant="outline" disabled={recordsPhase==='loading'} onClick={()=>void updateRecords()}>{recordsPhase==='loading'?'正在读取记录…':'更新记录'}</Button></div>
      {recordsPhase==='loading'&&<p role="status" className="text-sm text-muted-foreground">正在读取交接记录…</p>}
      {recordsPhase==='error'&&<p role="alert" className="break-words text-sm text-destructive">交接记录读取失败：{recordsError}</p>}
      {batches.map(value=><Button key={value.id} variant="outline" className="h-auto w-full justify-between gap-3 whitespace-normal text-left" disabled={disabled} onClick={()=>{sequence.current++;polls.current=0;setError('');adopt(value);}}><span className="min-w-0 break-words">{value.preview.from.name} → {value.preview.to.name}<span className="block text-xs text-muted-foreground">{new Date(value.acceptedAt).toLocaleString('zh-CN',{hour12:false})}</span></span><span className="shrink-0">{statusLabels[value.status]}</span></Button>)}
      {recordsPhase==='ready'&&!batches.length&&<p className="text-sm text-muted-foreground">暂无交接记录</p>}
    </CardContent></Card>
    <PersonnelTaskRecoveryPanel key={accountId} accountId={accountId} />
  </section>;
}
