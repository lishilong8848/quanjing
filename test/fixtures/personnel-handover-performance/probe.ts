type Group='checkbox'|'tab'|'button'|'submit';
type Sample={index:number;warm:boolean;eventAt:number|null;capturedAt:number|null;feedbackAt:number|null;elapsedMs:number|null;trusted:boolean|null;visibility:string|null;focused:boolean|null;width:number|null;height:number|null;name:string|null;missing:string|null;actionId?:string;eventKind?:string;preSelected?:string|null;clickAt?:number;clickTrusted?:boolean;readyAtClick?:boolean};
// Independent test instrumentation; never imported by the product entry.
export function installHandoverFeedbackProbe(){
  const limits:Record<Group,number>={checkbox:20,tab:20,button:20,submit:10};
  const groups:Record<Group,Sample[]>={checkbox:[],tab:[],button:[],submit:[]};
  let armed:Group|undefined,active:((reason?:string)=>void)|undefined,lastTab:{element:HTMLElement;sample:Sample;ready:()=>boolean}|undefined;
  const output=document.createElement('output');output.id='handover-feedback';output.style.cssText='position:fixed;bottom:0;left:0;z-index:10000;background:white;color:#222;font:11px monospace;padding:4px';document.body.append(output);
  const controls=document.createElement('aside');controls.style.cssText='position:fixed;bottom:0;right:0;z-index:10000;background:white;display:flex;flex-wrap:wrap;gap:6px;max-width:70vw';controls.setAttribute('aria-label','反馈测量控制');document.body.append(controls);
  const publish=()=>{output.textContent=armed?`${armed}：${groups[armed].length}/${limits[armed]+1}`:'固定样本尚未开始';};
  for(const group of Object.keys(limits) as Group[]){const button=document.createElement('button');button.textContent=`测量：${group}`;button.onclick=()=>{if(groups[group].length)return;armed=group;publish();};controls.append(button);}
  const exportButton=document.createElement('button');exportButton.textContent='导出反馈样本';controls.append(exportButton);
  const measure=(event:MouseEvent,isPointer:boolean)=>{
    const element=(event.target as Element)?.closest<HTMLElement>('button');
    if(!armed||!element||controls.contains(element)||(element as HTMLButtonElement).disabled)return;
    if(armed==='tab'&&!isPointer){if(lastTab?.element===element){lastTab.sample.clickAt=event.timeStamp;lastTab.sample.clickTrusted=event.isTrusted;lastTab.sample.readyAtClick=lastTab.ready();}return;}
    if(armed!=='tab'&&isPointer)return;
    const name=(element.getAttribute('aria-label')||element.textContent||'').trim();
    const role=element.getAttribute('role'),group=armed,items=groups[group];
    if(items.length>=limits[group]+1)return;
    const matches=group==='checkbox'?role==='checkbox'&&!!element.closest('[id$="content-handover"]'):group==='tab'?role==='tab'&&['岗位交接','交接预览'].includes(name):group==='button'?name==='核对交接清单':name==='确认交接';
    if(!matches)return;
    active?.('上一动作未完成');
    const checked=element.getAttribute('aria-checked');
    const sample:Sample={index:items.length,warm:items.length===0,eventAt:event.timeStamp,capturedAt:performance.now(),feedbackAt:null,elapsedMs:null,trusted:event.isTrusted,visibility:document.visibilityState,focused:document.hasFocus(),width:innerWidth,height:innerHeight,name,missing:null,actionId:`${group}-${items.length}`,eventKind:isPointer?'pointerdown':'click',...(group==='tab'?{preSelected:element.getAttribute('aria-selected')}: {})};items.push(sample);
    let done=false;
    const ready=()=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      if(!element.isConnected||!rect.width||!rect.height||style.display==='none'||style.visibility==='hidden')return false;
      if(group==='checkbox')return element.getAttribute('aria-checked')!==checked;
      if(group==='tab')return element.getAttribute('aria-selected')==='true'&&!!document.querySelector(`[role="tabpanel"][data-state="active"][aria-labelledby="${element.id}"]`);
      return (element as HTMLButtonElement).disabled&&element.textContent?.includes(group==='button'?'正在核对':'正在提交');
    };
    const finish=(missing:string|null)=>{if(done)return;done=true;if(!missing){sample.feedbackAt=performance.now();sample.elapsedMs=sample.feedbackAt-sample.eventAt!;}sample.missing=missing;observer.disconnect();clearTimeout(timer);active=undefined;publish();};
    const observer=new MutationObserver(()=>{if(ready())finish(null);});
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>finish('没有观测到反馈'),1500);active=reason=>finish(reason||'导出前未完成');
    if(group==='tab')lastTab={element,sample,ready};
    if(ready())finish(null);
  };
  document.addEventListener('pointerdown',event=>measure(event,true),true);
  document.addEventListener('click',event=>measure(event,false),true);
  exportButton.onclick=()=>{
    active?.();
    const result:Record<string,unknown>={semantics:'tabs: trusted native pointerdown to visible committed DOM, click auxiliary; other groups: native click to visible committed DOM; not paint or full gesture',limits,groups:{}};
    for(const group of Object.keys(limits) as Group[]){
      const observed=groups[group],raw=Array.from({length:limits[group]},(_,index)=>observed[index+1]||{index:index+1,warm:false,eventAt:null,capturedAt:null,feedbackAt:null,elapsedMs:null,trusted:null,visibility:null,focused:null,width:null,height:null,name:null,missing:'样本未执行'});
      const values=raw.map(value=>value.elapsedMs),present=values.filter((value):value is number=>value!==null).sort((a,b)=>a-b);
      (result.groups as Record<string,unknown>)[group]={warm:observed[0]||null,raw,count:raw.length,missing:values.filter(value=>value===null).length,max:present.length?Math.max(...present):null,p95:present.length===limits[group]?present[Math.ceil(limits[group]*.95)-1]:null,thresholdMs:group==='submit'?150:100};
    }
    output.dataset.result=JSON.stringify(result);output.textContent='固定样本已导出';
  };
  publish();
}
